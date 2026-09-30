// Package collector 实现各类指标采集器。
//
// 依据：docs/agent.md §3（采集器规格）、§4.8（过滤规则）、§10（资源预算）、§13.1（平台适配层）。
//
// ⛔ 本包最重要的设计决定：**解析逻辑与平台解耦**
//
//   - `/proc` 的解析（procfs.go）与各采集器（cpu.go / mem.go / disk.go / net.go / process.go / gpu.go）
//     都**不带构建标签**，只认一个注入的目录 `procRoot`；
//   - 只有「/proc 在哪」「本平台是否支持」这两件事放在 `platform_*.go` 里。
//
// 直接好处：整套采集逻辑可以在**任何**开发机上用夹具目录（`collector/testdata/proc/**`）跑单元测试，
// 不必先有一台 Linux 才能验证 —— 而采集解析恰恰是最容易写错、又最难在真机上定位的部分
//（`/proc` 的字段个数随内核版本变化，数错一列就会把"写入扇区数"当成"读取扇区数"）。
//
// ⛔ 采集器的另一条铁律：缺权限/工具缺失/指标不可用一律**优雅降级**（produced=false + 明确日志），
//    ⛔ 绝不 panic、绝不写 0 冒充"采到了"（✅ §4.4）。
package collector

import (
	"context"
	"os"
	"runtime"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
)

// Snapshot 一次上报要带的全部采集结果。
//
// ⚠️ 由调度器加锁后交给采集器填写：各采集器周期不同、并发触发，
// 但每个采集器只碰属于自己的那一段字段。
type Snapshot struct {
	Host    *model.Host
	Metrics model.Metrics
}

// Collector 一个采集器。
type Collector interface {
	// Name 采集器名（cpu/mem/disk/net/gpu/process），用于日志与配置对应。
	Name() string
	// Interval 采集周期（来自本机配置）。
	Interval() time.Duration
	// Collect 采集一次，把结果写入 s 中属于自己的字段。
	//
	// 返回 produced=false 表示本周期没有新数据（没有 GPU、指标不可用、全被过滤掉…）。
	// ⛔ 此时**不得**把 s 的对应字段清空或写成 0：
	//    中心的 flatten 会跳过 nil 字段，而写 0 会画出一条"机器突然归零"的假曲线，
	//    还会让聚合层把 0 当成真实最小值永远留住。
	Collect(ctx context.Context, s *Snapshot) (produced bool, err error)
}

// CapabilityReporter 可选接口：采集器声明本机是否具备某项能力。
//
// 键名必须是中心 `host.capabilities` 白名单里的键（docs/api.md §2.1），
// 例如 `disk.inode` / `disk.io` / `net.conn_count` / `gpu.nvidia` / `process.top`。
type CapabilityReporter interface {
	Capabilities() map[string]bool
}

// StatFSResult 一次容量查询的结果。
type StatFSResult struct {
	TotalBytes uint64
	FreeBytes  uint64 // 含 root 保留块
	AvailBytes uint64 // 普通进程可用
	TotalInode uint64
	FreeInode  uint64
}

// StatFSSource 容量查询函数。⚠️ 做成注入而不是直接调用：磁盘容量是全套采集里
// **唯一**绕不开平台 API 的地方（/proc 不暴露剩余空间），注入后整套 /proc 解析
// 就能在开发机上用夹具测试。
type StatFSSource func(path string) (StatFSResult, error)

// BuildOptions 构造参数。
type BuildOptions struct {
	Config *config.Config
	// ProcRoot `/proc` 的根目录。测试传夹具目录（如 `testdata/proc`），生产传 DefaultProcRoot。
	ProcRoot string
	// StatFS 为 nil 时用本平台实现（Linux 为 syscall.Statfs）。
	StatFS StatFSSource
}

// New 按配置构造本平台的采集器集合（只含 enabled 的项，顺序固定便于日志与测试断言）。
func New(opts BuildOptions) []Collector { return newPlatformCollectors(opts) }

