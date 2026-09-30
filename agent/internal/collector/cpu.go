// cpu.go 实现 CPU 采集器。
//
// 依据：docs/agent.md §3（cpu 行）、docs/database.md §5.7.2
//（`cpu.usage` / `cpu.core.usage{core=<n>}` 单位 %、`cpu.load1|5|15` 无量纲、`cpu.ctx_switch` 次/s）。
//
// 数据源：`{root}/stat`（首行 `cpu` 为总体、`cpu0..cpuN` 每核、`ctxt` 累计上下文切换）+ `{root}/loadavg`。
//
// 产出：`CPU.Usage`（必填）、`CPU.Cores`（仅在 `collect.cpu.per_core` 为真时填）、
// `CPU.Load`（恰好 3 个）、`CPU.CtxSwitch`。
//
// ⚠️ 四个踩坑点：
//  1. **total 只加前 8 个字段**（user..steal）。4.2+ 内核行尾还有 guest/guest_nice，
//     它们**已经包含在 user/nice 里**，再加一遍 => total 偏大 => 使用率整体偏低（且看不出来）。
//  2. `cpu.usage` 是中心 schema 的必填项，所以**第一次采集必须返回 produced=false**，
//     让调度器这一轮不上报。⛔ 不能塞 0 或估算值：那会画出一条"刚启动 CPU 归零"的假曲线，
//     而且中心聚合层会把 0 当成真实最小值永远留在图例里。
//  3. 使用率必须**夹到 0–100**：/proc/stat 各字段不是同一瞬间读到的，浮点误差能让结果变成
//     100.00000000000001，中心 pct schema 是闭区间 → **整批上报** 400。
//  4. 每核使用率的**下标就是维度值** `core=<n>`（§5.7.2：核序号是维度，取代老的
//     `cpu.core.<n>.usage` 写法）。所以一旦核列表出现编号空洞，整份 cores 都不再可信，
//     必须整个丢掉而不是错位填充 —— 错位会让 `cpu.core.usage{core=3}` 显示的是 cpu4 的值。
package collector

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
)

// cpuStatFields `cpu`/`cpuN` 行里参与 total 的字段数（user nice system idle iowait irq softirq steal）。
//
// ⛔ 有意的"前 8 个"：4.2+ 内核后面跟着 guest、guest_nice，而 guest 时间**已经计入 user**，
// 把 10 个字段全加起来会把 total 算大（容器/虚拟化机器上更明显），使用率被系统性低估。
const cpuStatFields = 8

// cpuTimes 一次采样的 CPU tick 计数。
type cpuTimes struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

// total 全部 tick 之和（分母）。
func (t cpuTimes) total() uint64 {
	return t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal
}

// idleAll "空闲"口径：idle + iowait。
//
// ✅ 采用 Linux `top`/`htop` 的口径：iowait 时 CPU 并没有被占用，算进 busy 会让
// 磁盘繁忙的机器在面板上显示成"CPU 忙"，掩盖真正的瓶颈。
func (t cpuTimes) idleAll() uint64 { return t.idle + t.iowait }

// cpuCollector CPU 采集器。
//
// ⚠️ 同一实例不会被并发调用（调度器按各自的周期顺序触发），所以内部状态不加锁；
// 但 warnOnce 内部用 sync.Once，即便将来改成并发也不会重复刷日志。
type cpuCollector struct {
	cfg  *config.Config
	root string
	now  clock
	log  *slog.Logger

	prevTotal cpuTimes
	prevCores []cpuTimes
	hasPrev   bool

	ctx rateTracker

	warnStat    warnOnce
	warnNoUsage warnOnce
	warnCores   warnOnce
}

// newCPUCollector 构造 CPU 采集器（签名由 platform_linux.go 钉死）。
func newCPUCollector(cfg *config.Config, root string) Collector {
	return &cpuCollector{
		cfg:  cfg,
		root: root,
		now:  time.Now,
		log:  slog.Default(),
	}
}

func (c *cpuCollector) Name() string { return "cpu" }

func (c *cpuCollector) Interval() time.Duration { return c.cfg.Collect.CPU.Interval.Std() }

