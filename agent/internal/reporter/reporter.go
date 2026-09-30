// Package reporter 实现上报管线：组包 → 序列化（只做一次）→ 签名 → gzip → POST → 重试。
//
// 依据：docs/agent.md §5（上报管线）、§5.2（幂等/重试/丢弃）、§5.3（网络与体积）、§6.2（签名）、
//
//	docs/api.md §2.1/§2.2（报文与响应）。
//
// ⛔ 本包最重要的三条不变式：
//
//  1. **签名用的字节 === 发送的字节**（✅ 决策 #35）。Go 里这很容易做到，但仍然只序列化一次，
//     并把同一份 `[]byte` 交给 sha256、HMAC 与 gzip —— 任何"反序列化再序列化"都会改变
//     字段顺序/空白，从而产生 401，而且本机完全看不出哪里错了。
//  2. **响应只读 `{ok, server_ts}`**（✅ 决策 #12 单向宗旨）。解析用的结构体只有这两个字段，
//     即便中心将来误加了 config/command 一类的字段，Agent 也**读不到** —— 这是把宗旨写进类型系统。
//  3. **重试只在内存里**（✅ 决策 #14）。⛔ 不落盘、不跨断网补传；仍失败就丢弃这一批，
//     由中心的离线告警覆盖数据缺口。
package reporter

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"vantage-agent/internal/auth"
	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
	"vantage-agent/internal/ulid"
	"vantage-agent/internal/version"
)

// maxResponseBytes 读取响应体的上限。
//
// ⛔ 必须设上限：响应体理论上只有 `{"ok":true,"server_ts":…}` 几十字节，
//
//	若中心端被改坏或中间有代理返回一个大页面，无上限的 io.ReadAll 会把 Agent 的内存顶爆。
//	（读干净是必要的：不读完连接无法复用，每个周期重建 TLS 握手很浪费。）
const maxResponseBytes = 4 * 1024

// Options 构造参数。
type Options struct {
	Config  *config.Config
	AgentID string
	// Key 身份凭证（`vk_` 前缀）→ `X-Agent-Key`。⛔ 只进请求头，不进日志、不进 URL。
	Key    string
	Secret []byte
	Logger *slog.Logger

	// HTTPClient 可注入（测试用 httptest.Server）。为 nil 时按配置构造。
	HTTPClient *http.Client
	// Sleep 可注入：测试里退避不该真的等 2s/4s/8s。
	Sleep func(time.Duration)
	// Now 可注入。
	Now func() time.Time
}

// Reporter 上报器。⚠️ 单实例使用；内部计数器不是为高并发设计的
// （按 ✅ §10：固定少量 goroutine，不随主机规模膨胀）。
type Reporter struct {
	cfg     *config.Config
	agentID string
	key     string
	secret  []byte
	log     *slog.Logger
	client  *http.Client
	sleep   func(time.Duration)
	now     func() time.Time

	// seq 批次序号（单调递增，中心只做展示与排障用）。
	seq uint64
	// failures 连续/累计上报失败次数 → 上报为 `agent.report_failures`（✅ G10 自监控）。
	failures atomic.Uint64
	// lastServerTS 最近一次成功响应里的 server_ts（✅ §6.5：用中心时间校正自身展示/探活记录时间）。
	lastServerTS atomic.Int64
	// reportedIP 上一次连接中心时本端的源地址，即"自测出口 IP"。
	//
	// ⚠️ 只能在**下一次**上报里带上：出口 IP 是连接建立之后才知道的，而它本身要写进报文里。
	//    这不是缺陷 —— 出口 IP 变了（换网卡/换路由）恰恰是下一次上报要报告的事情，
	//    所以"用上一次的观测值"正好是我们要的语义。
	reportedIP atomic.Value // string
}

// Response 一次成功上报的结果。
type Response struct {
	OK         bool
	ServerTS   int64
	StatusCode int
	Attempts   int
	RawBytes   int // 压缩前（= 签名覆盖的那份）字节数
	WireBytes  int // 实际发出的字节数
}

// SendError 上报失败。
type SendError struct {
	// Kind network（连不上/超时）/ server（5xx）/ rejected（4xx，重试无用）/
	// payload_too_large（413，说明 Agent 侧熔断失效）/ too_large（本地裁剪后仍超限，直接丢弃）
	Kind       string
	StatusCode int
	Attempts   int
	Detail     string
	Err        error
}

