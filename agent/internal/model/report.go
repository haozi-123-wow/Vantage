// Package model 定义上行报文的线上格式（wire format）。
//
// 依据：docs/api.md §2.1（report）/§2.2（heartbeat）、docs/agent.md §5。
//
// ⛔ 字段名、类型、范围必须与中心 server/src/models/report.js 的 JSON Schema 一致。
// 中心的每个 object 都写了 `additionalProperties: false`，所以字段拼错不是「被忽略」而是当场 400。
// 两端的对齐由 contracts/wire/*.json（Go 侧生成）+ server/test/agentwire.test.js（中心侧走真实链路）钉死。
//
// 关于指针：可空数值一律用 `*float64` 而不是 `float64`，用于区分两种语义 ——
//
//	nil  = 本周期没采到（省略该字段，中心不产出数据点）
//	&0.0 = 采到了，值就是 0
//
// 若用值类型 + omitempty，`net.err = 0` 会被静默丢弃，曲线会凭空缺一个点。
package model

import (
	"fmt"
	"strings"
)

// 数组长度上限（与中心 REPORT_LIMITS 一致；改这里就是改契约）。
const (
	MaxCPUCores    = 256
	MaxDisks       = 64
	MaxNets        = 64
	MaxGPUs        = 16
	MaxProcessTop  = 50
	MaxProbes      = 64
	MaxHostnameLen = 253
	MaxOSLen       = 128
	MaxArchLen     = 32
	MaxTargetLen   = 512
	MaxProbeName   = 128
	MaxProbeError  = 512
	MaxMountLen    = 255
	MaxDeviceLen   = 64
	MaxProcNameLen = 256
)

// Report `POST /api/v1/agent/report` 请求体。
type Report struct {
	AgentID string  `json:"agent_id"`
	BatchID string  `json:"batch_id"`
	Ts      int64   `json:"ts"`
	Seq     *uint64 `json:"seq,omitempty"`
	// Host 首次上报与能力变化时必填，其余可省（✅ §2.1）——由 reporter 决定何时带上。
	Host *Host `json:"host,omitempty"`
	// ReportedIP Agent 自测出口 IP（取自到中心的 TCP 连接本端地址，⛔ 不外呼第三方服务）。
	ReportedIP string   `json:"reported_ip,omitempty"`
	Metrics    *Metrics `json:"metrics"`
	Probes     []Probe  `json:"probes,omitempty"`
}

// Heartbeat `POST /api/v1/agent/heartbeat` 请求体（✅ §2.2：仅心跳，⛔ 无 metrics）。
type Heartbeat struct {
	AgentID string  `json:"agent_id"`
	BatchID string  `json:"batch_id"`
	Ts      int64   `json:"ts"`
	Seq     *uint64 `json:"seq,omitempty"`
}

// Host 主机信息。
type Host struct {
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	Kernel   string `json:"kernel"`
	Arch     string `json:"arch,omitempty"`
	// BootTime 开机时间，**unix 秒**。
	//
	// ✅ 收窄 M-5：设计文档原先把口径留空（秒/毫秒/RFC3339 都收），现按 Agent 实现定型为
	// 「整数 unix 秒」并由中心 schema 锁死 —— 混口径会让「运行时长」在面板上差 1000 倍。
	BootTime     int64         `json:"boot_time"`
	Capabilities *Capabilities `json:"capabilities,omitempty"`
}

// Capabilities 能力声明（✅ 决策 #55；⛔ 键集合是白名单，多一个键中心就 400）。
type Capabilities struct {
	DiskInode    *bool `json:"disk.inode,omitempty"`
	DiskIO       *bool `json:"disk.io,omitempty"`
	NetConnCount *bool `json:"net.conn_count,omitempty"`
	GPUNvidia    *bool `json:"gpu.nvidia,omitempty"`
	GPUAMD       *bool `json:"gpu.amd,omitempty"`
	ProcessTop   *bool `json:"process.top,omitempty"`
	ProbePing    *bool `json:"probe.ping,omitempty"`
	ProbeHTTP    *bool `json:"probe.http,omitempty"`
	ProbeTCP     *bool `json:"probe.tcp,omitempty"`
	Docker       *bool `json:"docker,omitempty"`
}

