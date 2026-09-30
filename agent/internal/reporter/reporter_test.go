package reporter_test

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"vantage-agent/internal/auth"
	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
	"vantage-agent/internal/reporter"
)

// ⛔ 测试用凭证：全是公开的假值，⛔ 不得用于生产。
var (
	testAgentID = "11111111-2222-3333-4444-555555555555"
	testKey     = "vk_TEST_KEY_DO_NOT_USE"
	testSecret  = []byte("vs_TEST_SECRET_DO_NOT_USE_0123456789abcdef")
)

// capturedRequest 假中心收到的一次请求。
type capturedRequest struct {
	path    string
	headers http.Header
	// raw 是**解压后**的报文字节，也就是"应当被签名的那份字节"。
	raw     []byte
	wireLen int
	gzipped bool
}

// fakeCenter 假中心：它做真中心最核心的那件事 —— 用收到的字节重新算一遍签名并比对。
//
// ⚠️ 这里用 `auth.Sign` 算期望值，看起来"自己验自己"，但实际验的是**接线**：
//
//	哪份字节被签、path 用哪个、头里放的是不是同一个 nonce/timestamp。
//	canonical 的**拼装格式**本身由 `contracts/agent-signature.json` 的共享向量钉死
//	（那份向量的期望签名来自中心实现，Go 侧逐字节比对）。
type fakeCenter struct {
	srv *httptest.Server

	mu        sync.Mutex
	requests  []capturedRequest
	failTimes int
	failCode  int

	// onRequest 允许单个用例自定义响应（返回 true 表示已自行处理）。
	onRequest func(n int, w http.ResponseWriter, r *http.Request, body []byte) bool
}

func newFakeCenter(t *testing.T) *fakeCenter {
	t.Helper()
	f := &fakeCenter{failCode: http.StatusInternalServerError}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wire, _ := io.ReadAll(r.Body)
		body := wire
		gz := r.Header.Get("Content-Encoding") == "gzip"
		if gz {
			zr, err := gzip.NewReader(strings.NewReader(string(wire)))
			if err != nil {
				http.Error(w, `{"error":{"code":"bad_gzip"}}`, http.StatusBadRequest)
				return
			}
			body, _ = io.ReadAll(zr)
			_ = zr.Close()
		}

		f.mu.Lock()
		n := len(f.requests) + 1
		f.requests = append(f.requests, capturedRequest{
			path: r.URL.Path, headers: r.Header.Clone(), raw: body, wireLen: len(wire), gzipped: gz,
		})
		failTimes := f.failTimes
		code := f.failCode
		onRequest := f.onRequest
		f.mu.Unlock()

		if onRequest != nil && onRequest(n, w, r, body) {
			return
		}
		if n <= failTimes {
			w.WriteHeader(code)
			_, _ = w.Write([]byte(`{"error":{"code":"boom"}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"server_ts":1758800000999}`))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeCenter) snapshot() []capturedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]capturedRequest, len(f.requests))
	copy(out, f.requests)
	return out
}

func (f *fakeCenter) setFailures(n, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failTimes, f.failCode = n, code
}

// verifySignature 断言：签名 == HMAC(secret, canonical(POST, path, X-Timestamp, X-Nonce, sha256(收到的字节)))
func verifySignature(t *testing.T, req capturedRequest) {
	t.Helper()

	for _, h := range []string{"X-Agent-Id", "X-Agent-Key", "X-Timestamp", "X-Nonce", "X-Signature"} {
		if req.headers.Get(h) == "" {
			t.Fatalf("缺少请求头 %s（中心会直接 401）", h)
		}
	}
	if got := req.headers.Get("X-Agent-Id"); got != testAgentID {
		t.Fatalf("X-Agent-Id 应为 %s，实际 %q", testAgentID, got)
	}
	if got := req.headers.Get("X-Agent-Key"); got != testKey {
		t.Fatalf("X-Agent-Key 应为 %s，实际 %q", testKey, got)
	}
	if ua := req.headers.Get("User-Agent"); !strings.HasPrefix(ua, "vantage-agent/") {
		t.Fatalf("User-Agent 应当是 vantage-agent/<version>，实际 %q", ua)
	}

	ts, err := strconv.ParseInt(req.headers.Get("X-Timestamp"), 10, 64)
	if err != nil {
		t.Fatalf("X-Timestamp 不是十进制整数：%q", req.headers.Get("X-Timestamp"))
	}

	// ⛔ 关键断言：签名必须是对**收到的这份字节**算出来的。
	//    若实现"先解析再重新序列化"，这里的字节就会与签名覆盖的字节不一致 → 本断言失败。
	want := auth.Sign(testSecret, "POST", req.path, ts, req.headers.Get("X-Nonce"), req.raw)
	if got := req.headers.Get("X-Signature"); got != want {
		t.Fatalf("签名与「收到的字节」不匹配：说明签名覆盖的字节 ≠ 实际发送的字节\n得到: %s\n期望: %s",
			got, want)
	}
}