func (e *SendError) Error() string {
	if e.StatusCode > 0 {
		return fmt.Sprintf("上报失败（%s，HTTP %d，尝试 %d 次）：%s", e.Kind, e.StatusCode, e.Attempts, e.Detail)
	}
	return fmt.Sprintf("上报失败（%s，尝试 %d 次）：%s", e.Kind, e.Attempts, e.Detail)
}

func (e *SendError) Unwrap() error { return e.Err }

// New 构造上报器。
func New(opts Options) (*Reporter, error) {
	if opts.Config == nil {
		return nil, errors.New("reporter: Config 不能为空")
	}
	cfg := opts.Config

	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	r := &Reporter{
		cfg:     cfg,
		agentID: opts.AgentID,
		key:     opts.Key,
		secret:  opts.Secret,
		log:     log,
		sleep:   opts.Sleep,
		now:     opts.Now,
	}
	if r.sleep == nil {
		r.sleep = time.Sleep
	}
	if r.now == nil {
		r.now = time.Now
	}
	r.reportedIP.Store("")

	if opts.HTTPClient != nil {
		r.client = opts.HTTPClient
		return r, nil
	}

	client, err := r.buildClient()
	if err != nil {
		return nil, err
	}
	r.client = client
	return r, nil
}

// buildClient 按配置构造 HTTP 客户端（TLS / CA / mTLS / 连接复用）。
func (r *Reporter) buildClient() (*http.Client, error) {
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}

	if caFile := r.cfg.Center.TLS.CAFile; caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("读取 center.tls.ca_file 失败（%s）：%w", caFile, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("center.tls.ca_file 里没有可用的 PEM 证书：%s", caFile)
		}
		tlsCfg.RootCAs = pool
	}
	// mTLS 可选：配置校验已保证 cert/key 成对出现
	if certFile := r.cfg.Center.TLS.CertFile; certFile != "" {
		cert, err := tls.LoadX509KeyPair(certFile, r.cfg.Center.TLS.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("加载 mTLS 证书失败：%w", err)
		}
		tlsCfg.Certificates = []tls.Certificate{cert}
	}
	// ⛔ 这里**没有** InsecureSkipVerify 的分支：配置校验直接拒绝该选项，
	//    所以不存在"悄悄关掉证书校验"的代码路径（自签证书请配 ca_file）。

	timeout := r.cfg.Center.Timeout.Std()
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			conn, err := dialer.DialContext(ctx, network, addr)
			if err == nil {
				if la, ok := conn.LocalAddr().(*net.TCPAddr); ok {
					r.reportedIP.Store(la.IP.String())
				}
			}
			return conn, err
		},
		TLSClientConfig:       tlsCfg,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          4,
		MaxIdleConnsPerHost:   1, // 单实例 Agent：保持一条热连接就够，避免无谓的 TLS 握手
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   timeout,
		ResponseHeaderTimeout: timeout,
		ExpectContinueTimeout: time.Second,
	}
	return &http.Client{Transport: transport, Timeout: timeout}, nil
}

// ReportedIP 上一次观测到的本端出口 IP（首次上报前为空）。
func (r *Reporter) ReportedIP() string {
	if v, ok := r.reportedIP.Load().(string); ok {
		return v
	}
	return ""
}

// ServerTS 最近一次成功响应里的 server_ts（0 表示还没成功过）。
func (r *Reporter) ServerTS() int64 { return r.lastServerTS.Load() }

// Failures 累计上报失败次数 → `agent.report_failures`。
func (r *Reporter) Failures() uint64 { return r.failures.Load() }

// logFields 供调用方在日志里带上**不含凭证**的上下文。
func (r *Reporter) logFields() []any {
	return []any{"center", r.cfg.Center.URL, "agent_id", r.agentID}
}

// ---------------------------------------------------------------------------
// 上报
// ---------------------------------------------------------------------------

// Prepared 一批已定稿、已序列化、只等发出的报文。
//
// ⛔ 为什么把「序列化」与「发送」拆开：调度器要同时满足两条互相拉扯的要求 ——
//   - 采集器在持续写共享快照，**序列化必须在锁内**完成，否则会把数据竞争带进 JSON 编码器；
//   - 网络 I/O 可能持续数十秒（重试 + 退避），**绝不能**把锁持有那么久。
//
// 拆开之后：锁内 Prepare（纯计算，微秒级），锁外 Send（I/O）。
type Prepared struct {
	raw     []byte
	path    string
	batchID string
	kind    string
}

// BatchID 本批的幂等键（便于日志里对齐"哪一批失败了"）。
func (p *Prepared) BatchID() string { return p.batchID }

// Bytes 压缩前的报文字节数。
func (p *Prepared) Bytes() int { return len(p.raw) }

