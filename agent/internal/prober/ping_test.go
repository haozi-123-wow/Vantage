// 本文件：`ping` 探活的单元测试（**纯函数 + 平台无关的降级路径**）。
//
// 分层对应源码的分层：
//   - ICMP 报文构造/校验、目标解析、降级判定 → 本文件（任何平台都能跑）；
//   - 「怎么开 ICMP socket」→ ping_linux_test.go（带构建标签）。
//
// ⛔ 全部离线：只碰 127.0.0.1 与 .invalid 这种永不解析的域名，
// ⛔ 不 ping 任何公网地址（断网 CI 下必须仍然全绿）。
//
// ⚠️ 校验和与 reply 匹配是这层最容易写错的两处。因此：
//   - 固定向量给出**手算的期望字节**（推导过程写在注释里）；
//   - 另加一个**独立实现**的参考校验和（referenceChecksum，按字节折叠，与生产实现的
//     "按 16 位字求和"是两条不同的代码路径）作为交叉验证 —— 只断言"实现自己算出来
//     的数"等于写死的常量，等于把实现的 bug 也一起写进期望值。
package prober

import (
	"context"
	"encoding/binary"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
)

// ---------------------------------------------------------------------------
// ICMP 校验和（RFC 1071）
// ---------------------------------------------------------------------------

func TestICMPChecksumKnownVectors(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want uint16
		why  string
	}{
		{
			name: "全零 4 字节",
			in:   []byte{0x00, 0x00, 0x00, 0x00},
			want: 0xffff,
			why:  "和 = 0，取反得 0xffff（进位折叠的必然结果；若实现直接把 0 当校验和就错了）",
		},
		{
			name: "奇数长度 3 字节 0x000102",
			in:   []byte{0x00, 0x01, 0x02},
			want: 0xfdfe,
			why:  "末字节按高位补零：0x0001 + 0x0200 = 0x0201，取反 = 0xfdfe",
		},
		{
			name: "奇数长度补零等价性 0x00010200",
			in:   []byte{0x00, 0x01, 0x02, 0x00},
			want: 0xfdfe,
			why:  "与上一条必须同值：证明"补零在低位"而不是"丢弃末字节"",
		},
		{
			name: "0x0001f203",
			in:   []byte{0x00, 0x01, 0xf2, 0x03},
			want: 0x0dfb,
			why:  "和 = 0x0001 + 0xf203 = 0xf204，取反 = 0x0dfb",
		},
		{
			name: "ICMP echo 头（type=8 code=0 id=0x1234 seq=0x0001，校验和字段先置 0）",
			in:   []byte{0x08, 0x00, 0x00, 0x00, 0x12, 0x34, 0x00, 0x01},
			want: 0xe5ca,
			why:  "和 = 0x0800 + 0x1234 + 0x0001 = 0x1235 + 0x0800 = 0x1a35…取反 = 0xe5ca（0x1a35 无进位，折叠后不变）",
		},
	}
	for _, c := range cases {
		if got := icmpChecksum(c.in); got != c.want {
			t.Errorf("%s：icmpChecksum(% x) = %#04x，期望 %#04x（%s）", c.name, c.in, got, c.want, c.why)
		}
		// ✅ 交叉验证：独立实现的参考校验和必须给出同一个答案。
		if ref := referenceChecksum(c.in); ref != c.want {
			t.Errorf("%s：独立参考实现给出 %#04x，与期望 %#04x 不符（说明期望值或实现之一有误）",
				c.name, ref, c.want)
		}
	}
}

