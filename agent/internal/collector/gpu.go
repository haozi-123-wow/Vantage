// gpu.go 实现 GPU 采集器（本机只做 NVIDIA；AMD/rocm-smi 为预留，✅ §13.3）。
//
// 依据：docs/agent.md §3（gpu 行：`nvidia-smi --query-gpu … --format=csv`）、
// docs/database.md §5.7.2（`gpu.util` %、`gpu.mem_used|mem_total` bytes、`gpu.temp` ℃、`gpu.power` W，
// 维度 `{index}`）、docs/api.md §2.1（`host.capabilities` 的 `gpu.nvidia` / `gpu.amd`）。
//
// 职责边界：只写 `s.Metrics.GPU`。⛔ 没有卡、没有 nvidia-smi、命令失败/超时一律**优雅降级**：
// produced=false + 一次 WARN + `gpu.nvidia=false`，绝不 panic、绝不上报 0 冒充"采到了"。
//
// ⚠️ 四个踩坑点：
//  1. **异步可达的卡不在任何文件里**：GPU 指标只能靠外部命令拿，所以它是全套采集里唯一
//     会"卡住"的一环 → 必须用 `exec.CommandContext` + **3s 超时**。
//     没有超时的后果不是采集变慢，而是整个上报管线被一个坏掉的驱动拖住（连带 CPU/内存都不上报）。
//  2. nvidia-smi 的输出里 `[N/A]`、`[Not Supported]`、空值是**常态**（虚拟 GPU、MIG、
//     老卡没有功耗读数）：这些一律留 nil，⛔ 不能当 0 —— 0 会在图表上画出"功耗突然归零"。
//  3. `memory.used/total` 的单位是 **MiB**（不是 MB、更不是 bytes），×1048576 才是 bytes（§5.7.2）。
//  4. `gpu.util` 是 0–100 的百分比、`temp` 允许 −100..300、`power` 非负：中心的这些范围是硬约束，
//     越界会让**整批**上报 400，所以产出前逐项夹紧/丢弃（宁可少一个字段）。
package collector

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
)

// smiTimeout nvidia-smi 的硬超时（3s）。
//
// ⚠️ 正常执行只要几十毫秒；3s 是给"驱动本身出问题"留的上限。
// 超时后本轮直接放弃 GPU（下一次周期再试），⛔ 不等待、不重试 —— 上报管线不能被它拖住。
const smiTimeout = 3 * time.Second

// smiFields nvidia-smi 查询的字段顺序。
//
// ⛔ 必须与 parseSMIOutput 里的下标一一对应：这是"命令行"与"解析"之间唯一的契约，
// 两边顺序不一致会得到"索引当温度"这种完全错乱但看起来正常的输出。
var smiFields = []string{
	"index",
	"utilization.gpu",
	"memory.used",
	"memory.total",
	"temperature.gpu",
	"power.draw",
}

// smiFailuresBeforeUnavailable 连续失败多少次才把 `gpu.nvidia` 声明为 false。
//
// ⚠️ 要有迟滞：一次超时（机器卡顿、驱动瞬时忙）不该让能力声明翻来翻去。
// capabilities 变化会让 Agent 重新上报 host（✅ §2.1），频繁抖动等于凭空多出上报量。
const smiFailuresBeforeUnavailable = 3

// mibToBytes MiB → bytes（§5.7.2 要求 bytes）。
const mibToBytes = 1024 * 1024

// gpuCollector GPU 采集器。
type gpuCollector struct {
	cfg *config.Config
	// root 由构造签名给定（platform_linux.go 钉死）。本采集器不读 /proc：
	// NVIDIA 的指标只能靠 nvidia-smi 拿，`/proc/driver/nvidia/version` 在容器里常是宿主那一份
	//（有版本文件却没有设备节点），用它判"有没有卡"会误报。保留字段是为了与其它采集器
	// 保持同一构造形状，也便于将来接 rocm-smi 的文件型数据源。
	root string
	log  *slog.Logger

	// 注入点（默认是真实实现）：测试要覆盖"没有 nvidia-smi""命令失败"这些路径，
	// 不可能真的去装/卸一张卡。
	lookPath    func(string) (string, error)
	nvidiaNodes func() int
	run         func(ctx context.Context, name string, args ...string) ([]byte, error)

	bin       string
	probed    bool
	available bool
	failures  int

	warnExec warnOnce
	warnCaps warnOnce
}

