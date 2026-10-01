// cpu_test.go —— CPU 采集器：夹具解析、双采样速率（注入时钟）、降级。
package collector

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"vantage-agent/internal/config"
)

// 首轮采集必然 produced=false：cpu.usage 是差分指标，没有上一份样本就给不出使用率，
// 而 cpu.usage 是中心必填项，⛔ 不能塞 0 冒充（cpu.go 踩坑点 2）。
func TestCPUFirstSampleProducesNothing(t *testing.T) {
	root := copyFixtures(t)
	c := newCPUCollector(testConfig(), root).(*cpuCollector)
	clk := newFakeClock()
	c.now = clk.now

	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || produced {
		t.Fatalf("首轮应 produced=false（got %v, err=%v）", produced, err)
	}
	if s.Metrics.CPU != nil {
		t.Fatalf("首轮不得写 s.Metrics.CPU（got %+v）", s.Metrics.CPU)
	}
}

// 双采样 + 注入时钟：使用率 / 每核 / 负载 / 上下文切换速率全部按"差值 ÷ 真实 Δt"。
// ⚠️ 同时覆盖"周期被改掉"的场景：配置写 60s，真实 Δt 是 30s —— 分母必须是 30s。
func TestCPUTwoSampleRatesWithInjectedClock(t *testing.T) {
	root := copyFixtures(t)
	cfg := testConfig()
	cfg.Collect.CPU.Interval = config.Duration(60 * time.Second) // 模拟 reload 改过周期
	c := newCPUCollector(cfg, root).(*cpuCollector)
	clk := newFakeClock()
	c.now = clk.now
	ctx := context.Background()

	var s Snapshot
	if _, err := c.Collect(ctx, &s); err != nil {
		t.Fatalf("预热轮失败：%v", err)
	}

	overwrite(t, root, "stat", statSecondSample)
	clk.advance(30 * time.Second) // 真实 Δt = 30s ≠ 配置周期 60s
	s = Snapshot{}
	produced, err := c.Collect(ctx, &s)
	if err != nil || !produced {
		t.Fatalf("第二轮应 produced=true（got %v, err=%v）", produced, err)
	}
	cpu := s.Metrics.CPU
	if cpu == nil || cpu.Usage == nil {
		t.Fatal("第二轮必须有 cpu.usage")
	}
	if math.Abs(*cpu.Usage-wantCPUUsagePct) > 1e-9 {
		t.Fatalf("cpu.usage = %v，期望 %v（Δtotal=1680, Δidle=1230）", *cpu.Usage, wantCPUUsagePct)
	}
	// 上下文切换速率：Δ60000 / 30s = 2000 次/s（分母若错拿配置周期 60s 会得到 1000）。
	if cpu.CtxSwitch == nil || *cpu.CtxSwitch != 2000 {
		t.Fatalf("cpu.ctx_switch = %v，期望 2000（Δ60000 ÷ 真实 30s）", cpu.CtxSwitch)
	}
	// 负载恰好 3 个（中心 schema minItems=maxItems=3）。
	if len(cpu.Load) != 3 || cpu.Load[0] != 0.52 || cpu.Load[1] != 0.68 || cpu.Load[2] != 0.71 {
		t.Fatalf("cpu.load = %v，期望 [0.52 0.68 0.71]", cpu.Load)
	}
	// 每核：下标即 core 维度值，两核同比率 26.7857。
	if len(cpu.Cores) != 2 {
		t.Fatalf("cpu.cores 应有 2 项，实际 %v", cpu.Cores)
	}
	for i, v := range cpu.Cores {
		if math.Abs(v-wantCPUUsagePct) > 1e-9 {
			t.Fatalf("cpu.cores[%d] = %v，期望 %v", i, v, wantCPUUsagePct)
		}
	}
}

// 计数器回绕 / 无 tick 前进 → produced=false（本轮放弃而不是发 0 或负数）。
func TestCPUCounterRegressionSkipsRound(t *testing.T) {
	root := copyFixtures(t)
	c := newCPUCollector(testConfig(), root).(*cpuCollector)
	clk := newFakeClock()
	c.now = clk.now
	ctx := context.Background()
	var s Snapshot
	if _, err := c.Collect(ctx, &s); err != nil {
		t.Fatalf("预热轮失败：%v", err)
	}
	// 回绕：所有计数变小（total 9880 → 100）。
	overwrite(t, root, "stat", "cpu  10 10 20 40 10 5 4 1 0 0\nctxt 1\n")
	clk.advance(30 * time.Second)
	produced, err := c.Collect(ctx, &s)
	if err != nil {
		t.Fatalf("回绕轮不应报错：%v", err)
	}
	if produced {
		t.Fatalf("计数器回绕必须 produced=false")
	}

	// 无 tick 前进（同一份文件再采一次，total 不变）。
	overwrite(t, root, "stat", "cpu  1300 100 650 9200 230 30 40 10 0 0\nctxt 260000\n")
	if _, err := c.Collect(ctx, &s); err != nil {
		t.Fatalf("正常轮失败：%v", err)
	}
	clk.advance(30 * time.Second)
	produced, err = c.Collect(ctx, &s)
	if err != nil {
		t.Fatalf("无前进轮不应报错：%v", err)
	}
	if produced {
		t.Fatalf("total 无前进（ct == pt）必须 produced=false")
	}
}

