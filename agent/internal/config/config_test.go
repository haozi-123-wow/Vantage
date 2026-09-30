package config_test

import (
	"sort"
	"strings"
	"testing"
	"time"

	"vantage-agent/internal/config"
)

// 默认的两个必需段。测试用「段名 → YAML 片段」覆盖它们，因此可以只写要改的那一段。
//
// ⚠️ 不能写成"在最小配置后面追加一段"：yaml.v3 **拒绝重复的顶层键**
// （`mapping key "center" already defined`），追加式写法根本构不出用例。
// 这本身是好事：重复段不会被静默合并成一个。
var defaultSections = map[string]string{
	"10-center": "center:\n  url: \"https://vantage.example.com\"\n",
	"20-agent": "agent:\n" +
		"  id: \"11111111-2222-3333-4444-555555555555\"\n" +
		"  key_file: \"/etc/vantage/agent.key\"\n" +
		"  secret_file: \"/etc/vantage/agent.secret\"\n",
}

// document 按段名排序拼出完整 YAML（排序保证同一 map 的输出稳定，便于断言行号）。
func document(sections map[string]string) string {
	merged := make(map[string]string, len(defaultSections)+len(sections))
	for k, v := range defaultSections {
		merged[k] = v
	}
	for k, v := range sections {
		merged[k] = v
	}
	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var b strings.Builder
	for _, k := range keys {
		b.WriteString(merged[k])
	}
	return b.String()
}

// mustParse 解析成功才算通过；sections 为 nil 时就是一份"只填必需项"的最小配置。
func mustParse(t *testing.T, sections map[string]string) *config.Config {
	t.Helper()
	cfg, err := config.Parse([]byte(document(sections)))
	if err != nil {
		t.Fatalf("应当解析成功，却失败了：%v", err)
	}
	return cfg
}