// Raw 压缩前的报文字节（= 签名覆盖的那份字节）。
//
// ⚠️ 仅供 `--once --print-body` 这类**排障**用途：报文里只有指标，⛔ 不含任何凭证。
// 调用方不应修改返回的切片（它是发送时用的同一份）。
func (p *Prepared) Raw() []byte { return p.raw }

// Prepare 定稿一批上报：填批次身份 → 本地校验 → 序列化 → 按需裁剪。
//
// 调用方只需要填 `Host` / `Metrics` / `Probes`；`agent_id`、`batch_id`、`ts`、`seq`、
// `reported_ip` 由本方法统一填写 —— 这样"批次身份"只有一处生成逻辑，也就不会出现
// 两个地方各生成一个 batch_id、把幂等键玩坏的情况。
func (r *Reporter) Prepare(rep *model.Report) (*Prepared, error) {
	rep.AgentID = r.agentID
	rep.Ts = r.now().UnixMilli()
	r.seq++
	// ⚠️ 取本地副本再取地址：直接把 &r.seq 放进报文，会让报文里的指针**别名**到计数器上，
	//    下一次上报自增时旧报文里的值也跟着变（同步序列化看不出问题，一旦异步化就会静默出错）。
	seq := r.seq
	rep.Seq = &seq
	if ip := r.ReportedIP(); ip != "" {
		rep.ReportedIP = ip
	}

	batchID, err := ulid.New()
	if err != nil {
		return nil, &SendError{Kind: "internal", Detail: err.Error(), Err: err}
	}
	rep.BatchID = batchID

	if err := rep.Validate(); err != nil {
		// 参数错误：这是 Agent 自己的 bug（或采集器给出了越界值），⛔ 不发出去，
		// 否则中心会回 400，而我们只会在日志里看到一行"schema_invalid"，看不出是哪个字段。
		return nil, &SendError{Kind: "invalid", Detail: err.Error(), Err: err}
	}

	raw, trims, err := r.encodeWithinLimit(rep)
	if err != nil {
		return nil, &SendError{Kind: "too_large", Detail: err.Error(), Err: err}
	}
	if len(trims) > 0 {
		r.log.Warn("上报体超过单批上限，已按 §5.3 的顺序裁剪",
			append(r.logFields(), "trims", trims, "raw_bytes", len(raw), "limit", r.cfg.Report.MaxBatchBytes)...)
	}
	return &Prepared{raw: raw, path: auth.ReportPath, batchID: batchID, kind: "report"}, nil
}

// PrepareHeartbeat 定稿一次心跳（✅ §2.2：无 metrics、无 host，只更新"还活着"）。
func (r *Reporter) PrepareHeartbeat(hb *model.Heartbeat) (*Prepared, error) {
	hb.AgentID = r.agentID
	hb.Ts = r.now().UnixMilli()
	r.seq++
	seq := r.seq
	hb.Seq = &seq

	batchID, err := ulid.New()
	if err != nil {
		return nil, &SendError{Kind: "internal", Detail: err.Error(), Err: err}
	}
	hb.BatchID = batchID

	if err := hb.Validate(); err != nil {
		return nil, &SendError{Kind: "invalid", Detail: err.Error(), Err: err}
	}
	raw, err := marshal(hb)
	if err != nil {
		return nil, &SendError{Kind: "internal", Detail: err.Error(), Err: err}
	}
	return &Prepared{raw: raw, path: auth.HeartbeatPath, batchID: batchID, kind: "heartbeat"}, nil
}

// Send 执行「签名 → gzip → POST → 重试」。⛔ 不持有任何外部锁。
func (p *Prepared) Send(ctx context.Context, r *Reporter) (Response, error) {
	return r.send(ctx, p.path, p.raw, p.batchID)
}

// Report 是 `Prepare` + `Send` 的便捷写法（一次性调用方用）。
func (r *Reporter) Report(ctx context.Context, rep *model.Report) (Response, error) {
	p, err := r.Prepare(rep)
	if err != nil {
		return Response{}, err
	}
	return p.Send(ctx, r)
}

// Heartbeat 是 `PrepareHeartbeat` + `Send` 的便捷写法。
func (r *Reporter) Heartbeat(ctx context.Context, hb *model.Heartbeat) (Response, error) {
	p, err := r.PrepareHeartbeat(hb)
	if err != nil {
		return Response{}, err
	}
	return p.Send(ctx, r)
}

