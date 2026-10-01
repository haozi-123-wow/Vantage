// process.go 实现进程采集器（总数 + Top-N）。
//
// 依据：docs/agent.md §3（process 行：`process.count` 无限维；Top-N 落 `process_snapshots`，⛔ 不进时序）、
// docs/api.md §2.1（`metrics.process.{count,top[]}`）、docs/database.md §5.7.2（`process.count` 单位"个"）。
//
// 数据源：`{root}/<pid>/stat`、`{root}/<pid>/statm`、`{root}/<pid>/comm`（root 下的**纯数字目录**即进程）。
//
// 职责边界：只写 `s.Metrics.Process`。单个进程读不到（采样瞬间退出了）→ 跳过它，
// ⛔ 不让整次采集失败；进程数一个都数不到才返回 produced=false。
//
// ⚠️ 四个踩坑点：
//  1. **comm 在括号里，且可以含空格与括号**（`(rm -rf /)`、`(a)b c)`）。
//     必须从**最后一个** `)` 之后开始切分字段：从第一个 `)` 切是经典错误 ——
//     这类进程的 utime/stime 会整体错位，CPU% 变成毫无意义的数字，
//     而且只有在跑着这类进程的机器上才看得出来。
//  2. `process.top[].cpu` 在中心是 **0–100 的百分比**，口径是 `top` 的**单核**语义
//     （100% = 占满一个核）。多线程进程的"单核口径"本可以到 400%，⛔ 必须夹到 100，
//     否则中心 schema 拒绝 → **整批上报** 400。
//  3. CPU% 的分母**不是墙钟时间**：墙钟要除以 USER_HZ 才变成秒，而 USER_HZ 在个别架构上
//     不是 100（标准库也没有 sysconf(_SC_CLK_TCK)），用一个常数会让那些机器上的 CPU%
//     整体差 10 倍且毫无报错。这里改用「进程 tick / 整机 tick × 核数 × 100」——
//     分子分母同单位，USER_HZ 直接约掉，且用的是内核自己记的时间（不受采集抖动影响）。
//  4. `process.top[].name` **必填且 ≤256 字节、必须是合法 UTF-8**：名字里有非法字节
//     或超长会让**整批**上报 400，所以统一走 sanitizeProcName 清洗。
package collector

import (
	"context"
	"log/slog"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
)

// procStatCommUtime 从 `)` 之后算起的字段下标：utime 是 stat 的第 14 个字段。
//
// ⚠️ 括号后的第一个字段是 state（第 3 个），所以 utime 的下标是 14−3 = 11、stime 是 12。
// 这两个数字写错的后果就是"CPU% 看起来有值但是错的"，属于最难发现的故障。
const (
	statRestUtime = 11
	statRestStime = 12
)

// processCollector 进程采集器。
type processCollector struct {
	cfg  *config.Config
	root string
	log  *slog.Logger

	// prevTicks pid → 上一次的 (utime+stime)（单位 tick）。
	// ⚠️ 每周期**整体重建**：死掉的进程不会一直占着内存（§10 的资源预算）。
	prevTicks   map[int]float64
	prevMachine float64
	hasPrev     bool
	ncpu        int

	warnRoot  warnOnce
	warnWatch warnOnce
	warnTopN  warnOnce
}

// newProcessCollector 构造进程采集器（签名由 platform_linux.go 钉死）。
func newProcessCollector(cfg *config.Config, root string) Collector {
	return &processCollector{
		cfg:       cfg,
		root:      root,
		log:       slog.Default(),
		prevTicks: map[int]float64{},
	}
}

func (c *processCollector) Name() string { return "process" }

func (c *processCollector) Interval() time.Duration { return c.cfg.Collect.Process.Interval.Std() }

// Capabilities 声明 Top-N 能力（`top_n: 0` 时明确声明"不带 Top"，面板就不会画一个空表）。
func (c *processCollector) Capabilities() map[string]bool {
	return map[string]bool{"process.top": c.cfg.Collect.Process.TopN > 0}
}