func TestICMPChecksumVerifyProperty(t *testing.T) {
	// ✅ RFC 1071 的验证规则：把校验和填回报文后，整包（含校验和字段）求和再取反应为 0。
	//    这条性质比任何单个常量都强：它对"随机"报文也成立，能抓住进位折叠、字节序、
	//    奇偶长度处理这几类错误。
	for _, pkt := range [][]byte{
		{0x08, 0x00, 0x00, 0x00, 0x12, 0x34, 0x00, 0x01},
		{0x00, 0x00, 0x00, 0x00},
		{0xff, 0xff, 0xff, 0xff},
		{0x08, 0x00, 0x00, 0x00, 0xab, 0xcd, 0x12, 0x34, 0xaa},             // 奇数长度
		{0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0xde, 0xad, 0xbe}, // 奇数长度 + 高字节
	} {
		work := clone(pkt)
		work[2], work[3] = 0, 0
		binary.BigEndian.PutUint16(work[2:4], icmpChecksum(work))
		if sum := icmpChecksum(work); sum != 0 {
			t.Fatalf("填入校验和后整包应为 0，实际 %#04x（报文 % x）", sum, work)
		}
		if !verifyICMPChecksum(work) {
			t.Fatalf("verifyICMPChecksum 应通过：% x", work)
		}
		// 改一个 bit 就必须失败（否则脏包会被当成有效回复）。
		work[0] ^= 0x01
		if verifyICMPChecksum(work) {
			t.Fatalf("被改动的报文不得通过校验：% x", work)
		}
	}
}

