// 本文件：`http` / `https` 探活（docs/agent.md §4「本地探活」）。
//
// 职责边界：
//   - 只管「发一次请求、判断是否算成功、量出耗时」；⛔ 不校验、不修正 URL
//     （补 scheme、去尾斜杠这类"顺手修正"属于 config 的职责，在这里做会让
//     配置错误在本地被掩盖，用户以为配的是 https，实际探的是 http）。
//   - ⛔ 没有任何从中心取目标的代码路径：target 只能来自 pb.URL（本机 config.yaml）。
//
// 踩坑提醒（每条都对应一种真实故障）：
//   - ⛔ 响应体必须读完再 Close：不读完的连接无法复用，每次探活都要重新握手，
//     面板上的延迟会凭空多出一个 RTT，而且高并发时会把本机端口耗光。
//   - ⚠️ body_contains 只读前 maxBodyRead 字节：一条返回几百 MB 的接口足以把
//     Agent 的内存顶爆（§4.3 给 Agent 的预算是「空闲 20–30MB」）。
//   - ⚠️ latency_ms 量到「读完全部（或到上限的）响应体」为止，不是拿到响应头为止：
//     否则一个「头很快、身体很慢」的接口（正是最该被发现的那类）会显示成健康。
//   - ⛔ https 走系统默认证书校验，不提供 InsecureSkipVerify 开关：关掉校验的探活
//     只是"TCP 通不通"的昂贵版本，证书过期/域名不匹配这类最该报警的故障会全部漏掉。
package prober

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
	"vantage-agent/internal/version"
)

const (
	// maxBodyRead 读取响应体的上限（64KB）。body_contains 只在前缀里找：
	// 探活关心的是「服务有没有正常应答」，不是「把整个响应体搬回家」。
	maxBodyRead = 64 * 1024

	// maxErrText 驱动错误文案的截断上限。
	// 非 2xx 时驱动会把响应体前 100 字节塞进错误里，对端返回一个 10MB 的 HTML
	// 会让 error 字段超长；虽然 writeProbeError 兜底到 512B，这里先截一道更省内存。
	maxErrText = 200
)

// defaultTimeout 兜底超时。
// ⚠️ 配置校验保证 timeout ≥ 100ms，但 New() 也可能被非 config 路径直接调用，
// 缺了兜底会让 http.Client Timeout=0 变成**永不超时** —— 一个挂死的探活会拖住整批上报。
const defaultTimeout = 5 * time.Second

// maxAllowedTimeout 单个探活自身的耗时天花（与 ctx 取小值后生效）。
//
// ⚠️ 探活是「顺带做」的事：它吃掉的每一秒都直接推迟本次上报。
// 默认 report.interval=30s，一条探活不该超过它太多。
const maxAllowedTimeout = 30 * time.Second

// maxProbeErrorBytes 中心对 `probes[].error` 的长度上限（model.MaxProbeError，512 字节）。
//
// ⛔ 超长不是"被截断"而是整批 400：一条 DNS 错误里塞着几十个 resolver 地址、
// 或者 body_contains 不符时把 HTML 塞进错误文案，都能轻易越过 512 字节。
const maxProbeErrorBytes = model.MaxProbeError

// syscall 错误码的别名。
//
// ⚠️ 单独起这三个名字是为了让 classify 那几行读起来就是"连接被拒绝 / 网络不可达 /
// 主机不可达"三件事，而不是一串 syscall 常量；它们在各平台上的数值不同，
// 用 errors.Is 比较即可，⛔ 不要改成字符串匹配（见 classNetErr 的注释）。
var (
	syscallECONNREFUSED = syscall.ECONNREFUSED
	syscallENETUNREACH  = syscall.ENETUNREACH
	syscallEHOSTUNREACH = syscall.EHOSTUNREACH
)

// errTruncated 文案截断的可见标记。
// ⚠️ 必须有标记：不然运维会把截断当成"错误原文就长这样"，去搜一个不存在的报错。
const errTruncated = "…(已截断)"

// probeMeta 与探活类型无关的公共元数据（name / type / target / interval）。
//
// 为什么用嵌入而不是各自写一遍：中心按 name 区分探活、按 type 选语义，
// 这几个字段一旦在某个实现里写错，面板上是"两条探活互相覆盖"这种极难查的现象。
type probeMeta struct {
	name     string
	typ      string
	target   string
	interval time.Duration
}

