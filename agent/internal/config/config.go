// Package config 读取、校验并热重载 `config.yaml`。
//
// 依据：docs/agent.md §7（SIGHUP 热重载）、§8（字段参考与校验规则）。
//
// ⛔ 单向宗旨的落点：**配置只在本地**。本包没有任何从中心拉取配置的代码路径，
// 将来也不允许有 —— 中心地址、采集项、频率、探活目标全部由这台机器上的文件决定。
//
// 三条硬规则（都来自 §8，且都是「静默失效」的防治）：
//  1. **未知字段一律拒绝**，并指出完整路径（`center.tls.foo`）。拼错的键若不报错，
//     运维会以为配置生效了，实际按默认值跑 —— 这类问题在面板上完全看不出来。
//  2. 校验失败时**保留旧配置**（由调用方保证：先 Parse 成功再原子替换指针）。
//  3. 非 https 的中心地址只有在显式 `center.allow_insecure_http: true` 时才放行，且启动打 WARN。
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path"
	"reflect"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// MinInterval 各周期下限：避免配置成 100ms 把被监控机自己拖垮（✅ §8「建议 ≥ 5s，避免自伤」）。
const MinInterval = 5 * time.Second

// MaxBatchBytesCeiling 单批压缩前上限的硬天花（✅ G2：Agent 侧熔断阈值 256KB）。
// 中心允许压缩前 1MB，但 Agent 侧必须更早熔断 —— 让 413 永远不该出现。
const MaxBatchBytesCeiling = 256 * 1024

// DefaultExcludeFS 默认排除的伪文件系统（✅ §4.8）。不排除的话一台机器会报出几十个
// 永远 100% 满的 tmpfs/overlay，把磁盘曲线彻底淹掉。
var DefaultExcludeFS = []string{
	"tmpfs", "devtmpfs", "proc", "sysfs", "overlay", "squashfs",
	"cgroup", "cgroup2", "devpts", "autofs", "ramfs",
}

// DefaultExcludeNetDevices 默认排除的虚拟网卡（✅ §4.8）。
var DefaultExcludeNetDevices = []string{"lo", "docker*", "veth*", "br-*", "virbr*"}

// ---------------------------------------------------------------------------
// 基本类型
// ---------------------------------------------------------------------------

// Duration 支持 `10s` / `1m30s` / `500ms` 写法的时长。
type Duration time.Duration

// UnmarshalYAML 只接受字符串形式：写成裸数字（`interval: 30`）会被拒绝 ——
// 那样没人知道单位是秒还是毫秒，而猜错的后果是上报频率差 1000 倍。
//
// ⚠️ 必须按 YAML 标签先判数字：`value.Decode(&s)` 会把 `10` 这种整数字面量**成功**解成
// 字符串 "10"，于是错误信息退化成"格式非法"，看不出真正的问题是「没写单位」。
func (d *Duration) UnmarshalYAML(value *yaml.Node) error {
	switch value.Tag {
	case "!!int", "!!float", "!!bool":
		return fmt.Errorf(
			"第 %d 行：时长必须写成字符串（带单位，如 30s / 1m30s / 500ms），裸数字会让人猜单位是秒还是毫秒",
			value.Line)
	}
	var s string
	if err := value.Decode(&s); err != nil {
		return fmt.Errorf("第 %d 行：时长必须写成字符串（如 30s / 1m30s），不能是空值或复杂结构", value.Line)
	}
	parsed, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("第 %d 行：时长格式非法 %q（示例：5s、30s、1m30s、500ms）", value.Line, s)
	}
	*d = Duration(parsed)
	return nil
}

// MarshalYAML 便于日志/测试回显。
func (d Duration) MarshalYAML() (any, error) { return d.Std().String(), nil }

// Std 转回标准库时长。
func (d Duration) Std() time.Duration { return time.Duration(d) }

// ---------------------------------------------------------------------------
// 配置树（字段名即 `config.yaml` 的键名，⛔ 改动即改契约）
// ---------------------------------------------------------------------------

// Config 根对象。
type Config struct {
	Center   Center       `yaml:"center"`
	Agent    AgentBlock   `yaml:"agent"`
	Host     HostBlock    `yaml:"host"`
	Collect  CollectBlock `yaml:"collect"`
	Report   ReportBlock  `yaml:"report"`
	Probes   []ProbeBlock `yaml:"probes"`
	Filters  FiltersBlock `yaml:"filters"`
	Clock    ClockBlock   `yaml:"clock"`
	Resource Resource     `yaml:"resource"`
	Log      LogBlock     `yaml:"log"`
}

