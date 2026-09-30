//go:build windows

// errclass_windows.go：classNetErr 用的 syscall 错误码别名（Windows 真值）。
//
// ⚠️ 必须用 WSA_* 的**真实数值**：Windows 上 syscall.ECONNREFUSED 是 Go 内部的
// 伪 errno（APPLICATION_ERROR 段，值 0x20000016），真实拨号错误携带的是
// WSAECONNREFUSED(10061)。实测（go1.25 windows/amd64）：
//
//	dial tcp 127.0.0.1:1 → errno = 10061，errors.Is(err, syscall.ECONNREFUSED) = false
//
// 所以「连接被拒绝」分类必须拿 10061 去比，否则所有 refused 都会被当成含糊的
// 网络错误，面板上的排查提示就废了（Linux 生产路径不受影响，见 errclass_linux.go）。
package prober

import "syscall"

var (
	syscallECONNREFUSED = syscall.Errno(10061) // WSAECONNREFUSED
	syscallENETUNREACH  = syscall.Errno(10051) // WSAENETUNREACH
	syscallEHOSTUNREACH = syscall.Errno(10065) // WSAEHOSTUNREACH
)
