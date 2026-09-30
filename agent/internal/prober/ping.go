// 本文件：`ping` 探活的**目标解析 + 降级策略 + ICMP 报文处理**（docs/agent.md §4、§4.4、G8）。
//
// 分层（✅ 已定设计，别把这两层混在一起）：
//   - 本文件不带构建标签 → 目标解析、报文构造/校验、降级判定在任何平台都能跑单测；
//   - ping_linux.go / ping_other.go 只负责「怎么开一个 ICMP socket」。
//     这样「Linux 上 ping 探活到底怎么降级」这件事不需要一台 Linux 才能验证。
//
// 职责边界与踩坑：
//   - ⛔ 不要求、不检查提权。`setcap cap_net_raw+ep` 只是 docs §4.4 给出的 opt-in 手段，
//     代码里既不能假设它存在，也不能因为缺它而失败 —— 缺权限时唯一正确的反应是降级。
//   - ⛔ 非特权 ICMP 不可用时**自动降级为 TCP 探测并打 WARN**：
//     静默降级最坏 —— 面板上 ping 全红，运维会去查目标网络，
//     而真正的原因是本机 net.ipv4.ping_group_range 没放开。
//   - ⚠️ 降级判定必须与「目标不可达」严格分开：目标 ping 不通是**结果**（up=false），
//     ICMP 不可用是**能力问题**（降级 + capability=false）。把两者混起来的后果是
//     一台没开 ping_group_range 的机器会让所有 ping 探活永远失败，且看起来像目标挂了。
package prober

import (
	"context"
	"encoding/binary"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
)

// ===========================================================================
// ICMP 报文常量（RFC 792；IPv4 的 echo）
// ===========================================================================

const (
	icmpEchoRequest = 8 // type=8 code=0：Echo Request
	icmpEchoReply   = 0 // type=0 code=0：Echo Reply

	// icmpHeaderLen ICMP 头长度：type(1) + code(1) + checksum(2) + rest(4)。
	icmpHeaderLen = 8

	// icmpEchoIDOffset / icmpEchoSeqOffset 是 rest 字段在报文里的偏移。
	// ⚠️ 这两个值写错的表现是「报文能发出去、永远收不到匹配的回复」，
	// 排查时看起来像"对方不回 ping"，极难定位。
	icmpEchoIDOffset  = 4
	icmpEchoSeqOffset = 6

	// icmpPayloadLen 需要**偶数**：odsChecksum 对奇数长度做补零处理，
	// 长度固定成偶数可以让「构造」与「校验」两条路径的字节数完全一致，减少一类 off-by-one。
	icmpPayloadLen = 16

	// 非特权 ICMP socket 的协议号（Linux：net.ipv4.ping_group_range 决定权限）。
	ipprotoICMP = 1
)

// pingProbeID 本进程所有 ping 探活共用的 ICMP identifier。
//
// ⚠️ 为什么用一个进程级随机值而不是每条探活一个：
//   - 收到的回复靠 (identifier, sequence) 匹配，identifier 固定 + sequence 自增
//     已足以把「本进程发出的请求的回复」与「同机其它 ping 程序的回复」分开；
//   - 每条探活各用一个 identifier 会让人误以为「identifier 是探活的身份」，
//     而它其实只是内核回包路由的一个标签 —— 真正的身份是上报里的 name。
//
// 用 time.Now() 纳秒取低位做随机化：非特权 ping socket 由内核**改写** identifier
// 用于内部匹配，再原样写回，所以两端一致性由内核保证，我们只需要一个不撞车的初值。
var pingProbeID = uint16(time.Now().UnixNano())

// pingSeq 序列号（同一进程内递增，配合 identifier 一起校验回复归属）。
//
// ⚠️ 必须递增而不是每条探活固定：探活周期 30s、timeout 2s 时，上一轮的迟到回复
// 可能在下一轮才到达；固定序列号会让它被当成本轮的回复认领，量出一个错误的延迟。
var pingSeq atomic.Uint32

// ===========================================================================
// 报文构造与校验（纯函数，单测的主要落点）
// ===========================================================================