// Collect 采集一次。
//
// ⛔ produced=false 时**完全不碰** s.Metrics.CPU：中心 schema 要求 cpu.usage 必填，
// 写一个半成品进去只会让 reporter 的本地校验失败，把**整批**（含 mem/disk/net）都丢掉。
func (c *cpuCollector) Collect(_ context.Context, s *Snapshot) (bool, error) {
	content, err := readFileTrimmed(c.root, "stat")
	if err != nil {
		c.warnStat.warn(c.log, "读不到 /proc/stat，本轮跳过 CPU 采集",
			"path", procPath(c.root, "stat"), "err", err)
		return false, nil
	}

	total, cores, coresOK, ctxt, hasCtxt := parseProcStat(content)
	if !hasCPUStat(total) {
		c.warnStat.warn(c.log, "读不到 /proc/stat，本轮跳过 CPU 采集",
			"path", procPath(c.root, "stat"), "err", "缺少 `cpu ` 首行")
		return false, nil
	}

	now := c.now()
	prev, hasPrev := c.prevTotal, c.hasPrev
	prevCores := c.prevCores
	c.prevTotal, c.prevCores, c.hasPrev = total, cores, true

	// 上下文切换速率与使用率无关，先独立算出来；但它单独一个字段撑不起上报
	//（cpu.usage 必填），所以还是走同一个 produced 判断。
	ctxSwitch, hasCtxSwitch := 0.0, false
	if hasCtxt {
		ctxSwitch, hasCtxSwitch = c.ctx.rate(float64(ctxt), now)
	}

	if !hasPrev {
		// ✅ 第一次采集：没有上一次样本 → 速率与使用率都无从谈起。
		// 返回 produced=false（而不是写 0）：调度器这一轮不上报，下一个周期就有真实值了。
		return false, nil
	}

	usage, ok := cpuUsagePct(prev, total)
	if !ok {
		// 计数器回绕（重启/虚拟化环境热插拔）或整机一个 tick 都没走。
		c.warnNoUsage.warn(c.log, "本轮算不出 CPU 使用率（计数器回绕或没有 tick 前进），跳过本次上报",
			"prev_total", prev.total(), "cur_total", total.total())
		return false, nil
	}

	cpu := &model.CPU{Usage: f64(usage)}
	if hasCtxSwitch {
		cpu.CtxSwitch = f64(ctxSwitch)
	}
	if load, ok := parseLoadAvg(ReadTrimmed(c.root, "loadavg")); ok {
		cpu.Load = load
	}
	if c.cfg.Collect.CPU.PerCore {
		cpu.Cores = c.buildCores(prevCores, cores, coresOK)
	}

	s.Metrics.CPU = cpu
	return true, nil
}

// buildCores 计算每核使用率；数组下标即 `core=<n>` 的维度值。
//
// ⚠️ 一旦核数量与上一次不一致（CPU 热插拔、容器 cpuset 变化）或解析出的核编号有空洞，
// 就直接返回 nil：错位的 cores 会让 `cpu.core.usage{core=3}` 显示的是别的核的数据，
// 而这在面板上完全看不出异常（比"这个周期没有每核数据"危险得多）。
func (c *cpuCollector) buildCores(prev, cur []cpuTimes, ok bool) []float64 {
	if !ok || len(cur) == 0 {
		c.warnCores.warn(c.log, "本轮不产出每核使用率：/proc/stat 的核列表不可用或有编号空洞")
		return nil
	}
	if len(prev) != len(cur) {
		// 首次采样后核数变化：这一轮没有可比的上一份样本。
		return nil
	}
	out := make([]float64, 0, len(cur))
	for i := range cur {
		usage, ok := cpuUsagePct(prev[i], cur[i])
		if !ok {
			// 单个核没有 tick 前进（离线核）：留 0 会让曲线看起来"这个核完全空闲"，
			// 但那本来就是 /proc 报告的状态（离线/未调度），所以填 0 是"采到了 0"的合法语义。
			usage = 0
		}
		out = append(out, usage)
	}
	// ⛔ 中心 schema 的 cores 上限 256（model.MaxCPUCores）：超了会让整批 400，
	// 所以宁可丢掉高位核也要保住这一批（这是"少数据 > 没数据"的取舍）。
	if len(out) > model.MaxCPUCores {
		c.warnCores.warn(c.log, "核数超过中心上限，已截断",
			"cores", len(out), "limit", model.MaxCPUCores)
		out = out[:model.MaxCPUCores]
	}
	return out
}

// hasCPUStat 判断总体行是否解析成功（零值 ≠ 解析成功，故不能只比零值）。
func hasCPUStat(t cpuTimes) bool { return t.total() > 0 }