// Center 中心地址与 TLS。
type Center struct {
	URL       string   `yaml:"url"`
	Timeout   Duration `yaml:"timeout"`
	TLS       TLSBlock `yaml:"tls"`
	AllowHTTP bool     `yaml:"allow_insecure_http"`
}

// TLSBlock 证书相关。mTLS 可选（提供 cert/key 即启用）。
type TLSBlock struct {
	CAFile     string `yaml:"ca_file"`
	SkipVerify bool   `yaml:"insecure_skip_verify"`
	CertFile   string `yaml:"cert_file"`
	KeyFile    string `yaml:"key_file"`
}

// AgentBlock 身份与凭证。
//
// ⛔ 凭证只从这里给的两个**文件路径**加载：不存在 `--key` 之类的命令行形式
// （`ps` / `/proc/$PID/cmdline` 对同机低权用户可见，✅ 决策 #37）。
type AgentBlock struct {
	ID         string `yaml:"id"`
	KeyFile    string `yaml:"key_file"`
	SecretFile string `yaml:"secret_file"`
}

// HostBlock 本机别名与标签（可选）。
type HostBlock struct {
	Alias string   `yaml:"alias"`
	Tags  []string `yaml:"tags"`
}

// CollectBlock 采集项。**缺省块 = 用默认值**（即下面 Defaults() 里的那一套），
// 这样一份只写 center/agent 的最小配置也能正常上报
// （中心的 schema 要求 cpu 与 mem 必填，全默认关闭会让每批上报都被 400）。
type CollectBlock struct {
	CPU     CPUCollect     `yaml:"cpu"`
	Mem     CollectItem    `yaml:"mem"`
	Disk    CollectItem    `yaml:"disk"`
	Net     CollectItem    `yaml:"net"`
	GPU     GPUCollect     `yaml:"gpu"`
	Process ProcessCollect `yaml:"process"`
	Docker  DockerCollect  `yaml:"docker"`
}

// CollectItem 通用采集项。
type CollectItem struct {
	Enabled  bool     `yaml:"enabled"`
	Interval Duration `yaml:"interval"`
}

// CPUCollect CPU 采集项。
type CPUCollect struct {
	Enabled  bool     `yaml:"enabled"`
	Interval Duration `yaml:"interval"`
	PerCore  bool     `yaml:"per_core"`
}

// GPUCollect GPU 采集项（无卡或没有 nvidia-smi 时优雅降级，⛔ 不报错）。
type GPUCollect struct {
	Enabled  bool     `yaml:"enabled"`
	Interval Duration `yaml:"interval"`
	Provider string   `yaml:"provider"` // nvidia（amd 预留）
}

// ProcessCollect 进程采集项。
type ProcessCollect struct {
	Enabled  bool     `yaml:"enabled"`
	Interval Duration `yaml:"interval"`
	TopN     int      `yaml:"top_n"`
	Watch    []string `yaml:"watch"` // 关键进程白名单（存活状态）
}

// DockerCollect 预留：本期不实现，`enabled: true` 会被拒绝（✅ §4.2、决策 #13）。
type DockerCollect struct {
	Enabled bool `yaml:"enabled"`
}

// ReportBlock 上报管线参数。
type ReportBlock struct {
	// Interval 上报周期。⚠️ 采集周期**不得小于**它：一批报文里每个指标只有一个值，
	// 采集比上报更快只会让中间那些样本被静默丢掉。
	Interval          Duration   `yaml:"interval"`
	HeartbeatInterval Duration   `yaml:"heartbeat_interval"`
	Gzip              bool       `yaml:"gzip"`
	GzipLevel         int        `yaml:"gzip_level"`
	MaxBatchBytes     int        `yaml:"max_batch_bytes"`
	Retry             RetryBlock `yaml:"retry"`
}

// RetryBlock 内存级重试策略（⛔ 不落盘、不跨断网补传，✅ 决策 #14）。
type RetryBlock struct {
	MaxAttempts int      `yaml:"max_attempts"`
	Backoff     Duration `yaml:"backoff"`
	MaxElapsed  Duration `yaml:"max_elapsed"`
}