// referenceChecksum 是 RFC 1071 校验和的**独立实现**，只用于测试交叉验证。
//
// ⚠️ 它刻意用不同的代码路径：生产实现按 16 位字（binary.BigEndian.Uint16）求和，
// 这里按字节累加成 32 位和再折叠 —— 两条路径同时写错的概率远低于一条。
//
//	来源：RFC 1071 §2「the 16-bit one's complement of the one's complement sum」，
//	按字节累加时等价于把每对字节当作 (hi<<8)+lo。
func referenceChecksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i < len(b); i++ {
		// 偶数下标为高位字节：b[i] << 8；奇数下标为低位字节。
		if i%2 == 0 {
			sum += uint32(b[i]) << 8
		} else {
			sum += uint32(b[i])
		}
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

// ---------------------------------------------------------------------------
// 报文构造
// ---------------------------------------------------------------------------

func TestBuildICMPEchoLayout(t *testing.T) {
	const id, seq = 0xabcd, 0x0007
	pkt := buildICMPEcho(id, seq)

	// 长度：8 字节头 + 固定 payload（payload 取偶数是刻意的，见源码注释）。
	if want := icmpHeaderLen + icmpPayloadLen; len(pkt) != want {
		t.Fatalf("报文长度应为 %d，实际 %d", want, len(pkt))
	}
	// type=8 code=0：Echo Request（RFC 792）。
	if pkt[0] != icmpEchoRequest {
		t.Fatalf("type 应为 %d（echo request），实际 %d", icmpEchoRequest, pkt[0])
	}
	if pkt[1] != 0 {
		t.Fatalf("code 应为 0，实际 %d", pkt[1])
	}
	// id/seq 必须落在 offset 4/6（写错 offset 的表现是"发得出去、永远收不到回复"）。
	if got := binary.BigEndian.Uint16(pkt[icmpEchoIDOffset:]); got != id {
		t.Fatalf("identifier 位置有误：得到 %#04x，期望 %#04x", got, id)
	}
	if got := binary.BigEndian.Uint16(pkt[icmpEchoSeqOffset:]); got != seq {
		t.Fatalf("sequence 位置有误：得到 %#04x，期望 %#04x", got, seq)
	}
	// 校验和字段必须真的被填上，且整包能通过验证。
	if binary.BigEndian.Uint16(pkt[2:4]) == 0 {
		t.Fatal("构造后校验和字段不能为 0")
	}
	if !verifyICMPChecksum(pkt) {
		t.Fatalf("构造出来的报文未通过自身校验和验证：% x", pkt)
	}
}

func TestBuildICMPEchoKnownBytes(t *testing.T) {
	// ✅ 固定向量：id=0x1234、seq=0x0001、payload = 0x00..0x0f。
	//
	// 期望校验和 0xad8a 的推导（RFC 1071，校验和字段先按 0 参与求和）：
	//
	//	0x0800 (type+code) + 0x0000 (校验和字段) + 0x1234 (id) + 0x0001 (seq) = 0x1a35
	//	payload 16 字节相邻两两求和：0x0000+0x0101+…+0x0707 = 8 × 0x0101 = 0x0808
	//	总和 = 0x1a35 + 0x0808 = 0x223d → 折叠（无溢出位）→ 取反 = 0xdcc2
	//
	// ⚠️ 上面这串手算只用于说明口径；下面接一个**独立实现**（referenceChecksum）
	// 做交叉验证，避免"手算错一个数就把期望值写错"。
	want := []byte{
		0x08, 0x00, 0xad, 0x8a, // type code checksum
		0x12, 0x34, 0x00, 0x01, // identifier sequence
		0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
		0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
	}
	pkt := buildICMPEcho(0x1234, 0x0001)
	if string(pkt) != string(want) {
		t.Fatalf("固定向量不符：\n得到 % x\n期望 % x", pkt, want)
	}

	// 独立参考实现对同一个报文（校验和字段置 0）的计算必须等于 0xad8a。
	zeroed := clone(want)
	zeroed[2], zeroed[3] = 0, 0
	if got := referenceChecksum(zeroed); got != 0xad8a {
		t.Fatalf("独立参考实现给出 %#04x，与固定向量 0xad8a 不符", got)
	}
	if got := icmpChecksum(zeroed); got != 0xad8a {
		t.Fatalf("生产实现给出 %#04x，与固定向量 0xad8a 不符", got)
	}
}

// ---------------------------------------------------------------------------
// echo reply 匹配（⛔ 最容易误报的一处）
// ---------------------------------------------------------------------------

func TestIsEchoReplyTo(t *testing.T) {
	sent := buildICMPEcho(0x1234, 0x0001)
	reply := replyTo(sent) // 构造一个"正确"的回复

	if !isEchoReplyTo(reply, sent) {
		t.Fatal("匹配的 echo reply 必须被认领")
	}

	// ① type 不对：把自己发出去的 echo request 回环当成回复。
	//    真实场景：探测本机自己的 IP 时内核可能把请求回显回来，
	//    认领它会让延迟量成"几乎为 0"。
	bad := clone(reply)
	bad[0] = icmpEchoRequest
	if isEchoReplyTo(bad, sent) {
		t.Fatal("type=8（echo request）不得被当成回复认领")
	}

	// ② code 非 0：只有 code=0 的 echo reply 才算正常应答。
	bad = clone(reply)
	bad[1] = 1
	if isEchoReplyTo(bad, sent) {
		t.Fatal("code≠0 的 ICMP 包不得被认领")
	}

	// ③ identifier 不同：同机其它 ping 程序的回复。认领它会让延迟与结果都不可信。
	bad = clone(reply)
	binary.BigEndian.PutUint16(bad[icmpEchoIDOffset:], 0x9999)
	rechecksum(bad)
	if isEchoReplyTo(bad, sent) {
		t.Fatal("identifier 不同的回复不得被认领")
	}

	// ④ sequence 不同：上一轮迟到的回复。认领它会让延迟量成一个偏小的错误值。
	bad = clone(reply)
	binary.BigEndian.PutUint16(bad[icmpEchoSeqOffset:], 0x0002)
	rechecksum(bad)
	if isEchoReplyTo(bad, sent) {
		t.Fatal("sequence 不同的回复不得被认领")
	}

	// ⑤ 校验和损坏：脏包被当成有效回复 → 面板显示健康而链路实际有问题。
	bad = clone(reply)
	bad[2] ^= 0xff
	if isEchoReplyTo(bad, sent) {
		t.Fatal("校验和错误的包不得被认领")
	}

	// ⑥ 长度不足：不能 panic，只能返回 false。
	if isEchoReplyTo([]byte{0x00}, sent) {
		t.Fatal("长度不足的包不得被认领")
	}
	if isEchoReplyTo(reply, []byte{0x08}) {
		t.Fatal("请求报文本身长度不足时不得认领")
	}
}

func TestIsEchoReplyToDoesNotMutateInput(t *testing.T) {
	// ⚠️ verifyICMPChecksum 必须复制后再把校验和字段置零：就地把收到的包改掉，
	//    会把复用的读缓冲弄脏（下一次 ReadFrom 读到的就是被污染的包）。
	sent := buildICMPEcho(0x1234, 0x0001)
	reply := replyTo(sent)
	before := string(reply)
	_ = isEchoReplyTo(reply, sent)
	if string(reply) != before {
		t.Fatal("匹配判定不得就地修改收到的报文")
	}
}

// ---------------------------------------------------------------------------
// 目标解析 → TCP 降级候选
// ---------------------------------------------------------------------------

func TestSplitHostPort(t *testing.T) {
	cases := []struct {
		in       string
		wantHost string
		wantPort string
		wantOK   bool
	}{
		{"1.1.1.1", "1.1.1.1", "", true},
		{"1.1.1.1:80", "1.1.1.1", "80", true},
		{" 1.1.1.1:80 ", "1.1.1.1", "80", true}, // 前后空白必须容忍（从面板复制粘贴很常见）
		{"[2001:db8::1]:443", "2001:db8::1", "443", true},
		{"fe80::1", "fe80::1", "", true}, // 裸 IPv6 字面量：没有端口
		{"::1", "::1", "", true},
		{"example.com", "example.com", "", true},
		{"", "", "", false},                    // 空 → 无目标
		{"   ", "", "", false},                 // 全空白 → 无目标
		{":80", "", "", false},                 // 只有端口没有主机 → 没有可探的目标
		{"[::1", "", "", false},                // 方括号没闭合 → 无法判断端口边界
		{"dns.example.com:443", "", "", false}, // ⚠️ 单冒号主机名：与 IPv6 无法区分，必须判为歧义
	}
	for _, c := range cases {
		host, port, ok := splitHostPort(c.in)
		if ok != c.wantOK || host != c.wantHost || port != c.wantPort {
			t.Errorf("splitHostPort(%q) = (%q, %q, %v)，期望 (%q, %q, %v)",
				c.in, host, port, ok, c.wantHost, c.wantPort, c.wantOK)
		}
	}
}

func TestTCPTargetsForHost(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		// 没带端口 → 依次尝试 80 与 443（只探一个会误判"只开 443 的机器"不可达）。
		{"1.1.1.1", []string{"1.1.1.1:80", "1.1.1.1:443"}},
		{"example.com", []string{"example.com:80", "example.com:443"}},
		// 带了端口 → 就用用户指定的那个（他明确知道要探什么）。
		{"1.1.1.1:8080", []string{"1.1.1.1:8080"}},
		{"[2001:db8::1]:443", []string{"[2001:db8::1]:443"}},
		// 有歧义的写法 → 没有候选（调用方给出一条可照着改的失败结果）。
		{"dns.example.com:443", nil},
		{"", nil},
	}
	for _, c := range cases {
		got := tcpTargetsForHost(c.in)
		if len(got) != len(c.want) {
			t.Errorf("tcpTargetsForHost(%q) = %v，期望 %v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("tcpTargetsForHost(%q)[%d] = %q，期望 %q", c.in, i, got[i], c.want[i])
			}
		}
	}
}