// testConfig 一份指向假中心的配置（直接改结构体、不走 Parse：这里测的是上报管线，不是配置校验）。
func testConfig(t *testing.T, centerURL string) *config.Config {
	t.Helper()
	cfg := config.Defaults()
	cfg.Center.URL = centerURL
	cfg.Center.AllowHTTP = true
	cfg.Center.Timeout = config.Duration(5 * time.Second)
	cfg.Agent.ID = testAgentID
	return cfg
}

func newReporter(t *testing.T, cfg *config.Config, sleep func(time.Duration)) *reporter.Reporter {
	t.Helper()
	r, err := reporter.New(reporter.Options{
		Config:  cfg,
		AgentID: testAgentID,
		Key:     testKey,
		Secret:  testSecret,
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		Sleep:   sleep,
	})
	if err != nil {
		t.Fatalf("构造 reporter 失败：%v", err)
	}
	return r
}

// validReport 一份**最小但合法**的报文（中心 schema 要求 cpu.usage 与 mem.total）。
func validReport() *model.Report {
	usage := 12.5
	total := float64(8 << 30)
	return &model.Report{
		Metrics: &model.Metrics{
			CPU: &model.CPU{Usage: &usage},
			Mem: &model.Mem{Total: &total},
		},
	}
}

func noSleep(time.Duration) {}

func f(v float64) *float64 { return &v }

// measureSize 用一次"必定成功"的上报量出真实报文字节数。
//
// 有了它，裁剪类用例就可以把上限精确卡在"比当前字节数少 1"上，从而**确定性地**逼出某一级裁剪，
// 不必靠估算 JSON 长度（那样会写出随字段顺序漂移、改一行就红的脆弱断言）。
func measureSize(t *testing.T, rep *model.Report) int {
	t.Helper()
	center := newFakeCenter(t)
	cfg := testConfig(t, center.srv.URL)
	cfg.Report.MaxBatchBytes = config.MaxBatchBytesCeiling
	r := newReporter(t, cfg, noSleep)

	if _, err := r.Report(context.Background(), rep); err != nil {
		t.Fatalf("量尺寸时上报失败：%v", err)
	}
	return len(center.snapshot()[0].raw)
}

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------

