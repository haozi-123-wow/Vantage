// gpu_test.go —— GPU 采集器：CSV 解析（[N/A]/空值/乱序/重复索引）、优雅降级（注入 exec）。
package collector

import (
	"context"
	"errors"
	"testing"
)

// nvidia-smi 的真实输出形态：[N/A]、空列、[Not Supported]、越界温度、负功耗、乱序、重复索引。
func TestParseSMIOutputRealWorldShapes(t *testing.T) {
	out := parseSMIOutput(`0, 45, 8192, 24576, 67, 120.5
1, [N/A], , 4096, [N/A], [Not Supported]
2, 130, 100, , 999, -5
`)
	if len(out) != 3 {
		t.Fatalf("应解析出 3 块卡，got %d：%+v", len(out), out)
	}
	g0 := out[0]
	if g0.Index != 0 || *g0.Util != 45 || *g0.Temp != 67 {
		t.Fatalf("gpu0 基本字段错误：%+v", g0)
	}
	// mem 单位是 MiB → ×1048576 转 bytes（§5.7.2）。
	if *g0.MemUsed != 8192*1024*1024 || *g0.MemTotal != 24576*1024*1024 {
		t.Fatalf("gpu0 mem 未做 MiB→bytes 换算：%v / %v", *g0.MemUsed, *g0.MemTotal)
	}
	if *g0.Power != 120.5 {
		t.Fatalf("gpu0 power = %v", *g0.Power)
	}
	g1 := out[1]
	if g1.Util != nil || g1.MemUsed != nil || g1.Temp != nil || g1.Power != nil {
		// [N/A] / 空列一律留 nil：⛔ 不能当 0（会画出"功耗突然归零"）。
		t.Fatalf("gpu1 的 [N/A]/空列必须留 nil：%+v", g1)
	}
	if g1.MemTotal == nil || *g1.MemTotal != 4096*1024*1024 {
		t.Fatalf("gpu1 mem_total = %v", g1.MemTotal)
	}
	g2 := out[2]
	// util 越界夹到 0–100（中心 pct 闭区间，越界整批 400）。
	if *g2.Util != 100 {
		t.Fatalf("gpu2 util 应夹到 100，got %v", *g2.Util)
	}
	// 温度越界（999）丢弃而不是夹紧：夹紧会把"字段错位"伪装成合法数据。
	if g2.Temp != nil {
		t.Fatalf("gpu2 温度越界应留 nil，got %v", *g2.Temp)
	}
	// 负功耗按 0（nonNeg）。
	if g2.Power == nil || *g2.Power != 0 {
		t.Fatalf("gpu2 power = %v，期望 0", g2.Power)
	}
}

// 乱序输出必须按 index 升序；重复索引留第一条（覆盖会让"随机留一份数值"）。
func TestParseSMIOutputOrderAndDuplicates(t *testing.T) {
	out := parseSMIOutput(`2, 30, 1000, 2000, 50, 100
0, 45, 8192, 24576, 67, 120.5
0, 99, 1, 1, 1, 1
`)
	if len(out) != 2 {
		t.Fatalf("重复索引应去重到 2 条，got %d", len(out))
	}
	if out[0].Index != 0 || out[1].Index != 2 {
		t.Fatalf("应按 index 升序：[%d, %d]", out[0].Index, out[1].Index)
	}
	if *out[0].Util != 45 {
		t.Fatalf("重复索引应保留第一条，util = %v", *out[0].Util)
	}
}