// Metrics 一批采集结果。⛔ `cpu` 与 `mem` 是中心的底线要求（至少要有 CPU 使用率与内存总量）。
type Metrics struct {
	CPU     *CPU     `json:"cpu"`
	Mem     *Mem     `json:"mem"`
	Disk    []Disk   `json:"disk,omitempty"`
	Net     []Net    `json:"net,omitempty"`
	GPU     []GPU    `json:"gpu,omitempty"`
	Process *Process `json:"process,omitempty"`
	// Agent 自监控最小集（✅ G10）。⚠️ 需要中心 schema 放行 metrics.agent，见 design-deltas。
	Agent *Self `json:"agent,omitempty"`
}

// CPU CPU 采集结果。
type CPU struct {
	Usage *float64 `json:"usage"` // 必填（中心 schema required）
	// Cores 每核使用率；下标即 `cpu.core.usage{core=<下标>}` 的 core 值。
	Cores     []float64 `json:"cores,omitempty"`
	Load      []float64 `json:"load,omitempty"`       // 必须恰好 3 个：1/5/15 分钟
	CtxSwitch *float64  `json:"ctx_switch,omitempty"` // 上下文切换速率（次/s）
}

// Mem 内存与 Swap。⚠️ 报文里是 `mem.swap.*`，落库后指标名却是顶层的 `swap.*`（中心 §5.7.2 有意为之）。
type Mem struct {
	Total     *float64 `json:"total"` // 必填
	Used      *float64 `json:"used,omitempty"`
	Available *float64 `json:"available,omitempty"`
	Cached    *float64 `json:"cached,omitempty"`
	Buffers   *float64 `json:"buffers,omitempty"`
	Swap      *Swap    `json:"swap,omitempty"`
}

// Swap 交换分区用量。
type Swap struct {
	Total *float64 `json:"total,omitempty"`
	Used  *float64 `json:"used,omitempty"`
}

// Disk 单个挂载点。`inode_used` 的语义是**百分比**（落库为 disk.inode_used_pct），不是数量。
type Disk struct {
	Mount     string   `json:"mount"`
	Device    string   `json:"device,omitempty"`
	Total     *float64 `json:"total,omitempty"`
	Used      *float64 `json:"used,omitempty"`
	InodeUsed *float64 `json:"inode_used,omitempty"`
	ReadBps   *float64 `json:"read_bps,omitempty"`
	WriteBps  *float64 `json:"write_bps,omitempty"`
	ReadIOPS  *float64 `json:"read_iops,omitempty"`
	WriteIOPS *float64 `json:"write_iops,omitempty"`
	LatencyMS *float64 `json:"latency_ms,omitempty"`
}

// Net 单张网卡。
type Net struct {
	Device    string   `json:"device"`
	RxBps     *float64 `json:"rx_bps,omitempty"`
	TxBps     *float64 `json:"tx_bps,omitempty"`
	RxTotal   *float64 `json:"rx_total,omitempty"`
	TxTotal   *float64 `json:"tx_total,omitempty"`
	ConnCount *uint32  `json:"conn_count,omitempty"`
	Err       *float64 `json:"err,omitempty"`
	Drop      *float64 `json:"drop,omitempty"`
}

// GPU 单块 GPU。
type GPU struct {
	Index    int      `json:"index"`
	Util     *float64 `json:"util,omitempty"`
	MemUsed  *float64 `json:"mem_used,omitempty"`
	MemTotal *float64 `json:"mem_total,omitempty"`
	Temp     *float64 `json:"temp,omitempty"`
	Power    *float64 `json:"power,omitempty"`
}

// Process 进程总数 + Top-N（Top-N 落 process_snapshots，⛔ 不进时序）。
type Process struct {
	Count uint32       `json:"count"`
	Top   []ProcessTop `json:"top,omitempty"`
}

// ProcessTop 单个进程条目。
type ProcessTop struct {
	Pid  int      `json:"pid"`
	Name string   `json:"name"`
	CPU  *float64 `json:"cpu,omitempty"`
	Mem  *float64 `json:"mem,omitempty"`
}

// Self Agent 自监控最小集（✅ G10：便于尽早发现「监控系统自身把机器压垮」）。
//
// 落库指标名为 `agent.mem_rss` / `agent.report_failures` / `agent.reload_ok`；
// `reload_ok` 以布尔上报，中心摊平时转成 1/0（时序值只能是数字）。
type Self struct {
	MemRSS         *float64 `json:"mem_rss,omitempty"`
	ReportFailures *uint64  `json:"report_failures,omitempty"`
	ReloadOK       *bool    `json:"reload_ok,omitempty"`
}

