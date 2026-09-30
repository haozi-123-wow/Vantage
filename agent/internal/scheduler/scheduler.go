// Package scheduler 负责「各采集器按自己的周期跑、探活按自己的周期跑、上报按上报周期跑」。
//
// 依据：docs/agent.md §4.5（不同任务不同频率、事件驱动 sleep、**无忙轮询**）、
//       §10（固定少量 goroutine，不随主机规模膨胀）、§7（SIGHUP 热重载）。
//
// 并发模型（固定 3 类 goroutine，数量不随主机规模变）：
//
//	采集器 1 条/每项  →  写共享快照（持锁，微秒级）
//	探活   1 条/每条  →  写自己的结果（持锁）
//	上报   1 条        →  锁内序列化、锁外做网络 I/O
//
// ⛔ 为什么上报要"锁内序列化、锁外发送"：采集器在持续写快照，JSON 编码必须发生在锁内；
//    而发送可能持续几十秒（重试 + 退避），绝不能把锁持有那么久 —— 那会让采集器全部堵住，
//    进而让"采集耗时 < 50ms"这条硬指标失效。
//
// ⛔ 热重载的实现方式：**整代重启**。收到 SIGHUP 后取消当前这一代的所有 goroutine、
//    等它们全部退出，再用新配置起新一代。这样任何时刻只有一代在跑，不存在两代同时写快照。
//    进程、HTTP 连接池（在 reporter 里）与签名状态全部保留 —— 这正是 ✅ §7 要的效果：
//    避免 restart 造成短周期内反复上下线、误触离线告警并让曲线断层。
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"vantage-agent/internal/auth"
	"vantage-agent/internal/collector"
	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
	"vantage-agent/internal/prober"
	"vantage-agent/internal/reporter"
)

// collectBudget 单次采集耗时预算（✅ §4.3：目标 < 50ms）。
// ⚠️ 超了只打 WARN 不中断：GPU（要 fork nvidia-smi）本来就会超，这是已知例外。
const collectBudget = 50 * time.Millisecond

// Options 构造参数。
type Options struct {
	Config      *config.Config
	Credentials *auth.Credentials
	Logger      *slog.Logger
	// ProcRoot 可注入（测试传夹具目录）。
	ProcRoot string
	// StatFS 可注入（测试）。
	StatFS collector.StatFSSource
	// Reporter 可注入（测试指向假中心）；nil 时按配置与凭证构造。
	Reporter *reporter.Reporter
}

// Scheduler 调度器。
type Scheduler struct {
	log     *slog.Logger
	creds   *auth.Credentials
	opts    Options
	rep     *reporter.Reporter
	reloads chan *config.Config

	mu   sync.Mutex
	cfg  *config.Config
	snap collector.Snapshot
	// probes 各探活的最近一次结果（按配置顺序输出）。
	probes map[string]model.Probe
	// dirty 自上次上报以来有没有新的采集结果。
	dirty bool
	// hostFingerprint 上次带 host 上报时的指纹：用于实现"首次与能力变化时必填"（✅ §2.1）。
	hostFingerprint string
	// lastUpload 上次实际发出报文的时间（心跳节流用）。
	lastUpload time.Time
	// reloadOK 最近一次 SIGHUP 的结果 → `agent.reload_ok`（✅ G10）。
	reloadOK *bool

	wg sync.WaitGroup
}