// parseErr 要求解析**失败**，并返回错误文本（本文件大量断言错误信息是否"照着就能改"）。
func parseErr(t *testing.T, sections map[string]string) string {
	t.Helper()
	cfg, err := config.Parse([]byte(document(sections)))
	if err == nil {
		t.Fatalf("应当解析失败，却成功了（report.interval=%s）", cfg.Report.Interval.Std())
	}
	return err.Error()
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

func TestDefaults(t *testing.T) {
	cfg := mustParse(t, nil)

	// ✅ 本轮修订 G3：上报周期默认 30s（原先 15s）
	if got := cfg.Report.Interval.Std(); got != 30*time.Second {
		t.Fatalf("report.interval 默认应为 30s，实际 %s", got)
	}
	if got := cfg.Report.HeartbeatInterval.Std(); got != 60*time.Second {
		t.Fatalf("report.heartbeat_interval 默认应为 60s，实际 %s", got)
	}

	// 采集周期必须 ≥ 上报周期，否则中间样本会被静默丢弃 —— 默认值必须自洽
	for _, it := range []struct {
		name string
		got  time.Duration
	}{
		{"cpu", cfg.Collect.CPU.Interval.Std()},
		{"mem", cfg.Collect.Mem.Interval.Std()},
		{"disk", cfg.Collect.Disk.Interval.Std()},
		{"net", cfg.Collect.Net.Interval.Std()},
		{"gpu", cfg.Collect.GPU.Interval.Std()},
		{"process", cfg.Collect.Process.Interval.Std()},
	} {
		if it.got < cfg.Report.Interval.Std() {
			t.Fatalf("默认 collect.%s.interval（%s）小于 report.interval（%s）：会静默丢样本",
				it.name, it.got, cfg.Report.Interval.Std())
		}
	}

	// 中心的底线：缺省块不能把 cpu/mem 关掉（否则每批上报都被 400）
	if !cfg.Collect.CPU.Enabled || !cfg.Collect.Mem.Enabled {
		t.Fatal("cpu/mem 默认必须启用（中心 schema 要求每批必有 cpu.usage 与 mem.total）")
	}
	if cfg.Collect.Docker.Enabled {
		t.Fatal("docker 默认必须关闭（本期未实现）")
	}
	if !cfg.Clock.UseServerTS {
		t.Fatal("clock.use_server_ts 默认应为 true")
	}
	if cfg.Resource.GoMemLimitMB != 48 {
		t.Fatalf("resource.gomemlimit_mb 默认应为 48，实际 %d", cfg.Resource.GoMemLimitMB)
	}
	if cfg.Report.MaxBatchBytes != config.MaxBatchBytesCeiling {
		t.Fatalf("report.max_batch_bytes 默认应为 %d，实际 %d", config.MaxBatchBytesCeiling, cfg.Report.MaxBatchBytes)
	}
	if len(cfg.Filters.Disk.ExcludeFS) == 0 || len(cfg.Filters.Net.ExcludeDevices) == 0 {
		t.Fatal("默认过滤规则不能为空：否则会报出几十个永远 100% 满的 tmpfs")
	}
	if cfg.Collect.CPU.PerCore != true {
		t.Fatal("cpu.per_core 默认应为 true")
	}
	if cfg.Report.Gzip != true || cfg.Report.GzipLevel != 6 {
		t.Fatal("gzip 默认应为 true / level 6")
	}
	if cfg.Report.Retry.MaxAttempts != 3 || cfg.Report.Retry.Backoff.Std() != 2*time.Second ||
		cfg.Report.Retry.MaxElapsed.Std() != 30*time.Second {
		t.Fatal("重试默认应为 3 次 / 2s 退避 / ≤30s（✅ G2）")
	}
}

// ---------------------------------------------------------------------------
// 未知字段：必须报错，且必须给出**完整路径**
// ---------------------------------------------------------------------------

func TestUnknownFieldReportsFullPath(t *testing.T) {
	cases := []struct {
		name     string
		sections map[string]string
		wantPath string
	}{
		{"顶层", map[string]string{"30-extra": "foo: 1\n"}, "foo"},
		{"一层嵌套", map[string]string{"10-center": "center:\n  url: \"https://x\"\n  timeoutt: 10s\n"}, "center.timeoutt"},
		{"两层嵌套", map[string]string{"10-center": "center:\n  url: \"https://x\"\n  tls:\n    skip_verify: true\n"}, "center.tls.skip_verify"},
		{"数组元素", map[string]string{"30-probes": "probes:\n  - name: a\n    type: ping\n    host: 1.1.1.1\n    timeuot: 2s\n"}, "probes[0].timeuot"},
		{"采集项", map[string]string{"30-collect": "collect:\n  cpu:\n    per_core_usage: true\n"}, "collect.cpu.per_core_usage"},
		{"过滤器", map[string]string{"30-filters": "filters:\n  disk:\n    exclude_fsx: [\"tmpfs\"]\n"}, "filters.disk.exclude_fsx"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			msg := parseErr(t, c.sections)
			if !strings.Contains(msg, c.wantPath) {
				t.Fatalf("错误信息必须指出完整路径 %q，实际：%s", c.wantPath, msg)
			}
			if !strings.Contains(msg, "未知字段") {
				t.Fatalf("错误信息应说明是未知字段：%s", msg)
			}
		})
	}
}

func TestKnownButMisplacedFieldIsRejected(t *testing.T) {
	// interval 是合法的键，但放在 center 下就是错的 —— 不能因为"这个键见过"就放行
	msg := parseErr(t, map[string]string{"10-center": "center:\n  url: \"https://x\"\n  interval: 30s\n"})
	if !strings.Contains(msg, "center.interval") {
		t.Fatalf("应指出 center.interval：%s", msg)
	}
}

func TestUnknownFieldReportsAllOfThem(t *testing.T) {
	msg := parseErr(t, map[string]string{
		"10-center": "center:\n  url: \"https://x\"\n  aaa: 1\n  bbb: 2\n",
	})
	if !strings.Contains(msg, "center.aaa") || !strings.Contains(msg, "center.bbb") {
		t.Fatalf("多个未知字段应一次列全：%s", msg)
	}
}

// ---------------------------------------------------------------------------
// https 强制（✅ §8 / G6）
// ---------------------------------------------------------------------------

func TestInsecureHTTPRequiresExplicitOptIn(t *testing.T) {
	msg := parseErr(t, map[string]string{"10-center": "center:\n  url: \"http://127.0.0.1:8080\"\n"})
	if !strings.Contains(msg, "https://") {
		t.Fatalf("http 地址未显式放行时必须被拒，实际：%s", msg)
	}

	cfg := mustParse(t, map[string]string{
		"10-center": "center:\n  url: \"http://127.0.0.1:8080\"\n  allow_insecure_http: true\n",
	})
	if cfg.Center.URL != "http://127.0.0.1:8080" {
		t.Fatalf("显式放行后应可用，实际 %q", cfg.Center.URL)
	}
	if !cfg.Center.AllowHTTP {
		t.Fatal("allow_insecure_http 应为 true，供调用方打醒目 WARN")
	}
}

