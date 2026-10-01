// collector_test.go —— 采集器单元测试的公共辅助。
//
// 设计要点（与 docs/agent-todo.md A-T06 的验收标准对应）：
//   - 所有用例跑在 `testdata/proc` 夹具的**临时副本**上：用例之间互不污染，
//     且可以在采集轮次之间改写夹具文件来模拟"下一个周期 /proc 变了"；
//   - 速率类指标一律**注入时钟**（各采集器的 `now` 字段），断言"差值 ÷ 真实经过时间"，
//     ⛔ 不真 sleep，⛔ 不拿配置周期当分母（rate.go 第 1 条踩坑）；
//   - 优雅降级路径（缺文件、缺工具、statfs 失败）都有专属用例。
package collector

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"vantage-agent/internal/config"
)

// copyFixtures 把 testdata/proc 复制到临时目录并返回 ProcRoot。
func copyFixtures(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "proc")
	src := filepath.Join("testdata", "proc")
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(src, path)
		if relErr != nil {
			return relErr
		}
		dst := filepath.Join(root, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, b, 0o644)
	})
	if err != nil {
		t.Fatalf("复制夹具失败：%v", err)
	}
	return root
}

// overwrite 在夹具副本里改写一个文件（rel 用 `/` 分隔，与 /proc 一致）。
func overwrite(t *testing.T, root, rel, content string) {
	t.Helper()
	dst := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.WriteFile(dst, []byte(content), 0o644); err != nil {
		t.Fatalf("改写夹具 %s 失败：%v", rel, err)
	}
}

// removeFixture 删除夹具副本里的一个文件（模拟"权限收紧 / 文件消失"）。
func removeFixture(t *testing.T, root, rel string) {
	t.Helper()
	if err := os.Remove(filepath.Join(root, filepath.FromSlash(rel))); err != nil && !os.IsNotExist(err) {
		t.Fatalf("删除夹具 %s 失败：%v", rel, err)
	}
}

// fakeClock 可注入的时钟：速率断言的前提是 Δt 完全可控。
type fakeClock struct{ t time.Time }

func newFakeClock() *fakeClock { return &fakeClock{t: time.Unix(1_700_000_000, 0)} }

func (f *fakeClock) now() time.Time { return f.t }

func (f *fakeClock) advance(d time.Duration) { f.t = f.t.Add(d) }

// testConfig 构造一个"全开、30s 周期"的配置（不经过 yaml，直接构造结构体）。
func testConfig() *config.Config {
	cfg := &config.Config{}
	d := config.Duration(30 * time.Second)
	cfg.Collect.CPU.Enabled, cfg.Collect.CPU.Interval, cfg.Collect.CPU.PerCore = true, d, true
	cfg.Collect.Mem.Enabled, cfg.Collect.Mem.Interval = true, d
	cfg.Collect.Disk.Enabled, cfg.Collect.Disk.Interval = true, d
	cfg.Collect.Net.Enabled, cfg.Collect.Net.Interval = true, d
	cfg.Collect.GPU.Enabled, cfg.Collect.GPU.Interval = true, d
	cfg.Collect.Process.Enabled, cfg.Collect.Process.Interval, cfg.Collect.Process.TopN = true, d, 10
	cfg.Report.Interval = d
	return cfg
}

// statfsStub 按 mount 精确匹配的 statfs 注入实现（未登记的路径返回错误，
// 用于覆盖"网络盘挂住 → 跳过该挂载点"的降级路径）。
func statfsStub(entries map[string]StatFSResult) StatFSSource {
	return func(path string) (StatFSResult, error) {
		if st, ok := entries[path]; ok {
			return st, nil
		}
		return StatFSResult{}, errStatfsStubMiss
	}
}

// secondSampleOfStat 机器层面第二个 /proc/stat 采样：
// total 9880 → 11560（Δ1680），ctxt 200000 → 260000（Δ60000），每核 4940 → 5780。
// 使用率 = (1680 − 1230) / 1680 × 100 = 26.785714…%（idle Δ = 1230）。
const statSecondSample = `cpu  1300 100 650 9200 230 30 40 10 0 0
cpu0 650 50 325 4600 115 15 20 5 0 0
cpu1 650 50 325 4600 115 15 20 5 0 0
intr 123456 1 2 3
ctxt 260000
btime 1700000000
processes 4321
procs_running 2
procs_blocked 0
softirq 1000 0 0
`

// wantCPUUsagePct 两次采样推出的使用率（450/1680×100）。
const wantCPUUsagePct = 26.785714285714285
