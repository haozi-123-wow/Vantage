// Command vantage-agent 是被监控端的采集与上报进程。
//
// 依据：docs/agent.md（全文）、docs/api.md §2。
//
// ⛔ 三条不可违背的约束（违反任何一条都算重大缺陷）：
//
//  1. **通信严格单向**：本进程只主动出站连接中心；⛔ 不监听任何端口、不接受任何入站连接、
//     不读取响应里除 `{ok, server_ts}` 之外的任何内容。整个 `agent/` 里没有、也不会出现
//     「从中心拉配置」的代码路径。
//  2. **配置只在本地**：中心地址、采集项、频率、探活目标全部来自本机 `config.yaml`；
//     改配置的唯一方式 = 上机改文件 + `reload`（SIGHUP）或 `restart`。
//  3. **凭证不进命令行**：只从 `agent.key_file` / `agent.secret_file` 两个受限文件读
//     （`--key` 一类的参数永远不会存在，✅ 决策 #37）。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"vantage-agent/internal/auth"
	"vantage-agent/internal/collector"
	"vantage-agent/internal/config"
	"vantage-agent/internal/logging"
	"vantage-agent/internal/model"
	"vantage-agent/internal/prober"
	"vantage-agent/internal/reporter"
	"vantage-agent/internal/scheduler"
	"vantage-agent/internal/version"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "vantage-agent: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	fs := flag.NewFlagSet("vantage-agent", flag.ContinueOnError)
	var (
		configPath = fs.String("config", "/etc/vantage/config.yaml", "配置文件路径")
		showVer    = fs.Bool("version", false, "打印版本后退出")
		checkOnly  = fs.Bool("check", false, "只校验配置与凭证（并打印生效摘要），不启动调度")
		once       = fs.Bool("once", false, "采集并上报**一次**后退出（真机联调用）")
		printBody  = fs.Bool("print-body", false, "配合 --once：把将要上报的报文体打印到 stdout（⛔ 只含指标，不含凭证）")
	)
	if err := fs.Parse(os.Args[1:]); err != nil {
		return err
	}
	if *showVer {
		fmt.Printf("vantage-agent %s (%s)\n", version.Version, scheduler.GoRuntime())
		return nil
	}

	// --- ① 配置 ---------------------------------------------------------------
	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}

	logger, logCloser, err := logging.New(cfg.Log)
	if err != nil {
		return err
	}
	defer func() { _ = logCloser.Close() }()

	// ⛔ 非 Linux 直接拒绝启动：本期采集器只做 Linux（✅ §13.3）。
	//    在这里挡住的理由：中心的 schema 要求每批上报必须带 cpu.usage 与 mem.total，
	//    没有采集器就会每 30 秒发一批必然被 400 的报文，日志里刷满无用错误。
	if !collector.Supported {
		return fmt.Errorf(
			"本平台（%s）暂不支持采集：M1–M5 只做 Linux，Windows/macOS 排在 M6（✅ §13.3）",
			scheduler.GoRuntime())
	}

	if cfg.Center.AllowHTTP {
		logger.Warn("⛔ 已放行非 https 的中心地址（center.allow_insecure_http: true）："+
			"凭证与指标将以明文传输，⛔ 仅限测试环境", "center", cfg.Center.URL)
	}

	// --- ② 凭证（⛔ 只从受限文件读，永不进命令行）--------------------------------
	creds, err := auth.LoadCredentials(cfg.Agent.KeyFile, cfg.Agent.SecretFile)
	if err != nil {
		return err
	}
	for _, w := range creds.Warnings {
		logger.Warn(w)
	}

	// --- ③ 资源封顶（✅ §4.3：GOMEMLIMIT 封顶，空闲目标 20–30MB）------------------
	limitBytes := int64(cfg.Resource.GoMemLimitMB) << 20
	debug.SetMemoryLimit(limitBytes)

	logger.Info("vantage-agent 启动",
		"version", version.Version,
		"runtime", scheduler.GoRuntime(),
		"config", *configPath,
		"mem_limit_mb", cfg.Resource.GoMemLimitMB,
		"summary", cfg.Summary())

	if *checkOnly {
		fmt.Println("配置与凭证校验通过")
		fmt.Println("生效摘要：" + cfg.Summary())
		return nil
	}

	// --- ④ 单次模式（真机联调：跑一次就走，不进常驻循环）--------------------------
	if *once {
		return runOnce(cfg, creds, logger, *printBody)
	}

	// --- ⑤ 常驻调度 + SIGHUP 热重载 -------------------------------------------
	sched, err := scheduler.New(scheduler.Options{
		Config:      cfg,
		Credentials: creds,
		Logger:      logger,
		ProcRoot:    collector.DefaultProcRoot,
	})
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// ⛔ 热重载只读本地文件；不存在"从中心拉配置"的路径（单向宗旨）。
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-hup:
				newCfg, err := config.Load(*configPath)
				if err != nil {
					// ⛔ 校验不通过 → 保留旧配置 + 记日志 + 上报 config_reload_failed 信号，
					//    **绝不进入半配置状态**（✅ §7 失败安全）
					sched.ReloadFailed(err)
					continue
				}
				sched.Reload(newCfg)
			}
		}
	}()

	return sched.Run(ctx)
}

