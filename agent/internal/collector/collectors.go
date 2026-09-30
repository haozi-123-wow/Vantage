package collector

// 本文件**不带构建标签**：采集器集合的组装逻辑在所有平台上都编译。
//
// ⚠️ 这一点很关键。曾经把 newPlatformCollectors 放在 platform_linux.go 里（带
// `//go:build linux`），后果是：在非 Linux 开发机上即使把 ProcRoot 指向夹具目录，
// 也**拿不到任何采集器** —— 于是"用夹具目录验证 /proc 解析"这个设计意图被静默废掉了。
//
// 现在只有两件事是平台相关的，它们放在 platform_*.go 里：
//   - `DefaultProcRoot` / `Supported`（/proc 在哪、本平台是否被支持）；
//   - `defaultStatFS`（磁盘容量是全套采集里唯一绕不开平台 API 的地方，必须真的 statfs(2)）。
//
// 采集器本身只读注入目录里的文本，因此**任何平台**都能用夹具跑它们。

// newPlatformCollectors 按配置组装采集器集合。
//
// ⛔ 顺序固定（cpu → mem → disk → net → gpu → process）：日志、测试断言与
// 「本周期有没有新数据」的判断都依赖它稳定。
//
// 这里只按 `enabled` 决定**是否创建**；采集时是否真有数据由各采集器自己判断
//（例如没有 nvidia-smi 时 GPU 采集器依然存在，但会优雅降级并声明 gpu.nvidia=false）。
func newPlatformCollectors(opts BuildOptions) []Collector {
	cfg := opts.Config
	root := opts.ProcRoot
	if root == "" {
		root = DefaultProcRoot
	}
	statfs := opts.StatFS
	if statfs == nil {
		statfs = defaultStatFS
	}

	out := make([]Collector, 0, 6)
	if cfg.Collect.CPU.Enabled {
		out = append(out, newCPUCollector(cfg, root))
	}
	if cfg.Collect.Mem.Enabled {
		out = append(out, newMemCollector(cfg, root))
	}
	if cfg.Collect.Disk.Enabled {
		out = append(out, newDiskCollector(cfg, root, statfs))
	}
	if cfg.Collect.Net.Enabled {
		out = append(out, newNetCollector(cfg, root))
	}
	if cfg.Collect.GPU.Enabled {
		out = append(out, newGPUCollector(cfg, root))
	}
	if cfg.Collect.Process.Enabled {
		out = append(out, newProcessCollector(cfg, root))
	}
	return out
}
