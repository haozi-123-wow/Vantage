// process_test.go —— 进程采集器：/proc 解析（括号 comm）、双采样 CPU%（整机 tick 口径）、Top-N。
package collector

import (
	"context"
	"os"
	"strings"
	"testing"

	"vantage-agent/internal/model"
)

// 夹具进程 tick（utime+stime）：1→15、7→4、42→37、1234→150、5555→60；整机 total=9880。
// 第二轮整机 total=29880（Δ20000），ncpu=2 → cpu% = Δproc / 20000 × 200。
func TestProcessTwoSamplesTopAndCPU(t *testing.T) {
	root := copyFixtures(t)
	cfg := testConfig() // top_n = 10
	c := newProcessCollector(cfg, root).(*processCollector)
	ctx := context.Background()

	var s Snapshot
	produced, err := c.Collect(ctx, &s)
	if err != nil || !produced {
		t.Fatalf("首轮应产出（got %v, err=%v）", produced, err)
	}
	p := s.Metrics.Process
	if p.Count != 5 {
		t.Fatalf("首轮进程数 = %d，期望 5（夹具有 5 个 pid）", p.Count)
	}
	for _, tEntry := range p.Top {
		if tEntry.CPU != nil {
			t.Fatalf("首轮没有上一份样本，cpu 必须留 nil：%+v", tEntry)
		}
	}
	// 首轮全部无 CPU%：Top 按 pid 升序（完全确定的排序）。
	if len(p.Top) != 5 || p.Top[0].Pid != 1 || p.Top[4].Pid != 5555 {
		t.Fatalf("首轮 Top 应按 pid 升序 5 条：%+v", pidsOf(p.Top))
	}
	// mem 来自 statm 第 2 列 × 页大小。
	if got := *p.Top[3].Mem; got != 512*float64(os.Getpagesize()) {
		t.Fatalf("pid1234 mem = %v，期望 512×pageSize=%v", got, 512*float64(os.Getpagesize()))
	}

	// 第二轮：整机与目标进程 tick 前进；pid 5555 消失（采样瞬间退出）。
	overwrite(t, root, "stat", `cpu  3200 100 1600 24400 300 60 100 120 0 0
cpu0 1600 50 800 12200 150 30 50 60 0 0
cpu1 1600 50 800 12200 150 30 50 60 0 0
ctxt 400000
btime 1700000000
`)
	overwrite(t, root, "1/stat", "1 (systemd) S 0 1 1 0 -1 4194560 100 0 0 0 60 55 0 0 20 0 1 0 100 1000 100 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n")
	overwrite(t, root, "42/stat", "42 (a)b c) S 1 42 42 0 -1 4194560 200 0 0 0 425 212 0 0 20 0 1 0 500 2000 50 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n")
	overwrite(t, root, "1234/stat", "1234 (nginx) S 1 1234 1234 0 -1 4194560 300 0 0 0 1300 150 0 0 20 0 1 0 600 3000 120 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n")
	if err := os.RemoveAll(root + "/5555"); err != nil {
		t.Fatalf("删除 pid5555 失败：%v", err)
	}

	s = Snapshot{}
	produced, err = c.Collect(ctx, &s)
	if err != nil || !produced {
		t.Fatalf("第二轮应产出（got %v, err=%v）", produced, err)
	}
	p = s.Metrics.Process
	if p.Count != 4 {
		t.Fatalf("第二轮进程数 = %d，期望 4（5555 已退出）", p.Count)
	}
	// Top 按 CPU 降序：1234(13%) > 42(6%) > 1(1%) > 7(0%)。
	if len(p.Top) != 4 {
		t.Fatalf("Top 应有 4 条：%+v", pidsOf(p.Top))
	}
	want := []struct {
		pid  int
		cpu  float64
		name string
	}{{1234, 13, "nginx"}, {42, 6, "a)b c"}, {1, 1, "systemd"}, {7, 0, "rm -rf /"}}
	for i, w := range want {
		got := p.Top[i]
		if got.Pid != w.pid || got.Name != w.name {
			t.Fatalf("Top[%d] = (%d,%q)，期望 (%d,%q)", i, got.Pid, got.Name, w.pid, w.name)
		}
		if got.CPU == nil || *got.CPU != w.cpu {
			// cpu% = Δticks ÷ Δ整机ticks × ncpu × 100（USER_HZ 约掉）。
			t.Fatalf("Top[%d].cpu = %v，期望 %v", i, got.CPU, w.cpu)
		}
	}
}

func pidsOf(tops []model.ProcessTop) []int {
	out := make([]int, 0, len(tops))
	for _, tEntry := range tops {
		out = append(out, tEntry.Pid)
	}
	return out
}

