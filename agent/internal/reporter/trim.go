package reporter

import (
	"fmt"

	"vantage-agent/internal/model"
)

// encodeWithinLimit 序列化报文并保证不超过单批上限。
//
// 依据：docs/agent.md §5.3（✅ G2：单批压缩前 256KB 熔断）。
//
// 裁剪顺序是**定死的**，因为它是"丢什么最不心疼"的排序：
//
//	① process.top 截半        —— Top-N 明细本来就只是排障用的，且另有 process_snapshots 承载；
//	② GPU 次要指标（temp/power）—— GPU 的核心是 util 与显存，温度/功耗是锦上添花；
//	③ net.err/drop、disk.latency_ms —— 次要指标，缺几个点不影响容量与可用性判断；
//	④ 仍超限 → **丢弃整批**（不重试）。
//
// ⛔ 第 ④ 步不许改成"随便再丢点什么"：真正会撑到 256KB 的只有异常场景（上千个挂载点、
//
//	进程名畸长），此时继续缝缝补补只会把一份**语义已经不可信**的数据发出去 ——
//	宁可不发。中心侧的上限是压缩前 1MB，出现 413 说明这里的熔断失效了。
//
// ⚠️ 每裁剪一级都要**重新序列化并重新测长**：JSON 的字节数不是线性可估的
//
//	（去掉一个字段可能让整数变成更短的形式，也可能因为逗号位置变化而几乎不变）。
func (r *Reporter) encodeWithinLimit(rep *model.Report) (raw []byte, trims []string, err error) {
	limit := r.cfg.Report.MaxBatchBytes

	raw, err = marshal(rep)
	if err != nil {
		return nil, nil, err
	}
	if len(raw) <= limit {
		return raw, nil, nil
	}

	// ① process.top 截半
	if p := rep.Metrics.Process; p != nil && len(p.Top) > 1 {
		p.Top = p.Top[:len(p.Top)/2]
		trims = append(trims, fmt.Sprintf("process.top 截半至 %d 条", len(p.Top)))
		if raw, err = marshal(rep); err != nil {
			return nil, trims, err
		}
		if len(raw) <= limit {
			return raw, trims, nil
		}
	}

	// ② 丢弃 GPU 次要指标
	droppedGPUSecondary := false
	for i := range rep.Metrics.GPU {
		if rep.Metrics.GPU[i].Temp != nil || rep.Metrics.GPU[i].Power != nil {
			rep.Metrics.GPU[i].Temp = nil
			rep.Metrics.GPU[i].Power = nil
			droppedGPUSecondary = true
		}
	}
	if droppedGPUSecondary {
		trims = append(trims, "丢弃 gpu.temp / gpu.power")
		if raw, err = marshal(rep); err != nil {
			return nil, trims, err
		}
		if len(raw) <= limit {
			return raw, trims, nil
		}
	}

	// ③ 丢弃 net.err/drop 与 disk.latency_ms
	droppedSecondary := false
	for i := range rep.Metrics.Net {
		if rep.Metrics.Net[i].Err != nil || rep.Metrics.Net[i].Drop != nil {
			rep.Metrics.Net[i].Err = nil
			rep.Metrics.Net[i].Drop = nil
			droppedSecondary = true
		}
	}
	for i := range rep.Metrics.Disk {
		if rep.Metrics.Disk[i].LatencyMS != nil {
			rep.Metrics.Disk[i].LatencyMS = nil
			droppedSecondary = true
		}
	}
	if droppedSecondary {
		trims = append(trims, "丢弃 net.err / net.drop / disk.latency_ms")
		if raw, err = marshal(rep); err != nil {
			return nil, trims, err
		}
	}

	// ④ 仍然超限 → 丢弃整批（调用方会记 error 日志，⛔ 不重试）
	if len(raw) > limit {
		return nil, trims, fmt.Errorf(
			"按 §5.3 全部裁剪后仍超限（%d > %d 字节），丢弃该批：请检查过滤规则（挂载点/网卡数量）与 collect.process.top_n",
			len(raw), limit)
	}
	return raw, trims, nil
}