func TestSkipVerifyIsRejected(t *testing.T) {
	msg := parseErr(t, map[string]string{
		"10-center": "center:\n  url: \"https://x\"\n  tls:\n    insecure_skip_verify: true\n",
	})
	if !strings.Contains(msg, "insecure_skip_verify") {
		t.Fatalf("关闭证书校验必须被拒：%s", msg)
	}
}

func TestMTLSFilesMustBePaired(t *testing.T) {
	msg := parseErr(t, map[string]string{
		"10-center": "center:\n  url: \"https://x\"\n  tls:\n    cert_file: \"/etc/vantage/c.pem\"\n",
	})
	if !strings.Contains(msg, "cert_file") {
		t.Fatalf("只给 cert 不给 key 必须被拒：%s", msg)
	}
}

// ---------------------------------------------------------------------------
// 身份与凭证
// ---------------------------------------------------------------------------

func TestAgentIdentityValidation(t *testing.T) {
	msg := parseErr(t, map[string]string{
		"20-agent": "agent:\n  id: \"not-a-uuid\"\n  key_file: \"/k\"\n  secret_file: \"/s\"\n",
	})
	if !strings.Contains(msg, "agent.id") || !strings.Contains(msg, "UUID") {
		t.Fatalf("非法 UUID 必须被拒：%s", msg)
	}

	// 同一个文件当 key 与 secret 用 → 拒绝（两者职责不同：key 验身份、secret 只算 HMAC）
	msg = parseErr(t, map[string]string{
		"20-agent": "agent:\n  id: \"11111111-2222-3333-4444-555555555555\"\n  key_file: \"/etc/vantage/same\"\n  secret_file: \"/etc/vantage/same\"\n",
	})
	if !strings.Contains(msg, "不能是同一个文件") {
		t.Fatalf("key/secret 同文件应被拒：%s", msg)
	}
}

func TestCredentialMustBeFilesNotInline(t *testing.T) {
	// ⛔ 决策 #37：不存在把 key/secret 直接写在配置里的写法 —— 那是未知字段，必须报错
	msg := parseErr(t, map[string]string{
		"20-agent": "agent:\n  id: \"11111111-2222-3333-4444-555555555555\"\n  key_file: \"/k\"\n  secret_file: \"/s\"\n  key: \"vk_abc\"\n",
	})
	if !strings.Contains(msg, "agent.key") {
		t.Fatalf("内联 key 必须被当成未知字段拒绝：%s", msg)
	}
	msg = parseErr(t, map[string]string{
		"20-agent": "agent:\n  id: \"11111111-2222-3333-4444-555555555555\"\n  key_file: \"/k\"\n  secret_file: \"/s\"\n  secret: \"vs_abc\"\n",
	})
	if !strings.Contains(msg, "agent.secret") {
		t.Fatalf("内联 secret 必须被当成未知字段拒绝：%s", msg)
	}
}

// ---------------------------------------------------------------------------
// 时长与周期联动
// ---------------------------------------------------------------------------

func TestDurationMustBeStringNotBareNumber(t *testing.T) {
	msg := parseErr(t, map[string]string{"10-center": "center:\n  url: \"https://x\"\n  timeout: 10\n"})
	if !strings.Contains(msg, "时长必须写成字符串") {
		t.Fatalf("裸数字时长必须被拒（单位不明会差 1000 倍）：%s", msg)
	}

	msg = parseErr(t, map[string]string{"10-center": "center:\n  url: \"https://x\"\n  timeout: \"十秒\"\n"})
	if !strings.Contains(msg, "时长格式非法") {
		t.Fatalf("非法时长文本必须被拒：%s", msg)
	}
}

func TestIntervalFloor(t *testing.T) {
	msg := parseErr(t, map[string]string{"30-report": "report:\n  interval: 1s\n"})
	if !strings.Contains(msg, "太小") {
		t.Fatalf("周期低于下限必须被拒：%s", msg)
	}
}