// procSample 一个进程本轮的读数（nil = 该项没读到）。
type procSample struct {
	pid   int
	name  string
	cpu   *float64 // 单核口径的 CPU%，首次采样时 nil
	ticks *float64 // utime + stime
	mem   *float64 // RSS bytes
}

// Collect 采集一次。⛔ produced=false 时保持 s.Metrics.Process 原样。
func (c *processCollector) Collect(_ context.Context, s *Snapshot) (bool, error) {
	// ⚠️ watch 白名单在当前上报格式里**没有承载字段**（model.Process 只有 count 与 top），
	// 这是已记录的开放项（docs/agent.md §8 的 collect.process.watch）。
	// 本期只记录不产出指标：⛔ 不假装实现（比如把被监控进程塞进 top 里冒充）——
	// 那会让中心看到一批含义不明的数据，比没有数据更难排查。只打一条 WARN 说明。
	if len(c.cfg.Collect.Process.Watch) > 0 {
		c.warnWatch.warn(c.log, "collect.process.watch 本期只记录、不产出指标：当前上报格式没有承载它的字段",
			"watch", strings.Join(c.cfg.Collect.Process.Watch, ","))
	}

	pids, err := c.listPids()
	if err != nil {
		c.warnRoot.warn(c.log, "读不到进程目录，本轮跳过进程采集", "root", c.root, "err", err)
		return false, nil
	}
	if len(pids) == 0 {
		// ✅ 与文件头契约一致：进程数一个都数不到 → produced=false。
		// count=0 是"这台机器没有任何进程"，/proc 可读却零 pid 只会是挂载坏了 —— 伪造 0 比没数据更糟。
		c.warnRoot.warn(c.log, "进程目录里没有任何数字 pid 目录，本轮跳过进程采集", "root", c.root)
		return false, nil
	}

	machineTicks, ncpu := c.machineCPU()
	c.ncpu = ncpu

	samples := make([]procSample, 0, len(pids))
	cur := make(map[int]float64, len(pids))
	for _, pid := range pids {
		sample, ok := c.readProcess(pid)
		if !ok {
			// 采样瞬间进程退出了（/proc/<pid> 消失）或没有权限读：跳过它，不算失败。
			continue
		}
		if sample.ticks != nil {
			cur[pid] = *sample.ticks
		}
		samples = append(samples, sample)
	}

	prevTicks, prevMachine, hasPrev := c.prevTicks, c.prevMachine, c.hasPrev
	c.prevTicks, c.prevMachine, c.hasPrev = cur, machineTicks, true

	// ✅ CPU%：分子分母都是 tick，USER_HZ 约掉（见文件头注释第 3 点）。
	// ⚠️ 第一次采集没有上一次样本 → cpu 留 nil（中心不会为 nil 产出数据点），
	//    但 count / mem 是本周期就采到的，照常上报。
	var dMachine float64
	if hasPrev {
		dMachine = machineTicks - prevMachine
	}
	for i := range samples {
		if !hasPrev || dMachine <= 0 || samples[i].ticks == nil {
			continue
		}
		prev, ok := prevTicks[samples[i].pid]
		if !ok {
			continue // 本轮新出现的进程：没有可比样本
		}
		d := *samples[i].ticks - prev
		if d < 0 {
			continue // pid 复用/计数器回绕：宁可这一轮没有 CPU%
		}
		pct := clampPct(d / dMachine * float64(c.ncpu) * 100)
		samples[i].cpu = f64(pct)
	}

	out := &model.Process{Count: uint32(len(samples))}
	out.Top = c.buildTop(samples)
	s.Metrics.Process = out
	return true, nil
}

