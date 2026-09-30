// 本文件：`http` / `https` 探活的单元测试。
//
// ⛔ 全部使用 net/http/httptest 本地服务：测试必须能在**没有网络**的环境下跑
// （⛔ 不依赖 example.com、不依赖任何公网 IP），否则 CI 一断网就整片红。
//
// ⚠️ 超时类用例一律「小 timeout + 服务端等 ctx 结束」，⛔ 不用真实长 sleep：
// 一个 2s 的超时用例会让整个测试包慢 2s，而它验证的东西与 150ms 的用例完全一样。
package prober

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"vantage-agent/internal/config"
	"vantage-agent/internal/version"
)

// testProbeBlock 造一份探活配置。
//
// ⚠️ interval 必须显式给足（≥ config.MinInterval）：虽然探活器不校验它，
// 但用它构造出的用例一旦被当成"合法配置"复制到别处，就能过配置校验这一关。
func testProbeBlock(mut func(*config.ProbeBlock)) *config.ProbeBlock {
	pb := &config.ProbeBlock{
		Name:     "probe-under-test",
		Type:     "http",
		URL:      "http://127.0.0.1/",
		Method:   "GET",
		Timeout:  config.Duration(500 * time.Millisecond),
		Interval: config.Duration(30 * time.Second),
	}
	if mut != nil {
		mut(pb)
	}
	return pb
}

func TestHTTPProbeOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "healthy")
	}))
	defer srv.Close()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) { pb.URL = srv.URL }))
	res := p.Probe(context.Background())

	if !res.Up {
		t.Fatalf("200 应判为 up=true，实际 up=false error=%v", errText(res.Error))
	}
	// ✅ 契约：status_code 填**实际**值（面板要能看出目标回了什么）。
	if res.StatusCode == nil || *res.StatusCode != 200 {
		t.Fatalf("status_code 应为 200，实际 %v", res.StatusCode)
	}
	if res.LatencyMS == nil || *res.LatencyMS < 0 {
		t.Fatalf("成功结果必须带非负 latency_ms，实际 %v", res.LatencyMS)
	}
	// ⛔ 成功时不得带 error：中心/面板会把带 error 的探活渲染成失败。
	if res.Error != nil {
		t.Fatalf("成功结果不应有 error，实际 %q", *res.Error)
	}
	if res.Name != "probe-under-test" || res.Type != "http" || res.Target != srv.URL {
		t.Fatalf("元数据不符：name=%q type=%q target=%q", res.Name, res.Type, res.Target)
	}
}

func TestHTTPProbeUnexpectedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, "down for maintenance")
	}))
	defer srv.Close()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.ExpectStatus = []int{200}
	}))
	res := p.Probe(context.Background())

	if res.Up {
		t.Fatal("503 不在期望集合内，必须 up=false")
	}
	// ⛔ 失败也要带 status_code：否则用户看到"探活挂了"却不知道对端回了 503。
	if res.StatusCode == nil || *res.StatusCode != 503 {
		t.Fatalf("失败结果仍应带实际 status_code=503，实际 %v", res.StatusCode)
	}
	msg := errText(res.Error)
	for _, want := range []string{"状态码不符", "期望 [200]", "实际 503"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error 文案应包含 %q，实际 %q", want, msg)
		}
	}
}

func TestHTTPProbeExpectStatusDefaultIs200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent) // 204
	}))
	defer srv.Close()

	// expect_status 未配置：按 [200] 处理 → 204 不算成功。
	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.ExpectStatus = nil
	}))
	res := p.Probe(context.Background())
	if res.Up {
		t.Fatal("未配置 expect_status 时应按 [200] 判定，204 必须 up=false")
	}
	if !strings.Contains(errText(res.Error), "默认") {
		t.Fatalf("error 应说明期望值是默认的，实际 %q", errText(res.Error))
	}
}