// /proc/stat 缺失 → 优雅降级（produced=false + 不 panic）。
func TestCPUMissingProcStatDegrades(t *testing.T) {
	root := t.TempDir() // 空目录：没有任何 /proc 文件
	c := newCPUCollector(testConfig(), root).(*cpuCollector)
	c.now = newFakeClock().now
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || produced {
		t.Fatalf("缺 /proc/stat 应 produced=false（got %v, err=%v）", produced, err)
	}
}

// parseLoadAvg：不足 3 个 / 非数字 → 整体丢弃（发 2 个会让中心整批 400）。
func TestParseLoadAvgStrict(t *testing.T) {
	if v, ok := parseLoadAvg("0.52 0.68 0.71 2/345 9999"); !ok || len(v) != 3 {
		t.Fatalf("标准 loadavg 应解析出 3 个值，got %v ok=%v", v, ok)
	}
	if _, ok := parseLoadAvg("0.52 0.68"); ok {
		t.Fatal("不足 3 个必须 ok=false")
	}
	if _, ok := parseLoadAvg("a b c"); ok {
		t.Fatal("非数字必须 ok=false")
	}
	if _, ok := parseLoadAvg("-1 -1 -1"); ok {
		t.Fatal("负负载必须 ok=false（中心 nonNeg）")
	}
}

// parseProcStat：guest/guest_nice 不计入 total（4.2+ 内核加列不能把 total 撑大）。
func TestParseProcStatIgnoresGuestFields(t *testing.T) {
	total, cores, coresOK, ctxt, hasCtxt := parseProcStat(statSecondSample)
	// 前 8 个字段和 = 11560；guest 两列都是 0 所以夹具上看不出差别，直接用扩大值验证。
	total2, _, _, _, _ := parseProcStat("cpu  1300 100 650 9200 230 30 40 10 500 700\nctxt 1\n")
	if got := total.total(); got != 11560 {
		t.Fatalf("total = %d，期望 11560（前 8 个字段之和）", got)
	}
	if got := total2.total(); got != 11560 {
		t.Fatalf("guest/guest_nice 不得计入 total：got %d，期望 11560", got)
	}
	if len(cores) != 2 || !coresOK {
		t.Fatalf("cores = %v coresOK=%v，期望 2 核且编号连续", cores, coresOK)
	}
	if !hasCtxt || ctxt != 260000 {
		t.Fatalf("ctxt = %d hasCtxt=%v", ctxt, hasCtxt)
	}
	// 编号空洞 → coresOK=false（下标必须等于 core 维度值）。
	_, cores2, ok2, _, _ := parseProcStat("cpu  1 1 1 1 1 1 1 1\ncpu0 1 1 1 1 1 1 1 1\ncpu2 1 1 1 1 1 1 1 1\n")
	if ok2 || len(cores2) != 2 {
		t.Fatalf("编号空洞应 coresOK=false：cores=%v ok=%v", cores2, ok2)
	}
	// 少于 8 个数字字段 → 解析失败（补 0 会让使用率虚高且无报错）。
	if _, cores3, ok3, _, _ := parseProcStat("cpu  1 1 1 1 1 1 1\ncpu0 1 1 1 1 1 1 1\n"); ok3 && len(cores3) != 0 {
		t.Fatalf("7 字段核行应被整体拒绝")
	}
}

// statfsStubMiss statfsStub 未登记路径时返回的哨兵错误。
var errStatfsStubMiss = errors.New("statfs stub: path not registered")

// clampPct 边界（百分比越界会让中心整批 400，这里钉死夹紧行为）。
func TestClampPctBounds(t *testing.T) {
	cases := []struct{ in, want float64 }{
		{-0.5, 0}, {0, 0}, {26.78, 26.78}, {100, 100}, {100.0000001, 100}, {400, 100},
	}
	for _, c := range cases {
		if got := clampPct(c.in); got != c.want {
			t.Fatalf("clampPct(%v) = %v，期望 %v", c.in, got, c.want)
		}
	}
}