func (m probeMeta) Name() string            { return m.name }
func (m probeMeta) Type() string            { return m.typ }
func (m probeMeta) Target() string          { return m.target }
func (m probeMeta) Interval() time.Duration { return m.interval }
func (m probeMeta) failing() model.Probe    { return newFailure(m) }
func (m probeMeta) succeeded(latency float64) model.Probe {
	return newSuccess(m, latency)
}

// newFailure 构造一条「探活失败」的结果。
//
// ⛔ 三条硬约束的落点：探活失败是**结果**（up=false），不是异常 —— 调用方永远
// 不需要猜「返回零值是什么意思」，中心也永远能区分「没这条探活」和「探不通」。
func newFailure(m probeMeta) model.Probe {
	return model.Probe{Name: m.name, Type: m.typ, Target: m.target, Up: false}
}

// newSuccess 构造一条成功结果；latency 单位毫秒。
func newSuccess(m probeMeta, latency float64) model.Probe {
	ms := latency
	return model.Probe{Name: m.name, Type: m.typ, Target: m.target, Up: true, LatencyMS: &ms}
}

// withError 给失败结果补上 error 文案（统一在这里截断，避免各处漏掉中心 512 字节的上限）。
func withError(p model.Probe, msg string) model.Probe {
	s := truncateUTF8(msg, maxProbeErrorBytes)
	p.Error = &s
	return p
}

// truncateUTF8 按**字节**上限截断，并保证结果仍是合法 UTF-8。
//
// ⚠️ 中心的 512 是字节数，不是字符数：只按 rune 截会在中文文案上超标，
// 只按字节截又会把最后一个汉字劈成半个 —— 半个 UTF-8 序列会让 JSON 里出现替换字符，
// 运维看到的错误文案直接变成乱码。
func truncateUTF8(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	keep := limit - len(errTruncated)
	if keep < 0 {
		keep = 0
	}
	for keep > 0 && !utf8.ValidString(s[:keep]) {
		keep--
	}
	return s[:keep] + errTruncated
}

// probeTimeout 把「配置超时」与「调用方 ctx 的 deadline」取小。
//
// ⚠️ 为什么不能只用 pb.Timeout：调度器整批探活的 ctx 可能只剩 200ms，
// 而某条探活的 timeout 是 5s —— 只按配置走会让这条探活独占 5s，
// 后面的探活与整批上报一起被推迟（而且超时时刻正好落在上报窗口里）。
//
// 为什么要给天花：单条探活的 timeout 配成 5m 也能通过配置校验，
// 那等于让探活线程池被一条挂死的探活长期占住。
func probeTimeout(ctx context.Context, cfg time.Duration) time.Duration {
	d := cfg
	if d <= 0 {
		d = defaultTimeout
	}
	if d > maxAllowedTimeout {
		d = maxAllowedTimeout
	}
	if deadline, ok := ctx.Deadline(); ok {
		if left := time.Until(deadline); left < d {
			d = left
		}
	}
	if d <= 0 {
		// ctx 已过期：给一个正数让 net 立即失败，而不是变成「无超时」。
		d = time.Millisecond
	}
	return d
}

// classNetErr 把网络错误翻成运维能直接照着排查的中文。
//
// ⚠️ 顺序不可调换：超时必须先判。connection refused 与 timeout 都是 net.Error，
// 但它们指向完全不同的排查方向（对端没监听 vs 中间被防火墙丢包），说错等于把用户带偏。
func classNetErr(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "超时（" + msg + "）"
	case errors.Is(err, context.Canceled):
		return "探测被取消（" + msg + "）"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "超时（" + msg + "）"
	}
	var de *net.DNSError
	if errors.As(err, &de) {
		return "DNS 解析失败（" + de.Err + "；查询名 " + de.Name + "）"
	}
	// ⛔ 不用 strings.Contains(msg, "refused") 判：文案随 Go 版本与操作系统语言变化，
	//    而 syscall 的 errno 是稳定的。
	switch {
	case errors.Is(err, syscallECONNREFUSED):
		return "连接被拒绝（对端端口没有程序在监听）"
	case errors.Is(err, syscallENETUNREACH):
		return "网络不可达（本机没有到目标的路由）"
	case errors.Is(err, syscallEHOSTUNREACH):
		return "主机不可达"
	}
	return msg
}

// ---------------------------------------------------------------------------
// http / https
// ---------------------------------------------------------------------------

// httpProber 一条 http/https 探活。
type httpProber struct {
	probeMeta
	url          string
	method       string
	expectStatus []int  // 空 = 默认 [200]
	bodyContains string // 空 = 不检查
	timeout      time.Duration
	client       *http.Client
}