func TestHTTPProbeExpectStatusCustomSet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot) // 418
	}))
	defer srv.Close()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.ExpectStatus = []int{200, 418} // 多值集合里的任意一个都算成功
	}))
	if res := p.Probe(context.Background()); !res.Up {
		t.Fatalf("418 在期望集合 [200 418] 内，应 up=true，实际 error=%q", errText(res.Error))
	}
}

func TestHTTPProbeBodyContainsHit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"status":"ok","detail":"all good"}`)
	}))
	defer srv.Close()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.BodyContains = `"status":"ok"`
	}))
	if res := p.Probe(context.Background()); !res.Up {
		t.Fatalf("body_contains 命中应 up=true，实际 error=%q", errText(res.Error))
	}
}

func TestHTTPProbeBodyContainsMiss(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"status":"degraded"}`)
	}))
	defer srv.Close()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.BodyContains = `"status":"ok"`
	}))
	res := p.Probe(context.Background())
	if res.Up {
		t.Fatal("body_contains 未命中必须 up=false")
	}
	msg := errText(res.Error)
	// ⚠️ 文案要带上「已经拿到了 200」这件事，否则用户会以为是连接问题。
	for _, want := range []string{"响应体不包含", "已读", "degraded"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error 文案应包含 %q，实际 %q", want, msg)
		}
	}
	if res.StatusCode == nil || *res.StatusCode != 200 {
		t.Fatalf("内容不符时 status_code 仍应是实际的 200，实际 %v", res.StatusCode)
	}
}

func TestHTTPProbeTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 等到探活超时把请求 ctx 掐掉再返回，⛔ 不用 time.Sleep 硬等。
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer func() { close(release); srv.Close() }()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.Timeout = config.Duration(150 * time.Millisecond)
	}))
	res := p.Probe(context.Background())
	if res.Up {
		t.Fatal("服务端不响应必须 up=false")
	}
	if !strings.Contains(errText(res.Error), "超时") {
		t.Fatalf("error 应说明是超时，实际 %q", errText(res.Error))
	}
	// ⚠️ 超时后 latency_ms 必须是 nil：连响应头都没拿到，"耗时"没有意义，
	// 给个 &0 会让面板画出一个假的数据点。
	if res.LatencyMS != nil {
		t.Fatalf("连接未建立时 latency_ms 应为 nil，实际 %v", *res.LatencyMS)
	}
	if res.StatusCode != nil {
		t.Fatalf("没拿到响应就不该有 status_code，实际 %v", *res.StatusCode)
	}
}

func TestHTTPProbeConnRefused(t *testing.T) {
	// ⚠️ 127.0.0.1:1 是保留端口且本机不会有服务监听：连接一定被拒绝（不是超时），
	// 比"临时 listen 再关掉"更稳定（关掉的端口在 TIME_WAIT 阶段行为取决于平台）。
	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = "http://127.0.0.1:1/"
		pb.Timeout = config.Duration(2 * time.Second)
	}))
	res := p.Probe(context.Background())
	if res.Up {
		t.Fatal("连接被拒绝必须 up=false")
	}
	if !strings.Contains(errText(res.Error), "连接被拒绝") {
		t.Fatalf("error 应指出连接被拒绝（而不是含糊的网络错误），实际 %q", errText(res.Error))
	}
}

func TestHTTPProbeDNSFailure(t *testing.T) {
	// ⚠️ `.invalid` 是 RFC 2606 保留的"永不解析"顶级域：无需任何网络即可确定性失败。
	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = "http://nonexistent-host.invalid/"
		pb.Timeout = config.Duration(3 * time.Second)
	}))
	res := p.Probe(context.Background())
	if res.Up {
		t.Fatal("DNS 解析不了必须 up=false")
	}
	msg := errText(res.Error)
	if !strings.Contains(msg, "DNS") && !strings.Contains(msg, "解析") && !strings.Contains(msg, "超时") {
		t.Fatalf("error 应说明解析/超时问题，实际 %q", msg)
	}
}