// New 构造调度器。
func New(opts Options) (*Scheduler, error) {
	if opts.Config == nil {
		return nil, errors.New("scheduler: Config 不能为空")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	s := &Scheduler{
		log:     opts.Logger,
		creds:   opts.Credentials,
		opts:    opts,
		cfg:     opts.Config,
		probes:  map[string]model.Probe{},
		reloads: make(chan *config.Config, 1),
	}
	s.snap.Host = collector.HostInfo(opts.ProcRoot)

	if opts.Reporter != nil {
		s.rep = opts.Reporter
		return s, nil
	}
	if opts.Credentials == nil {
		return nil, errors.New("scheduler: 未提供凭证")
	}
	rep, err := reporter.New(reporter.Options{
		Config:  opts.Config,
		AgentID: opts.Config.Agent.ID,
		Key:     opts.Credentials.Key,
		Secret:  opts.Credentials.Secret,
		Logger:  opts.Logger,
	})
	if err != nil {
		return nil, err
	}
	s.rep = rep
	return s, nil
}

// Reload 应用一份**已解析并校验通过**的新配置（由 SIGHUP 处理器调用）。
//
// ⛔ 校验失败时**不要**调这个方法：那时必须保留旧配置，只调 `ReloadFailed`。
func (s *Scheduler) Reload(cfg *config.Config) {
	select {
	case s.reloads <- cfg:
	default:
		// 通道满（连续两次 SIGHUP 挤在一起）→ 丢掉旧的那份，保留最新的一份。
		select {
		case <-s.reloads:
		default:
		}
		select {
		case s.reloads <- cfg:
		default:
		}
	}
}

// ReloadFailed 记录一次失败的重载：⛔ 保留旧配置，只更新自监控指标与日志。
func (s *Scheduler) ReloadFailed(err error) {
	bad := false
	s.mu.Lock()
	s.reloadOK = &bad
	s.mu.Unlock()
	s.log.Error("配置热重载失败：⛔ 继续使用旧配置（不进入半配置状态）", "err", err)
}

// ReportFailures 供外部（例如 status 子命令）读取当前失败计数。
func (s *Scheduler) ReportFailures() uint64 { return s.rep.Failures() }

// LastServerTS 最近一次成功响应里的 server_ts。
func (s *Scheduler) LastServerTS() int64 { return s.rep.ServerTS() }

// Run 启动调度，阻塞直到 ctx 被取消。
func (s *Scheduler) Run(ctx context.Context) error {
	for {
		genCtx, cancel := context.WithCancel(ctx)
		cfg := s.currentConfig()

		s.startGeneration(genCtx, cfg)
		s.log.Info("调度已启动",
			"report_interval", cfg.Report.Interval.Std(),
			"heartbeat_interval", cfg.Report.HeartbeatInterval.Std(),
			"collectors", len(s.collectorsFor(cfg)),
			"probers", len(prober.New(cfg)))

		select {
		case <-ctx.Done():
			cancel()
			s.wg.Wait()
			s.log.Info("调度已停止（优雅退出）")
			return nil
		case newCfg := <-s.reloads:
			// ⛔ 先取消并**等干净**再换代：任何时刻只能有一代在写快照。
			cancel()
			s.wg.Wait()
			s.applyConfig(newCfg)
		}
	}
}

func (s *Scheduler) currentConfig() *config.Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

func (s *Scheduler) collectorsFor(cfg *config.Config) []collector.Collector {
	return collector.New(collector.BuildOptions{Config: cfg, ProcRoot: s.opts.ProcRoot, StatFS: s.opts.StatFS})
}

// applyConfig 换用新配置：保留进程、连接池与签名状态，只换调度参数与采集器集合。
func (s *Scheduler) applyConfig(cfg *config.Config) {
	ok := true
	s.mu.Lock()
	s.cfg = cfg
	s.reloadOK = &ok
	// 主机信息重新采一次：内核升级、能力变化都应该反映到下一次带 host 的上报里
	s.snap.Host = collector.HostInfo(s.opts.ProcRoot)
	s.mu.Unlock()

	// ⚠️ Reconfigure 只允许在两次上报之间调用；这里刚 join 完上一代，满足该前提。
	s.rep.Reconfigure(cfg)

	s.log.Info("配置已热重载（进程与 TCP 连接保持不断）",
		"report_interval", cfg.Report.Interval.Std(),
		"collectors", len(s.collectorsFor(cfg)),
		"probers", len(prober.New(cfg)),
		"summary", cfg.Summary())
}

// ---------------------------------------------------------------------------
// 各代 goroutine
// ---------------------------------------------------------------------------

func (s *Scheduler) startGeneration(ctx context.Context, cfg *config.Config) {
	for _, c := range s.collectorsFor(cfg) {
		c := c
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.runCollector(ctx, c)
		}()
	}
	for _, p := range prober.New(cfg) {
		p := p
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.runProber(ctx, p)
		}()
	}

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.runReporter(ctx, cfg)
	}()
}

// runCollector 单采集器的**事件驱动**循环（✅ §4.5：无忙轮询）。
func (s *Scheduler) runCollector(ctx context.Context, c collector.Collector) {
	// 立刻采一次、不等第一个周期：否则启动后要白等一个周期才有数据，
	// 而中心的离线阈值只有 3×周期。
	s.collectOnce(ctx, c)

	t := time.NewTicker(c.Interval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.collectOnce(ctx, c)
		}
	}
}