// newGPUCollector 构造 GPU 采集器（签名由 platform_linux.go 钉死）。
func newGPUCollector(cfg *config.Config, root string) Collector {
	return &gpuCollector{
		cfg:         cfg,
		root:        root,
		log:         slog.Default(),
		lookPath:    exec.LookPath,
		nvidiaNodes: countNvidiaNodes,
		run:         runSMI,
	}
}

func (c *gpuCollector) Name() string { return "gpu" }

func (c *gpuCollector) Interval() time.Duration { return c.cfg.Collect.GPU.Interval.Std() }

// Capabilities 声明 GPU 能力。
//
// ⚠️ 这个接口会在第一次 Collect **之前**被调用（首报要带 host.capabilities），
// 所以这里做一次静态探测（nvidia-smi 在不在 PATH、有没有 /dev/nvidiaN 设备节点），
// 此后以真实执行结果为准。`gpu.amd` 恒为 false：本期是预留（config 接受 provider=amd 但不实现），
// 明确声明"没有这项能力"比不声明更能让面板做出正确的展示决策。
func (c *gpuCollector) Capabilities() map[string]bool {
	c.probe()
	return map[string]bool{
		"gpu.nvidia": c.available,
		"gpu.amd":    false,
	}
}

// probe 静态探测：命令存在 + 真的有设备节点。
//
// ⚠️ 只看命令存在是不够的：容器里常见"装了 nvidia-smi 但没有 GPU 直通"，
// 此时命令能跑、输出为空，声明有能力会让面板挂一个永远为空的图表
//（capabilityWhitelist 的注释里提到的正是这种"宁可少显示一个图表"的取舍）。
func (c *gpuCollector) probe() {
	if c.probed {
		return
	}
	c.probed = true

	bin, err := c.lookPath("nvidia-smi")
	if err != nil || bin == "" {
		c.available = false
		return
	}
	c.bin = bin
	if c.nvidiaNodes() == 0 {
		c.available = false
		return
	}
	c.available = true
}

// countNvidiaNodes 数 /dev/nvidiaN 设备节点。
//
// ⚠️ 之所以不读 /proc/driver/nvidia/version：容器里 /proc 常是宿主的那一份，
// 而设备节点一定在容器的 /dev 里（直通是挂 /dev/nvidia* 进去的）。
func countNvidiaNodes() int {
	n := 0
	for i := 0; i < model.MaxGPUs; i++ {
		if _, err := os.Stat("/dev/nvidia" + strconv.Itoa(i)); err == nil {
			n++
		}
	}
	return n
}

// Collect 采集一次。⛔ produced=false 时保持 s.Metrics.GPU 原样。
func (c *gpuCollector) Collect(ctx context.Context, s *Snapshot) (bool, error) {
	c.probe()
	if !c.available || c.bin == "" {
		// 没有卡/没有工具：能力已经声明 false，这里保持沉默（每个周期打一条 WARN 没有意义）。
		return false, nil
	}

	if ctx == nil {
		// 防御：Collect 的 ctx 由调度器给，但 nil ctx 会让 CommandContext panic，
		// 而"采集器 panic"会带走整个 Agent（⛔ 铁律：绝不 panic）。
		ctx = context.Background()
	}
	runCtx, cancel := context.WithTimeout(ctx, smiTimeout)
	defer cancel()

	args := []string{
		"--query-gpu=" + strings.Join(smiFields, ","),
		"--format=csv,noheader,nounits",
	}
	out, err := c.run(runCtx, c.bin, args...)
	if err != nil {
		c.failures++
		c.warnExec.warn(c.log, "nvidia-smi 执行失败，本轮不产出 GPU 指标（下个周期再试）",
			"bin", c.bin, "timeout", smiTimeout, "err", err)
		if c.failures >= smiFailuresBeforeUnavailable {
			c.available = false
			c.warnCaps.warn(c.log, "nvidia-smi 连续失败，已把 gpu.nvidia 声明为 false",
				"failures", c.failures)
		}
		return false, nil
	}
	c.failures = 0
	c.available = true

	gpus := parseSMIOutput(string(out))
	if len(gpus) == 0 {
		// 命令成功但一行有效数据都没有（卡被独占/MIG 未配置）：本轮没有新数据。
		return false, nil
	}
	s.Metrics.GPU = gpus
	return true, nil
}

