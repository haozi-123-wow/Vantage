// net.go 实现网卡采集器（累计流量 / 速率 / 错误丢包 / 连接数）。
//
// 依据：docs/agent.md §3（net 行）、§4.8（网卡过滤）、docs/database.md §5.7.2
//（`net.rx_bps|tx_bps` bytes/s、`net.rx_total|tx_total` bytes、`net.conn_count` 个、
// `net.err|drop` **次/s**，维度 `{device}`）。
//
// 数据源：`{root}/net/dev`（16 个数字字段）+ `{root}/net/tcp`、`{root}/net/tcp6`（连接数）。
//
// 职责边界：只写 `s.Metrics.Net`。网卡被过滤 / 名字超长 → 跳过该网卡并打 WARN，不让整次采集失败。
//
// ⚠️ 五个踩坑点：
//  1. `net.err` / `net.drop` 是**速率**（次/s），不是累计值 —— §5.7.2 的单位栏写的是"次/s"。
//     发累计值会让面板上出现一条只涨不落的曲线，看起来像"错误在无限增长"。
//  2. `net.conn_count` 只数 **ESTABLISHED**（`st` 字段 = `01`）：LISTEN（`0A`）不是连接，
//     把它算进去会让"连接数"等于"监听端口数 + 已建立连接数"，在 Web 服务器上永远虚高。
//  3. `/proc/net/tcp6` 里会出现 **IPv4-mapped** 地址（`::ffff:a.b.c.d`），内核按
//     4 个 32 位字（各自小端）打印成 32 个十六进制字符。不还原成 IPv4 的话，
//     双栈机器上"走 IPv4 的已建立连接"会全部数不到任何网卡上（恒为 0）。
//  4. 网卡名异常长（虚拟化/容器场景下可能出现）同样会让指标全名超 200 字符 →
//     中心整批 400，所以产出前用 metric.Build 预检。
//  5. `net.dev` 里的网卡不一定在 `net.Interfaces()` 里（容器里只挂载了宿主 /proc 时就是这样）。
//     这种网卡**不写 conn_count**（留 nil）而不是写 0：写 0 是"采到了 0 个连接"，
//     而我们其实根本没有它的地址表。
package collector

import (
	"context"
	"encoding/hex"
	"log/slog"
	"net"
	"strings"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/metric"
	"vantage-agent/internal/model"
)

// netConnCountBase conn_count 的基名：net 派生序列里最长的一个，用来预检全名长度。
const netConnCountBase = "net.conn_count"

// netEstablished /proc/net/tcp 的状态码（十六进制）：01 = ESTABLISHED。
const netEstablished = "01"

// netDevSample 一次 /proc/net/dev 采样（nil 字段 = 该列不可用）。
type netDevSample struct {
	name    string
	rxBytes *float64
	txBytes *float64
	errs    *float64 // rx_errs + tx_errs
	drops   *float64 // rx_drop + tx_drop
}

// netDevDevice 单个网卡的差分器。
type netDevDevice struct {
	rxBytes rateTracker
	txBytes rateTracker
	errs    rateTracker
	drops   rateTracker
}

// netCollector 网卡采集器。
type netCollector struct {
	cfg  *config.Config
	root string
	now  clock
	log  *slog.Logger

	// ifaceAddrs 注入"本机网卡 → 地址列表"。
	// ⚠️ 做成字段是为了可测：连接数归集的关键逻辑（本端地址属于哪张网卡）必须能脱离
	//    本机真实网卡来验证，否则测试只能"在开发机上碰巧跑通"。
	ifaceAddrs func() map[string][]net.IP

	devs map[string]*netDevDevice

	warnDev     warnOnce
	warnName    warnOnce
	warnTooMany warnOnce
	warnNoTCP   warnOnce

	capProbed bool
	capConn   bool
}

// newNetCollector 构造网卡采集器（签名由 platform_linux.go 钉死）。
func newNetCollector(cfg *config.Config, root string) Collector {
	return &netCollector{
		cfg:        cfg,
		root:       root,
		now:        time.Now,
		log:        slog.Default(),
		ifaceAddrs: systemIfaceAddrs,
		devs:       map[string]*netDevDevice{},
	}
}