func TestCollectFasterThanReportIsRejected(t *testing.T) {
	// 这是本配置里最容易踩、后果又最隐蔽的一条：采集 15s / 上报 30s 时，
	// 一半的样本永远出不了这台机器，而面板上"只是曲线疏了一点"，没有任何报警。
	msg := parseErr(t, map[string]string{"30-collect": "collect:\n  cpu:\n    interval: 15s\n"})
	if !strings.Contains(msg, "collect.cpu.interval") || !strings.Contains(msg, "静默丢弃") {
		t.Fatalf("采集快于上报必须被拒并说明原因：%s", msg)
	}

	// 把上报周期一起调到 5s 就自洽了
	cfg := mustParse(t, map[string]string{
		"30-report":  "report:\n  interval: 5s\n",
		"40-collect": "collect:\n  cpu:\n    interval: 5s\n",
	})
	if cfg.Report.Interval.Std() != 5*time.Second || cfg.Collect.CPU.Interval.Std() != 5*time.Second {
		t.Fatal("两者都调到 5s 后应通过")
	}

	// 采集比上报**慢**是允许的（该周期没有新数据 → 报心跳）
	slow := mustParse(t, map[string]string{
		"30-report":  "report:\n  interval: 10s\n",
		"40-collect": "collect:\n  cpu:\n    interval: 30s\n  mem:\n    interval: 10s\n",
	})
	if slow.Collect.CPU.Interval.Std() != 30*time.Second {
		t.Fatal("采集慢于上报应当被接受")
	}
}

func TestCPUMemCannotBeDisabled(t *testing.T) {
	msg := parseErr(t, map[string]string{"30-collect": "collect:\n  cpu:\n    enabled: false\n"})
	if !strings.Contains(msg, "collect.cpu.enabled") {
		t.Fatalf("关闭 cpu 采集必须被拒（中心 schema 的底线）：%s", msg)
	}
	msg = parseErr(t, map[string]string{"30-collect": "collect:\n  mem:\n    enabled: false\n"})
	if !strings.Contains(msg, "collect.mem.enabled") {
		t.Fatalf("关闭 mem 采集必须被拒：%s", msg)
	}
	// 关掉非底线项是允许的
	cfg := mustParse(t, map[string]string{"30-collect": "collect:\n  disk:\n    enabled: false\n  gpu:\n    enabled: false\n"})
	if cfg.Collect.Disk.Enabled || cfg.Collect.GPU.Enabled {
		t.Fatal("disk/gpu 应当可以关闭")
	}
}

func TestDockerIsReservedNotImplemented(t *testing.T) {
	msg := parseErr(t, map[string]string{"30-collect": "collect:\n  docker:\n    enabled: true\n"})
	if !strings.Contains(msg, "docker") || !strings.Contains(msg, "M5") {
		t.Fatalf("开启 docker 采集必须被拒并说明排期：%s", msg)
	}
}

func TestProcessTopNLimit(t *testing.T) {
	msg := parseErr(t, map[string]string{"30-collect": "collect:\n  process:\n    top_n: 99\n"})
	if !strings.Contains(msg, "top_n") {
		t.Fatalf("top_n 超限必须被拒（与中心 schema 的 process.top 上限一致）：%s", msg)
	}
}

func TestGPUProviderWhitelist(t *testing.T) {
	msg := parseErr(t, map[string]string{"30-collect": "collect:\n  gpu:\n    provider: intel\n"})
	if !strings.Contains(msg, "provider") {
		t.Fatalf("未知 GPU provider 必须被拒：%s", msg)
	}
	mustParse(t, map[string]string{"30-collect": "collect:\n  gpu:\n    provider: amd\n"})
}

// ---------------------------------------------------------------------------
// 上报管线参数
// ---------------------------------------------------------------------------