func TestHTTPProbeBadURLIsFailureNotPanic(t *testing.T) {
	// ⛔ 本探活不"修正"URL：配错的 URL 必须以失败结果暴露出来。
	//    这里的 URL 连 scheme 都没有（配置校验本该拦住）。
	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = "127.0.0.1:8080/no-scheme"
	}))
	res := p.Probe(context.Background())
	if res.Up {
		t.Fatal("非法 URL 必须 up=false")
	}
	if res.Error == nil || *res.Error == "" {
		t.Fatal("非法 URL 必须给出非空 error 文案")
	}
	if res.Target != "127.0.0.1:8080/no-scheme" {
		t.Fatalf("target 必须是配置里的原始字符串（⛔ 不修正），实际 %q", res.Target)
	}
}

func TestHTTPProbeSendsUserAgentFromVersion(t *testing.T) {
	gotUA := make(chan string, 1)
	gotMethod := make(chan string, 1)
	gotPath := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// ⚠️ 通道容量 1 且只在收响应头前发送：探活在读到响应头之前不会返回，
		//    所以测试在 Probe 之后读通道不会有竞态。
		gotUA <- r.Header.Get("User-Agent")
		gotMethod <- r.Method
		gotPath <- r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL + "/healthz"
		pb.Method = "get" // ⚠️ 小写：必须被规范成 GET，否则某些服务端回 405
	}))
	if res := p.Probe(context.Background()); !res.Up {
		t.Fatalf("探活应成功，error=%q", errText(res.Error))
	}

	want := version.UserAgent()
	if got := <-gotUA; got != want {
		t.Fatalf("User-Agent 应为 %q（取自 internal/version），实际 %q", want, got)
	}
	if !strings.HasPrefix(want, "vantage-agent/") || strings.Contains(want, "vantage-agent/vantage-agent/") {
		t.Fatalf("⛔ User-Agent 不能重复拼接前缀：%q", want)
	}
	if got := <-gotMethod; got != http.MethodGet {
		t.Fatalf("method 应规范成 GET，实际 %q", got)
	}
	if got := <-gotPath; got != "/healthz" {
		t.Fatalf("路径应原样保留，实际 %q", got)
	}
}

// bigBody 64KB+ 的响应体：用来证明 body_contains 只读前缀、且不会把整个响应体搬进内存。
var bigBody = func() string {
	var b strings.Builder
	b.WriteString("/healthz ") // 命中词放在**最前面**
	b.WriteString(strings.Repeat("x", 256*1024))
	b.WriteString(`"status":"ok"`) // 命中词**故意**放在 64KB 之后：前缀里找不到
	return b.String()
}()

func TestHTTPProbeLargeBodyOnlyReadsPrefix(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, bigBody)
	}))
	defer srv.Close()

	// ① 命中词在前缀内 → 成功，且耗时量到"读满上限"为止。
	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.BodyContains = "/healthz"
		pb.Timeout = config.Duration(5 * time.Second)
	}))
	res := p.Probe(context.Background())
	if !res.Up {
		t.Fatalf("前缀里的 body_contains 应命中，error=%q", errText(res.Error))
	}
	if res.LatencyMS == nil {
		t.Fatal("成功结果必须带 latency_ms")
	}

	// ② 命中词在 64KB 之后 → 判定为未命中（并说明"已读"了多少字节）。
	//    这正是「只读前 64KB」的证据：如果实现读了整个 256KB 响应体，这里会误判成成功。
	p2 := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.BodyContains = `"status":"ok"`
		pb.Timeout = config.Duration(5 * time.Second)
	}))
	res2 := p2.Probe(context.Background())
	if res2.Up {
		t.Fatal("超过 64KB 上限的部分不参与 body_contains 判定，必须 up=false")
	}
	msg := errText(res2.Error)
	if !strings.Contains(msg, fmt.Sprintf("已读 %d 字节", maxBodyRead)) {
		t.Fatalf("error 应说明只读了 %d 字节上限，实际 %q", maxBodyRead, msg)
	}
}