func TestResolveProbeIP(t *testing.T) {
	// 字面量 IPv4：不查 DNS，直接可用。
	ip, err := resolveProbeIP("127.0.0.1")
	if err != nil {
		t.Fatalf("IPv4 字面量应可解析：%v", err)
	}
	if !ip.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatalf("解析结果应为 127.0.0.1，实际 %v", ip)
	}
	// 带端口也要能解析出主机的 IP。
	if ip, err = resolveProbeIP("127.0.0.1:80"); err != nil || !ip.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatalf("带端口的 IPv4 应解析出主机 IP：ip=%v err=%v", ip, err)
	}
	// ⛔ IPv6 明确报错而不是"退回 IPv4"：本期实现的是 AF_INET 的 ICMP，
	//    拿 IPv6 去建 socket 会以网络错误的面目失败，看起来像目标挂了。
	if _, err := resolveProbeIP("::1"); err == nil || !strings.Contains(err.Error(), "IPv6") {
		t.Fatalf("IPv6 目标应给出明确的不支持错误，实际 %v", err)
	}
	// 有歧义的写法：错误信息必须能指导用户改（否则他只能猜）。
	if _, err := resolveProbeIP("dns.example.com:443"); err == nil || !strings.Contains(err.Error(), "[主机名]:端口") {
		t.Fatalf("歧义写法应给出可照改的错误文案，实际 %v", err)
	}
	// 永不解析的域名（RFC 2606）：必须是失败而不是 panic。
	if _, err := resolveProbeIP("nonexistent-host.invalid"); err == nil {
		t.Fatal(".invalid 域名不应解析成功")
	}
}