func TestReportHappyPath(t *testing.T) {
	center := newFakeCenter(t)
	cfg := testConfig(t, center.srv.URL)

	var slept []time.Duration
	r, err := reporter.New(reporter.Options{
		Config: cfg, AgentID: testAgentID, Key: testKey, Secret: testSecret,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Sleep:  func(d time.Duration) { slept = append(slept, d) },
	})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := r.Report(context.Background(), validReport())
	if err != nil {
		t.Fatalf("上报应当成功：%v", err)
	}
	if !resp.OK || resp.ServerTS != 1758800000999 {
		t.Fatalf("响应解析异常：%+v", resp)
	}
	if resp.Attempts != 1 {
		t.Fatalf("应当一次成功，实际尝试 %d 次", resp.Attempts)
	}
	if len(slept) != 0 {
		t.Fatalf("成功路径不应有任何退避：%v", slept)
	}
	if r.Failures() != 0 {
		t.Fatalf("成功后失败计数应为 0，实际 %d", r.Failures())
	}
	if r.ServerTS() != 1758800000999 {
		t.Fatalf("server_ts 未被记录（clock.use_server_ts 依赖它）：%d", r.ServerTS())
	}
	if resp.RawBytes == 0 || resp.WireBytes == 0 {
		t.Fatalf("响应里应带上实际字节数：%+v", resp)
	}
	if resp.WireBytes >= resp.RawBytes {
		t.Logf("提示：本批压缩后 %d ≥ 压缩前 %d（小报文属正常）", resp.WireBytes, resp.RawBytes)
	}

	reqs := center.snapshot()
	if len(reqs) != 1 {
		t.Fatalf("假中心应收到 1 个请求，实际 %d", len(reqs))
	}
	if reqs[0].path != auth.ReportPath {
		t.Fatalf("路径应为 %s，实际 %s", auth.ReportPath, reqs[0].path)
	}
	if !reqs[0].gzipped {
		t.Fatal("默认应当 gzip 压缩上报")
	}
	verifySignature(t, reqs[0])

	var got map[string]any
	if err := json.Unmarshal(reqs[0].raw, &got); err != nil {
		t.Fatalf("报文体不是合法 JSON：%v", err)
	}
	for _, k := range []string{"agent_id", "batch_id", "ts", "seq", "metrics"} {
		if _, ok := got[k]; !ok {
			t.Fatalf("报文缺少字段 %s：%s", k, reqs[0].raw)
		}
	}
	if got["agent_id"] != testAgentID {
		t.Fatalf("agent_id 应为 %s，实际 %v", testAgentID, got["agent_id"])
	}
	if bid, _ := got["batch_id"].(string); len(bid) != 26 {
		t.Fatalf("batch_id 应当是 26 字符 ULID，实际 %q", bid)
	}
}

func TestSeqIncreasesAndBatchIDUnique(t *testing.T) {
	center := newFakeCenter(t)
	r := newReporter(t, testConfig(t, center.srv.URL), noSleep)

	for i := 0; i < 3; i++ {
		if _, err := r.Report(context.Background(), validReport()); err != nil {
			t.Fatalf("第 %d 次上报失败：%v", i+1, err)
		}
	}

	seen := map[string]bool{}
	var lastSeq float64
	for i, req := range center.snapshot() {
		var m map[string]any
		_ = json.Unmarshal(req.raw, &m)
		seq, _ := m["seq"].(float64)
		if seq <= lastSeq {
			t.Fatalf("seq 必须单调递增：第 %d 个请求 seq=%v，上一个=%v", i+1, seq, lastSeq)
		}
		lastSeq = seq
		bid, _ := m["batch_id"].(string)
		if seen[bid] {
			t.Fatalf("batch_id 重复：%s（重复的幂等键会让中心把新数据当成重放丢弃）", bid)
		}
		seen[bid] = true
	}
}

// ---------------------------------------------------------------------------
// 签名覆盖的字节
// ---------------------------------------------------------------------------

func TestSignatureCoversSentBytesNotReserialized(t *testing.T) {
	// 构造一条"重新序列化后字节必变"的报文：进程名里带 < > & 与中文。
	// 若实现去解析再重新序列化（或用默认的 HTML 转义），签名就会对不上。
	center := newFakeCenter(t)
	r := newReporter(t, testConfig(t, center.srv.URL), noSleep)

	rep := &model.Report{Metrics: &model.Metrics{
		CPU: &model.CPU{Usage: f(1)},
		Mem: &model.Mem{Total: f(1024)},
		Process: &model.Process{Count: 3, Top: []model.ProcessTop{
			{Pid: 1, Name: `<a href="x">&数据</a>`, CPU: f(0.5)},
		}},
	}}
	if _, err := r.Report(context.Background(), rep); err != nil {
		t.Fatalf("上报失败：%v", err)
	}

	req := center.snapshot()[0]
	verifySignature(t, req)
	// ⚠️ 刻意关掉 HTML 转义：`<` `&` 应当原样出现，而不是 \u003c / \u0026
	if !strings.Contains(string(req.raw), "&数据") {
		t.Fatalf("报文字节里应当保留原文（不转义 HTML）：%s", req.raw)
	}
}

