// net_test.go —— 网卡采集器：夹具解析、双采样速率（注入时钟）、连接数归集（IPv4-mapped）、过滤。
package collector

import (
	"context"
	"math"
	"net"
	"testing"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
)

// 网卡名与夹具 net/dev 的顺序一致（lo eth0 eth1 eth9 docker0 veth1a2b3c）。
func netDevices(rows []struct {
	name string
}) {}

// 第二个 /proc/net/dev 采样：eth0 rx 5M→8M、tx 3M→3.6M；errs 15→18；drops 12→14。
const netDevSecondSample = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000 1000 0 0 0 0 0 0 1000000 1000 0 0 0 0 0 0
  eth0: 8000000 4000 14 8 0 0 0 0 3600000 2500 4 6 0 0 0 0
  eth1: 8000 80 0 0 0 0 0 0 9000 90 0 0 0 0 0 0
  eth9: 1234 10 1 2 0 0 0 0 4321 20 3 4 0 0 0 0
docker0: 100 2 0 0 0 0 0 0 200 3 0 0 0 0 0 0
  veth1a2b3c: 50 1 0 0 0 0 0 0 60 1 0 0 0 0 0 0
`

// stubIfaceAddrs 固定的"本机网卡 → 地址"表：eth0=10.0.0.5、lo=127.0.0.1。
// eth1/eth9/docker0/veth1a2b3c 不在表里 → 它们的 conn_count 必须留 nil（未知 ≠ 0）。
func stubIfaceAddrs() map[string][]net.IP {
	return map[string][]net.IP{
		"eth0": {net.IPv4(10, 0, 0, 5)},
		"lo":   {net.IPv4(127, 0, 0, 1)},
	}
}

func TestNetTwoSampleRatesAndConnCount(t *testing.T) {
	root := copyFixtures(t)
	cfg := testConfig()
	cfg.Collect.Net.Interval = config.Duration(60 * time.Second) // 分母不得拿配置周期
	c := newNetCollector(cfg, root).(*netCollector)
	clk := newFakeClock()
	c.now = clk.now
	c.ifaceAddrs = stubIfaceAddrs
	ctx := context.Background()

	var s Snapshot
	if _, err := c.Collect(ctx, &s); err != nil {
		t.Fatalf("预热轮失败：%v", err)
	}
	overwrite(t, root, "net/dev", netDevSecondSample)
	clk.advance(30 * time.Second) // 真实 Δt = 30s
	s = Snapshot{}
	produced, err := c.Collect(ctx, &s)
	if err != nil || !produced {
		t.Fatalf("第二轮应产出（got %v, err=%v）", produced, err)
	}

	byDev := map[string]model.Net{}
	for _, r := range s.Metrics.Net {
		byDev[r.Device] = r
	}
	eth0 := byDev["eth0"]
	if eth0.Device == "" {
		t.Fatalf("缺 eth0：%+v", s.Metrics.Net)
	}
	// 速率 = 差值 ÷ 真实 30s（若错拿配置周期 60s，数值会小一半）。
	if eth0.RxBps == nil || *eth0.RxBps != 100000 {
		t.Fatalf("eth0.rx_bps = %v，期望 100000（Δ3000000÷30s）", eth0.RxBps)
	}
	if eth0.TxBps == nil || *eth0.TxBps != 20000 {
		t.Fatalf("eth0.tx_bps = %v，期望 20000（Δ600000÷30s）", eth0.TxBps)
	}
	// err/drop 是速率（次/s），不是累计值：Δ3/30=0.1、Δ2/30≈0.0667。
	if eth0.Err == nil || *eth0.Err != 0.1 {
		t.Fatalf("eth0.err = %v，期望 0.1（Δ3÷30s）", eth0.Err)
	}
	if eth0.Drop == nil || !almostEqual(*eth0.Drop, 2.0/30.0) {
		t.Fatalf("eth0.drop = %v，期望 %v（Δ2÷30s）", eth0.Drop, 2.0/30.0)
	}
	// 累计值照常上报。
	if eth0.RxTotal == nil || *eth0.RxTotal != 8000000 {
		t.Fatalf("eth0.rx_total = %v", eth0.RxTotal)
	}
	// 连接数：tcp(10.0.0.5) + tcp6 的 IPv4-mapped(10.0.0.5) 都归 eth0 → 2；
	// IPv4 归集靠 ipKey 的 To4 还原（不还原的话 mapped 连接恒为 0）。
	if eth0.ConnCount == nil || *eth0.ConnCount != 2 {
		t.Fatalf("eth0.conn_count = %v，期望 2（tcp + tcp6-mapped）", eth0.ConnCount)
	}
	if lo := byDev["lo"]; lo.ConnCount == nil || *lo.ConnCount != 1 {
		t.Fatalf("lo.conn_count = %v，期望 1", lo.ConnCount)
	}
	// 地址表里没有的网卡：conn_count 留 nil（写 0 是伪造"0 个连接"）。
	for _, name := range []string{"eth1", "eth9", "docker0", "veth1a2b3c"} {
		if r := byDev[name]; r.ConnCount != nil {
			t.Fatalf("%s.conn_count 应为 nil（未知地址表），got %v", name, *r.ConnCount)
		}
	}
}

// almostEqual 浮点容差比较。
func almostEqual(a, b float64) bool { return math.Abs(a-b) <= 1e-9 }

// 过滤：exclude_devices 命中 docker0 与 veth1a2b3c；`docker*` 也必须匹配裸 `docker`。
func TestNetExcludeDevicesFilter(t *testing.T) {
	root := copyFixtures(t)
	cfg := testConfig()
	cfg.Filters.Net.ExcludeDevices = []string{"docker*", "veth*"}
	c := newNetCollector(cfg, root).(*netCollector)
	clk := newFakeClock()
	c.now = clk.now
	c.ifaceAddrs = stubIfaceAddrs
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || !produced {
		t.Fatalf("应产出（got %v, err=%v）", produced, err)
	}
	got := map[string]bool{}
	for _, r := range s.Metrics.Net {
		got[r.Device] = true
	}
	if got["docker0"] || got["veth1a2b3c"] {
		t.Fatalf("docker0/veth1a2b3c 应被过滤：%v", got)
	}
	if !got["eth0"] || !got["lo"] {
		t.Fatalf("其余网卡应保留：%v", got)
	}
	// ⛔ `docker*` 必须同时匹配裸 `docker`（真机上两种名字都出现过）。
	if !config.MatchAny([]string{"docker*"}, "docker") {
		t.Fatal("docker* 应匹配裸 docker")
	}
}

// 全部网卡被过滤 → produced=false（⛔ 不写空数组冒充"没有网卡"）。
func TestNetAllFilteredProducesNothing(t *testing.T) {
	root := copyFixtures(t)
	cfg := testConfig()
	cfg.Filters.Net.ExcludeDevices = []string{"*"}
	c := newNetCollector(cfg, root).(*netCollector)
	clk := newFakeClock()
	c.now = clk.now
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || produced {
		t.Fatalf("全过滤应 produced=false（got %v, err=%v）", produced, err)
	}
	if s.Metrics.Net != nil {
		t.Fatalf("produced=false 时不得写 s.Metrics.Net")
	}
}

// 读不到 net/tcp{,6}：其余指标照常，conn_count 全部 nil。
func TestNetNoTCPFilesConnCountNil(t *testing.T) {
	root := copyFixtures(t)
	c := newNetCollector(testConfig(), root).(*netCollector)
	clk := newFakeClock()
	c.now = clk.now
	c.ifaceAddrs = stubIfaceAddrs
	removeFixture(t, root, "net/tcp")
	removeFixture(t, root, "net/tcp6")
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || !produced {
		t.Fatalf("无 tcp 文件时其余指标应照常产出（got %v, err=%v）", produced, err)
	}
	for _, r := range s.Metrics.Net {
		if r.ConnCount != nil {
			t.Fatalf("%s.conn_count 应为 nil，got %v", r.Device, *r.ConnCount)
		}
	}
}

// net/dev 缺失 → 优雅降级。
func TestNetMissingDevDegrades(t *testing.T) {
	c := newNetCollector(testConfig(), t.TempDir()).(*netCollector)
	clk := newFakeClock()
	c.now = clk.now
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || produced {
		t.Fatalf("缺 net/dev 应 produced=false（got %v, err=%v）", produced, err)
	}
}

// parseProcNetAddr：小端字节序还原（错序的表现是"连接数永远为 0"且无任何报错）。
func TestParseProcNetAddrEndianness(t *testing.T) {
	ip, ok := parseProcNetAddr("0100007F")
	if !ok || ip.String() != "127.0.0.1" {
		t.Fatalf("0100007F 应还原为 127.0.0.1，got %v", ip)
	}
	ip, ok = parseProcNetAddr("0500000A")
	if !ok || ip.String() != "10.0.0.5" {
		t.Fatalf("0500000A 应还原为 10.0.0.5，got %v", ip)
	}
	// IPv4-mapped：每 4 字节一组各自反转 → ::ffff:10.0.0.5，且 ipKey 归一成 IPv4。
	ip, ok = parseProcNetAddr("0000000000000000FFFF00000500000A")
	if !ok {
		t.Fatal("mapped 地址应解析成功")
	}
	if got := ip.To4().String(); got != "10.0.0.5" {
		t.Fatalf("mapped 地址应还原出 10.0.0.5，got %v", got)
	}
	if k := ipKey(ip); k != "4:10.0.0.5" {
		t.Fatalf("ipKey 应归一为 4:10.0.0.5，got %q", k)
	}
	// 非 ESTABLISHED 状态不得进入本端地址表（LISTEN 不是连接）。
	if ips := parseEstablishedLocalIPs("   0: 0500000A:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000"); len(ips) != 0 {
		t.Fatalf("LISTEN(0A) 不应计入，got %v", ips)
	}
	if ips := parseEstablishedLocalIPs("   1: 0500000A:1F90 0A00000A:0050 06 00000000:00000000 00:00000000 00000000"); len(ips) != 0 {
		t.Fatalf("TIME_WAIT(06) 不应计入，got %v", ips)
	}
}

// parseNetDev：表头跳过、列缺失留 nil（⛔ 不用 0 顶上）。
func TestParseNetDevColumnGuards(t *testing.T) {
	samples := parseNetDev("Inter-|   Receive  |  Transmit\n face |bytes ...\n  lo: 1000000 1000 0 0 0 0 0 0 1000000 1000 0 0 0 0 0 0\n  x0: 10 1\n")
	if len(samples) != 2 {
		t.Fatalf("应解析出 2 张网卡，got %d", len(samples))
	}
	if samples[0].name != "lo" || *samples[0].rxBytes != 1000000 || *samples[0].txBytes != 1000000 {
		t.Fatalf("lo 解析错误：%+v", samples[0])
	}
	if samples[1].name != "x0" || samples[1].txBytes != nil || samples[1].errs != nil {
		t.Fatalf("字段缺失时必须留 nil：%+v", samples[1])
	}
}