// ---------------------------------------------------------------------------
// 降级路径（⛔ 硬约束：ICMP 不可用 → 自动走 TCP + WARN，绝不静默、绝不崩溃）
// ---------------------------------------------------------------------------

// pingProbeBlock 造一条 ping 探活配置。
func pingProbeBlock(host string, timeout time.Duration) *config.ProbeBlock {
	return &config.ProbeBlock{
		Name:     "ping-under-test",
		Type:     "ping",
		Host:     host,
		Timeout:  config.Duration(timeout),
		Interval: config.Duration(30 * time.Second),
	}
}

// newTestPingProber 造一条 ping 探活器（断言类型转换成功，避免用例里到处写 type assertion）。
func newTestPingProber(t *testing.T, host string, timeout time.Duration) *pingProber {
	t.Helper()
	p, ok := newPingProber(pingProbeBlock(host, timeout)).(*pingProber)
	if !ok {
		t.Fatal("newPingProber 应返回 *pingProber")
	}
	return p
}

// mustErrText 取失败结果的 error 文案（⛔ 失败却没文案本身就是 bug，直接 Fatal）。
func mustErrText(t *testing.T, res model.Probe) string {
	t.Helper()
	if res.Error == nil || *res.Error == "" {
		t.Fatal("失败结果必须带非空 error 文案（探活失败是结果，不是异常）")
	}
	return *res.Error
}

func TestPingDegradesToTCPWhenICMPUnavailable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("起本地监听失败：%v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close() // ⛔ 不接受任何数据，连上就关
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	host := net.JoinHostPort("127.0.0.1", itoa(port))

	// 带端口的 host：降级后就用这个端口。
	p := newTestPingProber(t, host, 2*time.Second)

	// ✅ 关键断言：icmpOK=false 时**走的是 TCP**。
	start := time.Now()
	res := p.probeWith(context.Background(), 2*time.Second, false)
	if !res.Up {
		t.Fatalf("降级到本地监听端口应成功，error=%q", errText(res.Error))
	}
	if res.LatencyMS == nil || *res.LatencyMS < 0 {
		t.Fatalf("降级成功也应带 latency_ms，实际 %v", res.LatencyMS)
	}
	// ⚠️ 本地 TCP 连接建立应该很快：若这里其实走了 ICMP（不该发生），
	//    在 ICMP 不可用的本机必然超时 2s，这条断言会立刻抓住。
	if elapsed := time.Since(start); elapsed > 1500*time.Millisecond {
		t.Fatalf("降级应走 TCP（本地连接几乎瞬时），实际耗时 %v —— 疑似仍走了 ICMP", elapsed)
	}
	// ✅ 成功结果里**不带** error：error 字段的语义是"为什么没成功"，
	//    语义变化由日志 WARN + capabilities 告知中心（见 ping.go 的注释）。
	if res.Error != nil {
		t.Fatalf("降级成功时 error 字段应为 nil，实际 %q", *res.Error)
	}
	// target 仍是配置里的原始 host（⛔ 不因为降级就改成别的形式）。
	if res.Target != host {
		t.Fatalf("target 应保持原始 host %q，实际 %q", host, res.Target)
	}
	if res.Type != "ping" {
		t.Fatalf("降级后 type 仍应是配置里的 ping（语义变化靠 error/日志体现），实际 %q", res.Type)
	}
}

