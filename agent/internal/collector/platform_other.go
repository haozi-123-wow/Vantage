//go:build !linux

package collector

import "errors"

// ⛔ 非 Linux 平台本期**不提供采集**（✅ §13.3：M1–M5 只做 Linux，Windows/macOS 排到 M6）。
//
// 注意这里只关掉两件事：`Supported`（main 据此拒绝启动）与容量查询。
// **采集器本身仍然会被构造出来**（见 collectors.go），这样在任意开发机上都能把
// ProcRoot 指向夹具目录跑真实的 /proc 解析逻辑做单元测试与联调。
//
// 拒绝启动而不是"发一半数据"的理由：中心的 schema 要求每批上报必须带 cpu.usage 与
// mem.total，没有采集器就会每 30 秒发一批必然被 400 的报文，日志里刷满无用错误。
//
// 换成 M6 的活时，只需新增 windows/darwin 的采集器实现并翻转 `Supported`，
// 主干、上报格式与中心侧**零改动**（✅ §17.2）。

// DefaultProcRoot 非 Linux 平台没有 /proc。
const DefaultProcRoot = ""

// Supported 本平台是否支持采集。
const Supported = false

// defaultStatFS 非 Linux 未实现（M6 才需要）。
func defaultStatFS(string) (StatFSResult, error) {
	return StatFSResult{}, errors.New("本平台尚未实现容量查询（Windows/macOS 排在 M6）")
}