// Reconfigure 换用新配置继续上报（✅ §7 SIGHUP 热重载）。
//
// ⛔ **只允许在两次上报之间调用**（调度器在主循环里换配置，因此天然满足）。
//    在 `send` 进行中换配置会产生数据竞争。
//
// ⚠️ 生效范围：`report.*`（周期、gzip、重试、体积上限）与采集相关配置立即生效；
//    `center.url` / `center.tls.*` / `center.timeout` 涉及已建立的连接与 TLS 会话，
//    **需要重启进程**才生效 —— 这也是 ✅ §7 明确"保留 TCP 连接"的代价：既然连接要留着，
//    就不能靠换配置去改它的握手参数。
func (r *Reporter) Reconfigure(cfg *config.Config) { r.cfg = cfg }

// send 执行「签名 → gzip → POST → 重试」。
//
// ⚠️ 每次尝试都换一个 **nonce 与时间戳**，但**复用同一个 batch_id**：
//   - batch_id 是幂等键：若上一次尝试其实已经在中心落库，只是响应丢了，
//     这次会被中心的幂等检查直接命中并返回同样的 200，不会重复写入；
//   - nonce 换新：nonce 是防重放键，若某条路径消费了它却没写库（例如请求已到中心、
//     但在写库前连接断了），复用旧 nonce 会让重试拿到 409 `nonce_reused`——
//     那是**自己把自己锁死**，而换新 nonce 立刻就能过。
//   - 时间戳换新：退避 2s/4s/8s 后旧时间戳可能已经滑出签名窗口。
func (r *Reporter) send(ctx context.Context, path string, raw []byte, batchID string) (Response, error) {
	started := r.now()
	payload, err := r.compress(raw)
	if err != nil {
		return Response{}, &SendError{Kind: "internal", Detail: err.Error(), Err: err}
	}
	bodySHA := auth.BodySHA256Hex(raw)
	deadline := started.Add(r.cfg.Report.Retry.MaxElapsed.Std())

	var lastErr *SendError
	for attempt := 1; attempt <= r.cfg.Report.Retry.MaxAttempts; attempt++ {
		nonce, err := auth.NewNonce()
		if err != nil {
			return Response{}, &SendError{Kind: "internal", Detail: err.Error(), Attempts: attempt, Err: err}
		}
		ts := r.now().UnixMilli()
		signature := auth.Sign(r.secret, auth.MethodPost, path, ts, nonce, raw)

		resp, sendErr := r.attempt(ctx, path, payload, raw, bodySHA, nonce, ts, signature, attempt)
		if sendErr == nil {
			r.failures.Store(0)
			r.lastServerTS.Store(resp.ServerTS)
			resp.Attempts = attempt
			resp.RawBytes = len(raw)
			resp.WireBytes = len(payload)
			return resp, nil
		}
		lastErr = sendErr
		lastErr.Attempts = attempt

		if !sendErr.retryable() {
			break
		}
		if attempt == r.cfg.Report.Retry.MaxAttempts {
			break
		}
		// 指数退避：2s → 4s → 8s（✅ G2）。上限校验已保证 backoff ≤ max_elapsed。
		backoff := r.cfg.Report.Retry.Backoff.Std() * time.Duration(1<<(attempt-1))
		if r.now().Add(backoff).After(deadline) {
			r.log.Warn("重试窗口已用完，放弃该批次",
				append(r.logFields(), "batch_id", batchID, "attempt", attempt, "budget", r.cfg.Report.Retry.MaxElapsed.Std())...)
			break
		}
		r.sleep(backoff)
	}

	r.failures.Add(1)
	return Response{}, lastErr
}