// capabilityWhitelist 中心 `host.capabilities` 的键白名单（docs/api.md §2.1）。
//
// ⛔ 与 server/src/models/report.js 的 CAPABILITIES_SCHEMA 必须一致：中心那个 object 是
// `additionalProperties: false`，多一个键整批上报就 400。所以这里是**过滤**而不是断言。
var capabilityWhitelist = map[string]struct{}{
	"disk.inode":      {},
	"disk.io":         {},
	"net.conn_count":  {},
	"gpu.nvidia":      {},
	"gpu.amd":         {},
	"process.top":     {},
	"probe.ping":      {},
	"probe.http":      {},
	"probe.tcp":       {},
	"docker":          {},
}

// Capabilities 汇总所有采集器的能力声明，并滤掉白名单外的键。
//
// 冲突策略：同一键被多个采集器声明且不一致时取**逻辑与**（更保守的那个）——
// 宁可让面板少显示一个图表，也不要显示一个永远为空的图表。
func Capabilities(cs []Collector) map[string]bool {
	out := map[string]bool{}
	for _, c := range cs {
		cr, ok := c.(CapabilityReporter)
		if !ok {
			continue
		}
		for k, v := range cr.Capabilities() {
			if _, allowed := capabilityWhitelist[k]; !allowed {
				continue
			}
			if prev, seen := out[k]; seen {
				out[k] = prev && v
				continue
			}
			out[k] = v
		}
	}
	return out
}

// CapabilitiesToModel 把能力 map 转成上报体里的 `host.capabilities`。
//
// ⛔ 只输出**已知为真或假的键**；map 里没有的键保持 nil（省略）——
// 「本机没声明这项能力」与「本机明确没有这项能力」在面板上语义不同。
func CapabilitiesToModel(m map[string]bool) *model.Capabilities {
	if len(m) == 0 {
		return nil
	}
	caps := &model.Capabilities{}
	set := func(dst **bool, key string) {
		if v, ok := m[key]; ok {
			vv := v
			*dst = &vv
		}
	}
	set(&caps.DiskInode, "disk.inode")
	set(&caps.DiskIO, "disk.io")
	set(&caps.NetConnCount, "net.conn_count")
	set(&caps.GPUNvidia, "gpu.nvidia")
	set(&caps.GPUAMD, "gpu.amd")
	set(&caps.ProcessTop, "process.top")
	set(&caps.ProbePing, "probe.ping")
	set(&caps.ProbeHTTP, "probe.http")
	set(&caps.ProbeTCP, "probe.tcp")
	set(&caps.Docker, "docker")
	return caps
}

// CapabilityFingerprint 给出能力声明的稳定指纹，用于判断"能力是否变化"。
//
// ✅ §2.1：`host`（含 capabilities）**首次上报与能力变化时必填**，其余可省。
// 用一个有序拼接的字符串做指纹，比比较结构体指针可靠得多。
func CapabilityFingerprint(m map[string]bool) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// 手写插入排序：键数 ≤ 10，避免为此引入 sort 依赖到包级 API 语义里
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	buf := make([]byte, 0, len(keys)*8)
	for _, k := range keys {
		buf = append(buf, k...)
		if m[k] {
			buf = append(buf, '1')
		} else {
			buf = append(buf, '0')
		}
		buf = append(buf, ';')
	}
	return string(buf)
}

// HostInfo 采集主机信息。
//
// `host.os` / `host.arch` 取 Go 的运行时值（编译目标即运行平台）；
// 内核版本读 `{procRoot}/sys/kernel/osrelease`，开机时间读 `{procRoot}/stat` 的 `btime`。
//
// ⚠️ kernel 读不到时回退成 OS 名（如 "linux"）而不是空串：中心 schema 要求 host.kernel 非空，
// 空串会让**整批上报** 400，代价远大于内核版本不精确。
func HostInfo(procRoot string) *model.Host {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "unknown"
	}
	kernel := ReadTrimmed(procRoot, "sys/kernel/osrelease")
	if kernel == "" {
		kernel = runtime.GOOS
	}
	return &model.Host{
		Hostname: hostname,
		OS:       runtime.GOOS,
		Kernel:   kernel,
		Arch:     runtime.GOARCH,
		BootTime: readBootTime(procRoot),
	}
}