// listPids 列出 root 下的纯数字目录（即进程）。
//
// ⚠️ 用 ReadDir 而不是遍历 /proc 所有条目再逐个 stat：进程目录的"目录"属性在
// 容器/特殊挂载下不一定可靠（历史上 pid 目录曾是普通文件），只认**纯数字名字**最稳。
func (c *processCollector) listPids() ([]int, error) {
	entries, err := os.ReadDir(c.root)
	if err != nil {
		return nil, err
	}
	pids := make([]int, 0, len(entries))
	for _, e := range entries {
		pid, ok := parsePID(e.Name())
		if !ok {
			continue
		}
		pids = append(pids, pid)
	}
	// 排序：让输出顺序只取决于 pid（读目录的顺序在不同文件系统上并不稳定），
	// 这样"同一份夹具跑两次结果一致"，测试不会间歇性失败。
	sort.Ints(pids)
	return pids, nil
}

// parsePID 严格解析十进制 pid（`self`、`net`、`sys` 这类非数字目录会被拒掉）。
func parsePID(name string) (int, bool) {
	v, ok := parseUintString(name)
	if !ok || v == 0 || v > 1<<31-1 {
		return 0, false
	}
	return int(v), true
}

// readProcess 读一个进程的 stat / statm / comm。
//
// 返回 ok=false 表示该进程本轮读不到有效 stat（通常是采样瞬间已经退出）。
// stat 里读不到 utime/stime 时 sample.ticks 为 nil（CPU% 留 nil），但进程仍会计入总数。
func (c *processCollector) readProcess(pid int) (procSample, bool) {
	statContent, err := readFileTrimmed(c.root, pidPath(pid, "stat"))
	if err != nil {
		return procSample{}, false
	}
	comm, utime, stime, ok := parseProcPidStat(statContent)
	if !ok {
		return procSample{}, false
	}

	sample := procSample{pid: pid}

	// 名字：优先 {pid}/comm，读不到则回退 stat 括号里的 comm（权限被收紧时就是这样）。
	name := ReadTrimmed(c.root, pidPath(pid, "comm"))
	if name == "" {
		name = comm
	}
	sample.name = sanitizeProcName(name)

	ticks := utime + stime
	sample.ticks = &ticks

	// 常驻内存：statm 的第 2 个字段是**页数**，× 页大小才是 bytes。
	// ⚠️ 用 os.Getpagesize() 而不是写死 4096：非 4K 页的架构（arm64 16K/64K 页）上会差 4–16 倍。
	if statm, err := readFileTrimmed(c.root, pidPath(pid, "statm")); err == nil {
		if pages, ok := atoiField(strings.Fields(statm), 1); ok {
			sample.mem = f64(float64(pages) * float64(os.Getpagesize()))
		}
	}
	return sample, true
}

// pidPath 拼 `{pid}/{file}` 相对路径。
func pidPath(pid int, file string) string {
	return strconv.Itoa(pid) + "/" + file
}

// machineCPU 读 `{root}/stat` 拿"整机累计 tick"与核数（CPU% 的分母/口径）。
//
// ⚠️ 核数取 `cpuN` 的行数：`top` 的单核口径要求"100% = 一个核"，
// 而这个换算必须知道机器有几个核。拿不到 cpuN 行时退回 runtime.NumCPU()。
func (c *processCollector) machineCPU() (float64, int) {
	content, err := readFileTrimmed(c.root, "stat")
	if err != nil {
		return 0, runtime.NumCPU()
	}
	total, cores, _, _, _ := parseProcStat(content)
	ncpu := len(cores)
	if ncpu == 0 {
		ncpu = runtime.NumCPU()
	}
	if ncpu <= 0 {
		ncpu = 1
	}
	return float64(total.total()), ncpu
}