func TestReportLimits(t *testing.T) {
	msg := parseErr(t, map[string]string{"30-report": "report:\n  max_batch_bytes: 1048576\n"})
	if !strings.Contains(msg, "硬天花") {
		t.Fatalf("超过 256KB 熔断阈值必须被拒：%s", msg)
	}

	msg = parseErr(t, map[string]string{"30-report": "report:\n  gzip_level: 0\n"})
	if !strings.Contains(msg, "gzip_level") {
		t.Fatalf("gzip_level 越界必须被拒：%s", msg)
	}

	// 退避比总时长还大：第一次退避就会超时，等于永远只尝试一次
	msg = parseErr(t, map[string]string{"30-report": "report:\n  retry:\n    backoff: 10s\n    max_elapsed: 5s\n"})
	if !strings.Contains(msg, "max_elapsed") {
		t.Fatalf("max_elapsed < backoff 必须被拒：%s", msg)
	}

	msg = parseErr(t, map[string]string{"30-report": "report:\n  retry:\n    max_attempts: 99\n"})
	if !strings.Contains(msg, "max_attempts") {
		t.Fatalf("max_attempts 越界必须被拒：%s", msg)
	}
}

// ---------------------------------------------------------------------------
// 探活
// ---------------------------------------------------------------------------

var probesSection = map[string]string{"30-probes": `
probes:
  - name: "site-health"
    type: http
    url: "https://example.com/healthz"
    expect_status: [200]
    timeout: 5s
    interval: 30s
`}

func TestProbesValid(t *testing.T) {
	cfg := mustParse(t, probesSection)
	if len(cfg.Probes) != 1 || cfg.Probes[0].Name != "site-health" {
		t.Fatalf("探活解析异常：%+v", cfg.Probes)
	}
	if cfg.Probes[0].Timeout.Std() != 5*time.Second {
		t.Fatalf("探活超时解析异常：%s", cfg.Probes[0].Timeout.Std())
	}
	if len(cfg.Probes[0].ExpectStatus) != 1 || cfg.Probes[0].ExpectStatus[0] != 200 {
		t.Fatalf("expect_status 解析异常：%+v", cfg.Probes[0].ExpectStatus)
	}
}