// ---------------------------------------------------------------------------
// 重试
// ---------------------------------------------------------------------------

func TestRetryThenSuccess(t *testing.T) {
	center := newFakeCenter(t)
	center.setFailures(2, http.StatusInternalServerError)

	var slept []time.Duration
	r := newReporter(t, testConfig(t, center.srv.URL), func(d time.Duration) { slept = append(slept, d) })

	resp, err := r.Report(context.Background(), validReport())
	if err != nil {
		t.Fatalf("第 3 次应当成功：%v", err)
	}
	if resp.Attempts != 3 {
		t.Fatalf("应当尝试 3 次，实际 %d", resp.Attempts)
	}
	// ✅ G2：2s 起指数退避
	if len(slept) != 2 || slept[0] != 2*time.Second || slept[1] != 4*time.Second {
		t.Fatalf("退避序列应为 [2s 4s]，实际 %v", slept)
	}

	reqs := center.snapshot()
	if len(reqs) != 3 {
		t.Fatalf("假中心应收到 3 个请求，实际 %d", len(reqs))
	}
	// ⛔ 重试必须复用同一个 batch_id（幂等键），但必须换 nonce
	var bids, nonces []string
	for _, req := range reqs {
		var m map[string]any
		_ = json.Unmarshal(req.raw, &m)
		bids = append(bids, m["batch_id"].(string))
		nonces = append(nonces, req.headers.Get("X-Nonce"))
		verifySignature(t, req)
	}
	if bids[0] != bids[1] || bids[1] != bids[2] {
		t.Fatalf("重试必须复用同一个 batch_id（否则中心会重复写库）：%v", bids)
	}
	if nonces[0] == nonces[1] || nonces[1] == nonces[2] {
		t.Fatalf("重试必须换 nonce（复用旧 nonce 会撞 409 nonce_reused，等于自己把自己锁死）：%v", nonces)
	}
}

func TestNonRetryable400(t *testing.T) {
	center := newFakeCenter(t)
	center.setFailures(99, http.StatusBadRequest)

	slept := 0
	r := newReporter(t, testConfig(t, center.srv.URL), func(time.Duration) { slept++ })

	_, err := r.Report(context.Background(), validReport())
	var se *reporter.SendError
	if !asSendError(err, &se) {
		t.Fatalf("错误类型不对：%T", err)
	}
	if se.Kind != "rejected" || se.StatusCode != 400 {
		t.Fatalf("400 应归类为 rejected，实际 %+v", se)
	}
	if got := len(center.snapshot()); got != 1 {
		t.Fatalf("4xx 不该重试，实际请求 %d 次", got)
	}
	if slept != 0 {
		t.Fatalf("4xx 不该退避，实际退避 %d 次", slept)
	}
	if r.Failures() != 1 {
		t.Fatalf("失败计数应为 1，实际 %d", r.Failures())
	}
}

func TestRetryOn429And409(t *testing.T) {
	for _, code := range []int{http.StatusTooManyRequests, http.StatusConflict} {
		code := code
		t.Run(http.StatusText(code), func(t *testing.T) {
			center := newFakeCenter(t)
			center.setFailures(1, code)
			r := newReporter(t, testConfig(t, center.srv.URL), noSleep)

			resp, err := r.Report(context.Background(), validReport())
			if err != nil {
				t.Fatalf("HTTP %d 后应当重试并成功：%v", code, err)
			}
			if resp.Attempts != 2 {
				t.Fatalf("应当尝试 2 次，实际 %d", resp.Attempts)
			}
		})
	}
}