// httpTransport 所有 http 探活共用一条传输。
//
// ✅ 为什么共用而不是每个探活一个 client：http.Client 的超时是 per-client 的，
// 但**连接池在 Transport 里** —— 探活器之间的目标往往不同，共用 Transport 能复用
// 「同一目标的多次探活」之间的连接（探活周期 30s，IdleConnTimeout 60s 正好覆盖），
// 同时避免每条探活各养一组空闲连接（§4.3 的内存预算不允许）。
var httpTransport = &http.Transport{
	Proxy: http.ProxyFromEnvironment,
	DialContext: (&net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	MaxIdleConns:          8,
	MaxIdleConnsPerHost:   2,
	IdleConnTimeout:       60 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ExpectContinueTimeout: 1 * time.Second,
	// ⛔ 不设置 TLSClientConfig.InsecureSkipVerify：见文件头注释。
	//    这里显式写一个 nil 配置只是为了让「没有自定义 TLS」这件事可见。
	TLSClientConfig: nil,
}

// newHTTPProber 构造 http/https 探活器。
func newHTTPProber(pb *config.ProbeBlock) Prober {
	// ⚠️ 独立 client 只为拿 per-client 的 Timeout（Transport 仍是共用的）。
	return &httpProber{
		probeMeta: probeMeta{
			name:     pb.Name,
			typ:      pb.Type,
			target:   pb.URL,
			interval: pb.Interval.Std(),
		},
		url:          pb.URL,
		method:       normalizeMethod(pb.Method),
		expectStatus: pb.ExpectStatus,
		bodyContains: pb.BodyContains,
		timeout:      pb.Timeout.Std(),
		client:       &http.Client{Transport: httpTransport, Timeout: pb.Timeout.Std()},
	}
}

// normalizeMethod 默认 GET。
// ⚠️ 用 strings.ToUpper：`method: get` 这种写法在 http.NewRequest 里**不会报错**，
// 但会被原样发出去，某些服务端因此按未知方法返回 405 —— 表现为"探活莫名失败"。
func normalizeMethod(m string) string {
	if strings.TrimSpace(m) == "" {
		return http.MethodGet
	}
	return strings.ToUpper(strings.TrimSpace(m))
}

// expects 判断状态码是否属于期望集合（空集合按 [200]）。
func (p *httpProber) expects(code int) bool {
	if len(p.expectStatus) == 0 {
		return code == http.StatusOK
	}
	for _, want := range p.expectStatus {
		if want == code {
			return true
		}
	}
	return false
}

// Probe 执行一次 http/https 探活。
//
// ⛔ 无论失败原因是什么（DNS、连不上、超时、状态码不符、内容不符），
// 都在这里返回 model.Probe，⛔ 不返回 error。
func (p *httpProber) Probe(ctx context.Context) model.Probe {
	timeout := probeTimeout(ctx, p.timeout)

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// ⚠️ URL 直接来自配置：这里**不做任何修正/补全**。配错了就该以「请求构造失败」
	// 的面目暴露出来，而不是被本地悄悄改成另一个目标。
	req, err := http.NewRequestWithContext(reqCtx, p.method, p.url, nil)
	if err != nil {
		return withError(newFailure(p.probeMeta), fmt.Sprintf("请求构造失败（%s）：%s", p.url, classNetErr(err)))
	}
	// ✅ User-Agent 统一走 internal/version：硬编码版本号会让面板上的版本与实际二进制脱节。
	req.Header.Set("User-Agent", version.UserAgent())
	req.Header.Set("Accept", "*/*")

	start := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		// ⚠️ 这里不能改成 up=false + latency：连都没连上，延迟没有意义
		//    （nil 与 &0 的语义区别见 model.Probe 的注释）。
		return withError(newFailure(p.probeMeta), fmt.Sprintf("抓取 %s 失败：%s", p.url, classNetErr(err)))
	}
	// ⛔ 先读完再 Close（文件头注释解释了为什么）；读了上限之外的连接会被 net/http 丢弃，
	// 不会被塞回连接池 —— 这正是我们想要的：宁可重建连接，也不把未知长度的响应体拖进内存。
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxBodyRead))
	// Drain 剩余部分，让连接可以复用；LimitReader 命中上限时这里会有实际工作要做。
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxBodyRead))
	closeErr := resp.Body.Close()
	elapsed := time.Since(start).Seconds() * 1000

	status := resp.StatusCode
	statusPtr := &status

	fail := func(msg string) model.Probe {
		pr := newFailure(p.probeMeta)
		pr.StatusCode = statusPtr
		return withError(pr, msg)
	}

	if readErr != nil {
		return fail(fmt.Sprintf("读取 %s 的响应体失败（已读 %d 字节）：%s", p.url, len(body), classNetErr(readErr)))
	}
	if closeErr != nil {
		// ⚠️ 单独报告：连接关闭失败通常意味着连接被中途重置，响应体可能不完整，
		//    这时候拿它去判 body_contains 会得出错误的结论。
		return fail(fmt.Sprintf("关闭 %s 的响应体失败：%s", p.url, classNetErr(closeErr)))
	}
	if !p.expects(status) {
		return fail(fmt.Sprintf("状态码不符：期望 %s，实际 %d（响应体前缀 %q）",
			formatExpect(p.expectStatus), status, preview(body)))
	}
	if p.bodyContains != "" && !bytes.Contains(body, []byte(p.bodyContains)) {
		return fail(fmt.Sprintf("响应体不包含 %q（已读 %d 字节，前缀 %q）",
			truncateUTF8(p.bodyContains, maxErrText), len(body), preview(body)))
	}

	pr := newSuccess(p.probeMeta, elapsed)
	// ✅ status_code 填**实际**状态码，不是期望值：面板要能看出"目标返回了 503 但被配置放过"。
	pr.StatusCode = statusPtr
	return pr
}

