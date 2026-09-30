//go:build linux

package collector

import "syscall"

// DefaultProcRoot Linux 上 /proc 的固定位置。
const DefaultProcRoot = "/proc"

// Supported 本平台是否支持采集（M1–M5 只做 Linux，✅ §13.3）。
const Supported = true

// defaultStatFS 用 syscall.Statfs 查文件系统容量与 inode。
//
// ⚠️ 这是磁盘采集里**唯一**绕不开平台 API 的部分：/proc 不暴露剩余空间，
//    必须真的去 statfs(2)。为了不把它塞进采集器里（否则整套 /proc 解析就没法在
//    开发机上用夹具测试），这里做成**注入的函数**：Linux 用本实现，测试用夹具值，
//    非 Linux 直接返回不支持。采集器集合的组装见 collectors.go（不带构建标签）。
func defaultStatFS(path string) (StatFSResult, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return StatFSResult{}, err
	}
	bsize := uint64(st.Bsize)
	return StatFSResult{
		TotalBytes: bsize * st.Blocks,
		// Bfree 含 root 保留块；Bavail 才是普通进程可用的量。
		// disk.used 用 total−Bfree（贴近 df 的语义）。
		FreeBytes:  bsize * st.Bfree,
		AvailBytes: bsize * st.Bavail,
		TotalInode: st.Files,
		FreeInode:  st.Ffree,
	}, nil
}