// attempt 单次尝试。返回 (响应, nil) 表示成功；(零值, *SendError) 表示失败。
func (r *Reporter) attempt(
	ctx context.Context,
	path string,
	payload, raw []byte,
	bodySHA, nonce string,
	ts int64,
	signature string,
	attempt int,
) (Response, *SendError) {
	req, err := http.NewRequestWithContext(ctx, auth.MethodPost, r.cfg.Center.URL+path, bytes.NewReader(payload))
	if err != nil {
		return Response{}, &SendError{Kind: "internal", Detail: err.Error(), Err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", version.UserAgent())
	req.Header.Set("X-Agent-Id", r.agentID)
	req.Header.Set("X-Agent-Key", r.key)
	req.Header.Set("X-Timestamp", fmt.Sprintf("%d", ts))
	req.Header.Set("X-Nonce", nonce)
	req.Header.Set("X-Signature", signature)
	if r.cfg.Report.Gzip {
		req.Header.Set("Content-Encoding", "gzip")
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return Response{}, &SendError{Kind: "network", Detail: err.Error(), Err: err}
	}
	defer func() {
		// 读完剩余部分再关闭：否则连接会被直接掐断，下个周期只能重建（含 TLS 握手）。
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxResponseBytes))
		_ = resp.Body.Close()
	}()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		var out struct {
			OK       bool  `json:"ok"`
			ServerTS int64 `json:"server_ts"`
		}
		// ⛔ 只认这两个键 —— 结构体里也只有这两个键，中心即使多塞了字段也读不到（✅ 决策 #12）。
		if err := json.Unmarshal(body, &out); err != nil {
			return Response{}, &SendError{
				Kind: "server", StatusCode: resp.StatusCode,
				Detail: fmt.Sprintf("响应不是合法 JSON：%s", truncate(string(body), 200)), Err: err,
			}
		}
		if !out.OK {
			return Response{}, &SendError{
				Kind: "rejected", StatusCode: resp.StatusCode,
				Detail: fmt.Sprintf("HTTP %d 但 ok=false：%s", resp.StatusCode, truncate(string(body), 200)),
			}
		}
		return Response{OK: true, ServerTS: out.ServerTS, StatusCode: resp.StatusCode}, nil

	case resp.StatusCode == http.StatusTooManyRequests:
		return Response{}, &SendError{
			Kind: "server", StatusCode: resp.StatusCode,
			Detail: fmt.Sprintf("被限流（Retry-After: %s）：说明上报周期与限流阈值不匹配，请核对中心配置",
				resp.Header.Get("Retry-After")),
		}

	case resp.StatusCode == http.StatusRequestEntityTooLarge:
		// ⛔ 走到这里说明 Agent 侧的 256KB 熔断失效了（本地裁剪后仍超限，或配置被改坏）。
		//    不重试：重试只会把同一份过大的数据再发一遍。
		return Response{}, &SendError{
			Kind: "payload_too_large", StatusCode: resp.StatusCode,
			Detail: "中心以 413 拒绝：Agent 侧熔断应当保证永不出现（请检查 report.max_batch_bytes 是否被调大）",
		}

	case resp.StatusCode == http.StatusConflict:
		// 409 nonce_reused：换一个 nonce 再试是有意义的（本方法每次尝试都会换新 nonce）。
		return Response{}, &SendError{
			Kind: "server", StatusCode: resp.StatusCode,
			Detail: fmt.Sprintf("中心返回 409（%s）：将换用新 nonce 重试", truncate(string(body), 200)),
		}

	case resp.StatusCode >= 500:
		return Response{}, &SendError{
			Kind: "server", StatusCode: resp.StatusCode,
			Detail: truncate(string(body), 200),
		}

	default:
		// 其余 4xx 都是"重试无用"：字段非法、验签失败、时钟漂移过大…
		return Response{}, &SendError{
			Kind: "rejected", StatusCode: resp.StatusCode,
			Detail: truncate(string(body), 300),
		}
	}
}

// retryable 是否需要重试。
//
// ⛔ 4xx 一律不重试（除了已单列的 409/429）：字段非法、验签失败、时钟漂移过大这类问题
//
//	重试只会把同样的错误再犯一遍，还会拖长上报周期、把内存里的批次堆起来。
func (e *SendError) retryable() bool {
	switch e.Kind {
	case "network", "server":
		return true
	default:
		return false
	}
}

// compress 按配置压缩（✅ §5.3：压缩只作传输层，⛔ 不参与签名）。
func (r *Reporter) compress(raw []byte) ([]byte, error) {
	if !r.cfg.Report.Gzip {
		return raw, nil
	}
	var buf bytes.Buffer
	// 预留一点空间避免多次扩容；压缩比通常在 4–10 倍之间
	buf.Grow(len(raw) / 3)
	zw, err := gzip.NewWriterLevel(&buf, r.cfg.Report.GzipLevel)
	if err != nil {
		return nil, fmt.Errorf("创建 gzip writer 失败：%w", err)
	}
	if _, err := zw.Write(raw); err != nil {
		return nil, fmt.Errorf("gzip 压缩失败：%w", err)
	}
	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("gzip 收尾失败：%w", err)
	}
	return buf.Bytes(), nil
}

// marshal 序列化报文：**紧凑 JSON、不转义 HTML**。
//
// ⚠️ 关掉 HTML 转义（SetEscapeHTML(false)）是为了让 `<` `>` `&` 原样出现在进程名、
//
//	挂载点里 —— 默认转义会产出 `\u003c` 这类转义序列，虽然仍是合法 JSON，
//	但会让排查时看到的报文难以阅读（而且白白多几个字节）。
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, fmt.Errorf("序列化失败：%w", err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
