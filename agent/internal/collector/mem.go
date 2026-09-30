// mem.go 实现内存与 Swap 采集器。
//
// 依据：docs/agent.md §3（mem 行）、docs/database.md §5.7.2（`mem.*` / `swap.*` 单位 bytes）。
//
// 数据源：`{root}/meminfo`（⚠️ 单位是 **kB**，一律 ×1024 转 bytes）。
//
// 产出：`Mem.Total`（必填）、`Used`、`Available`、`Cached`、`Buffers`、`Mem.Swap{Total,Used}`。
//
// ⛔ 本采集器**不产出** `mem.used_pct` / `swap.used_pct`：中心 `flattenMetrics` 会用同一批的
// 分子分母就地派生（server/src/services/metrics.service.js 的 derivedPct），那边还做了
// [0,100] 夹紧与"分母为 0 就不产出"的处理。Agent 再算一份必然与中心出现漂移
// （两处采样时刻不同、换算精度不同），而漂移在面板上表现为"两个百分比对不上"，极难排查。
//
// ⚠️ 两个踩坑点：
//  1. `Used = Total − Available`。⛔ 不要用 Total−Free：Free 不含可回收的页缓存，
//     会把"几乎全空"的机器报成 95% 占用。/proc/meminfo 的 MemAvailable 是内核
//     按"可回收性"估算出来的，3.14+ 才有（更老的内核退回 Total−Free−Cached−Buffers）。
//  2. 所有值都可能**缺**（老内核、容器里裁剪过的 meminfo）：缺哪个就留 nil，
//     但 Total 缺了整段就没意义（中心必填）→ 返回 produced=false。
package collector

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
)

// meminfoKeys 我们关心的键（其余键（如 HugePages_*）不读：读了也不上报，白花解析时间）。
var meminfoKeys = map[string]bool{
	"MemTotal":      true,
	"MemFree":       true,
	"MemAvailable":  true,
	"Cached":        true,
	"Buffers":       true,
	"SwapTotal":     true,
	"SwapFree":      true,
}

// memCollector 内存采集器。
type memCollector struct {
	cfg  *config.Config
	root string
	log  *slog.Logger

	warnMeminfo warnOnce
}

// newMemCollector 构造内存采集器（签名由 platform_linux.go 钉死）。
func newMemCollector(cfg *config.Config, root string) Collector {
	return &memCollector{cfg: cfg, root: root, log: slog.Default()}
}

func (c *memCollector) Name() string { return "mem" }

func (c *memCollector) Interval() time.Duration { return c.cfg.Collect.Mem.Interval.Std() }

// Collect 采集一次。⛔ produced=false 时保持 s.Metrics.Mem 原样。
func (c *memCollector) Collect(_ context.Context, s *Snapshot) (bool, error) {
	content, err := readFileTrimmed(c.root, "meminfo")
	if err != nil {
		c.warnMeminfo.warn(c.log, "读不到 /proc/meminfo，本轮跳过内存采集",
			"path", procPath(c.root, "meminfo"), "err", err)
		return false, nil
	}

	kv := parseMemInfo(content)

	total, hasTotal := kv["MemTotal"]
	if !hasTotal {
		c.warnMeminfo.warn(c.log, "解析 /proc/meminfo 失败（缺 MemTotal），本轮跳过内存采集",
			"path", procPath(c.root, "meminfo"))
		return false, nil
	}

	mem := &model.Mem{Total: f64(total)}

	available, hasAvailable := kv["MemAvailable"]
	if hasAvailable {
		// ✅ 主口径（3.14+）：MemAvailable 已经扣掉了"不可回收"的部分。
		mem.Available = f64(available)
		mem.Used = f64(nonNeg(total - available))
	} else {
		// ⚠️ 老内核（< 3.14）没有 MemAvailable，退化为 Total−Free−Cached−Buffers。
		//    这个口径偏保守（把部分可回收缓存算成"已用"），但比 Total−Free 准得多。
		//    缺 Cached/Buffers 时按 0 计：只有在老内核上才会走到这里，而那两个键
		//    自 2.6 起就一直在，真缺了也只是 Used 偏大一点，不会变成非法值。
		if free, ok := kv["MemFree"]; ok {
			used := total - free - kv["Cached"] - kv["Buffers"]
			mem.Used = f64(nonNeg(used))
		}
	}
	if v, ok := kv["Cached"]; ok {
		mem.Cached = f64(v)
	}
	if v, ok := kv["Buffers"]; ok {
		mem.Buffers = f64(v)
	}

	// Swap：内核没有配置 swap 时 SwapTotal 就是 0，那是**采到了 0**，如实上报。
	// ⚠️ 中心对 swap.used_pct 会做分母为 0 的保护（derivedPct 里 denominator<=0 直接不产出），
	//    所以这里发 0 不会产生 NaN/Inf。
	if swapTotal, ok := kv["SwapTotal"]; ok {
		swap := &model.Swap{Total: f64(swapTotal)}
		if swapFree, ok := kv["SwapFree"]; ok {
			swap.Used = f64(nonNeg(swapTotal - swapFree))
		}
		mem.Swap = swap
	}

	s.Metrics.Mem = mem
	return true, nil
}

// parseMemInfo 解析 `{root}/meminfo`，把关心的键换算成 **bytes**。
//
// ⚠️ 单位处理：/proc/meminfo 的这几个键单位是 kB（**1024 字节**，不是 1000）。
//    漏掉 ×1024 的后果是面板上的内存永远显示成"只用了 1/1024"，且不会有任何报错。
//    单位字段缺失时按 kB 处理（这些键自 2.6 起一直带 kB）；单位是别的（异常输出）
//    则**跳过该键**（当作没采到），而不是猜一个换算系数。
func parseMemInfo(content string) map[string]float64 {
	out := make(map[string]float64, len(meminfoKeys))
	for _, line := range splitLines(content) {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		if !meminfoKeys[key] {
			continue
		}
		raw, ok := atofField(fields, 1)
		if !ok || raw < 0 {
			continue
		}
		if len(fields) >= 3 && fields[2] != "kB" {
			continue
		}
		out[key] = raw * 1024
	}
	return out
}