func TestHTTPProbeErrorTextRespectsCenterLimit(t *testing.T) {
	// 非 2xx 且响应体 1MB：错误文案里塞的是前缀，⛔ 不允许超长
	//（中心对 probes[].error 的上限是 512 字节，超了整个批次 400）。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, strings.Repeat("错", 512*1024))
	}))
	defer srv.Close()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.Timeout = config.Duration(5 * time.Second)
	}))
	res := p.Probe(context.Background())
	if res.Up {
		t.Fatal("500 必须 up=false")
	}
	if res.Error == nil {
		t.Fatal("必须给出 error 文案")
	}
	if len(*res.Error) > maxProbeErrorBytes {
		t.Fatalf("error 文案超过中心上限：%d > %d", len(*res.Error), maxProbeErrorBytes)
	}
}

// ---------------------------------------------------------------------------
// 连接复用与 ctx 语义
// ---------------------------------------------------------------------------

func TestHTTPProbeReusesConnection(t *testing.T) {
	// ⚠️ 这条用例钉死「响应体读完了才 Close」：不读完，net/http 不会把连接放回池子，
	//    3 次探活就会开 3 条 TCP 连接（表现为每次探活凭空多一个 RTT，且端口占用上涨）。
	var conns int
	var reused int
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	}))
	srv.Config.ConnState = func(c net.Conn, s http.ConnState) {
		switch s {
		case http.StateNew:
			conns++
		case http.StateIdle:
			reused++
		}
	}
	srv.Start()
	defer srv.Close()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) { pb.URL = srv.URL }))
	for i := 0; i < 3; i++ {
		if res := p.Probe(context.Background()); !res.Up {
			t.Fatalf("第 %d 次探活失败：%q", i+1, errText(res.Error))
		}
	}

	// ⚠️ 只断言「连接数远小于请求数」而不是「恰好 1 条」：连接池的行为受
	//    调度与 IdleConnTimeout 影响，写死 1 会让用例偶发假红。
	//    阈值取 request 数的一半以下时，能明确区分"复用"与"每请求一条"。
	if conns >= 3 {
		t.Fatalf("3 次探活开了 %d 条连接：响应体没有读完再 Close，连接无法复用", conns)
	}
	if reused == 0 {
		t.Fatal("没有任何连接回到 idle 状态：连接从未被复用")
	}
}

func TestHTTPProbeContextCanceled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 进探活前就已经取消

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.Timeout = config.Duration(5 * time.Second)
	}))
	start := time.Now()
	res := p.Probe(ctx)
	if res.Up {
		t.Fatal("ctx 已取消必须 up=false")
	}
	// ⚠️ 余量给足（1s）而不是断言"几毫秒"：CI 调度抖动不该让用例假红。
	//    它要证明的是「ctx 取消能提前结束探活」，而不是"取消一定会立刻返回"。
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("ctx 已取消时探活应立即结束，实际耗时 %v", elapsed)
	}
}

func TestHTTPProbeContextDeadlineShorterThanConfigTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	// 配置 5s 但 ctx 只给 150ms：⛔ 必须以 ctx 为准，否则这条探活会独占 5s，
	// 把整批上报一起推迟。
	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.URL = srv.URL
		pb.Timeout = config.Duration(5 * time.Second)
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	start := time.Now()
	res := p.Probe(ctx)
	if res.Up {
		t.Fatal("ctx 超时必须 up=false")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("探活应受 ctx 的 150ms 约束，实际耗时 %v", elapsed)
	}
}

