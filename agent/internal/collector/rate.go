// rate.go 负责"累计计数器 → 速率"的差分（**不带构建标签**）。
//
// 依据：docs/agent.md §3（`net.rx_bps/tx_bps` 注明"速率=差值/时间"）、docs/database.md §5.7.2（单位）。
//
// 职责边界：只做差分与 0 除/回绕保护，不认识任何 /proc 字段。
//
// ⚠️ 三条容易写成故障的细节：
//  1. **必须用真实经过的时间**，⛔ 不能拿配置里的采集周期当分母：周期可以被 SIGHUP 热重载改掉
//    （§7），也可以因为机器卡顿而实际拉长。用配置周期会让 bps 在周期变化的那个点上演一个
//    跳变，而且此后每个点都偏，面板上看起来像"流量突然变了"。
//  2. **第一次采样算不出速率**（没有上一次样本）：此时对应字段留 nil，而不是写 0
//    （写 0 会被当成"采到了，流量是 0"）。
//  3. 计数器**变小**（网卡 down/up、设备热插拔、容器重启）与**时间没有前进**一律
//    返回"给不出速率"：前者会算出负数（中心 `minimum: 0` 拒绝），后者会算出 +Inf（同样拒绝），
//    而中心的拒绝是**整批 400** —— 少一个数据点远比丢一整批便宜。
package collector

import "time"

// clock 采集器读取"现在"的方式。
//
// ✅ 做成注入字段（构造时默认 `time.Now`）而不是直接调 `time.Now()`：速率类指标的期望值
// 完全取决于 Δt，测试必须能把时间钉住，否则断言只能写"不为 nil"——那等于没测。
type clock func() time.Time

// rateTracker 一个累计计数器的差分器（保存上一次样本）。
//
// ⚠️ 只保存**最近一次**样本就够：速率永远是"最近两次之差 / 时间差"，
// 多存历史只会让内存随采集周期数无谓增长（§10 的资源预算）。
type rateTracker struct {
	prev  float64
	at    time.Time
	valid bool
}

// step 记录本次样本并给出与上一次的差值（不做时间归一）。
//
// 返回 ok=false 的三种情况见文件头注释；⚠️ 无论 ok 与否都会把本次样本记下来，
// 这样"某一次时间没前进"不会让后面所有样本都算不出差值。
func (r *rateTracker) step(cur float64, at time.Time) (delta, dt float64, ok bool) {
	prev, prevAt, valid := r.prev, r.at, r.valid
	r.prev, r.at, r.valid = cur, at, true

	if !valid {
		return 0, 0, false
	}
	dt = at.Sub(prevAt).Seconds()
	if dt <= 0 {
		// 时钟没走（同一时刻被采集了两次）/ 时钟回拨：分母为 0 会得到 +Inf/NaN。
		return 0, 0, false
	}
	delta = cur - prev
	if delta < 0 {
		// 计数器回绕（设备重建、网卡 down/up）：负速率会被中心 nonNeg 拒绝。
		return 0, 0, false
	}
	return delta, dt, true
}

// rate 每秒速率（次/s、bytes/s）。
func (r *rateTracker) rate(cur float64, at time.Time) (float64, bool) {
	delta, dt, ok := r.step(cur, at)
	if !ok || dt <= 0 {
		return 0, false
	}
	return delta / dt, true
}

// delta 只取差值（不做时间归一），给"两次计数之比"这类指标用（如磁盘平均延迟）。
func (r *rateTracker) delta(cur float64, at time.Time) (float64, bool) {
	d, _, ok := r.step(cur, at)
	if !ok {
		return 0, false
	}
	return d, true
}

// ratioDelta 两个差值相除（如 Δ耗时/Δ完成次数）。
//
// ⚠️ 分母 ≤ 0 时返回 false：这段时间一次 IO 都没完成（如空闲磁盘），
// "0 次完成耗时 0ms" 除出来的是 NaN，而中心直接拒绝非有限数字。
// 宁可不出这个点，也不要出 NaN。
func ratioDelta(numerator, denominator float64) (float64, bool) {
	if denominator <= 0 {
		return 0, false
	}
	return numerator / denominator, true
}