// top_n = 0：明确不产出 Top（capabilities 也声明 false），count 照常。
func TestProcessTopNZero(t *testing.T) {
	root := copyFixtures(t)
	cfg := testConfig()
	cfg.Collect.Process.TopN = 0
	c := newProcessCollector(cfg, root).(*processCollector)
	var s Snapshot
	produced, _ := c.Collect(context.Background(), &s)
	if !produced {
		t.Fatal("应产出 count")
	}
	if s.Metrics.Process.Top != nil {
		t.Fatalf("top_n=0 时 Top 应为 nil，got %d 条", len(s.Metrics.Process.Top))
	}
	if c.Capabilities()["process.top"] {
		t.Fatal("top_n=0 应声明 process.top=false")
	}
}

// 括号 comm 的字段切分：必须从**最后一个** `)` 之后取字段，否则 utime/stime 整体错位。
func TestParseProcPidStatParens(t *testing.T) {
	comm, utime, stime, ok := parseProcPidStat("42 (a)b c) S 1 42 42 0 -1 4194560 200 0 0 0 25 12 0 0 20 0 1 0 500 2000 50 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0")
	if !ok || comm != "a)b c" || utime != 25 || stime != 12 {
		t.Fatalf("comm=%q utime=%v stime=%v ok=%v，期望 a)b c / 25 / 12", comm, utime, stime, ok)
	}
	comm, utime, stime, ok = parseProcPidStat("7 (rm -rf /) S 1 7 7 0 -1 4194560 80 0 0 0 3 1 0 0 20 0 1 0 50 900 80 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0")
	if !ok || comm != "rm -rf /" || utime != 3 || stime != 1 {
		t.Fatalf("comm=%q utime=%v stime=%v，期望 rm -rf / / 3 / 1", comm, utime, stime)
	}
	if _, _, _, ok := parseProcPidStat("1234 nginx S 1"); ok {
		t.Fatal("无括号的坏行应 ok=false")
	}
}

// sanitizeProcName：非法 UTF-8 丢字节、超长按字符边界截断（坏名字会让中心整批 400）。
func TestSanitizeProcName(t *testing.T) {
	if got := sanitizeProcName("  nginx "); got != "nginx" {
		t.Fatalf("trim 失败：%q", got)
	}
	if got := sanitizeProcName("a\xffb"); got != "ab" {
		t.Fatalf("非法 UTF-8 字节应丢弃：%q", got)
	}
	long := strings.Repeat("中", 130) // 390 字节
	got := sanitizeProcName(long)
	if len(got) > 256 {
		t.Fatalf("超长应截到 ≤256 字节，got %d", len(got))
	}
	// 截断必须落在字符边界：能被完整解码。
	for _, r := range got {
		if r == 0xFFFD {
			t.Fatalf("截断产生了半个多字节字符：%q", got[len(got)-3:])
		}
	}
	if got := sanitizeProcName("   \t\n "); got != "" {
		t.Fatalf("全空白应得空串：%q", got)
	}
}

// parsePID：只认纯数字且 >0。
func TestParsePID(t *testing.T) {
	for _, ok := range []string{"1", "1234", "999999"} {
		if _, valid := parsePID(ok); !valid {
			t.Fatalf("%s 应是合法 pid", ok)
		}
	}
	for _, bad := range []string{"0", "self", "net", "abc", "12x", ""} {
		if _, valid := parsePID(bad); valid {
			t.Fatalf("%q 不应是合法 pid", bad)
		}
	}
}

// 降级：进程目录读不到 → produced=false；collect.process.watch 只打 WARN 不产出指标。
func TestProcessDegradesAndWatchNoop(t *testing.T) {
	c := newProcessCollector(testConfig(), t.TempDir()).(*processCollector)
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || produced {
		t.Fatalf("空 root 应 produced=false（got %v, err=%v）", produced, err)
	}

	root := copyFixtures(t)
	cfg := testConfig()
	cfg.Collect.Process.Watch = []string{"nginx"} // 上报格式暂无承载字段（A-T14）
	c2 := newProcessCollector(cfg, root).(*processCollector)
	s2 := Snapshot{}
	produced, err = c2.Collect(context.Background(), &s2)
	if err != nil || !produced {
		t.Fatalf("配置 watch 不应影响采集（got %v, err=%v）", produced, err)
	}
	if s2.Metrics.Process.Count != 5 {
		t.Fatalf("watch 路径进程数 = %d，期望 5", s2.Metrics.Process.Count)
	}
}