func (s *Scheduler) collectOnce(ctx context.Context, c collector.Collector) {
	start := time.Now()

	// ⛔ 持锁采集：采集器直接写共享快照，锁外写就是数据竞争。
	//    采集本身是"读文件 + 算数"，微秒到毫秒级，不会把上报堵住。
	s.mu.Lock()
	produced, err := c.Collect(ctx, &s.snap)
	if produced {
		s.dirty = true
	}
	s.mu.Unlock()

	if elapsed := time.Since(start); elapsed > collectBudget {
		s.log.Warn("单次采集耗时超过预算（✅ §4.3 目标 <50ms；GPU 采集属已知例外）",
			"collector", c.Name(), "elapsed", elapsed)
	}
	if err != nil && ctx.Err() == nil {
		s.log.Warn("采集失败（已优雅降级，不影响其它采集器）", "collector", c.Name(), "err", err)
	}
}

// runProber 单条探活的事件驱动循环。
func (s *Scheduler) runProber(ctx context.Context, p prober.Prober) {
	s.probeOnce(ctx, p)

	t := time.NewTicker(p.Interval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.probeOnce(ctx, p)
		}
	}
}

func (s *Scheduler) probeOnce(ctx context.Context, p prober.Prober) {
	// ⚠️ 探活**不持锁**执行：它可能阻塞到超时（几秒），而它只产出一个独立结果、
	//    不与采集器竞争同一段字段。写完结果时再短促持锁。
	result := p.Probe(ctx)
	if ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	s.probes[p.Name()] = result
	s.dirty = true
	s.mu.Unlock()

	if !result.Up {
		s.log.Debug("探活未通过", "probe", result.Name, "type", result.Type, "target", result.Target,
			"error", derefString(result.Error))
	}
}

// runReporter 上报循环。
func (s *Scheduler) runReporter(ctx context.Context, cfg *config.Config) {
	t := time.NewTicker(cfg.Report.Interval.Std())
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.reportOnce(ctx)
		}
	}
}

// reportOnce 走一次"该上报还是该发心跳"的判定。
//
// ✅ §4.3：无变更时只报心跳。判据是**本周期有没有新的采集结果**：
// 采集周期比上报周期慢时（例如 disk 60s / 上报 30s），每隔一轮就没有新数据。
func (s *Scheduler) reportOnce(ctx context.Context) {
	cfg := s.currentConfig()
	now := time.Now()

	s.mu.Lock()
	dirty := s.dirty
	probes := s.probesSnapshotLocked()
	hbOnly := !dirty

	// 心跳节流：连续无变更时，心跳间隔不得密于 heartbeat_interval
	if hbOnly && !s.lastUpload.IsZero() && now.Sub(s.lastUpload) < cfg.Report.HeartbeatInterval.Std() {
		s.mu.Unlock()
		return
	}

	var prepared *reporter.Prepared
	if hbOnly {
		var hb model.Heartbeat
		p, err := s.rep.PrepareHeartbeat(&hb)
		if err != nil {
			s.mu.Unlock()
			s.log.Error("心跳未通过本地校验（Agent 自身问题）", "err", err)
			return
		}
		prepared = p
	} else {
		// ⚠️ 浅拷贝 Metrics 即可：切片头共享，但 `Prepare` 在**同一把锁内**完成序列化，
		//    而采集器要写快照也必须先拿到这把锁 —— 所以序列化期间不可能有并发写入。
		metrics := s.snap.Metrics
		metrics.Agent = s.selfMetricsLocked()
		rep := &model.Report{
			Metrics: &metrics,
			Probes:  probes,
			Host:    s.hostForReportLocked(),
		}
		// ⛔ Prepare 必须在锁内：它做 JSON 序列化，而采集器正在写同一份快照。
		p, err := s.rep.Prepare(rep)
		if err != nil {
			s.dirty = false // 这批数据有问题，清掉脏标记，下个周期重新采
			s.mu.Unlock()
			s.log.Error("上报体未通过本地校验/裁剪，本批被丢弃", "err", err)
			return
		}
		prepared = p
		s.dirty = false
	}
	s.lastUpload = now
	s.mu.Unlock()

	// ⛔ 锁外做网络 I/O：重试 + 退避可能持续几十秒
	resp, err := prepared.Send(ctx, s.rep)
	if err != nil {
		s.log.Error("上报失败（本批按丢弃式策略放弃，⛔ 不落盘不补传）",
			"batch_id", prepared.BatchID(), "bytes", prepared.Bytes(), "err", err)
		return
	}
	if hbOnly {
		s.log.Debug("心跳已上报", "batch_id", prepared.BatchID(), "server_ts", resp.ServerTS)
	} else {
		s.log.Info("上报成功", "batch_id", prepared.BatchID(), "bytes", prepared.Bytes(),
			"attempts", resp.Attempts, "server_ts", resp.ServerTS)
	}
}

