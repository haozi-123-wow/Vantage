//go:build !linux

// 本文件（非 Linux）：ICMP 探活的占位实现（docs/agent.md §13：Windows / macOS 排在 M6）。
//
// 职责：让 `ping` 类型在这两个平台上**仍然是一个合法的探活**，只是走降级路径。
//
// ⛔ 关键约束（✅ G8）：本文件里没有 ICMP 实现**不是错误**。
//
//	它必须安静地报告"本平台未实现"，由 ping.go 自动降级为 TCP 探测并打 WARN ——
//	如果这里 panic 或者返回一个让调用方无从判断的错误，一台 Windows 机器上
//	只要配了一条 ping 探活，整个 Agent 就会崩或者探活全红。
//
// ⚠️ 为什么不干脆用 `os/exec` 调系统 ping：
//  1. 平台差异太大（Windows 用 `-n` + UTF-16 输出，macOS 用 `-c`），解析输出等于把
//     版本差异引入探活结果；
//  2. 进程启动开销（几十毫秒）会直接进 latency_ms，把探活数字变得不可比；
//  3. 它引入了一个"外部依赖"，与单文件静态二进制的定位冲突。
//     正确做法是 M6 用平台原生 API（Windows：IcmpSendEcho2；macOS：SOCK_DGRAM+IPPROTO_ICMP）。
package prober

import "errors"

// errPingUnsupported 是本平台没有 ICMP 实现时的统一错误。
//
// ⚠️ 必须是普通 error 而不是 panic：调用方（ping.go 的 probeWith → probeViaICMP）
// 会把它翻成"ICMP socket 打开失败：…"并降级为 TCP，探活因此仍然有结果。
var errPingUnsupported = errors.New("本平台未实现 ICMP 探活（M6：Windows / macOS）")

// newICMPSocketPlatform 在非 Linux 平台恒失败（不需要 syscall，故没有构建标签依赖）。
func newICMPSocketPlatform() (packetConn, error) { return nil, errPingUnsupported }

// mustECAPPlatform 在非 Linux 平台恒为 false → Capabilities() 里 probe.ping=false
// → 面板据此提示"本机 ping 探活已降级"，而不是让用户以为目标真的 ping 不通。
func mustECAPPlatform() bool { return false }