// formatExpect 把期望状态码集合写成 `[200 204]` 这种一眼能看懂的文案。
func formatExpect(codes []int) string {
	if len(codes) == 0 {
		return "[200]（默认，未配置 expect_status）"
	}
	parts := make([]string, 0, len(codes))
	for _, c := range codes {
		parts = append(parts, fmt.Sprintf("%d", c))
	}
	return "[" + strings.Join(parts, " ") + "]"
}

// preview 取响应体前缀用于错误文案（已按 maxErrText 截断，⛔ 不会把整页 HTML 塞进 error）。
func preview(body []byte) string {
	if len(body) > maxErrText {
		body = body[:maxErrText]
	}
	// ⚠️ 经过 ToValidUTF8：对端返回 gzip/二进制或按字节截断的 UTF-8 时，
	//    直接 %q 会在日志与 error 里留下乱码甚至不可见控制字符。
	return string(bytes.ToValidUTF8(body, []byte("?")))
}

// ---------------------------------------------------------------------------
// tcp
// ---------------------------------------------------------------------------

// tcpProber 一条 tcp 连通性探活。
//
// ⛔ 不发送任何业务数据：这只是「端口通不通」的探测，乱发数据可能触发对端的协议错误，
// 甚至被对端记成一次畸形请求（例如对一台 MySQL 发一个 HTTP GET）。
type tcpProber struct {
	probeMeta
	timeout time.Duration
}

// newTCPProber 构造 tcp 探活器。host 形如 `10.0.0.5:5432`（配置校验已保证带端口）。
func newTCPProber(pb *config.ProbeBlock) Prober {
	return &tcpProber{
		probeMeta: probeMeta{
			name:     pb.Name,
			typ:      pb.Type,
			target:   pb.Host,
			interval: pb.Interval.Std(),
		},
		timeout: pb.Timeout.Std(),
	}
}

// Probe 执行一次 tcp 探活：只量「连接建立」的耗时。
func (p *tcpProber) Probe(ctx context.Context) model.Probe {
	timeout := probeTimeout(ctx, p.timeout)

	start := time.Now()
	// ✅ net.DialTimeout 的 ctx 版本：ctx 被取消时立即返回，不会等满 timeout。
	// ⚠️ 这里**故意**不发送任何数据，见 tcpProber 的注释。
	conn, err := (&net.Dialer{Timeout: timeout}).DialContext(ctx, "tcp", p.target)
	if err != nil {
		return withError(newFailure(p.probeMeta), fmt.Sprintf("连接 %s 失败：%s", p.target, classNetErr(err)))
	}
	elapsed := time.Since(start).Seconds() * 1000
	// 连接成功后立即关闭：留着会让本机端口与对端的连接数被探活慢慢吃掉。
	_ = conn.Close()

	// status_code 保持 nil：TCP 没有状态码，填 0/200 都是编造事实。
	return newSuccess(p.probeMeta, elapsed)
}

// ⛔ 本文件刻意**不解析 URL**（所以不 import net/url）：一旦在这里解析，就很容易
// 顺手"修正"它（补 scheme、去掉多写的端口）。配置错误被本地掩盖的后果是：
// 用户以为自己在探 https://a，实际探的是 http://a —— 面板上看不出任何区别。