func TestPingDegradeNoPortTriesBoth80And443(t *testing.T) {
	// 不带端口 → 依次试 80、443。
	// ⚠️ 本机可能真的有服务在监听 80/443（开发机上很常见），
	//    所以这里对"两种结局"都做严格断言，而不是假定必然失败。
	p := newTestPingProber(t, "127.0.0.1", 400*time.Millisecond)
	res := p.probeWith(context.Background(), 400*time.Millisecond, false)

	if res.Up {
		// 降级成功：必须有 latency，且不得带 error。
		if res.LatencyMS == nil {
			t.Fatal("降级成功必须带 latency_ms")
		}
		if res.Error != nil {
			t.Fatalf("降级成功不应带 error，实际 %q", *res.Error)
		}
		return
	}
	msg := mustErrText(t, res)
	if !strings.Contains(msg, "已降级为 TCP 探测") {
		t.Fatalf("error 文案必须说明「已降级为 TCP 探测」，否则面板上看不出探活语义变了；实际 %q", msg)
	}
	for _, want := range []string{":80", ":443"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error 文案应列出尝试过的候选端口 %q，实际 %q", want, msg)
		}
	}
}

func TestPingUnsupportedICMPAlwaysReturnsResult(t *testing.T) {
	// ⛔ 硬约束：ICMP 不可用时**不能崩溃、不能返回 error**，必须有 up=false + error 文案
	//    （或降级成功）。这里用一个**确定不可达**的端口，让"降级成功"不可能发生，
	//    从而稳定地断言失败形态。
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("ICMP 不可用时不得 panic：%v", r)
		}
	}()

	port := freePort(t) // 刚释放的端口：探它必然失败
	p := newTestPingProber(t, port, 300*time.Millisecond)
	res := p.probeWith(context.Background(), 300*time.Millisecond, false)

	if res.Up {
		t.Fatal("端口没有监听时降级探测必须 up=false")
	}
	msg := mustErrText(t, res)
	if !strings.Contains(msg, "已降级为 TCP 探测") {
		t.Fatalf("失败文案必须带降级说明，实际 %q", msg)
	}
	if len(msg) > maxProbeErrorBytes {
		t.Fatalf("error 文案超长：%d > %d", len(msg), maxProbeErrorBytes)
	}
	if res.StatusCode != nil {
		t.Fatalf("ping 探活不得填 status_code，实际 %v", *res.StatusCode)
	}
	if res.Name != "ping-under-test" || res.Type != "ping" || res.Target != port {
		t.Fatalf("降级结果必须保留元数据：name=%q type=%q target=%q", res.Name, res.Type, res.Target)
	}
}

func TestPingAmbiguousHostGivesActionableError(t *testing.T) {
	// `dns.example.com:443` 无法与 IPv6 区分：降级路径必须给出一条可照着改的失败结果，
	// ⛔ 不能静默探一个猜出来的目标（那会让用户以为"这个名字探通了"）。
	p := newTestPingProber(t, "dns.example.com:443", time.Second)
	res := p.probeWith(context.Background(), time.Second, false)
	if res.Up {
		t.Fatal("有歧义的 host 必须 up=false")
	}
	msg := mustErrText(t, res)
	if !strings.Contains(msg, "无法解析") && !strings.Contains(msg, "[主机名]:端口") {
		t.Fatalf("错误文案应给出可执行的修法，实际 %q", msg)
	}
	if res.Target != "dns.example.com:443" {
		t.Fatalf("target 应保持原始字符串，实际 %q", res.Target)
	}
}