func (c *netCollector) Name() string { return "net" }

func (c *netCollector) Interval() time.Duration { return c.cfg.Collect.Net.Interval.Std() }

// Capabilities 声明连接数能力（能不能读到 /proc/net/tcp）。
func (c *netCollector) Capabilities() map[string]bool {
	if !c.capProbed {
		c.capProbed = true
		_, errTCP := readFileTrimmed(c.root, "net/tcp")
		_, errTCP6 := readFileTrimmed(c.root, "net/tcp6")
		c.capConn = errTCP == nil || errTCP6 == nil
	}
	return map[string]bool{"net.conn_count": c.capConn}
}

// Collect 采集一次。⛔ produced=false 时保持 s.Metrics.Net 原样。
func (c *netCollector) Collect(_ context.Context, s *Snapshot) (bool, error) {
	content, err := readFileTrimmed(c.root, "net/dev")
	if err != nil {
		c.warnDev.warn(c.log, "读不到 /proc/net/dev，本轮跳过网卡采集",
			"path", procPath(c.root, "net/dev"), "err", err)
		return false, nil
	}

	samples := parseNetDev(content)
	if len(samples) == 0 {
		c.warnDev.warn(c.log, "解析 /proc/net/dev 没有得到任何网卡，本轮跳过网卡采集",
			"path", procPath(c.root, "net/dev"))
		return false, nil
	}

	at := c.now()

	// 连接数：一次读两个文件、一次归集，所有网卡共用（每张网卡各读一遍纯属浪费）。
	localIPs, hasTCP := c.establishedLocalIPs()
	var connByDev map[string]uint32
	var ifaceAddrs map[string][]net.IP
	if hasTCP {
		ifaceAddrs = c.ifaceAddrs()
		connByDev = countConnsByDevice(localIPs, ifaceAddrs)
	}
	c.capConn = hasTCP
	c.capProbed = true
	if !hasTCP {
		c.warnNoTCP.warn(c.log, "读不到 /proc/net/tcp{,6}，本轮不产出连接数",
			"root", c.root)
	}

	rows := make([]model.Net, 0, len(samples))
	for _, sample := range samples {
		if !c.cfg.Filters.Net.DeviceAllowed(sample.name) {
			continue
		}
		if len(sample.name) > model.MaxDeviceLen {
			c.warnName.warn(c.log, "网卡名超长，已跳过（维度值是必填的，无法降级）",
				"device_len", len(sample.name), "limit", model.MaxDeviceLen)
			continue
		}
		// ⛔ 预检指标全名：超长会让中心整批 400（连 CPU/内存一起丢）。
		if _, err := metric.Build(netConnCountBase, map[string]string{"device": sample.name}); err != nil {
			c.warnName.warn(c.log, "网卡的指标全名会超长/非法，已跳过（否则中心整批 400）",
				"device", sample.name, "err", err)
			continue
		}

		row := model.Net{Device: sample.name}
		dev := c.device(sample.name)
		if v := sample.rxBytes; v != nil {
			row.RxTotal = v
			row.RxBps = f64p(dev.rxBytes.rate(*v, at))
		}
		if v := sample.txBytes; v != nil {
			row.TxTotal = v
			row.TxBps = f64p(dev.txBytes.rate(*v, at))
		}
		if v := sample.errs; v != nil {
			row.Err = f64p(dev.errs.rate(*v, at))
		}
		if v := sample.drops; v != nil {
			row.Drop = f64p(dev.drops.rate(*v, at))
		}
		if hasTCP {
			// ⚠️ 只对"我们确实知道地址"的网卡写连接数：未知网卡写 0 是伪造数据。
			if _, known := ifaceAddrs[sample.name]; known {
				row.ConnCount = u32p(connByDev[sample.name])
			}
		}

		rows = append(rows, row)
	}

	if len(rows) == 0 {
		// 全被过滤：本轮没有新数据。⛔ 不写空数组冒充"这台机器没有网卡"。
		return false, nil
	}
	if len(rows) > model.MaxNets {
		c.warnTooMany.warn(c.log, "网卡数量超过中心上限，已截断",
			"rows", len(rows), "limit", model.MaxNets)
		rows = rows[:model.MaxNets]
	}

	s.Metrics.Net = rows
	return true, nil
}