// runOnce 采集并上报一次（`--once`）。
//
// 用途：真机首次联调与排障 —— 不必等常驻进程跑满一个周期，直接看"这一次到底发出去没有、
// 中心回了什么"。它走的是与常驻模式**完全相同**的采集与上报代码路径
//（唯一区别是只跑一轮，且没有重试之外的调度）。
func runOnce(cfg *config.Config, creds *auth.Credentials, logger *slog.Logger, printBody bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*cfg.Center.Timeout.Std()+cfg.Report.Retry.MaxElapsed.Std())
	defer cancel()

	collectors := collector.New(collector.BuildOptions{
		Config: cfg, ProcRoot: collector.DefaultProcRoot,
	})
	if len(collectors) == 0 {
		return errors.New("没有任何启用的采集器（检查 collect.*.enabled 与平台支持）")
	}

	var snap collector.Snapshot
	snap.Host = collector.HostInfo(collector.DefaultProcRoot)
	for _, c := range collectors {
		start := time.Now()
		produced, err := c.Collect(ctx, &snap)
		elapsed := time.Since(start)
		switch {
		case err != nil:
			logger.Warn("采集失败（已优雅降级）", "collector", c.Name(), "err", err)
		case !produced:
			logger.Info("本周期无数据（属正常降级）", "collector", c.Name(), "elapsed", elapsed)
		default:
			logger.Info("采集完成", "collector", c.Name(), "elapsed", elapsed)
		}
	}

	var probes []model.Probe
	for _, p := range prober.New(cfg) {
		r := p.Probe(ctx)
		probes = append(probes, r)
		logger.Info("探活完成", "probe", r.Name, "up", r.Up)
	}

	snap.Metrics.Agent = &model.Self{}
	caps := collector.Capabilities(collectors)
	for k, v := range prober.Capabilities(prober.New(cfg)) {
		caps[k] = v
	}
	host := *snap.Host
	host.Capabilities = collector.CapabilitiesToModel(caps)

	rep, err := reporter.New(reporter.Options{
		Config: cfg, AgentID: cfg.Agent.ID, Key: creds.Key, Secret: creds.Secret, Logger: nil,
	})
	if err != nil {
		return err
	}

	body := &model.Report{Metrics: &snap.Metrics, Probes: probes, Host: &host}
	prepared, err := rep.Prepare(body)
	if err != nil {
		return fmt.Errorf("报文未通过本地校验（⛔ 未发送）：%w", err)
	}
	if printBody {
		// ⚠️ 只打印报文：里面全是指标，⛔ 不含任何凭证
		fmt.Println(string(prepared.Raw()))
	}
	logger.Info("准备上报", "batch_id", prepared.BatchID(), "bytes", prepared.Bytes())

	resp, err := prepared.Send(ctx, rep)
	if err != nil {
		return err
	}
	fmt.Printf("上报成功：server_ts=%d attempts=%d 压缩前=%d字节 实际发出=%d字节\n",
		resp.ServerTS, resp.Attempts, resp.RawBytes, resp.WireBytes)
	return nil
}