func TestPayloadTooLargeIsNotRetried(t *testing.T) {
	center := newFakeCenter(t)
	center.setFailures(99, http.StatusRequestEntityTooLarge)
	r := newReporter(t, testConfig(t, center.srv.URL), noSleep)

	_, err := r.Report(context.Background(), validReport())
	var se *reporter.SendError
	if !asSendError(err, &se) || se.Kind != "payload_too_large" {
		t.Fatalf("413 应归类为 payload_too_large（说明本地熔断失效），实际 %v", err)
	}
	if got := len(center.snapshot()); got != 1 {
		t.Fatalf("413 不该重试，实际 %d 次", got)
	}
}

func TestRetryStopsAtMaxAttempts(t *testing.T) {
	center := newFakeCenter(t)
	center.setFailures(99, http.StatusInternalServerError)

	var slept []time.Duration
	cfg := testConfig(t, center.srv.URL)
	cfg.Report.Retry.MaxElapsed = config.Duration(1 * time.Minute) // 排除预算限制，专测次数上限
	r := newReporter(t, cfg, func(d time.Duration) { slept = append(slept, d) })

	if _, err := r.Report(context.Background(), validReport()); err == nil {
		t.Fatal("持续 500 应当最终失败")
	}
	if got := len(center.snapshot()); got != 3 {
		t.Fatalf("默认最多 3 次尝试，实际 %d", got)
	}
	if len(slept) != 2 {
		t.Fatalf("3 次尝试之间只应有 2 次退避，实际 %v", slept)
	}
}