// Probe 单条探活结果（✅ §4.6：目标来自本机配置，结果上报）。
type Probe struct {
	Name   string `json:"name"`
	Type   string `json:"type"` // ping / http / https / tcp / dns
	Target string `json:"target"`
	// Up ⛔ 绝不能加 omitempty：`up=false` 必须真的发出去，否则「探测失败」会变成「没这条探活」。
	Up         bool     `json:"up"`
	LatencyMS  *float64 `json:"latency_ms,omitempty"`
	StatusCode *int     `json:"status_code,omitempty"`
	Error      *string  `json:"error,omitempty"`
}

// ---------------------------------------------------------------------------
// 本地校验：把中心才发现的 400 提前到发送之前，并在日志里说清是哪一项。
// ---------------------------------------------------------------------------

// Validate 校验报文是否满足中心 schema 的硬性要求。
//
// ⛔ 这里只做「本地可判定」的检查（必填项、范围、长度、批内重复）；
//
//	真正的权威校验始终在中心（字段白名单只存在于 server/src/models/report.js）。
func (r *Report) Validate() error {
	var errs []string
	add := func(format string, a ...any) { errs = append(errs, fmt.Sprintf(format, a...)) }

	if !isUUIDish(r.AgentID) {
		add("agent_id 不是合法 UUID：%q", r.AgentID)
	}
	if r.BatchID == "" {
		add("batch_id 不能为空（ULID，每批唯一）")
	}
	if r.Ts <= 0 || r.Ts > 4102444800000 {
		add("ts 超范围（应为 unix 毫秒且 ≤ 2100-01-01）：%d", r.Ts)
	}
	if r.Host != nil {
		if r.Host.Hostname == "" || r.Host.OS == "" || r.Host.Kernel == "" {
			add("host 的 hostname/os/kernel 都不能为空")
		}
		if len(r.Host.Hostname) > MaxHostnameLen {
			add("host.hostname 超长（%d > %d）", len(r.Host.Hostname), MaxHostnameLen)
		}
		if len(r.Host.OS) > MaxOSLen {
			add("host.os 超长（%d > %d）", len(r.Host.OS), MaxOSLen)
		}
		if len(r.Host.Kernel) > MaxOSLen {
			add("host.kernel 超长（%d > %d）", len(r.Host.Kernel), MaxOSLen)
		}
		if len(r.Host.Arch) > MaxArchLen {
			add("host.arch 超长（%d > %d）", len(r.Host.Arch), MaxArchLen)
		}
		if r.Host.BootTime < 0 {
			add("host.boot_time 不能为负（unix 秒）：%d", r.Host.BootTime)
		}
	}

	if r.Metrics == nil {
		add("metrics 不能为空")
		return &ValidationError{Problems: errs}
	}
	r.Metrics.validate(add)

	if len(r.Probes) > MaxProbes {
		add("probes 条数超限（%d > %d）", len(r.Probes), MaxProbes)
	}
	for i, p := range r.Probes {
		switch {
		case p.Name == "":
			add("probes[%d].name 不能为空", i)
		case len(p.Name) > MaxProbeName:
			add("probes[%d].name 超长（%d > %d）", i, len(p.Name), MaxProbeName)
		}
		switch p.Type {
		case "ping", "http", "https", "tcp", "dns":
		default:
			add("probes[%d].type 非法：%q（允许 ping/http/https/tcp/dns）", i, p.Type)
		}
		switch {
		case p.Target == "":
			add("probes[%d].target 不能为空", i)
		case len(p.Target) > MaxTargetLen:
			add("probes[%d].target 超长（%d > %d）", i, len(p.Target), MaxTargetLen)
		}
		if p.Error != nil && len(*p.Error) > MaxProbeError {
			add("probes[%d].error 超长（%d > %d）", i, len(*p.Error), MaxProbeError)
		}
		if p.StatusCode != nil && (*p.StatusCode < 100 || *p.StatusCode > 599) {
			add("probes[%d].status_code 超范围：%d", i, *p.StatusCode)
		}
		if p.LatencyMS != nil && *p.LatencyMS < 0 {
			add("probes[%d].latency_ms 不能为负", i)
		}
	}

	if len(errs) > 0 {
		return &ValidationError{Problems: errs}
	}
	return nil
}

