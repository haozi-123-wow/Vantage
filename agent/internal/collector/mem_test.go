// mem_test.go —— 内存采集器：kB→bytes 换算、Used 口径、老内核回退、单位守卫、降级。
package collector

import (
	"context"
	"testing"
)

const (
	kb = 1024 // /proc/meminfo 的单位是 kB（1024 字节，不是 1000）
)

// 夹具：MemTotal=16000000 kB，MemAvailable=8000000 kB，Buffers=300000 kB，Cached=5000000 kB，
// SwapTotal=4000000 kB，SwapFree=3000000 kB。
func TestMemCollectorFixtureValues(t *testing.T) {
	root := copyFixtures(t)
	c := newMemCollector(testConfig(), root).(*memCollector)
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || !produced {
		t.Fatalf("应 produced=true（got %v, err=%v）", produced, err)
	}
	m := s.Metrics.Mem
	if m == nil || m.Total == nil {
		t.Fatal("必须有 mem.total（中心必填）")
	}
	if *m.Total != 16000000*kb {
		t.Fatalf("mem.total = %v，期望 %v（漏乘 1024 是经典错误）", *m.Total, 16000000*kb)
	}
	// 主口径：Used = Total − Available（不是 Total − Free）。
	if *m.Used != 8000000*kb {
		t.Fatalf("mem.used = %v，期望 %v（Total−Available）", *m.Used, 8000000*kb)
	}
	if *m.Available != 8000000*kb {
		t.Fatalf("mem.available = %v", *m.Available)
	}
	if *m.Cached != 5000000*kb || *m.Buffers != 300000*kb {
		t.Fatalf("cached/buffers = %v / %v", *m.Cached, *m.Buffers)
	}
	// Swap：无 swap 的机器 SwapTotal=0 是"采到了 0"，照常上报。
	if m.Swap == nil || m.Swap.Total == nil || *m.Swap.Total != 4000000*kb {
		t.Fatalf("swap.total = %+v", m.Swap)
	}
	if *m.Swap.Used != 1000000*kb {
		t.Fatalf("swap.used = %v，期望 %v（Total−Free）", *m.Swap.Used, 1000000*kb)
	}
}

// 老内核（< 3.14，无 MemAvailable）：Used 回退为 Total−Free−Cached−Buffers。
func TestMemCollectorLegacyKernelFallback(t *testing.T) {
	root := copyFixtures(t)
	overwrite(t, root, "meminfo", `MemTotal:       16000000 kB
MemFree:         2000000 kB
Buffers:          300000 kB
Cached:          5000000 kB
SwapTotal:             0 kB
SwapFree:              0 kB
`)
	c := newMemCollector(testConfig(), root).(*memCollector)
	var s Snapshot
	produced, _ := c.Collect(context.Background(), &s)
	if !produced {
		t.Fatal("老内核格式也应产出")
	}
	m := s.Metrics.Mem
	// 16000000 − 2000000 − 5000000 − 300000 = 8700000 kB。
	if m.Used == nil || *m.Used != 8700000*kb {
		t.Fatalf("老内核 Used = %v，期望 %v", m.Used, 8700000*kb)
	}
	if m.Available != nil {
		t.Fatalf("无 MemAvailable 时 available 必须留 nil，got %v", *m.Available)
	}
}

// 单位守卫：单位不是 kB 的键按"没采到"跳过；MemTotal 缺失 → produced=false（⛔ 不猜换算系数）。
func TestMemCollectorRejectsUnknownUnit(t *testing.T) {
	root := copyFixtures(t)
	overwrite(t, root, "meminfo", "MemTotal:       16000000 MB\nMemFree:         2000000 kB\n")
	c := newMemCollector(testConfig(), root).(*memCollector)
	var s Snapshot
	produced, _ := c.Collect(context.Background(), &s)
	if produced {
		t.Fatal("MemTotal 单位异常时必须 produced=false（写 0 或猜单位都是伪造数据）")
	}
	if s.Metrics.Mem != nil {
		t.Fatalf("produced=false 时不得写 s.Metrics.Mem")
	}
}

// SwapTotal 存在但 SwapFree 缺失：swap.used 留 nil，swap.total 照常。
func TestMemCollectorSwapFreeMissing(t *testing.T) {
	root := copyFixtures(t)
	overwrite(t, root, "meminfo", `MemTotal:       16000000 kB
MemAvailable:    8000000 kB
SwapTotal:       4000000 kB
`)
	c := newMemCollector(testConfig(), root).(*memCollector)
	var s Snapshot
	produced, _ := c.Collect(context.Background(), &s)
	if !produced {
		t.Fatal("主键齐全应产出")
	}
	if s.Metrics.Mem.Swap == nil || s.Metrics.Mem.Swap.Total == nil {
		t.Fatal("swap.total 应存在")
	}
	if s.Metrics.Mem.Swap.Used != nil {
		t.Fatalf("SwapFree 缺失时 swap.used 必须留 nil，got %v", *s.Metrics.Mem.Swap.Used)
	}
}

// /proc/meminfo 读不到 → 优雅降级。
func TestMemCollectorMissingFileDegrades(t *testing.T) {
	c := newMemCollector(testConfig(), t.TempDir()).(*memCollector)
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || produced {
		t.Fatalf("缺 meminfo 应 produced=false（got %v, err=%v）", produced, err)
	}
}