func TestRetryStopsWhenBudgetExhausted(t *testing.T) {
	center := newFakeCenter(t)
	center.setFailures(99, http.StatusInternalServerError)

	// 退避 2s、总预算 3s：第二次退避（4s）会超预算 → 应当只尝试 2 次就放弃
	cfg := testConfig(t, center.srv.URL)
	cfg.Report.Retry.Backoff = config.Duration(2 * time.Second)
	cfg.Report.Retry.MaxElapsed = config.Duration(3 * time.Second)

	// 用可推进的假时钟：预算判断基于 now()，不推进就永远算不出"超预算"
	now := time.Now()
	r, err := reporter.New(reporter.Options{
		Config: cfg, AgentID: testAgentID, Key: testKey, Secret: testSecret,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Sleep:  func(d time.Duration) { now = now.Add(d) },
		Now:    func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := r.Report(context.Background(), validReport()); err == nil {
		t.Fatal("应当失败")
	}
	if got := len(center.snapshot()); got != 2 {
		t.Fatalf("预算 3s / 退避 2s 时应只尝试 2 次，实际 %d", got)
	}
}

// ---------------------------------------------------------------------------
// 本地校验与裁剪
// ---------------------------------------------------------------------------

func TestInvalidReportIsNotSent(t *testing.T) {
	center := newFakeCenter(t)
	r := newReporter(t, testConfig(t, center.srv.URL), noSleep)

	// 缺 cpu.usage（中心 schema 必填）→ 必须在本地拦下，⛔ 不发出去
	rep := &model.Report{Metrics: &model.Metrics{CPU: &model.CPU{}, Mem: &model.Mem{}}}
	_, err := r.Report(context.Background(), rep)
	var se *reporter.SendError
	if !asSendError(err, &se) || se.Kind != "invalid" {
		t.Fatalf("应当在本地校验阶段就失败（kind=invalid），实际 %v", err)
	}
	if got := len(center.snapshot()); got != 0 {
		t.Fatalf("非法报文不该发出，实际发了 %d 次", got)
	}
}

// fatReport 造一份"有一处明显超重、其余很小"的报文。
// 各裁剪用例通过开关决定哪一部分超重，从而确定性地只触发某一级裁剪。
type fatReportOpts struct {
	topEntries int
	withGPU    bool
	withDiskIO bool
	withNetErr bool
}

func fatReport(o fatReportOpts) *model.Report {
	rep := &model.Report{Metrics: &model.Metrics{
		CPU: &model.CPU{Usage: f(1)},
		Mem: &model.Mem{Total: f(1024)},
	}}
	if o.topEntries > 0 {
		long := strings.Repeat("x", 35) // ASCII，保证与 SetEscapeHTML(false) 的编码一致
		top := make([]model.ProcessTop, o.topEntries)
		for i := range top {
			top[i] = model.ProcessTop{Pid: i + 1, Name: long, CPU: f(0.5)}
		}
		rep.Metrics.Process = &model.Process{Count: uint32(o.topEntries), Top: top}
	}
	if o.withGPU {
		rep.Metrics.GPU = []model.GPU{{Index: 0, Util: f(50), Temp: f(60), Power: f(120)}}
	}
	if o.withDiskIO {
		for i := 0; i < 12; i++ {
			rep.Metrics.Disk = append(rep.Metrics.Disk, model.Disk{
				Mount: "/mnt/vol" + strconv.Itoa(i), Device: "sd" + strconv.Itoa(i),
				Total: f(1e12), Used: f(5e11), LatencyMS: f(1.5),
			})
		}
	}
	if o.withNetErr {
		for i := 0; i < 8; i++ {
			rep.Metrics.Net = append(rep.Metrics.Net, model.Net{
				Device: "eth" + strconv.Itoa(i), RxBps: f(100), TxBps: f(200),
				Err: f(0.5), Drop: f(0.5),
			})
		}
	}
	return rep
}

// sendWithLimit 用指定上限发一次并返回收到的报文字节。
func sendWithLimit(t *testing.T, rep *model.Report, limit int) []byte {
	t.Helper()
	center := newFakeCenter(t)
	cfg := testConfig(t, center.srv.URL)
	cfg.Report.MaxBatchBytes = limit
	r := newReporter(t, cfg, noSleep)

	if _, err := r.Report(context.Background(), rep); err != nil {
		t.Fatalf("应当裁剪后发出，却失败了：%v", err)
	}
	req := center.snapshot()[0]
	verifySignature(t, req)
	if len(req.raw) > limit {
		t.Fatalf("发出去的字节 %d 仍超过上限 %d", len(req.raw), limit)
	}
	return req.raw
}

func decode(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("报文体不是合法 JSON：%v", err)
	}
	return m
}

func metricsOf(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	m := decode(t, raw)
	mm, ok := m["metrics"].(map[string]any)
	if !ok {
		t.Fatalf("报文缺少 metrics：%s", raw)
	}
	return mm
}

// topOf 安全地取出 process.top（缺字段时给出清晰失败，而不是 panic）。
func topOf(t *testing.T, metrics map[string]any) []any {
	t.Helper()
	proc, ok := metrics["process"].(map[string]any)
	if !ok {
		t.Fatalf("报文缺少 metrics.process：%v", metrics)
	}
	top, ok := proc["top"].([]any)
	if !ok {
		t.Fatalf("metrics.process 缺少 top：%v", proc)
	}
	return top
}

func TestTrimHalvesProcessTop(t *testing.T) {
	// 50 是中心 schema 允许的 process.top 上限；再多会被本地校验拦下，就测不到裁剪了
	rep := fatReport(fatReportOpts{topEntries: 50})
	size := measureSize(t, rep)

	raw := sendWithLimit(t, rep, size-1)
	metrics := metricsOf(t, raw)

	top := topOf(t, metrics)
	if len(top) != 25 {
		t.Fatalf("第一步裁剪应把 process.top 截半到 25 条，实际 %d", len(top))
	}
	// 只截半就够 → 后续两级不该被动
	if _, has := metrics["cpu"]; !has {
		t.Fatal("裁剪不该动 cpu（中心 schema 的底线）")
	}
}

func TestTrimDropsGPUSecondaryOnly(t *testing.T) {
	// 有 process.top 但只有 1 条（截半对它无效：len<=1 时跳过），
	// 于是"唯一的超重项"必须靠第二步（丢 GPU 次要指标）来削 —— 但 GPU 那点字节
	// 远不足以削掉 12 个磁盘条目的开销，所以这里改为：让 GPU 是**最后一点**超重。
	rep := fatReport(fatReportOpts{topEntries: 1, withGPU: true})
	size := measureSize(t, rep)

	raw := sendWithLimit(t, rep, size-1)
	metrics := metricsOf(t, raw)

	gpu, ok := metrics["gpu"].([]any)
	if !ok || len(gpu) == 0 {
		t.Fatalf("gpu 应当保留（util 是主要指标）：%v", metrics["gpu"])
	}
	g0 := gpu[0].(map[string]any)
	if _, has := g0["temp"]; has {
		t.Fatal("第二步裁剪应丢弃 gpu.temp")
	}
	if _, has := g0["power"]; has {
		t.Fatal("第二步裁剪应丢弃 gpu.power")
	}
	if _, has := g0["util"]; !has {
		t.Fatal("gpu.util 是主要指标，不该被丢弃")
	}
}

func TestTrimDropsNetAndDiskSecondaryOnly(t *testing.T) {
	// 没有 process.top（第一步跳过）、没有 GPU（第二步跳过）
	// → 只能靠第三步：丢 net.err/drop 与 disk.latency_ms
	rep := fatReport(fatReportOpts{withDiskIO: true, withNetErr: true})
	size := measureSize(t, rep)

	raw := sendWithLimit(t, rep, size-1)
	metrics := metricsOf(t, raw)

	disk0 := metrics["disk"].([]any)[0].(map[string]any)
	if _, has := disk0["latency_ms"]; has {
		t.Fatal("第三步裁剪应丢弃 disk.latency_ms")
	}
	if _, has := disk0["used"]; !has {
		t.Fatal("disk.used 不该被丢弃（容量是核心指标）")
	}
	net0 := metrics["net"].([]any)[0].(map[string]any)
	if _, has := net0["err"]; has {
		t.Fatal("第三步裁剪应丢弃 net.err")
	}
	if _, has := net0["drop"]; has {
		t.Fatal("第三步裁剪应丢弃 net.drop")
	}
	if _, has := net0["rx_bps"]; !has {
		t.Fatal("net.rx_bps 不该被丢弃")
	}
}

func TestTrimExhaustedDropsBatch(t *testing.T) {
	center := newFakeCenter(t)
	cfg := testConfig(t, center.srv.URL)
	// 上限设得比「最小合法报文」（约 180 字节）还小：三级裁剪都动不了 cpu/mem，
	// 所以必然走到第四步"丢弃整批"
	cfg.Report.MaxBatchBytes = 100
	r := newReporter(t, cfg, noSleep)

	_, err := r.Report(context.Background(), validReport())
	var se *reporter.SendError
	if !asSendError(err, &se) || se.Kind != "too_large" {
		t.Fatalf("裁不掉时应直接丢弃该批（kind=too_large），实际 %v", err)
	}
	if got := len(center.snapshot()); got != 0 {
		t.Fatalf("丢弃的批次不该发出去，实际发了 %d 次", got)
	}
}

// ---------------------------------------------------------------------------
// 心跳 / 出口 IP / 无 gzip
// ---------------------------------------------------------------------------

func TestHeartbeatHasNoMetrics(t *testing.T) {
	center := newFakeCenter(t)
	r := newReporter(t, testConfig(t, center.srv.URL), noSleep)

	if _, err := r.Heartbeat(context.Background(), &model.Heartbeat{}); err != nil {
		t.Fatalf("心跳应当成功：%v", err)
	}
	req := center.snapshot()[0]
	if req.path != auth.HeartbeatPath {
		t.Fatalf("路径应为 %s，实际 %s", auth.HeartbeatPath, req.path)
	}
	verifySignature(t, req)

	m := decode(t, req.raw)
	for _, forbidden := range []string{"metrics", "host", "probes"} {
		if _, has := m[forbidden]; has {
			t.Fatalf("心跳不得携带 %s（两套报文不混用，中心会 400）", forbidden)
		}
	}
	for _, required := range []string{"agent_id", "batch_id", "ts"} {
		if _, has := m[required]; !has {
			t.Fatalf("心跳缺少必填字段 %s", required)
		}
	}
}

func TestReportedIPFromPreviousConnection(t *testing.T) {
	center := newFakeCenter(t)
	r := newReporter(t, testConfig(t, center.srv.URL), noSleep)

	// 第一次：出口 IP 还不知道（它是连接建立之后才知道的）→ 省略该字段
	if _, err := r.Report(context.Background(), validReport()); err != nil {
		t.Fatal(err)
	}
	// 第二次：应当带上上一次观测到的本端地址（这里是回环）
	if _, err := r.Report(context.Background(), validReport()); err != nil {
		t.Fatal(err)
	}

	if ip := r.ReportedIP(); ip == "" {
		t.Fatal("首次连接后应当记录到本端出口 IP")
	}

	reqs := center.snapshot()
	first := decode(t, reqs[0].raw)
	second := decode(t, reqs[1].raw)
	if _, has := first["reported_ip"]; has {
		t.Fatalf("首次上报不该带 reported_ip（此时还不知道）：%v", first["reported_ip"])
	}
	if second["reported_ip"] != r.ReportedIP() {
		t.Fatalf("第二次上报应带上出口 IP %q，实际 %v", r.ReportedIP(), second["reported_ip"])
	}
}

func TestGzipDisabled(t *testing.T) {
	center := newFakeCenter(t)
	cfg := testConfig(t, center.srv.URL)
	cfg.Report.Gzip = false
	r := newReporter(t, cfg, noSleep)

	if _, err := r.Report(context.Background(), validReport()); err != nil {
		t.Fatal(err)
	}
	req := center.snapshot()[0]
	if req.gzipped || req.headers.Get("Content-Encoding") == "gzip" {
		t.Fatal("关掉 gzip 后不该发 Content-Encoding: gzip")
	}
	verifySignature(t, req)
}

// ---------------------------------------------------------------------------
// 单向宗旨
// ---------------------------------------------------------------------------

func TestResponseExtraFieldsAreIgnored(t *testing.T) {
	// ⛔ 决策 #12：即便中心（或中间人）在响应里塞了 command/config，Agent 也必须读不到。
	//    这里用一个"恶意"响应验证：实现只认 ok 与 server_ts。
	center := newFakeCenter(t)
	center.onRequest = func(_ int, w http.ResponseWriter, _ *http.Request, _ []byte) bool {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"server_ts":42,"command":"rm -rf /","interval":1}`))
		return true
	}
	r := newReporter(t, testConfig(t, center.srv.URL), noSleep)

	resp, err := r.Report(context.Background(), validReport())
	if err != nil {
		t.Fatalf("应当成功（多余字段要被忽略而不是报错）：%v", err)
	}
	if resp.ServerTS != 42 {
		t.Fatalf("应当只读到 server_ts，实际 %+v", resp)
	}
}

func TestOkFalseIsRejected(t *testing.T) {
	center := newFakeCenter(t)
	center.onRequest = func(_ int, w http.ResponseWriter, _ *http.Request, _ []byte) bool {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":false,"server_ts":1}`))
		return true
	}
	r := newReporter(t, testConfig(t, center.srv.URL), noSleep)

	_, err := r.Report(context.Background(), validReport())
	var se *reporter.SendError
	if !asSendError(err, &se) || se.Kind != "rejected" {
		t.Fatalf("ok=false 应被当成被拒绝且不重试，实际 %v", err)
	}
	if got := len(center.snapshot()); got != 1 {
		t.Fatalf("ok=false 不该重试，实际 %d 次", got)
	}
}

func TestNonJSONResponseIsServerError(t *testing.T) {
	center := newFakeCenter(t)
	center.onRequest = func(_ int, w http.ResponseWriter, _ *http.Request, _ []byte) bool {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html>502 Bad Gateway</html>`))
		return true
	}
	r := newReporter(t, testConfig(t, center.srv.URL), noSleep)

	_, err := r.Report(context.Background(), validReport())
	var se *reporter.SendError
	if !asSendError(err, &se) || se.Kind != "server" {
		t.Fatalf("非 JSON 的 2xx 响应应归类为 server（可重试），实际 %v", err)
	}
}

// asSendError 避免在文件顶部再引一个包。
func asSendError(err error, target **reporter.SendError) bool {
	if se, ok := err.(*reporter.SendError); ok {
		*target = se
		return true
	}
	return false
}