// Validate 心跳报文。
func (h *Heartbeat) Validate() error {
	var errs []string
	if !isUUIDish(h.AgentID) {
		errs = append(errs, fmt.Sprintf("agent_id 不是合法 UUID：%q", h.AgentID))
	}
	if h.BatchID == "" {
		errs = append(errs, "batch_id 不能为空（ULID，每批唯一）")
	}
	if h.Ts <= 0 || h.Ts > 4102444800000 {
		errs = append(errs, fmt.Sprintf("ts 超范围：%d", h.Ts))
	}
	if len(errs) > 0 {
		return &ValidationError{Problems: errs}
	}
	return nil
}

func (m *Metrics) validate(add func(string, ...any)) {
	// --- CPU -----------------------------------------------------------------
	if m.CPU == nil {
		add("metrics.cpu 必填（中心 schema 的底线要求）")
	} else {
		if m.CPU.Usage == nil {
			add("metrics.cpu.usage 必填")
		} else {
			checkPct(add, "metrics.cpu.usage", *m.CPU.Usage)
		}
		if len(m.CPU.Cores) > MaxCPUCores {
			add("metrics.cpu.cores 条数超限（%d > %d）", len(m.CPU.Cores), MaxCPUCores)
		}
		for i, v := range m.CPU.Cores {
			checkPct(add, fmt.Sprintf("metrics.cpu.cores[%d]", i), v)
		}
		if m.CPU.Load != nil && len(m.CPU.Load) != 3 {
			add("metrics.cpu.load 必须恰好 3 个（1/5/15 分钟），实际 %d", len(m.CPU.Load))
		}
		for i, v := range m.CPU.Load {
			checkNonNeg(add, fmt.Sprintf("metrics.cpu.load[%d]", i), v)
		}
		if m.CPU.CtxSwitch != nil {
			checkNonNeg(add, "metrics.cpu.ctx_switch", *m.CPU.CtxSwitch)
		}
	}

	// --- 内存 ----------------------------------------------------------------
	if m.Mem == nil {
		add("metrics.mem 必填（中心 schema 的底线要求）")
	} else {
		if m.Mem.Total == nil {
			add("metrics.mem.total 必填")
		} else {
			checkNonNeg(add, "metrics.mem.total", *m.Mem.Total)
		}
		for name, v := range map[string]*float64{
			"metrics.mem.used":      m.Mem.Used,
			"metrics.mem.available": m.Mem.Available,
			"metrics.mem.cached":    m.Mem.Cached,
			"metrics.mem.buffers":   m.Mem.Buffers,
		} {
			if v != nil {
				checkNonNeg(add, name, *v)
			}
		}
		if m.Mem.Swap != nil {
			if m.Mem.Swap.Total != nil {
				checkNonNeg(add, "metrics.mem.swap.total", *m.Mem.Swap.Total)
			}
			if m.Mem.Swap.Used != nil {
				checkNonNeg(add, "metrics.mem.swap.used", *m.Mem.Swap.Used)
			}
		}
	}

	// --- 磁盘（维度组合必须唯一，否则中心会以「批内重复序列」400）--------------
	if len(m.Disk) > MaxDisks {
		add("metrics.disk 条数超限（%d > %d）", len(m.Disk), MaxDisks)
	}
	diskSeen := map[string]int{}
	for i, d := range m.Disk {
		if d.Mount == "" {
			add("metrics.disk[%d].mount 不能为空", i)
		} else if len(d.Mount) > MaxMountLen {
			add("metrics.disk[%d].mount 超长（%d > %d）", i, len(d.Mount), MaxMountLen)
		}
		if len(d.Device) > MaxDeviceLen {
			add("metrics.disk[%d].device 超长（%d > %d）", i, len(d.Device), MaxDeviceLen)
		}
		key := d.Device + "\x00" + d.Mount
		if prev, dup := diskSeen[key]; dup {
			add("metrics.disk[%d] 与 disk[%d] 的维度重复（device=%q mount=%q）——中心会以批内重复序列拒绝", i, prev, d.Device, d.Mount)
		} else {
			diskSeen[key] = i
		}
		for name, v := range map[string]*float64{
			"total": d.Total, "used": d.Used, "read_bps": d.ReadBps, "write_bps": d.WriteBps,
			"read_iops": d.ReadIOPS, "write_iops": d.WriteIOPS, "latency_ms": d.LatencyMS,
		} {
			if v != nil {
				checkNonNeg(add, fmt.Sprintf("metrics.disk[%d].%s", i, name), *v)
			}
		}
		if d.InodeUsed != nil {
			checkPct(add, fmt.Sprintf("metrics.disk[%d].inode_used", i), *d.InodeUsed)
		}
	}

	// --- 网卡 ----------------------------------------------------------------
	if len(m.Net) > MaxNets {
		add("metrics.net 条数超限（%d > %d）", len(m.Net), MaxNets)
	}
	netSeen := map[string]int{}
	for i, n := range m.Net {
		if n.Device == "" {
			add("metrics.net[%d].device 不能为空", i)
		} else if len(n.Device) > MaxDeviceLen {
			add("metrics.net[%d].device 超长（%d > %d）", i, len(n.Device), MaxDeviceLen)
		}
		if prev, dup := netSeen[n.Device]; dup {
			add("metrics.net[%d] 与 net[%d] 的 device 重复（%q）", i, prev, n.Device)
		} else {
			netSeen[n.Device] = i
		}
		for name, v := range map[string]*float64{
			"rx_bps": n.RxBps, "tx_bps": n.TxBps, "rx_total": n.RxTotal,
			"tx_total": n.TxTotal, "err": n.Err, "drop": n.Drop,
		} {
			if v != nil {
				checkNonNeg(add, fmt.Sprintf("metrics.net[%d].%s", i, name), *v)
			}
		}
	}

	// --- GPU -----------------------------------------------------------------
	if len(m.GPU) > MaxGPUs {
		add("metrics.gpu 条数超限（%d > %d）", len(m.GPU), MaxGPUs)
	}
	gpuSeen := map[int]int{}
	for i, g := range m.GPU {
		if g.Index < 0 || g.Index > 1024 {
			add("metrics.gpu[%d].index 超范围：%d", i, g.Index)
		}
		if prev, dup := gpuSeen[g.Index]; dup {
			add("metrics.gpu[%d] 与 gpu[%d] 的 index 重复（%d）", i, prev, g.Index)
		} else {
			gpuSeen[g.Index] = i
		}
		if g.Util != nil {
			checkPct(add, fmt.Sprintf("metrics.gpu[%d].util", i), *g.Util)
		}
		for name, v := range map[string]*float64{
			"mem_used": g.MemUsed, "mem_total": g.MemTotal, "power": g.Power,
		} {
			if v != nil {
				checkNonNeg(add, fmt.Sprintf("metrics.gpu[%d].%s", i, name), *v)
			}
		}
		if g.Temp != nil && (*g.Temp < -100 || *g.Temp > 300) {
			add("metrics.gpu[%d].temp 超范围：%v", i, *g.Temp)
		}
	}

	// --- 进程 ----------------------------------------------------------------
	if m.Process != nil {
		if len(m.Process.Top) > MaxProcessTop {
			add("metrics.process.top 条数超限（%d > %d）", len(m.Process.Top), MaxProcessTop)
		}
		for i, p := range m.Process.Top {
			if p.Pid < 0 || p.Pid > 1<<31-1 {
				add("metrics.process.top[%d].pid 超范围：%d", i, p.Pid)
			}
			if p.Name == "" {
				add("metrics.process.top[%d].name 不能为空", i)
			} else if len(p.Name) > MaxProcNameLen {
				add("metrics.process.top[%d].name 超长（%d > %d）", i, len(p.Name), MaxProcNameLen)
			}
			if p.CPU != nil {
				checkPct(add, fmt.Sprintf("metrics.process.top[%d].cpu", i), *p.CPU)
			}
			if p.Mem != nil {
				checkNonNeg(add, fmt.Sprintf("metrics.process.top[%d].mem", i), *p.Mem)
			}
		}
	}

	// --- 自监控 --------------------------------------------------------------
	if m.Agent != nil {
		if m.Agent.MemRSS != nil {
			checkNonNeg(add, "metrics.agent.mem_rss", *m.Agent.MemRSS)
		}
	}
}

// ValidationError 本地校验失败；Problems 里每条都对应一个可以照着改的具体问题。
type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string {
	return "报文未通过本地校验（" + strings.Join(e.Problems, "；") + "）"
}

func checkPct(add func(string, ...any), name string, v float64) {
	if v < 0 || v > 100 {
		add("%s 超范围（百分比须在 0–100）：%v", name, v)
	}
}

func checkNonNeg(add func(string, ...any), name string, v float64) {
	if v < 0 {
		add("%s 不能为负：%v", name, v)
	}
}

// isUUIDish 与中心 sign.js 的 UUID_RE 同形（含连字符的 36 位十六进制）。
func isUUIDish(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !isHex(r) {
				return false
			}
		}
	}
	return true
}

func isHex(r rune) bool {
	return r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F'
}