// parseProcStat 解析 `{root}/stat`。
//
// 返回：总体 tick、每核 tick（按 cpuN 的 N 升序）、每核是否可信（编号连续无空洞）、
// ctxt 值与其是否存在。
//
// ⚠️ 编号连续性检查在这里而不是在 buildCores 里：解析阶段才知道原始编号，
// 而"下标 = core 维度值"这条契约（§5.7.2）要求下标必须等于内核给的 N。
func parseProcStat(content string) (total cpuTimes, cores []cpuTimes, coresOK bool, ctxt uint64, hasCtxt bool) {
	coresOK = true
	nextCore := uint64(0)

	for _, line := range splitLines(content) {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch {
		case fields[0] == "cpu":
			t, ok := parseCPUTimes(fields[1:])
			if ok {
				total = t
			}
		case strings.HasPrefix(fields[0], "cpu"):
			idx, ok := parseCoreIndex(fields[0])
			if !ok {
				continue
			}
			t, ok := parseCPUTimes(fields[1:])
			if !ok {
				// 某一行核数据畸形：整份 cores 都不再可信（编号会出现空洞）。
				coresOK = false
				continue
			}
			if idx != nextCore {
				coresOK = false // 有空洞或乱序：下标与 core 维度值不再对应
			}
			nextCore = idx + 1
			cores = append(cores, t)
		case fields[0] == "ctxt":
			if v, ok := lineUintField(line, "ctxt"); ok {
				ctxt, hasCtxt = v, true
			}
		}
	}
	return total, cores, coresOK, ctxt, hasCtxt
}

// parseCoreIndex 从 `cpu12` 里取出 12。
func parseCoreIndex(label string) (uint64, bool) {
	return parseUintString(strings.TrimPrefix(label, "cpu"))
}

// parseUintString 严格解析十进制无符号整数（⛔ 不用 fmt.Sscanf：它会容忍 `12abc`）。
func parseUintString(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	var v uint64
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch < '0' || ch > '9' {
			return 0, false
		}
		v = v*10 + uint64(ch-'0')
	}
	return v, true
}

// parseCPUTimes 把 `cpu` 行尾的数字切成 8 个字段。
//
// ⚠️ 少于 8 个字段（极老内核、或被裁剪的输出）直接判为解析失败：
// 缺字段时"补 0"会让 total 偏小、使用率虚高，而这种偏差不会报任何错。
func parseCPUTimes(nums []string) (cpuTimes, bool) {
	if len(nums) < cpuStatFields {
		return cpuTimes{}, false
	}
	var out [cpuStatFields]uint64
	for i := 0; i < cpuStatFields; i++ {
		v, ok := atoiField(nums, i)
		if !ok {
			return cpuTimes{}, false
		}
		out[i] = v
	}
	return cpuTimes{
		user:    out[0],
		nice:    out[1],
		system:  out[2],
		idle:    out[3],
		iowait:  out[4],
		irq:     out[5],
		softirq: out[6],
		steal:   out[7],
	}, true
}

// cpuUsagePct 使用率：`(Δtotal − Δidle − Δiowait) / Δtotal × 100`。
//
// 返回 ok=false 表示这一对样本给不出结果（total 没有前进 / 计数器回绕）。
func cpuUsagePct(prev, cur cpuTimes) (float64, bool) {
	pt, ct := prev.total(), cur.total()
	if ct <= pt {
		return 0, false
	}
	dTotal := ct - pt

	// idleAll 单独做减法：uint64 直接相减在计数器回绕时会得到天文数字。
	dIdle := uint64(0)
	if cur.idleAll() >= prev.idleAll() {
		dIdle = cur.idleAll() - prev.idleAll()
	}
	if dIdle > dTotal {
		// 采样错位（先读 idle 后读 user 之类）理论上不该出现，出现就按"全忙"处理更保守。
		dIdle = dTotal
	}

	busy := dTotal - dIdle
	return clampPct(float64(busy) / float64(dTotal) * 100), true
}

// parseLoadAvg 解析 `{root}/loadavg`，返回**恰好 3 个**值。
//
// ⛔ 不足 3 个一律整体丢弃（返回 ok=false）：中心 schema 对 load 是
// `minItems: 3, maxItems: 3`，发 2 个或 4 个都会让**整批**上报 400。
// 宁可这一轮没有 load，也不要为了"有数据"发一个长度不合法的数组。
func parseLoadAvg(content string) ([]float64, bool) {
	fields := strings.Fields(content)
	if len(fields) < 3 {
		return nil, false
	}
	out := make([]float64, 0, 3)
	for i := 0; i < 3; i++ {
		v, ok := atofField(fields, i)
		if !ok {
			return nil, false
		}
		// 中心对 load 是 nonNeg(1e9)：负数或天文数字同样会毁掉整批。
		if v < 0 || v > 1e9 {
			return nil, false
		}
		out = append(out, v)
	}
	return out, true
}
