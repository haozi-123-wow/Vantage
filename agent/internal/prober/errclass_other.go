//go:build !linux && !windows

// errclass_other.go：其余 unix 类平台（darwin 等，本期不支持但保持可编译）。
// syscall.ECONNREFUSED 等在这些平台是真实的 BSD errno，直接引用即可。
package prober

import "syscall"

var (
	syscallECONNREFUSED = syscall.ECONNREFUSED
	syscallENETUNREACH  = syscall.ENETUNREACH
	syscallEHOSTUNREACH = syscall.EHOSTUNREACH
)