// ProbeBlock 单条本地探活目标（✅ §4.6：中心不下发，只能本地配）。
type ProbeBlock struct {
	Name         string   `yaml:"name"`
	Type         string   `yaml:"type"` // ping / http / https / tcp / dns
	URL          string   `yaml:"url"`  // http/https
	Host         string   `yaml:"host"` // ping / tcp（tcp 为 host:port）
	Method       string   `yaml:"method"`
	ExpectStatus []int    `yaml:"expect_status"`
	BodyContains string   `yaml:"body_contains"`
	Timeout      Duration `yaml:"timeout"`
	Interval     Duration `yaml:"interval"`
}

// FiltersBlock Agent 端默认过滤（✅ §4.8：本地可覆盖）。
type FiltersBlock struct {
	Disk DiskFilter `yaml:"disk"`
	Net  NetFilter  `yaml:"net"`
}

// DiskFilter 磁盘过滤。
type DiskFilter struct {
	ExcludeFS     []string `yaml:"exclude_fs"`
	IncludeMounts []string `yaml:"include_mounts"` // 白名单优先，非空时只留匹配项
	ExcludeMounts []string `yaml:"exclude_mounts"`
}

// NetFilter 网卡过滤。
type NetFilter struct {
	ExcludeDevices []string `yaml:"exclude_devices"`
}

// ClockBlock 时钟策略。
type ClockBlock struct {
	// UseServerTS 用中心的 server_ts 校正自身展示/探活记录时间（✅ §6.5，默认开）。
	// ⚠️ 只影响本地展示，⛔ 不会回写本机系统时钟。
	UseServerTS bool `yaml:"use_server_ts"`
}

// Resource 资源封顶（✅ §4.3：空闲内存 < 20–30MB）。
type Resource struct {
	GoMemLimitMB int `yaml:"gomemlimit_mb"`
}