func TestProbesRejections(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			"重名",
			"probes:\n  - {name: a, type: ping, host: 1.1.1.1, timeout: 2s, interval: 30s}\n  - {name: a, type: tcp, host: 1.1.1.1:80, timeout: 2s, interval: 30s}\n",
			"重复",
		},
		{
			"类型非法",
			"probes:\n  - {name: a, type: udp, host: 1.1.1.1, timeout: 2s, interval: 30s}\n",
			"type 非法",
		},
		{
			"http 缺 url",
			"probes:\n  - {name: a, type: http, timeout: 2s, interval: 30s}\n",
			"url 必填",
		},
		{
			"ping 缺 host",
			"probes:\n  - {name: a, type: ping, timeout: 2s, interval: 30s}\n",
			"host 必填",
		},
		{
			"tcp 缺端口",
			"probes:\n  - {name: a, type: tcp, host: 10.0.0.5, timeout: 2s, interval: 30s}\n",
			"必须带端口",
		},
		{
			"dns 未实现",
			"probes:\n  - {name: a, type: dns, host: example.com, timeout: 2s, interval: 30s}\n",
			"预留",
		},
		{
			"状态码越界",
			"probes:\n  - {name: a, type: http, url: \"https://example.com\", expect_status: [999], timeout: 2s, interval: 30s}\n",
			"expect_status",
		},
		{
			"超时过小",
			"probes:\n  - {name: a, type: ping, host: 1.1.1.1, timeout: 5ms, interval: 30s}\n",
			"timeout 太小",
		},
		{
			"周期过小",
			"probes:\n  - {name: a, type: ping, host: 1.1.1.1, timeout: 2s, interval: 1s}\n",
			"interval 太小",
		},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			msg := parseErr(t, map[string]string{"30-probes": c.body})
			if !strings.Contains(msg, c.want) {
				t.Fatalf("应包含 %q，实际：%s", c.want, msg)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 过滤规则
// ---------------------------------------------------------------------------

func TestMatchAnyGlob(t *testing.T) {
	pats := []string{"lo", "docker*", "veth*", "br-*"}
	// ⚠️ `docker*` 也会匹配裸 `docker`（`*` 可匹配零个字符）—— 期望如此
	yes := []string{"lo", "docker", "docker0", "veth1a2b", "br-3f9c0a1b2c3d"}
	no := []string{"eth0", "ens18", "enp0s3", "wlan0", "enp0s3.100"}
	for _, n := range yes {
		if !config.MatchAny(pats, n) {
			t.Fatalf("%q 应被排除", n)
		}
	}
	for _, n := range no {
		if config.MatchAny(pats, n) {
			t.Fatalf("%q 不应被排除", n)
		}
	}
	// ⛔ 模式写错（非法 glob）不能导致采集整体失败：按"不匹配"处理
	if config.MatchAny([]string{"["}, "eth0") {
		t.Fatal("非法 glob 模式不应匹配任何东西")
	}
	if config.MatchAny([]string{""}, "eth0") {
		t.Fatal("空模式不应匹配任何东西")
	}
}

func TestDiskFilterPrecedence(t *testing.T) {
	f := config.DiskFilter{
		ExcludeFS:     []string{"tmpfs", "overlay"},
		IncludeMounts: []string{"/", "/data*"},
	}
	if !f.MountAllowed("/", "ext4") {
		t.Fatal("/ 在白名单内应被采集")
	}
	if !f.MountAllowed("/data1", "ext4") {
		t.Fatal("/data* 应匹配 /data1")
	}
	if f.MountAllowed("/var", "ext4") {
		t.Fatal("白名单非空时，未命中白名单的挂载点必须被排除（白名单优先）")
	}
	if f.MountAllowed("/data1", "tmpfs") {
		t.Fatal("文件系统类型被排除时，白名单也不该放行（tmpfs 永远 100% 满）")
	}

	// 白名单为空 → 退回黑名单语义
	g := config.DiskFilter{ExcludeFS: []string{"tmpfs"}, ExcludeMounts: []string{"/boot"}}
	if !g.MountAllowed("/", "ext4") || g.MountAllowed("/boot", "ext4") || g.MountAllowed("/x", "tmpfs") {
		t.Fatal("黑名单语义不正确")
	}
}

func TestNetFilter(t *testing.T) {
	f := config.NetFilter{ExcludeDevices: []string{"lo", "veth*"}}
	if f.DeviceAllowed("lo") || f.DeviceAllowed("veth9") {
		t.Fatal("被排除的网卡不应放行")
	}
	if !f.DeviceAllowed("eth0") {
		t.Fatal("eth0 应放行")
	}
}

// ---------------------------------------------------------------------------
// 安全：摘要绝不泄漏凭证（✅ §12.3 排障纪律）
// ---------------------------------------------------------------------------

func TestSummaryLeaksNothing(t *testing.T) {
	cfg := mustParse(t, probesSection)
	s := cfg.Summary()

	for _, forbidden := range []string{"vk_", "vs_", "agent.key", "agent.secret", "/etc/vantage"} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("配置摘要里出现了禁止内容 %q：%s", forbidden, s)
		}
	}
	// 但必须包含排障真正需要的生效值
	for _, want := range []string{"center=https://vantage.example.com", "report=30s", "probes=1"} {
		if !strings.Contains(s, want) {
			t.Fatalf("摘要缺少 %q：%s", want, s)
		}
	}
}

// ---------------------------------------------------------------------------
// 多问题一次列全（省掉"改一个跑一次"）
// ---------------------------------------------------------------------------

func TestValidationReportsAllProblemsAtOnce(t *testing.T) {
	_, err := config.Parse([]byte(`
center:
  url: "http://insecure.example.com"
agent:
  id: "bad"
  key_file: "/k"
  secret_file: "/s"
report:
  interval: 1s
  gzip_level: 42
resource:
  gomemlimit_mb: 1
log:
  level: verbose
`))
	if err == nil {
		t.Fatal("应当失败")
	}
	msg := err.Error()
	want := []string{"center.url", "agent.id", "report.interval", "gzip_level", "gomemlimit_mb", "log.level"}
	for _, w := range want {
		if !strings.Contains(msg, w) {
			t.Fatalf("错误信息应一次列全，缺少 %q：\n%s", w, msg)
		}
	}
	if !strings.Contains(msg, "共 6 项") {
		t.Fatalf("应给出问题总数（此处恰为 6 项）：\n%s", msg)
	}
}

func TestEmptyFileRejected(t *testing.T) {
	if _, err := config.Parse([]byte("   \n")); err == nil {
		t.Fatal("空配置必须被拒")
	}
}

func TestNonYAMLRejected(t *testing.T) {
	if _, err := config.Parse([]byte("\tnot: [valid\n")); err == nil {
		t.Fatal("非法 YAML 必须被拒")
	}
}