// 降级：没有 nvidia-smi → produced=false + gpu.nvidia=false（⛔ 不崩溃、不上报 0）。
func TestGPUMissingToolDegrades(t *testing.T) {
	root := copyFixtures(t)
	c := newGPUCollector(testConfig(), root).(*gpuCollector)
	c.lookPath = func(string) (string, error) { return "", errors.New("not found") }
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || produced {
		t.Fatalf("无 nvidia-smi 应 produced=false（got %v, err=%v）", produced, err)
	}
	if s.Metrics.GPU != nil {
		t.Fatalf("produced=false 时不得写 s.Metrics.GPU")
	}
	caps := c.Capabilities()
	if caps["gpu.nvidia"] {
		t.Fatalf("无 nvidia-smi 应声明 gpu.nvidia=false：%v", caps)
	}
	if caps["gpu.amd"] {
		t.Fatal("gpu.amd 本期恒为 false（预留）")
	}
}

// 有命令但没有设备节点（容器常见）：声明 false，不执行命令。
func TestGPUNoDeviceNodesDegrades(t *testing.T) {
	root := copyFixtures(t)
	c := newGPUCollector(testConfig(), root).(*gpuCollector)
	c.lookPath = func(string) (string, error) { return "/usr/bin/nvidia-smi", nil }
	c.nvidiaNodes = func() int { return 0 }
	var s Snapshot
	produced, _ := c.Collect(context.Background(), &s)
	if produced {
		t.Fatal("无设备节点应 produced=false")
	}
	if c.Capabilities()["gpu.nvidia"] {
		t.Fatal("无设备节点应声明 gpu.nvidia=false")
	}
}

// 执行失败：连续 3 次才把 gpu.nvidia 翻成 false（一次超时不应让能力声明抖动）。
func TestGPUFailuresFlipCapabilityWithHysteresis(t *testing.T) {
	root := copyFixtures(t)
	c := newGPUCollector(testConfig(), root).(*gpuCollector)
	c.lookPath = func(string) (string, error) { return "/usr/bin/nvidia-smi", nil }
	c.nvidiaNodes = func() int { return 1 }
	c.run = func(context.Context, string, ...string) ([]byte, error) {
		return nil, errors.New("exit status 6（stderr: NVML错误）")
	}
	ctx := context.Background()
	for i := 1; i <= 2; i++ {
		if produced, _ := c.Collect(ctx, &Snapshot{}); produced {
			t.Fatalf("第 %d 次失败不应产出", i)
		}
		if !c.available {
			t.Fatalf("第 %d 次失败还不得翻转能力（迟滞）", i)
		}
	}
	if produced, _ := c.Collect(ctx, &Snapshot{}); produced {
		t.Fatal("第 3 次失败不应产出")
	}
	if c.Capabilities()["gpu.nvidia"] {
		t.Fatal("连续 3 次失败后应声明 gpu.nvidia=false（capabilities 变化会触发 host 重报）")
	}
}

// 正常路径：注入的 run 返回 CSV → produced=true 且解析结果进 snapshot。
func TestGPUSuccessPath(t *testing.T) {
	root := copyFixtures(t)
	c := newGPUCollector(testConfig(), root).(*gpuCollector)
	c.lookPath = func(string) (string, error) { return "/usr/bin/nvidia-smi", nil }
	c.nvidiaNodes = func() int { return 2 }
	c.run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "/usr/bin/nvidia-smi" {
			t.Fatalf("应执行注入路径，got %q", name)
		}
		// 参数契约：--query-gpu 的字段顺序与解析下标一一对应。
		if len(args) != 2 || args[1] != "--format=csv,noheader,nounits" {
			t.Fatalf("nvidia-smi 参数错误：%v", args)
		}
		return []byte("0, 45, 8192, 24576, 67, 120.5\n1, 60, 2048, 8192, 55, 250\n"), nil
	}
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || !produced {
		t.Fatalf("应产出（got %v, err=%v）", produced, err)
	}
	if len(s.Metrics.GPU) != 2 || s.Metrics.GPU[1].Index != 1 {
		t.Fatalf("GPU 解析结果错误：%+v", s.Metrics.GPU)
	}
	if !c.Capabilities()["gpu.nvidia"] {
		t.Fatal("成功执行后应声明 gpu.nvidia=true")
	}
}