// buildICMPEcho 构造一个 ICMP Echo Request（含校验和）。
//
// 报文布局（RFC 792 §Echo or Echo Reply Message）：
//
//	 0                   1                   2                   3
//	 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|     Type      |     Code      |          Checksum             |
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|           Identifier          |        Sequence Number        |
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|     Data ...
//	+-+-+-+-+-+-+-+-+
//
// ⛔ payload 只放可识别的固定字节：不放主机名/时间戳之类的信息，
// 因为 ICMP 报文在链路上明文可见，而且它的用途只是「确认这是我们的包」。
func buildICMPEcho(id, seq uint16) []byte {
	b := make([]byte, icmpHeaderLen+icmpPayloadLen) // make 已清零，data 先全 0
	b[0] = icmpEchoRequest
	b[1] = 0
	binary.BigEndian.PutUint16(b[icmpEchoIDOffset:], id)
	binary.BigEndian.PutUint16(b[icmpEchoSeqOffset:], seq)
	for i := icmpHeaderLen; i < len(b); i++ {
		b[i] = byte(i - icmpHeaderLen)
	}
	binary.BigEndian.PutUint16(b[2:4], icmpChecksum(b))
	return b
}

// icmpChecksum 计算 ICMP 校验和（RFC 1071：16 位反码求和再取反）。
//
// ⚠️ 校验和字段自身在计算时必须按 0 处理：调用方要么传一个校验和字段为 0 的报文，
// 要么用 verifyICMPChecksum（它在内部先把字段清零）。
func icmpChecksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(b[i : i+2]))
	}
	if len(b)%2 == 1 {
		// 奇数长度：最后一个字节按高位字节处理（低 8 位补 0）。
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

// verifyICMPChecksum 校验一个收到的报文：把校验和字段置 0 后重算，应与原值相同。
//
// ⚠️ 这里必须复制一份再置零，⛔ 不能就地改：收到的切片是复用的读缓冲，
// 就地修改会把内核缓冲区里的字节改坏（下一次 ReadFrom 读到的就是被污染的包）。
func verifyICMPChecksum(b []byte) bool {
	if len(b) < icmpHeaderLen {
		return false
	}
	want := binary.BigEndian.Uint16(b[2:4])
	cp := make([]byte, len(b))
	copy(cp, b)
	cp[2], cp[3] = 0, 0
	return icmpChecksum(cp) == want
}

// isEchoReplyTo 判断收到的报文是不是「我们这次请求」的 echo reply。
//
// 逐项都要判，缺一项就会出现一类误报：
//   - 不看 type：会把自己发出去的 echo request 回环当成回复（本机回路场景真实存在）；
//   - 不看 id/seq：会认领同机其它 ping 程序（或上一次探活迟到的）回复，
//     表现为延迟莫名其妙地极小（几微秒）且抖动极大；
//   - 不校验校验和：损坏的包会被当成有效回复，面板显示健康而实际链路有问题。
func isEchoReplyTo(pkt, sent []byte) bool {
	if len(pkt) < icmpHeaderLen || len(sent) < icmpHeaderLen {
		return false
	}
	if pkt[0] != icmpEchoReply || pkt[1] != 0 {
		return false
	}
	if binary.BigEndian.Uint16(pkt[icmpEchoIDOffset:]) != binary.BigEndian.Uint16(sent[icmpEchoIDOffset:]) {
		return false
	}
	if binary.BigEndian.Uint16(pkt[icmpEchoSeqOffset:]) != binary.BigEndian.Uint16(sent[icmpEchoSeqOffset:]) {
		return false
	}
	return verifyICMPChecksum(pkt)
}

// ===========================================================================
// 目标解析与降级判定（纯函数）
// ===========================================================================

// splitHostPort 拆出 host 与 port。
//
// 覆盖三种写法：
//
//	"1.1.1.1"      → ("1.1.1.1", "", true)      // 没端口
//	"1.1.1.1:80"   → ("1.1.1.1", "80", true)
//	"[2001:db8::1]:80" → ("2001:db8::1", "80", true)
//
// ⛔ ok=false 表示「配置有歧义」而不是「没端口」：`dns.example.com:443` 这种主机名
// 冒号形式无法与 IPv6 字面量区分，硬拆会把主机名截断成 `dns.example.com:4` 之类，
// 于是探活永远失败而用户看不出原因。调用方应把它当作一条明确的失败结果。
func splitHostPort(host string) (string, string, bool) {
	h := strings.TrimSpace(host)
	if h == "" {
		return "", "", false
	}
	if strings.HasPrefix(h, "[") {
		if !strings.Contains(h, "]") {
			return "", "", false // 括号没闭合，无法判断端口从哪开始
		}
	}
	n, p, err := net.SplitHostPort(h)
	if err == nil {
		if n == "" {
			// ":80" —— 没写主机，ping 就没有目标可言。
			return "", "", false
		}
		// ⚠️ 带了端口但主机部分不是 IP 字面量、也没用方括号包起来：
		//    这正是 `dns.example.com:443` 这类「主机名冒号端口」写法 ——
		//    与 IPv6 字面量无法区分（文档见上），必须判为歧义而不是硬拆。
		//    （方括号写法 `[主机名]:443` 用户意图明确，放行。）
		if !strings.HasPrefix(h, "[") && net.ParseIP(n) == nil {
			return "", "", false
		}
		return n, p, true
	}
	// 走到这里说明 SplitHostPort 失败了：可能是「确实没带端口」，也可能是有歧义。
	if !strings.Contains(h, ":") {
		return h, "", true // 没有任何冒号 = 纯主机名/IP，无歧义
	}
	if strings.Count(h, ":") > 1 {
		// 多个冒号且没被方括号包起来：这只是 IPv6 字面量（如 fe80::1），没有端口。
		// ⚠️ 必须在括号检查之后判，且只按"多个冒号"判 —— 单冒号才是有歧义的情况。
		return h, "", true
	}
	return "", "", false // 单冒号但 SplitHostPort 失败 = 歧义写法
}

// tcpTargetsForHost 给出「降级为 TCP 探测」时要依次尝试的 host:port。
//
// ✅ 已定策略（任务书 §ping 降级）：
//   - host 里带了端口 → 就用该端口（用户已经明确了要探哪个端口）；
//   - 没带端口 → 依次尝试 :80 与 :443，**哪个先连通算成功**。
//
// ⚠️ 为什么不是"只探 80"：一台只开 443 的机器会被判成不可达，
// 而那正是最该被监控的形态（只跑 HTTPS 的服务）。
// ⚠️ 为什么不是"只探 443"：对称的问题。两个都试的代价只是一次连接尝试。
func tcpTargetsForHost(host string) []string {
	h, port, ok := splitHostPort(host)
	if !ok {
		return nil
	}
	if port != "" {
		return []string{net.JoinHostPort(h, port)}
	}
	return []string{net.JoinHostPort(h, "80"), net.JoinHostPort(h, "443")}
}

// ===========================================================================
// 平台接线（不带构建标签的薄壳）
// ===========================================================================
//
// 这些包装函数本身**不含任何平台逻辑**，只是把 syscall 类型挡在平台文件里：
// ping_linux.go / ping_other.go 各自实现 newICMPSocketPlatform / mustECAPPlatform，
// 而 ping.go 只跟 net.PacketConn 打交道 —— 于是「降级到 TCP」这类逻辑
// 在任何平台都能编译、也都能单测（构建标签只留在"怎么开 socket"那一层）。

// newICMPSocket 打开一个 ICMP socket（平台实现见 ping_linux.go / ping_other.go）。
func newICMPSocket() (packetConn, error) {
	return newICMPSocketPlatform()
}

// mustECAP 报告本机是否允许非特权 ICMP（平台实现见 ping_linux.go / ping_other.go）。
func mustECAP() bool { return mustECAPPlatform() }

// packetConn 是 ICMP socket 的最小接口（net.PacketConn + Close）。
//
// ⚠️ 之所以额外要求 Close：net.FilePacketConn 返回的是**新的** fd
// （原 fd 已经交给它），必须显式关闭，否则每次探活泄漏一个 fd，
// 几百个探活周期后就是 EMFILE —— 而它的表现是"所有探活突然全挂"，很难联想到套接字泄漏。
type packetConn interface {
	net.PacketConn
	Close() error
}

// ===========================================================================
// 可用性判定（缓存）
// ===========================================================================

// pingAvailOnce 保证可用性只探测一次。
//
// ⚠️ 不缓存会怎样：每条 ping 探活每个周期都去开一次 ICMP socket，而探测结论
// （net.ipv4.ping_group_range 是否放开）在一次运行里几乎不会变，纯粹是浪费；
// 更糟的是"每次探活都吞掉一次权限错误"会让日志被同一句话刷满。
var (
	pingAvailOnce   sync.Once
	pingAvailResult bool
)

// pingAvailable 报告本机是否允许**非特权** ICMP。
//
// ⛔ 只用来决定"走 ICMP 还是降级为 TCP"，绝不参与「目标是否可达」的判断，
// 更不会导致崩溃：拿不到权限本身就是一种可预期的运行状态（✅ §4.4）。
func pingAvailable() bool {
	pingAvailOnce.Do(func() {
		pingAvailResult = mustECAP()
		if pingAvailResult {
			slog.Debug("非特权 ICMP 可用（probe.ping 走 ICMP echo）")
			return
		}
		// ✅ WARN 只打一次：这是"能力"而不是"某次探活的结果"，
		//    每次探活都打会把真正有用的告警淹掉（而且 capability 已声明为 false）。
		slog.Warn("非特权 ICMP 不可用：ping 探活将自动降级为 TCP 探测",
			"reason", "本机不允许创建 ICMP ping socket（Linux 上是 net.ipv4.ping_group_range / 缺 CAP_NET_RAW）",
			"note", "面板上 probe.ping=false；opt-in 的 setcap cap_net_raw+ep 只是可选项，⛔ 不是本 Agent 的要求")
	})
	return pingAvailResult
}

// resetPingAvailabilityCache 让下一次 pingAvailable() 重新探测。
// ⚠️ 只给测试用：单测需要制造「ICMP 不可用」的场景，而进程级缓存会把它粘住。
func resetPingAvailabilityCache() {
	pingAvailOnce = sync.Once{}
	pingAvailResult = false
}

// pingDegradeWarnOnce 保证「降级」这条 WARN 只打一次。
var pingDegradeWarnOnce sync.Once

// logPingDegraded 在真正降级时提示一次。
//
// ⛔ 必须与 pingAvailable() 里那条 WARN 分开：那条说的是"本机不支持 ICMP"（能力），
// 这条说的是"这条探活这一轮实际走了 TCP"（行为）。用户排查时看的是后者。
// ⛔ 日志里不得出现凭证：这里只打 name 与 host，⛔ 不打印整份探活配置。
func logPingDegraded(name, host, tcpTarget string) {
	pingDegradeWarnOnce.Do(func() {
		slog.Warn("ping 探活已降级为 TCP 探测（结果语义已改变，面板上的 ping 实际是端口连通性）",
			"probe", name, "host", host, "tcp_target", tcpTarget,
			"error_hint", "已降级为 TCP 探测")
	})
}

// ===========================================================================
// ping 探活器
// ===========================================================================

// pingProber 一条 ping 探活。
type pingProber struct {
	probeMeta
	// host 供 ICMP 解析用（可能是 `1.1.1.1`，也可能是 `1.1.1.1:80`）。
	host    string
	timeout time.Duration
}

// newPingProber 构造 ping 探活器。
func newPingProber(pb *config.ProbeBlock) Prober {
	return &pingProber{
		probeMeta: probeMeta{
			name:     pb.Name,
			typ:      pb.Type,
			target:   pb.Host, // ✅ Target() 返回**原始的** host 字符串
			interval: pb.Interval.Std(),
		},
		host:    pb.Host,
		timeout: pb.Timeout.Std(),
	}
}

// Probe 执行一次 ping 探活。
//
// ⛔ 总是返回 model.Probe：ICMP 不可用、目标不可达、配置有歧义，全都是结果。
func (p *pingProber) Probe(ctx context.Context) model.Probe {
	timeout := probeTimeout(ctx, p.timeout)
	return p.probeWith(ctx, timeout, pingAvailable())
}

// probeWith 把「可用性」作为参数传进来，而不是在内部直接问 pingAvailable()。
//
// ✅ 为什么这样设计：可用性是进程级缓存的一次性探测，测试没法在同一个进程里
// 既验证「ICMP 可用」又验证「ICMP 不可用」两条路径。把它变成入参后，
// 两条路径都成了纯函数式的、可重复的断言 —— 降级逻辑因此不再依赖运行环境。
func (p *pingProber) probeWith(ctx context.Context, timeout time.Duration, icmpOK bool) model.Probe {
	if !icmpOK {
		return p.probeViaTCP(ctx, timeout, "本机不支持非特权 ICMP")
	}
	return p.probeViaICMP(ctx, timeout)
}

// probeViaICMP 走真正的 ICMP echo。
func (p *pingProber) probeViaICMP(ctx context.Context, timeout time.Duration) model.Probe {
	ip, err := resolveProbeIP(p.host)
	if err != nil {
		return p.failResult(err.Error())
	}

	// ⚠️ 这里再判一次可用性：可用性判定是缓存的，但 socket 可能因为
	// （进程内）fd 耗尽等运行期原因开不出来 —— 那种情况也必须降级，不是崩溃。
	sock, err := newICMPSocket()
	if err != nil {
		return p.probeViaTCP(ctx, timeout, "ICMP socket 打开失败："+classNetErr(err))
	}

	start := time.Now()
	roundTripErr := icmpEchoRoundTrip(sock, ip, timeout)
	_ = sock.Close()
	if roundTripErr != nil {
		// ⚠️ 目标不回包就是 up=false（这属于"结果"），**不**降级：
		//    降级只在"本机没有 ICMP 能力"时发生（见 probeWith）。
		//    把"ping 不通"也降级成 TCP 会让一条真的网络故障显示成健康。
		return p.failResult(fmt.Sprintf("ICMP echo 到 %s 无应答：%s", ip, classNetErr(roundTripErr)))
	}
	elapsed := time.Since(start).Seconds() * 1000
	return newSuccess(p.probeMeta, elapsed)
}

// probeViaTCP 降级：对同一 host 做 TCP 连通性探测，并把"已降级"写进 error 文案与日志。
//
// ⚠️ error 文案必须写明降级：否则面板上只会看到一条「up=false 的 ping」，
// 用户会去查目标网络，而真正的原因是本机 ICMP 不可用。
func (p *pingProber) probeViaTCP(ctx context.Context, timeout time.Duration, why string) model.Probe {
	targets := tcpTargetsForHost(p.host)
	if len(targets) == 0 {
		// 配置有歧义（如 dns.example.com:443 这种无法与 IPv6 区分的写法）：
		// 直接给出可执行的修法，而不是静默探一个猜出来的目标。
		return p.failResult(fmt.Sprintf(
			"ping 目标 %q 无法解析（%s）；主机名请写成 [主机名]:端口，或换成它解析到的 IP",
			p.host, why))
	}

	var attempts []string
	for i, t := range targets {
		start := time.Now()
		dialTimeout := probeTimeout(ctx, timeout)
		// ⚠️ 分给每个候选端口的预算要共享总超时：两个候选各等满 timeout
		//    会让一条探活吃掉 2×timeout，直接推迟本次上报。
		if len(targets) > 1 {
			dialTimeout = dialTimeout / time.Duration(len(targets)-i)
		}
		conn, err := (&net.Dialer{Timeout: dialTimeout}).DialContext(ctx, "tcp", t)
		if err != nil {
			attempts = append(attempts, fmt.Sprintf("%s：%s", t, classNetErr(err)))
			// ⚠️ ctx 被取消/超时后继续试下一个端口没有意义，只会把取消拖成两倍耗时。
			if ctx.Err() != nil {
				break
			}
			continue
		}
		elapsed := time.Since(start).Seconds() * 1000
		_ = conn.Close() // ⛔ 不发送任何数据，连上就关
		logPingDegraded(p.name, p.host, t)
		pr := newSuccess(p.probeMeta, elapsed)
		// ✅ 这里**故意**不在成功结果里写 error：error 字段的语义是"为什么没成功"，
		//    而语义变化这件事已经通过日志 WARN + host.capabilities["probe.ping"]=false
		//    告知中心了。给成功结果塞 error 会让面板把它渲染成一条失败的探活。
		return pr
	}

	logPingDegraded(p.name, p.host, targets[0])
	return p.failResult(fmt.Sprintf(
		"已降级为 TCP 探测（%s）：%s", why, strings.Join(attempts, "；")))
}

// failResult 统一构造 ping 的失败结果（⛔ 不返回 error）。
func (p *pingProber) failResult(msg string) model.Probe {
	return withError(newFailure(p.probeMeta), msg)
}

// resolveProbeIP 把配置里的 host 解析成 ICMP 需要的 IPv4 地址。
//
// ⛔ 只解析、不"猜测修正"：
//   - 解析失败（DNS 挂了/主机名写错）本身就是探活要发现的事实，如实上报；
//   - 解析到 IPv6 时报错并说明原因，而不是退回 IPv4：本文件实现的是 IPv4 ICMP
//     （AF_INET / ip4:icmp），拿一个 IPv6 地址去建 socket 会以 ENETUNREACH 之类的
//     面目失败，看起来像网络故障。
func resolveProbeIP(host string) (net.IP, error) {
	h, _, ok := splitHostPort(host)
	if !ok {
		return nil, fmt.Errorf("主机名 %q 无法解析（主机名带端口时请写成 [主机名]:端口）", host)
	}
	if ip := net.ParseIP(h); ip != nil {
		if ip.To4() == nil {
			return nil, fmt.Errorf("目标是 IPv6 地址（%s），本期只实现了 IPv4 ICMP", h)
		}
		return ip.To4(), nil
	}
	addrs, err := net.LookupIP(h)
	if err != nil {
		return nil, fmt.Errorf("DNS 解析失败（%s）：%s", h, classNetErr(err))
	}
	for _, a := range addrs {
		if v4 := a.To4(); v4 != nil {
			return v4, nil
		}
	}
	return nil, fmt.Errorf("主机名 %s 没有 A 记录（只解析到 IPv6 地址）", h)
}

// icmpEchoRoundTrip 发一个 echo request，等一个匹配的 echo reply（成功时返回 nil）。
//
// ⚠️ 超时由 PacketConn 的 SetDeadline 提供（裸 fd 没有 deadline 概念 ——
// 这正是把 fd 包成 net.PacketConn 的原因，见 ping_linux.go）。⛔ 不用 time.Sleep
// 轮询，也不开 goroutine 去"到点关 socket"（那会让 ReadFrom 的错误语义变模糊）。
//
// ⚠️ 只发一个包、只等一个回复：ping 探活要回答的是「通不通」，不是丢包率。
// 收紧成单包后最坏耗时 = timeout，可预测；否则探活耗时会在 1×~N× timeout 之间抖动，
// 让整批上报的窗口变得不可控。
func icmpEchoRoundTrip(sock net.PacketConn, ip net.IP, timeout time.Duration) error {
	sent := buildICMPEcho(pingProbeID, uint16(pingSeq.Add(1)))
	addr := &net.IPAddr{IP: ip}

	if err := sock.SetDeadline(time.Now().Add(timeout)); err != nil {
		return fmt.Errorf("设置读超时失败：%w", err)
	}
	if _, err := sock.WriteTo(sent, addr); err != nil {
		return fmt.Errorf("发送 ICMP 请求失败：%w", err)
	}

	buf := make([]byte, 1500) // 单个 ICMP 回包不会超过 MTU，1500 足够
	for {
		n, from, err := sock.ReadFrom(buf)
		if err != nil {
			return err // 超时/取消都在这里冒出来，交给 classNetErr 翻译
		}
		if from != nil && from.String() != ip.String() {
			// ⚠️ 来源不匹配的包直接丢弃继续等：ping socket 上可能混进同机其它进程的回复，
			//    认领它会让延迟小得离谱（看起来像本机回环）。
			continue
		}
		if !isEchoReplyTo(buf[:n], sent) {
			continue
		}
		return nil
	}
}

// ---------------------------------------------------------------------------
// 编译期断言：三个探活器都必须满足 Prober（⛔ 少了实现会一直编到调度器才炸）
// ---------------------------------------------------------------------------

var (
	_ Prober = (*httpProber)(nil)
	_ Prober = (*tcpProber)(nil)
	_ Prober = (*pingProber)(nil)
)