// device 取（或建）某网卡的差分器。
func (c *netCollector) device(name string) *netDevDevice {
	if d, ok := c.devs[name]; ok {
		return d
	}
	d := &netDevDevice{}
	c.devs[name] = d
	return d
}

// establishedLocalIPs 读 /proc/net/tcp 与 /proc/net/tcp6，返回所有 ESTABLISHED 连接的本端地址。
func (c *netCollector) establishedLocalIPs() ([]net.IP, bool) {
	var out []net.IP
	any := false
	for _, rel := range []string{"net/tcp", "net/tcp6"} {
		content, err := readFileTrimmed(c.root, rel)
		if err != nil {
			continue
		}
		any = true
		out = append(out, parseEstablishedLocalIPs(content)...)
	}
	if !any {
		return nil, false
	}
	return out, true
}

// parseEstablishedLocalIPs 从 /proc/net/tcp（或 tcp6）的内容里取出 ESTABLISHED 连接的**本端**地址。
//
// ✅ 纯函数：输入文件内容、输出地址列表。连接数这类逻辑没法"真去连一堆 TCP 再断言"，
// 拆成纯函数之后就能用夹具覆盖 IPv4 / IPv4-mapped IPv6 / 各种非 ESTABLISHED 状态。
//
// 行格式：`sl local_address rem_address st …`（字段 1 是本端、字段 3 是状态，均为十六进制）。
func parseEstablishedLocalIPs(content string) []net.IP {
	var out []net.IP
	for _, line := range splitLines(content) {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue // 表头行（`sl local_address …`）会在这里被丢掉
		}
		if fields[3] != netEstablished {
			continue // LISTEN(0A) / TIME_WAIT(06) / CLOSE_WAIT(08) … 都不是"连接"
		}
		host := fields[1]
		if i := strings.LastIndexByte(host, ':'); i >= 0 {
			host = host[:i] // 去掉 `:端口`（端口不影响归属判断）
		}
		if ip, ok := parseProcNetAddr(host); ok {
			out = append(out, ip)
		}
	}
	return out
}

// parseProcNetAddr 解析 /proc/net/tcp{,6} 的地址列。
//
// ⚠️ 内核按"内存里的 32 位字"打印，每个字是**小端**，所以：
//   - IPv4（8 个十六进制字符）：整体字节序要反过来：`0100007F` → 127.0.0.1；
//   - IPv6（32 个字符）：**每 4 个字节一组**各自反过来（`FFFF0000` → bytes 00 00 FF FF）。
//
// 不做这个倒序的话，所有地址都是错的（`0100007F` 会变成 1.0.0.127），
// 而错误只表现为"连接数永远是 0"，没有任何报错。
func parseProcNetAddr(s string) (net.IP, bool) {
	switch len(s) {
	case 8: // IPv4
		b, err := hex.DecodeString(s)
		if err != nil {
			return nil, false
		}
		reverseBytes(b)
		return net.IP(b), true
	case 32: // IPv6（含 IPv4-mapped）
		b, err := hex.DecodeString(s)
		if err != nil {
			return nil, false
		}
		for i := 0; i+4 <= len(b); i += 4 {
			reverseBytes(b[i : i+4])
		}
		return net.IP(b), true
	default:
		return nil, false
	}
}

func reverseBytes(b []byte) {
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
}

// ipKey 把地址归一成比较键。
//
// ✅ **IPv4-mapped 的还原就发生在这里**：`net.IP.To4()` 会把 `::ffff:a.b.c.d` 还原成 4 字节 IPv4，
// 于是"tcp6 文件里的 ::ffff:10.0.0.5"与"网卡的 IPv4 地址 10.0.0.5"能对上。
// ⛔ 不要用 String() 直接比较：同一地址的 16 字节映射形式与 4 字节形式的字符串不同。
func ipKey(ip net.IP) string {
	if ip == nil {
		return ""
	}
	if v4 := ip.To4(); v4 != nil {
		return "4:" + v4.String()
	}
	if v6 := ip.To16(); v6 != nil {
		return "6:" + v6.String()
	}
	return ""
}

