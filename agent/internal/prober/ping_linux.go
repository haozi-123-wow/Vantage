//go:build linux

// 本文件（Linux）：**非特权** ICMP socket 的实现（docs/agent.md §4、§4.4、G8）。
//
// 为什么是 SOCK_DGRAM + IPPROTO_ICMP：
//
//	这是 Linux 特有的 "ping socket"，权限由 net.ipv4.ping_group_range 决定，
//	普通用户即可用 —— 于是 Agent **不需要 root、也不需要 CAP_NET_RAW**（✅ §4.4）。
//	⛔ 不用 SOCK_RAW：那需要 CAP_NET_RAW，等于把「不要求提权」这条硬约束作废。
//	⚠️ 这种 socket 的 identifier 由**内核**改写并于回包时还原，
//	   所以我们的 identifier 只在本进程内有意义（也正因如此才不会与同机其它 ping 进程串包）。
//
// 收包怎么拿到超时（选型说明，⛔ 不要改成裸 Read）：
//
//	syscall 拿到的是裸 fd，**没有 deadline 概念** —— 直接在裸阻塞 fd 上 read 会永久挂住，
//	在探活里等于把这轮探活钉死，进而拖住整批上报。这里用 os.NewFile + net.FilePacketConn
//	把它包成 net.PacketConn：net 的 poller 会给它接上 epoll，于是 SetDeadline 生效、
//	ReadFrom 在到点时返回超时错误（net.Error.Timeout() == true，classNetErr 会翻成"超时"）。
//	✅ 选它而不是 syscall.SetNonblock + select 的理由：手写 select 循环要自己处理 EINTR、
//	   部分读、fd 生命周期与 ctx 取消，而 PacketConn 已经把这几件事做对了。
//	⚠️ socket 必须以 SOCK_NONBLOCK 创建：net.FilePacketConn 会再 dup 一份 fd，
//	   从阻塞 fd dup 出来的 fd 在 Go runtime 的 netpoller 里行为不一致。
//	⚠️ os.NewFile 成功后 fd 的所有权归 *os.File，⛔ 不能再 syscall.Close(fd)。
package prober

import (
	"net"
	"os"
	"syscall"
)

// newICMPSocketPlatform 打开一个非特权 ICMP socket，返回带 deadline 能力的 PacketConn。
func newICMPSocketPlatform() (packetConn, error) {
	// SOCK_DGRAM + IPPROTO_ICMP = Linux 的 ping socket（非特权）。
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM|syscall.SOCK_NONBLOCK|syscall.SOCK_CLOEXEC, ipprotoICMP)
	if err != nil {
		// ⚠️ 典型失败：EPERM/EACCES（ping_group_range 未放开）、EAFNOSUPPORT、
		//    EMFILE（fd 耗尽）。调用方会把它当"ICMP 不可用"并降级为 TCP，⛔ 不崩溃。
		return nil, err
	}

	// ⚠️ NewFile 的 name 只影响错误信息（裸 fd 没有路径），给个可读的名字便于排障。
	f := os.NewFile(uintptr(fd), "icmp-ping-socket")
	if f == nil {
		// fd 无效：必须自己关掉，否则泄漏。
		_ = syscall.Close(fd)
		return nil, syscall.EBADF
	}
	pc, err := net.FilePacketConn(f)
	// ⛔ FilePacketConn 会 dup 一份 fd，所以这里必须关掉 os.File 持有的原件；
	//    漏掉这一步每次探活泄漏一个 fd，最终表现为"所有探活突然全挂"。
	_ = f.Close()
	if err != nil {
		return nil, err
	}
	return pc, nil
}

// mustECAPPlatform 探测本机是否允许非特权 ICMP。
//
// ⚠️ 判据只能是"能不能开 socket"，⛔ 绝不能拿一次 ping 的结果来判断：
// 目标不可达（超时/无应答）与"本机没有 ICMP 权限"是两件事，
// 混起来会让一台权限正常的机器在目标挂掉时错误地永久降级为 TCP。
//
// ⚠️ 这里也**不用** os.Geteuid()==0 之类的判断：本人身份不是判据
// （普通用户也可能被 ping_group_range 放行，root 也可能被容器/安全模块屏蔽 socket）。
func mustECAPPlatform() bool {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM|syscall.SOCK_NONBLOCK|syscall.SOCK_CLOEXEC, ipprotoICMP)
	if err != nil {
		return false
	}
	_ = syscall.Close(fd) // 探测完立刻关：⛔ 不能把 fd 留着
	return true
}