// probesSnapshotLocked 按配置顺序输出探活结果（未出结果的不出现）。
// ⚠️ 调用方必须持锁。
func (s *Scheduler) probesSnapshotLocked() []model.Probe {
	if len(s.probes) == 0 {
		return nil
	}
	out := make([]model.Probe, 0, len(s.probes))
	for _, p := range s.cfg.Probes {
		if r, ok := s.probes[p.Name]; ok {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// hostForReportLocked 决定这一批要不要带 `host`。
//
// ✅ §2.1：**首次上报与能力变化时必填，其余可省**。省掉它每批能少约 200 字节，
// 而中心的 `host_info` 只在值变化时才需要更新。⚠️ 调用方必须持锁。
func (s *Scheduler) hostForReportLocked() *model.Host {
	if s.snap.Host == nil {
		return nil
	}
	caps := s.mergedCapabilitiesLocked()
	fp := capabilityFingerprint(caps) + "|" + s.snap.Host.Hostname + "|" + s.snap.Host.Kernel +
		fmt.Sprintf("|%d", s.snap.Host.BootTime)
	if fp == s.hostFingerprint {
		return nil // 没有变化 → 按契约可以省略
	}
	s.hostFingerprint = fp

	host := *s.snap.Host
	host.Capabilities = collector.CapabilitiesToModel(caps)
	return &host
}

// mergedCapabilitiesLocked 合并采集器与探活的能力声明。⚠️ 调用方必须持锁。
func (s *Scheduler) mergedCapabilitiesLocked() map[string]bool {
	cfg := s.cfg
	out := collector.Capabilities(s.collectorsFor(cfg))
	for k, v := range prober.Capabilities(prober.New(cfg)) {
		if prev, seen := out[k]; seen {
			out[k] = prev && v
			continue
		}
		out[k] = v
	}
	return out
}

// selfMetricsLocked Agent 自监控最小集（✅ G10）。⚠️ 调用方必须持锁。
func (s *Scheduler) selfMetricsLocked() *model.Self {
	self := &model.Self{}
	if rss := readSelfRSS(s.opts.ProcRoot); rss > 0 {
		self.MemRSS = &rss
	}
	failures := s.rep.Failures()
	self.ReportFailures = &failures
	if s.reloadOK != nil {
		ok := *s.reloadOK
		self.ReloadOK = &ok
	}
	return self
}

// readSelfRSS 读本进程的常驻内存（RSS）。
//
// ⚠️ 用 `{procRoot}/self/statm` 第二个字段（驻留页数）× 页大小，而不是
//    `runtime.MemStats.Sys`：后者是"向操作系统要到的总量"，比真实 RSS 大得多，
//    拿它去判断"监控系统有没有把这台机压垮"会一直虚高、失去参考价值。
//    读不到（非 Linux 夹具等）时返回 0 → 该指标被省略，⛔ 不写 0 冒充。
func readSelfRSS(procRoot string) float64 {
	if procRoot == "" {
		procRoot = collector.DefaultProcRoot
	}
	if procRoot == "" {
		return 0
	}
	raw := collector.ReadTrimmed(procRoot, "self/statm")
	if raw == "" {
		return 0
	}
	fields := strings.Fields(raw)
	if len(fields) < 2 {
		return 0
	}
	pages, err := parseUint(fields[1])
	if err != nil {
		return 0
	}
	return float64(pages) * float64(os.Getpagesize())
}

func parseUint(s string) (uint64, error) {
	var v uint64
	if s == "" {
		return 0, errors.New("空字符串")
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, fmt.Errorf("不是无符号整数：%q", s)
		}
		v = v*10 + uint64(s[i]-'0')
	}
	return v, nil
}

// capabilityFingerprint 需要按"有序且稳定"的方式拼出能力指纹。
func capabilityFingerprint(caps map[string]bool) string {
	return collector.CapabilityFingerprint(caps)
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// GoRuntime 供 status/日志输出当前 Go 运行时信息（排障用，不含任何凭证）。
func GoRuntime() string {
	return fmt.Sprintf("%s/%s %s", runtime.GOOS, runtime.GOARCH, runtime.Version())
}