// countConnsByDevice 按网卡地址把本端 IP 归集到网卡。
//
// ✅ 纯函数：网卡地址表是**入参**，⛔ 不在函数里调 net.Interfaces()。
// 这样测试才能构造"这台机器有哪些网卡和地址"，而不是依赖跑测试的那台机器。
//
// ⚠️ 一个地址出现在多张网卡上（bond 与 slave、容器与宿主共享地址）时会各计一次：
// 地址确实同时属于它们，按维度各报一份是唯一诚实的做法（把连接数全记在其中一张上才是错的）。
func countConnsByDevice(localIPs []net.IP, ifaceAddrs map[string][]net.IP) map[string]uint32 {
	byIP := map[string][]string{}
	for dev, ips := range ifaceAddrs {
		for _, ip := range ips {
			k := ipKey(ip)
			if k == "" {
				continue
			}
			byIP[k] = append(byIP[k], dev)
		}
	}

	out := map[string]uint32{}
	for _, ip := range localIPs {
		k := ipKey(ip)
		if k == "" {
			continue
		}
		for _, dev := range byIP[k] {
			out[dev]++
		}
	}
	return out
}

// systemIfaceAddrs 列出本机网卡及其地址（net.Interfaces 属标准库，各平台都可用）。
//
// ⚠️ 失败时返回空 map 而不是 nil：调用方据此判断"这张网卡我们不知道地址"→ 不写 conn_count，
// 而不是把 nil map 解引用 panic。
func systemIfaceAddrs() map[string][]net.IP {
	out := map[string][]net.IP{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifi := range ifaces {
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			out[ifi.Name] = append(out[ifi.Name], ipnet.IP)
		}
	}
	return out
}

// parseNetDev 解析 `{root}/net/dev`。
//
// 每行：`iface: rx_bytes rx_packets rx_errs rx_drop … tx_bytes tx_packets tx_errs tx_drop …`（共 16 个数字）。
//
// ⚠️ 只取需要的 6 列（rx_bytes / rx_errs / rx_drop / tx_bytes / tx_errs / tx_drop），
// 且**逐列判存在**：容器/虚拟网卡上出现过字段被裁剪的输出，缺列时对应指标留 nil，
// ⛔ 不用 0 顶上（0 会被当成"采到了"）。
func parseNetDev(content string) []netDevSample {
	var out []netDevSample
	for _, line := range splitLines(content) {
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			continue // 表头两行（`Inter-|   Receive …`）没有冒号或冒号在开头
		}
		name := strings.TrimSpace(line[:colon])
		if name == "" {
			continue
		}
		nums := strings.Fields(line[colon+1:])

		sample := netDevSample{name: name}
		if v, ok := atofField(nums, 0); ok {
			sample.rxBytes = f64(v)
		}
		if v, ok := atofField(nums, 8); ok {
			sample.txBytes = f64(v)
		}
		rxErr, okRxErr := atofField(nums, 2)
		txErr, okTxErr := atofField(nums, 10)
		if okRxErr || okTxErr {
			// ✅ Err/Drop 是"次/s"：这里先把 rx+tx 合成一个累计计数，再由差分器求速率。
			sample.errs = f64(sumOK(rxErr, okRxErr, txErr, okTxErr))
		}
		rxDrop, okRxDrop := atofField(nums, 3)
		txDrop, okTxDrop := atofField(nums, 11)
		if okRxDrop || okTxDrop {
			sample.drops = f64(sumOK(rxDrop, okRxDrop, txDrop, okTxDrop))
		}
		out = append(out, sample)
	}
	return out
}

// sumOK 把"可能缺失的两个数"相加：缺的那个按 0 计。
// ⚠️ 只有在一侧存在时才调用（两侧都缺时调用方留 nil）——否则会得到一个凭空的 0。
func sumOK(a float64, okA bool, b float64, okB bool) float64 {
	if okA && okB {
		return a + b
	}
	if okA {
		return a
	}
	return b
}