func TestHTTPProbeFollowsRedirect(t *testing.T) {
	// ⚠️ 302 跟随是 net/http 的默认行为，这里把它**钉住**：如果将来有人为了
	//    "支持 expect_status: [302]" 而关掉跟随，这条用例会立刻报警。
	mux := http.NewServeMux()
	mux.HandleFunc("/old", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/new", http.StatusFound)
	})
	mux.HandleFunc("/new", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "moved")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) { pb.URL = srv.URL + "/old" }))
	res := p.Probe(context.Background())
	if !res.Up {
		t.Fatalf("302 应被跟随并最终判定 200 成功，error=%q", errText(res.Error))
	}
	if res.StatusCode == nil || *res.StatusCode != 200 {
		t.Fatalf("status_code 应是最终跳转后的 200，实际 %v", res.StatusCode)
	}
}

func TestHTTPProbeHTTPSUsesRealCertVerification(t *testing.T) {
	// ⛔ 明确断言：本探活**不**跳过证书校验。
	//    httptest 的 TLS 服务是自签证书 —— 如果实现里放了 InsecureSkipVerify，
	//    这条用例会变成 up=true（假健康），于是「证书过期」这类最该报警的故障永远发现不了。
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := newHTTPProber(testProbeBlock(func(pb *config.ProbeBlock) {
		pb.Type = "https"
		pb.URL = srv.URL
	}))
	res := p.Probe(context.Background())
	if res.Up {
		t.Fatal("自签证书必须校验失败（⛔ 本探活不允许 InsecureSkipVerify）")
	}
	msg := errText(res.Error)
	if !strings.Contains(msg, "证书") && !strings.Contains(msg, "certificate") && !strings.Contains(msg, "x509") {
		t.Fatalf("error 应指出证书校验问题，实际 %q", msg)
	}
	if res.Type != "https" {
		t.Fatalf("Type() 应保留配置里的 https，实际 %q", res.Type)
	}
}

// ---------------------------------------------------------------------------
// 辅助函数（纯函数）单测
// ---------------------------------------------------------------------------

