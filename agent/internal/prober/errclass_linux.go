//go:build linux

// errclass_linux.go：classNetErr 用的 syscall 错误码别名（Linux 真值）。
//
// 为什么单独放一个带构建标签的文件：见 http.go「syscall 错误码的别名」注释 ——
// Windows 上 syscall 包里的 ECONNREFUSED 等是 Go 内部伪 errno（APPLICATION_ERROR 段），
// 真实 socket 错误携带的是 WSA_* 值，直接引用会导致「连接被拒绝」分类永远失配。
package prober

import "syscall"

var (
	syscallECONNREFUSED = syscall.ECONNREFUSED
	syscallENETUNREACH  = syscall.ENETUNREACH
	syscallEHOSTUNREACH = syscall.EHOSTUNREACH
)