// runSMI 执行 nvidia-smi 并返回 stdout。
//
// ⚠️ stderr 单独收：驱动报错信息（`Failed to initialize NVML: …`）只有 stderr 里有，
// 把它丢进 stdout 会污染 CSV 解析，而完全不收又会让日志里只剩一句"exit status 1"。
func runSMI(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("%w（stderr: %s）", err, truncateForLog(detail, 256))
	}
	return stdout.Bytes(), nil
}

// truncateForLog 日志里不放大段文本（驱动偶尔会吐几百行）。
func truncateForLog(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// parseSMIOutput 解析 nvidia-smi 的 CSV 输出。
//
// ✅ 纯函数（输入 stdout 文本、输出模型条目）：`[N/A]`、空值、多余空白、索引乱序、
// 行数不足这些真实输出形态都只能靠**夹具文本**覆盖，不可能要求测试机有这么一块卡。
//
// 字段顺序与 smiFields 一致：index, util, mem_used, mem_total, temp, power。
// 单位：mem_* 是 MiB（×1048576 → bytes）、util 是 %、temp 是 ℃、power 是 W。
func parseSMIOutput(stdout string) []model.GPU {
	var out []model.GPU
	used := map[int]bool{}

	for _, line := range splitLines(stdout) {
		cols := strings.Split(line, ",")
		for i := range cols {
			cols[i] = strings.TrimSpace(cols[i])
		}
		if len(cols) == 0 || cols[0] == "" {
			continue
		}
		// index 是 gpu[] 的必填项（中心 schema required + 唯一）：解析不出来就整行丢掉。
		idx, err := strconv.Atoi(cols[0])
		if err != nil || idx < 0 || idx > 1024 {
			continue
		}
		if used[idx] {
			// ⚠️ 索引重复会让中心以"批内重复序列"拒绝**整批**：
			// 留第一条而不是覆盖（覆盖会变成"随机留一份数值"，排查时完全看不出）。
			continue
		}
		used[idx] = true

		gpu := model.GPU{Index: idx}
		if v, ok := smiValue(cols, 1); ok {
			// util 是百分比：夹到 0–100（中心 pct 是闭区间，越界 → 整批 400）。
			gpu.Util = f64(clampPct(v))
		}
		if v, ok := smiValue(cols, 2); ok {
			gpu.MemUsed = f64(nonNeg(v) * mibToBytes)
		}
		if v, ok := smiValue(cols, 3); ok {
			gpu.MemTotal = f64(nonNeg(v) * mibToBytes)
		}
		if v, ok := smiValue(cols, 4); ok && v >= -100 && v <= 300 {
			// 超出 −100..300 的值一律丢弃而不是夹紧：温度超出这个范围说明解析出了问题
			//（比如字段错位），夹紧会把错误数据伪装成合法数据。
			gpu.Temp = f64(v)
		}
		if v, ok := smiValue(cols, 5); ok {
			gpu.Power = f64(nonNeg(v))
		}
		out = append(out, gpu)
	}

	// 按 index 升序输出：nvidia-smi 一般已经有序，但不保证（多卡/热插拔），
	// 而"同一份输入产出同一份输出"是测试不抖的前提。
	sort.Slice(out, func(i, j int) bool { return out[i].Index < out[j].Index })

	if len(out) > model.MaxGPUs {
		// 中心 gpu[] 上限 16：超了整批 400，宁可丢掉多余条目。
		out = out[:model.MaxGPUs]
	}
	return out
}

// smiValue 取第 i 列并转成数值。
//
// ⚠️ `[N/A]`（虚拟 GPU / MIG / 老卡没有功耗读数）与空值都是**常态**，
// 一律返回 ok=false →对应字段留 nil。⛔ 不要当 0：0 会在图表上画出"功耗突然归零"，
// 而且中心会把 0 当成真实的最小值永远留在聚合里。
func smiValue(cols []string, i int) (float64, bool) {
	if i < 0 || i >= len(cols) {
		return 0, false
	}
	s := cols[i]
	switch {
	case s == "":
		return 0, false
	case strings.HasPrefix(s, "["): // [N/A]、[Not Supported]、[Unknown Error]
		return 0, false
	case strings.EqualFold(s, "N/A"), strings.EqualFold(s, "nan"):
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}