func TestNormalizeMethod(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", http.MethodGet},
		{"   ", http.MethodGet},
		{"get", http.MethodGet},
		{"Get", http.MethodGet},
		{"HEAD", "HEAD"},
		{" post ", "POST"},
	}
	for _, c := range cases {
		if got := normalizeMethod(c.in); got != c.want {
			t.Errorf("normalizeMethod(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

func TestTruncateUTF8(t *testing.T) {
	// ⛔ 截断必须按**字节**（中心上限是 512 字节）且结果仍是合法 UTF-8。
	//    只按 rune 截会超字节；只按字节截会把汉字劈成半个 → 面板上出现乱码。
	long := strings.Repeat("错误", 400) // 1200 字节
	got := truncateUTF8(long, maxProbeErrorBytes)
	if len(got) > maxProbeErrorBytes {
		t.Fatalf("截断后仍超字节上限：%d > %d", len(got), maxProbeErrorBytes)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("截断把 UTF-8 序列劈开了：%q", got)
	}
	if !strings.HasSuffix(got, errTruncated) {
		t.Fatalf("截断后必须带可见标记 %q，否则运维会把截断当成错误原文", errTruncated)
	}
	// 恰好等于上限时不应截断（判据是 <= limit，不是 < limit）。
	exact := strings.Repeat("a", maxProbeErrorBytes)
	if got := truncateUTF8(exact, maxProbeErrorBytes); got != exact {
		t.Fatal("长度恰好等于上限时不应被截断")
	}
	if got := truncateUTF8("short", maxProbeErrorBytes); got != "short" {
		t.Fatalf("短文案不应被改动，实际 %q", got)
	}
}

func TestClassNetErr(t *testing.T) {
	if got := classNetErr(context.DeadlineExceeded); !strings.Contains(got, "超时") {
		t.Fatalf("context.DeadlineExceeded 应翻成超时，实际 %q", got)
	}
	if got := classNetErr(context.Canceled); !strings.Contains(got, "取消") {
		t.Fatalf("context.Canceled 应翻成取消，实际 %q", got)
	}
	if got := classNetErr(nil); got != "" {
		t.Fatalf("nil 错误应为空文案，实际 %q", got)
	}
	// ⚠️ 故意只用"真超时"这一种 net.Error 形态：连接的 refused/unreachable 由真实
	//    socket 路径覆盖（见 TestHTTPProbeConnRefused / TCP 用例），不在这里伪造。
	if got := classNetErr(fakeTimeoutErr{}); !strings.Contains(got, "超时") {
		t.Fatalf("net.Error.Timeout() 为真时应翻成超时，实际 %q", got)
	}
}

// fakeTimeoutErr 只实现 net.Error，用来验证「先判超时」这条分支。
type fakeTimeoutErr struct{}

func (fakeTimeoutErr) Error() string   { return "i/o timeout" }
func (fakeTimeoutErr) Timeout() bool   { return true }
func (fakeTimeoutErr) Temporary() bool { return true }

func TestProbeTimeoutPrefersContextDeadline(t *testing.T) {
	// 无 ctx deadline → 用配置值
	if got := probeTimeout(context.Background(), 2*time.Second); got != 2*time.Second {
		t.Fatalf("无 ctx deadline 时应返回配置值，实际 %v", got)
	}
	// 配置值缺省 → 兜底（⛔ 绝不能是 0，那会让 http.Client 永不超时）
	if got := probeTimeout(context.Background(), 0); got != defaultTimeout {
		t.Fatalf("配置缺失时应兜底为 %v，实际 %v", defaultTimeout, got)
	}
	// 配置值过大 → 被天花夹住
	if got := probeTimeout(context.Background(), 10*time.Minute); got != maxAllowedTimeout {
		t.Fatalf("配置过大时应夹到 %v，实际 %v", maxAllowedTimeout, got)
	}
	// ctx 更紧 → 以 ctx 为准
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if got := probeTimeout(ctx, 5*time.Second); got > 200*time.Millisecond {
		t.Fatalf("ctx 更紧时应以 ctx 为准（约 100ms），实际 %v", got)
	}
	// ctx 已过期 → 返回正数（让 net 立即失败），⛔ 不返回 0（0 = 永不超时）
	expired, cancel2 := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel2()
	time.Sleep(2 * time.Millisecond)
	if got := probeTimeout(expired, 5*time.Second); got <= 0 {
		t.Fatalf("ctx 已过期时必须返回正数（避免退化成永不超时），实际 %v", got)
	}
}

func TestNewProberDispatch(t *testing.T) {
	// ⛔ prober.go 的 newProber 按 type 分派，这里确认三个实现都被正确接上
	//    （漏一个的表现是"配置里配了探活，上报里完全没有"）。
	cfg := &config.Config{Probes: []config.ProbeBlock{
		{Name: "h", Type: "http", URL: "http://127.0.0.1:1/", Timeout: config.Duration(time.Second), Interval: config.Duration(30 * time.Second)},
		{Name: "hs", Type: "https", URL: "https://127.0.0.1:1/", Timeout: config.Duration(time.Second), Interval: config.Duration(30 * time.Second)},
		{Name: "t", Type: "tcp", Host: "127.0.0.1:1", Timeout: config.Duration(time.Second), Interval: config.Duration(30 * time.Second)},
		{Name: "p", Type: "ping", Host: "127.0.0.1", Timeout: config.Duration(time.Second), Interval: config.Duration(30 * time.Second)},
	}}
	ps := New(cfg)
	if len(ps) != 4 {
		t.Fatalf("应有 4 个探活器，实际 %d", len(ps))
	}
	for i, wantType := range []string{"http", "https", "tcp", "ping"} {
		if ps[i].Type() != wantType {
			t.Fatalf("第 %d 个探活器类型应为 %q，实际 %q", i, wantType, ps[i].Type())
		}
	}
	if ps[2].Target() != "127.0.0.1:1" || ps[3].Target() != "127.0.0.1" {
		t.Fatalf("Target() 应返回配置里的原始字符串：%q / %q", ps[2].Target(), ps[3].Target())
	}
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

func errText(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}