// LogBlock 日志。
type LogBlock struct {
	Level      string `yaml:"level"` // debug/info/warn/error
	File       string `yaml:"file"`  // 空 = stderr（交给 journald）
	MaxSizeMB  int    `yaml:"max_size_mb"`
	MaxBackups int    `yaml:"max_backups"`
	Format     string `yaml:"format"` // text/json
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

// Defaults 返回一份可以直接用的默认配置。
//
// ✅ 本轮修订 G3：`report.interval` 默认由 15s 改为 **30s**，采集周期随之对齐
// （cpu/mem/net/gpu 30s、disk/process 60s）—— 采集比上报更快的部分会被静默丢弃，
// 所以两者必须一起改。中心离线阈值 ≈ 3×周期 = 90s。
func Defaults() *Config {
	return &Config{
		Center: Center{
			Timeout: Duration(10 * time.Second),
		},
		Collect: CollectBlock{
			CPU:     CPUCollect{Enabled: true, Interval: Duration(30 * time.Second), PerCore: true},
			Mem:     CollectItem{Enabled: true, Interval: Duration(30 * time.Second)},
			Disk:    CollectItem{Enabled: true, Interval: Duration(60 * time.Second)},
			Net:     CollectItem{Enabled: true, Interval: Duration(30 * time.Second)},
			GPU:     GPUCollect{Enabled: true, Interval: Duration(30 * time.Second), Provider: "nvidia"},
			Process: ProcessCollect{Enabled: true, Interval: Duration(60 * time.Second), TopN: 10},
			Docker:  DockerCollect{Enabled: false}, // 预留，⛔ 本期不实现
		},
		Report: ReportBlock{
			Interval:          Duration(30 * time.Second),
			HeartbeatInterval: Duration(60 * time.Second),
			Gzip:              true,
			GzipLevel:         6,
			MaxBatchBytes:     MaxBatchBytesCeiling,
			Retry: RetryBlock{
				MaxAttempts: 3,
				Backoff:     Duration(2 * time.Second),
				MaxElapsed:  Duration(30 * time.Second),
			},
		},
		Filters: FiltersBlock{
			Disk: DiskFilter{ExcludeFS: append([]string(nil), DefaultExcludeFS...)},
			Net:  NetFilter{ExcludeDevices: append([]string(nil), DefaultExcludeNetDevices...)},
		},
		Clock:    ClockBlock{UseServerTS: true},
		Resource: Resource{GoMemLimitMB: 48},
		Log:      LogBlock{Level: "info", Format: "text", MaxSizeMB: 16, MaxBackups: 3},
	}
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

// Load 读取并校验指定路径的配置文件。
func Load(filePath string) (*Config, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("读取配置文件失败（%s）：%w", filePath, err)
	}
	cfg, err := Parse(data)
	if err != nil {
		return nil, err
	}
	return cfg, nil
}

// Parse 从字节解析配置：先查未知字段（带完整路径），再解码，最后做语义校验。
//
// ⛔ 顺序不可调换：先解码再查未知字段的话，拼错的键已经被解码器忽略了，
// 错误信息会退化成「某个字段不合法」，运维根本看不出是拼写问题。
func Parse(data []byte) (*Config, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, errors.New("配置文件是空的")
	}

	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("配置文件不是合法 YAML：%w", err)
	}

	cfg := Defaults()
	var unknown []string
	checkUnknownKeys(docRoot(&root), reflect.TypeOf(*cfg), "", &unknown)
	if len(unknown) > 0 {
		return nil, fmt.Errorf(
			"配置文件存在未知字段（拼错的配置会静默失效，因此一律拒绝）：\n  - %s\n"+
				"提示：字段清单见 docs/agent.md §8",
			strings.Join(unknown, "\n  - "))
	}

	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true) // 第二道闸：上面的遍历漏掉的形状（如错误的嵌套层级）由它兜底
	if err := dec.Decode(cfg); err != nil {
		return nil, fmt.Errorf("配置解析失败：%w", err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func docRoot(n *yaml.Node) *yaml.Node {
	if n != nil && n.Kind == yaml.DocumentNode && len(n.Content) > 0 {
		return n.Content[0]
	}
	return n
}

// checkUnknownKeys 遍历 YAML 节点树，按结构体 tag 找出所有未知键，并给出**完整路径**。
//
// 为什么不用 `KnownFields(true)` 就完事：它的报错形如
// `line 12: field foo not found in type config.TLSBlock` —— 有行号但没有路径，
// 而配置文件里的键路径（`center.tls.foo`）才是运维能直接照着改的东西。
func checkUnknownKeys(n *yaml.Node, t reflect.Type, at string, out *[]string) {
	if n == nil {
		return
	}
	if n.Kind == yaml.AliasNode {
		checkUnknownKeys(n.Alias, t, at, out)
		return
	}

	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	// 实现了自定义反序列化的类型（如 Duration）按标量处理
	if reflect.PointerTo(t).Implements(reflect.TypeOf((*yaml.Unmarshaler)(nil)).Elem()) {
		return
	}

	switch n.Kind {
	case yaml.DocumentNode:
		for _, c := range n.Content {
			checkUnknownKeys(c, t, at, out)
		}
	case yaml.SequenceNode:
		if t.Kind() != reflect.Slice && t.Kind() != reflect.Array {
			return
		}
		for i, c := range n.Content {
			checkUnknownKeys(c, t.Elem(), fmt.Sprintf("%s[%d]", at, i), out)
		}
	case yaml.MappingNode:
		// map 类型（如 map[string]string）不设白名单
		if t.Kind() != reflect.Struct {
			return
		}
		fields := yamlFieldIndex(t)
		for i := 0; i+1 < len(n.Content); i += 2 {
			keyNode, valNode := n.Content[i], n.Content[i+1]
			key := keyNode.Value
			child, ok := fields[key]
			if !ok {
				where := key
				if at != "" {
					where = at + "." + key
				}
				*out = append(*out, fmt.Sprintf("%s（第 %d 行）", where, keyNode.Line))
				continue
			}
			childPath := key
			if at != "" {
				childPath = at + "." + key
			}
			checkUnknownKeys(valNode, child, childPath, out)
		}
	}
}

// yamlFieldIndex 建立「yaml 键名 → 字段类型」的索引（跳过 `-` 与内联字段）。
func yamlFieldIndex(t reflect.Type) map[string]reflect.Type {
	out := make(map[string]reflect.Type, t.NumField())
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		name := strings.Split(f.Tag.Get("yaml"), ",")[0]
		if name == "-" {
			continue
		}
		if name == "" {
			name = strings.ToLower(f.Name)
		}
		out[name] = f.Type
	}
	return out
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

// Validate 语义校验。返回的错误会把**所有**问题一次列全，避免改一个跑一次。
func (c *Config) Validate() error {
	var p []string
	add := func(format string, a ...any) { p = append(p, fmt.Sprintf(format, a...)) }

	c.validateCenter(add)
	c.validateAgent(add)
	c.validateCollect(add)
	c.validateReport(add)
	c.validateProbes(add)
	c.validateFilters(add)
	c.validateMisc(add)

	if len(p) > 0 {
		return fmt.Errorf("配置校验未通过（共 %d 项）：\n  - %s", len(p), strings.Join(p, "\n  - "))
	}
	return nil
}

func (c *Config) validateCenter(add func(string, ...any)) {
	if c.Center.URL == "" {
		add("center.url 必填")
	} else if !strings.HasPrefix(c.Center.URL, "https://") {
		if !c.Center.AllowHTTP {
			add("center.url 必须是 https://（当前 %q）。仅测试环境可显式设置 center.allow_insecure_http: true 放行 http", c.Center.URL)
		} else if !strings.HasPrefix(c.Center.URL, "http://") {
			add("center.url 只支持 http:// 或 https://（当前 %q）", c.Center.URL)
		}
	}
	if c.Center.Timeout <= 0 {
		add("center.timeout 必须为正（如 10s）")
	}
	if c.Center.TLS.SkipVerify {
		add("center.tls.insecure_skip_verify: true 会关闭证书校验，⛔ 生产禁止（自签证书请用 ca_file）")
	}
	cert, key := c.Center.TLS.CertFile, c.Center.TLS.KeyFile
	if (cert == "") != (key == "") {
		add("center.tls.cert_file 与 key_file 必须成对提供（mTLS 可选，要么都给要么都不给）")
	}
}

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (c *Config) validateAgent(add func(string, ...any)) {
	if c.Agent.ID == "" {
		add("agent.id 必填（由中心创建 Agent 时生成）")
	} else if !uuidRE.MatchString(c.Agent.ID) {
		add("agent.id 必须是合法 UUID（当前 %q）", c.Agent.ID)
	}
	if c.Agent.KeyFile == "" {
		add("agent.key_file 必填（chmod 600，属运行用户）——⛔ 不支持把 key 写在配置里或命令行上")
	}
	if c.Agent.SecretFile == "" {
		add("agent.secret_file 必填（chmod 600）——⛔ 不支持把 secret 写在配置里或命令行上")
	}
	if c.Agent.KeyFile != "" && c.Agent.SecretFile != "" && c.Agent.KeyFile == c.Agent.SecretFile {
		add("agent.key_file 与 agent.secret_file 不能是同一个文件（key 用于身份、secret 只用于算 HMAC）")
	}
}

// collectItem 把「名字 + 启用 + 周期」抽象出来，便于统一做下限与联动校验。
type collectItem struct {
	name     string
	enabled  bool
	interval Duration
}

func (c *Config) collectItems() []collectItem {
	return []collectItem{
		{"collect.cpu", c.Collect.CPU.Enabled, c.Collect.CPU.Interval},
		{"collect.mem", c.Collect.Mem.Enabled, c.Collect.Mem.Interval},
		{"collect.disk", c.Collect.Disk.Enabled, c.Collect.Disk.Interval},
		{"collect.net", c.Collect.Net.Enabled, c.Collect.Net.Interval},
		{"collect.gpu", c.Collect.GPU.Enabled, c.Collect.GPU.Interval},
		{"collect.process", c.Collect.Process.Enabled, c.Collect.Process.Interval},
	}
}

func (c *Config) validateCollect(add func(string, ...any)) {
	for _, it := range c.collectItems() {
		if !it.enabled {
			continue
		}
		if it.interval.Std() < MinInterval {
			add("%s.interval 太小（%s < 下限 %s）：把被监控机自己拖垮得不偿失", it.name, it.interval.Std(), MinInterval)
		}
		// ⚠️ 一批报文里每个指标只有一个值。采集比上报更快 = 中间那些样本永远出不了这台机器，
		//    而且面板上完全看不出来（曲线只是"稀疏"了一点，没有任何报警）。
		if c.Report.Interval.Std() > 0 && it.interval.Std() < c.Report.Interval.Std() {
			add("%s.interval（%s）小于 report.interval（%s）：多余的采集结果会被静默丢弃。"+
				"请把采集周期调到 ≥ 上报周期，或把 report.interval 调小",
				it.name, it.interval.Std(), c.Report.Interval.Std())
		}
	}
	if c.Collect.Process.TopN < 0 || c.Collect.Process.TopN > 50 {
		add("collect.process.top_n 必须在 0–50（与中心 schema 的 process.top 上限一致，当前 %d）", c.Collect.Process.TopN)
	}
	switch c.Collect.GPU.Provider {
	case "", "nvidia", "amd":
	default:
		add("collect.gpu.provider 只支持 nvidia / amd（当前 %q；amd 为预留）", c.Collect.GPU.Provider)
	}
	if c.Collect.Docker.Enabled {
		add("collect.docker.enabled 本期不支持：docker 采集排在 M5，上报体的 metrics.docker 现在恒为 null（✅ 决策 #13）")
	}
	// 中心的底线：一批至少要有 cpu 与 mem，否则整批 400
	if !c.Collect.CPU.Enabled {
		add("collect.cpu.enabled 不能关闭：中心的 schema 要求每批必须有 cpu.usage（否则整批上报被 400）")
	}
	if !c.Collect.Mem.Enabled {
		add("collect.mem.enabled 不能关闭：中心的 schema 要求每批必须有 mem.total（否则整批上报被 400）")
	}
}

func (c *Config) validateReport(add func(string, ...any)) {
	r := c.Report
	if r.Interval.Std() < MinInterval {
		add("report.interval 太小（%s < 下限 %s）", r.Interval.Std(), MinInterval)
	}
	if r.HeartbeatInterval.Std() < MinInterval {
		add("report.heartbeat_interval 太小（%s < 下限 %s）", r.HeartbeatInterval.Std(), MinInterval)
	}
	if r.MaxBatchBytes <= 0 {
		add("report.max_batch_bytes 必须为正（默认 %d = 256KB）", MaxBatchBytesCeiling)
	} else if r.MaxBatchBytes > MaxBatchBytesCeiling {
		add("report.max_batch_bytes 超过硬天花 %d（256KB）：中心上限虽是 1MB，但 Agent 必须更早熔断，"+
			"否则网络故障时会把整批数据反复重传", MaxBatchBytesCeiling)
	}
	if r.Gzip {
		if r.GzipLevel < 1 || r.GzipLevel > 9 {
			add("report.gzip_level 必须在 1–9（当前 %d）", r.GzipLevel)
		}
	}
	if r.Retry.MaxAttempts < 1 || r.Retry.MaxAttempts > 10 {
		add("report.retry.max_attempts 必须在 1–10（当前 %d）", r.Retry.MaxAttempts)
	}
	if r.Retry.Backoff.Std() <= 0 {
		add("report.retry.backoff 必须为正（默认 2s）")
	}
	if r.Retry.MaxElapsed.Std() < r.Retry.Backoff.Std() {
		add("report.retry.max_elapsed（%s）不能小于 backoff（%s）：第一次退避就会超时",
			r.Retry.MaxElapsed.Std(), r.Retry.Backoff.Std())
	}
	if r.Retry.MaxElapsed.Std() > 5*time.Minute {
		add("report.retry.max_elapsed 不应超过 5min（当前 %s）：重试窗口会跨过下几个上报周期，把内存里的批次数顶起来",
			r.Retry.MaxElapsed.Std())
	}
}

// 允许的探活类型（与中心 probe_results 的类型白名单一致；dns 为预留位）
var probeTypes = map[string]bool{"ping": true, "http": true, "https": true, "tcp": true, "dns": true}

func (c *Config) validateProbes(add func(string, ...any)) {
	if len(c.Probes) > 64 {
		add("probes 条数超限（%d > 64，与中心 schema 的 probes 上限一致）", len(c.Probes))
	}
	seen := map[string]int{}
	for i, pb := range c.Probes {
		at := fmt.Sprintf("probes[%d]", i)
		if pb.Name == "" {
			add("%s.name 必填", at)
		} else if prev, dup := seen[pb.Name]; dup {
			add("%s.name 与 probes[%d] 重复（%q）：中心按 name 区分探活，重复会让两条结果互相覆盖", at, prev, pb.Name)
		} else {
			seen[pb.Name] = i
		}
		if !probeTypes[pb.Type] {
			add("%s.type 非法（%q）：只支持 ping / http / https / tcp / dns", at, pb.Type)
		}
		switch pb.Type {
		case "http", "https":
			if pb.URL == "" {
				add("%s.url 必填（type=%s）", at, pb.Type)
			}
			for _, code := range pb.ExpectStatus {
				if code < 100 || code > 599 {
					add("%s.expect_status 含非状态码（%d）", at, code)
				}
			}
		case "ping":
			if pb.Host == "" {
				add("%s.host 必填（type=ping）", at)
			}
		case "tcp":
			if pb.Host == "" {
				add("%s.host 必填（type=tcp，需带端口，如 10.0.0.5:5432）", at)
			} else if !strings.Contains(pb.Host, ":") {
				add("%s.host 必须带端口（tcp 探活形如 10.0.0.5:5432，当前 %q）", at, pb.Host)
			}
		case "dns":
			add("%s.type=dns 为预留类型，本期未实现", at)
		}
		if pb.Timeout.Std() < 100*time.Millisecond {
			add("%s.timeout 太小（%s）：至少 100ms", at, pb.Timeout.Std())
		}
		if pb.Interval.Std() < MinInterval {
			add("%s.interval 太小（%s < 下限 %s）", at, pb.Interval.Std(), MinInterval)
		}
	}
}

func (c *Config) validateFilters(add func(string, ...any)) {
	for i, fs := range c.Filters.Disk.ExcludeFS {
		if strings.TrimSpace(fs) == "" {
			add("filters.disk.exclude_fs[%d] 是空字符串", i)
		}
	}
	for i, d := range c.Filters.Net.ExcludeDevices {
		if strings.TrimSpace(d) == "" {
			add("filters.net.exclude_devices[%d] 是空字符串", i)
		}
	}
}

func (c *Config) validateMisc(add func(string, ...any)) {
	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		add("log.level 非法（%q）：只支持 debug / info / warn / error", c.Log.Level)
	}
	switch c.Log.Format {
	case "text", "json":
	default:
		add("log.format 非法（%q）：只支持 text / json", c.Log.Format)
	}
	if c.Resource.GoMemLimitMB < 16 {
		add("resource.gomemlimit_mb 太小（%d < 16）：太紧会让 GC 忙于回收反而更耗 CPU", c.Resource.GoMemLimitMB)
	}
	if c.Resource.GoMemLimitMB > 4096 {
		add("resource.gomemlimit_mb 过大（%d）：空闲目标应是 20–30MB，请确认这是有意为之", c.Resource.GoMemLimitMB)
	}
	if len(c.Host.Alias) > 128 {
		add("host.alias 过长（%d > 128）", len(c.Host.Alias))
	}
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

// MatchAny 判断名字是否命中任一 glob 模式（`docker*` / `veth*` / `lo`）。
// ⚠️ 用 `path.Match` 语义（`*` 不跨 `/`）—— 设备名里不会出现 `/`，够用。
// 模式非法（如 `[`）时按不匹配处理：⛔ 过滤器写错不该导致采集整个失败。
func MatchAny(patterns []string, name string) bool {
	for _, p := range patterns {
		if p == "" {
			continue
		}
		if ok, err := path.Match(p, name); err == nil && ok {
			return true
		}
		if p == name {
			return true
		}
	}
	return false
}

// MountAllowed 判断某挂载点是否应被采集（✅ §4.8：白名单优先）。
func (f DiskFilter) MountAllowed(mount, fsType string) bool {
	if MatchAny(f.ExcludeFS, fsType) {
		return false
	}
	if len(f.IncludeMounts) > 0 {
		return MatchAny(f.IncludeMounts, mount)
	}
	return !MatchAny(f.ExcludeMounts, mount)
}

// DeviceAllowed 判断某网卡是否应被采集。
func (f NetFilter) DeviceAllowed(device string) bool {
	return !MatchAny(f.ExcludeDevices, device)
}

// Summary 给出一条**不含凭证**的生效配置摘要（日志用，✅ §7）。
// ⛔ 只输出路径与数值，永不输出 key/secret 的内容。
func (c *Config) Summary() string {
	items := make([]string, 0, 8)
	for _, it := range c.collectItems() {
		state := "off"
		if it.enabled {
			state = it.interval.Std().String()
		}
		items = append(items, fmt.Sprintf("%s=%s", strings.TrimPrefix(it.name, "collect."), state))
	}
	return fmt.Sprintf(
		"center=%s report=%s heartbeat=%s collect{%s} probes=%d host_alias=%q",
		c.Center.URL, c.Report.Interval.Std(), c.Report.HeartbeatInterval.Std(),
		strings.Join(items, " "), len(c.Probes), c.Host.Alias)
}