func TestPingNoAnswerIsResultNotDegradation(t *testing.T) {
	// ⚠️ 目标不回 ICMP 与"本机没有 ICMP 能力"是两件事：
	//    ping 不通是**结果**（up=false + 超时文案），⛔ 不能降级成 TCP
	//    —— 否则一条真实的网络故障会被显示成健康。
	//
	// 用一个本地 UDP socket 冒充 ICMP socket：本地 UDP 不会产生 ICMP echo reply，
	// 因此这条路径必然在 timeout 内超时（离线、确定、不需要任何权限）。
	sock, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("起本地 UDP（模拟 ICMP socket）失败：%v", err)
	}
	defer sock.Close()

	start := time.Now()
	rtErr := icmpEchoRoundTrip(sock, net.IPv4(127, 0, 0, 1), 200*time.Millisecond)
	if rtErr == nil {
		t.Fatal("本地 UDP socket 不该收到 ICMP echo reply")
	}
	if got := classNetErr(rtErr); !strings.Contains(got, "超时") {
		t.Fatalf("没收到应答应翻成「超时」，实际 %q", got)
	}
	// ⚠️ 必须由 deadline 到点结束，而不是"很快返回一个别的错误"：
	//    后者说明读超时没生效（裸 fd 没有 deadline，这正是包成 PacketConn 的原因）。
	if elapsed := time.Since(start); elapsed < 150*time.Millisecond {
		t.Fatalf("应在约 200ms 的 deadline 上超时，实际 %v —— 读超时可能没生效", elapsed)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("读超时应严格受 deadline 约束，实际 %v", elapsed)
	}
}

func TestPingTargetKeepsOriginalHost(t *testing.T) {
	cases := []string{"1.1.1.1", "1.1.1.1:80", "[2001:db8::1]:443", "example.com"}
	for _, host := range cases {
		p := newPingProber(pingProbeBlock(host, time.Second))
		if p.Target() != host {
			t.Errorf("Target() = %q，期望原始 host %q", p.Target(), host)
		}
	}
}

// ---------------------------------------------------------------------------
// 可用性与能力声明
// ---------------------------------------------------------------------------

func TestPingAvailableIsIdempotentAndCached(t *testing.T) {
	// ⚠️ 可用性结论必须缓存且稳定：每次探活都开一次 socket 是浪费，
	//    而"结论会变"会让降级行为不可预测（同样的配置一会走 ICMP 一会走 TCP）。
	first := pingAvailable()
	second := pingAvailable()
	if first != second {
		t.Fatalf("缓存失效：两次调用返回 %v / %v", first, second)
	}

	var wg sync.WaitGroup
	results := make([]bool, 16)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = pingAvailable()
		}(i)
	}
	wg.Wait()
	for i, r := range results {
		if r != first {
			t.Fatalf("第 %d 次并发调用得到 %v，与首次 %v 不一致", i, r, first)
		}
	}
}