// buildTop 按 CPU 降序取 TopN。
//
// ⚠️ 排序必须**完全确定**：
//   - 主键 CPU 降序（没有 CPU% 的进程排在最后，用 −1 参与比较）；
//   - 次键 pid 升序 —— 没有这个次键时，两个 CPU% 相同的进程在不同次运行里顺序可能不同，
//     测试会间歇性失败，面板上也会看到顺序来回跳。
func (c *processCollector) buildTop(samples []procSample) []model.ProcessTop {
	n := c.cfg.Collect.Process.TopN
	if n <= 0 {
		return nil
	}
	if n > model.MaxProcessTop {
		// 配置校验已经卡了 ≤50，这里的上限只是防御：中心的数组上限是硬约束。
		c.warnTopN.warn(c.log, "top_n 超过中心上限，已按上限处理",
			"top_n", n, "limit", model.MaxProcessTop)
		n = model.MaxProcessTop
	}

	ranked := make([]procSample, 0, len(samples))
	for _, s := range samples {
		if s.name == "" {
			// ⛔ 名字为空会让中心 schema 拒绝**整批**（name 必填）：
			//    宁可这个进程不进 Top，也不能发一条空名字的条目。
			continue
		}
		ranked = append(ranked, s)
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		ci, cj := cpuRank(ranked[i]), cpuRank(ranked[j])
		if ci != cj {
			return ci > cj
		}
		return ranked[i].pid < ranked[j].pid
	})

	if n > len(ranked) {
		n = len(ranked)
	}
	out := make([]model.ProcessTop, 0, n)
	for _, s := range ranked[:n] {
		out = append(out, model.ProcessTop{
			Pid:  s.pid,
			Name: s.name,
			CPU:  s.cpu,
			Mem:  s.mem,
		})
	}
	return out
}

// cpuRank 用于排序：没采到 CPU%（nil）的进程排在真实值之后。
func cpuRank(s procSample) float64 {
	if s.cpu == nil {
		return -1
	}
	return *s.cpu
}

// parseProcPidStat 从 `{root}/<pid>/stat` 取 comm、utime、stime。
//
// ⛔ 字段切分一律从**最后一个** `)` 之后开始：`comm` 是 `(名字)`，名字里可以含空格与括号
//（`(Web Content)`、`(a)b)c`、`(rm -rf /)`）。从第一个 `)` 切分会让这些进程的
// utime/stime 整体错位 —— CPU% 变成一个"有值但完全错误"的数字，没有任何报错。
func parseProcPidStat(content string) (comm string, utime, stime float64, ok bool) {
	open := strings.IndexByte(content, '(')
	closeIdx := strings.LastIndexByte(content, ')')
	if open < 0 || closeIdx <= open {
		return "", 0, 0, false
	}
	comm = content[open+1 : closeIdx]

	rest := strings.Fields(content[closeIdx+1:])
	// rest[0] 是 state（第 3 个字段），所以 utime/stime 的下标是 11/12。
	utime, okU := atofField(rest, statRestUtime)
	stime, okS := atofField(rest, statRestStime)
	if !okU || !okS {
		return comm, 0, 0, false
	}
	return comm, utime, stime, true
}

// sanitizeProcName 清洗进程名，保证中心的 name 约束一定满足：
// 长度 ≤ 256 字节（model.MaxProcNameLen）、合法 UTF-8、非空。
//
// ⚠️ 三件事都不是"美化"：
//   - 非法 UTF-8 字节（进程可以把自己 comm 设成任意字节）会让 JSON 序列化出坏数据，
//     中心解析失败 → **整批** 400；
//   - 超过 256 字节同样让中心拒绝整批；
//   - 截断必须按**字符边界**，把一个多字节字符切成两半就又变成非法 UTF-8 了。
func sanitizeProcName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}

	var b strings.Builder
	b.Grow(len(s))
	for len(s) > 0 {
		r, size := utf8.DecodeRuneInString(s)
		if r == utf8.RuneError && size == 1 {
			s = s[1:] // 非法字节：丢掉（保留长度信息没有意义，中心要的是合法字符串）
			continue
		}
		b.WriteRune(r)
		s = s[size:]
	}

	out := b.String()
	// 按字符边界截断到 256 字节。
	for len(out) > model.MaxProcNameLen {
		_, size := utf8.DecodeLastRuneInString(out)
		if size <= 0 {
			size = 1
		}
		out = out[:len(out)-size]
	}
	return out
}