func TestCapabilitiesBindsProbePingToAvailability(t *testing.T) {
	// ✅ 面板靠 capabilities 提示"本机 ping 探活已降级"，
	//    所以 probe.ping 必须等于 pingAvailable()，⛔ 不能恒为 true。
	ps := New(&config.Config{Probes: []config.ProbeBlock{
		{Name: "p", Type: "ping", Host: "127.0.0.1", Timeout: config.Duration(time.Second), Interval: config.Duration(30 * time.Second)},
		{Name: "h", Type: "http", URL: "http://127.0.0.1:1/", Timeout: config.Duration(time.Second), Interval: config.Duration(30 * time.Second)},
	}})
	caps := Capabilities(ps)
	if got, want := caps["probe.ping"], pingAvailable(); got != want {
		t.Fatalf("capabilities[probe.ping] = %v，应与 pingAvailable() = %v 一致", got, want)
	}
	if !caps["probe.http"] {
		t.Fatalf("配了 http 探活就应声明 probe.http=true：%v", caps)
	}
	// ⛔ 没配的探活类型不得凭空声明能力（中心按能力下发面板展示）。
	if _, ok := caps["probe.tcp"]; ok {
		t.Fatalf("未配置 tcp 探活时不应声明 probe.tcp：%v", caps)
	}
}

func TestNewICMPSocketDoesNotPanic(t *testing.T) {
	// ⛔ 硬约束：拿不到 ICMP socket 是**可预期的正常状态**（§4.4），不得 panic。
	//    非 Linux 上这里恒失败（占位实现），Linux 上取决于 ping_group_range。
	//    两种结局都必须只是"成功拿到 socket 并关掉"或"拿到一个普通 error"。
	sock, err := newICMPSocket()
	if err != nil {
		if err.Error() == "" {
			t.Fatal("失败时错误信息不能为空（日志里会变成一句没有信息的话）")
		}
		return
	}
	if err := sock.Close(); err != nil {
		t.Fatalf("关闭 ICMP socket 失败：%v", err)
	}
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

func TestClassNetErrOnRealSocketTimeout(t *testing.T) {
	// 用**真实**的 socket 超时（不是伪造的 net.Error）：确认它被翻成「超时」。
	sock, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("起本地 UDP 失败：%v", err)
	}
	defer sock.Close()
	if err := sock.SetDeadline(time.Now().Add(30 * time.Millisecond)); err != nil {
		t.Fatalf("设置 deadline 失败：%v", err)
	}
	buf := make([]byte, 8)
	_, _, readErr := sock.ReadFrom(buf)
	if readErr == nil {
		t.Fatal("到点后 ReadFrom 应返回超时错误")
	}
	ne, ok := readErr.(net.Error)
	if !ok || !ne.Timeout() {
		t.Fatalf("期望一个超时类 net.Error，实际 %v", readErr)
	}
	if got := classNetErr(readErr); !strings.Contains(got, "超时") {
		t.Fatalf("socket 超时应翻成「超时」，实际 %q", got)
	}
}

func TestClassNetErrOnRealConnRefused(t *testing.T) {
	// TCP 探活用例已覆盖连接被拒绝；这里再钉一次分类函数的输出（它是所有探活共用的）。
	port := freePort(t)
	conn, err := net.DialTimeout("tcp", port, time.Second)
	if err != nil {
		if got := classNetErr(err); !strings.Contains(got, "连接被拒绝") {
			t.Fatalf("连接被拒绝应翻成对应中文，实际 %q", got)
		}
		return
	}
	_ = conn.Close()
	t.Skip("本机刚释放的端口又可以被连接，跳过（不影响分类函数的其他用例）")
}

// clone 复制报文（测试里构造"坏包"用，⛔ 不能就地改原始报文）。
func clone(b []byte) []byte {
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

// replyTo 把一个 echo request 变成"正确的" echo reply（type=0，重算校验和）。
func replyTo(sent []byte) []byte {
	out := clone(sent)
	out[0] = icmpEchoReply
	out[2], out[3] = 0, 0
	binary.BigEndian.PutUint16(out[2:4], icmpChecksum(out))
	return out
}

// rechecksum 重算校验和字段（构造坏包后让它重新"自洽"）。
func rechecksum(pkt []byte) {
	pkt[2], pkt[3] = 0, 0
	binary.BigEndian.PutUint16(pkt[2:4], icmpChecksum(pkt))
}

// itoa 小工具（避免为了一个端口号引入 strconv 到多个测试文件里）。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
