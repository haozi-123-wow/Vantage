// 本文件：`tcp` 探活的单元测试。
//
// ⛔ 全部用 net.Listen 起本机端口：测试必须能在**没有网络**的环境下跑，
// ⛔ 不用 8.8.8.8:53 之类的公网地址（断网 CI 会整片红，而且是"时好时坏"的那种红）。
//
// ⚠️ 耗时断言一律给足余量（≥1s）：探活的 latency_ms 是真实测出来的，
// 断言"小于 50ms"会在负载高的机器上假红，而它想验证的东西（连接建立了、耗时是正数）
// 用宽松阈值一样能证明。
package prober

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"vantage-agent/internal/config"
)

// tcpProbeBlock 造一份 tcp 探活配置。
func tcpProbeBlock(host string, timeout time.Duration) *config.ProbeBlock {
	return &config.ProbeBlock{
		Name:     "tcp-under-test",
		Type:     "tcp",
		Host:     host,
		Timeout:  config.Duration(timeout),
		Interval: config.Duration(30 * time.Second),
	}
}

func TestTCPProbeSuccess(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("起本地监听失败：%v", err)
	}
	defer ln.Close()

	// 服务端只接受连接、读一次（读到 EOF 就说明客户端没发数据、且立刻关了）。
	readDone := make(chan tcpServerRead, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			readDone <- tcpServerRead{err: err}
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		buf := make([]byte, 64)
		n, err := conn.Read(buf)
		readDone <- tcpServerRead{n: n, data: buf[:n], err: err}
	}()

	p := newTCPProber(tcpProbeBlock(ln.Addr().String(), 2*time.Second))
	start := time.Now()
	res := p.Probe(context.Background())
	elapsed := time.Since(start)

	if !res.Up {
		t.Fatalf("端口在监听应 up=true，实际 error=%q", errText(res.Error))
	}
	if res.LatencyMS == nil || *res.LatencyMS < 0 {
		t.Fatalf("成功必须带非负 latency_ms，实际 %v", res.LatencyMS)
	}
	// ⚠️ latency_ms 只应量"连接建立"，不该包含任何业务交互 ——
	//    给足余量（100ms）而不是精确值，避免调度抖动造成假红。
	if *res.LatencyMS > 100 {
		t.Fatalf("localhost 连接建立的延迟应远小于 100ms，实际 %v ms", *res.LatencyMS)
	}
	if elapsed > time.Second {
		t.Fatalf("探活应立即返回，实际耗时 %v", elapsed)
	}
	// ⛔ TCP 没有状态码：必须是 nil，⛔ 不能填 0 或 200（那是编造事实）。
	if res.StatusCode != nil {
		t.Fatalf("tcp 探活的 status_code 必须为 nil，实际 %v", *res.StatusCode)
	}
	if res.Error != nil {
		t.Fatalf("成功结果不应有 error，实际 %q", *res.Error)
	}

	// ✅ 关键断言：服务端**一个字节**都不该收到。
	select {
	case r := <-readDone:
		if r.err != nil && !errors.Is(r.err, io.EOF) {
			// 到点还没读到任何东西也算通过（说明客户端没发数据）。
			if ne, ok := r.err.(net.Error); !ok || !ne.Timeout() {
				t.Fatalf("服务端读连接失败：%v", r.err)
			}
		}
		if r.n != 0 || len(r.data) != 0 {
			t.Fatalf("⛔ tcp 探活不得发送任何业务数据，服务端却收到了 %d 字节：%q", r.n, r.data)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("服务端读取超时（既没读到数据也没等到 EOF）：探活可能没有关闭连接")
	}
}

func TestTCPProbeRefused(t *testing.T) {
	// ⚠️ 先让系统分配一个端口再立刻关掉：这个端口在本机几乎不可能被占用，
	//    比猜一个固定端口更稳（固定端口可能被同事的服务占上 → 用例变成假绿）。
	port := freePort(t)

	p := newTCPProber(tcpProbeBlock(port, 2*time.Second))
	res := p.Probe(context.Background())
	if res.Up {
		t.Fatal("没有监听的端口必须 up=false")
	}
	if !strings.Contains(errText(res.Error), "连接被拒绝") {
		t.Fatalf("error 应指出连接被拒绝（与超时区分开），实际 %q", errText(res.Error))
	}
	// ⛔ 失败时 latency_ms 必须为 nil：连都没连上，"耗时"没有意义。
	if res.LatencyMS != nil {
		t.Fatalf("连接失败时 latency_ms 应为 nil，实际 %v", *res.LatencyMS)
	}
	if res.StatusCode != nil {
		t.Fatalf("tcp 探活的 status_code 必须为 nil，实际 %v", *res.StatusCode)
	}
}

func TestTCPProbeEmptyHost(t *testing.T) {
	// 配置校验会拦住它（tcp 的 host 必填且必须带端口），但探活器本身
	// ⛔ 不能在缺字段时 panic 或挂起 —— 它必须给出一条明确的结果。
	p := newTCPProber(tcpProbeBlock("", 500*time.Millisecond))
	res := p.Probe(context.Background())
	if res.Up {
		t.Fatal("空 host 必须 up=false")
	}
	if res.Error == nil || *res.Error == "" {
		t.Fatal("空 host 必须给出非空 error 文案")
	}
}

func TestTCPProbeContextCanceled(t *testing.T) {
	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	p := newTCPProber(tcpProbeBlock(port, 5*time.Second))
	start := time.Now()
	res := p.Probe(ctx)
	if res.Up {
		t.Fatal("ctx 已取消必须 up=false")
	}
	// ⚠️ 余量给足：证明的是"ctx 能提前结束探活"，不是"取消一定在 1ms 内返回"。
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("ctx 已取消时探活应立即结束，实际耗时 %v", elapsed)
	}
}

func TestTCPProbeContextDeadlineShorterThanConfigTimeout(t *testing.T) {
	port := freePort(t)
	// ctx 只给 100ms，配置给 5s：必须以 ctx 为准，否则一条探活会独占 5s。
	p := newTCPProber(tcpProbeBlock(port, 5*time.Second))
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	res := p.Probe(ctx)
	if res.Up {
		t.Fatal("ctx 超时必须 up=false")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("探活应受 ctx 约束，实际耗时 %v", elapsed)
	}
}

func TestTCPProbeMetadata(t *testing.T) {
	p := newTCPProber(tcpProbeBlock("10.0.0.5:5432", 3*time.Second))
	if p.Name() != "tcp-under-test" {
		t.Fatalf("Name() = %q", p.Name())
	}
	if p.Type() != "tcp" {
		t.Fatalf("Type() = %q", p.Type())
	}
	// ✅ Target() 必须是配置里的原始 host（带端口的 host:port）。
	if p.Target() != "10.0.0.5:5432" {
		t.Fatalf("Target() = %q，期望 10.0.0.5:5432", p.Target())
	}
	if p.Interval() != 30*time.Second {
		t.Fatalf("Interval() = %v，期望 30s", p.Interval())
	}
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

// tcpServerRead 服务端读到的东西（0 字节 + EOF 是"客户端没发数据"的正常形态）。
type tcpServerRead struct {
	n    int
	data []byte
	err  error
}

// freePort 拿一个"刚刚还空着"的本机端口（先 listen 拿系统分配，再关掉）。
//
// ⚠️ 这里存在理论上的 TOCTOU（关掉到探活之间端口被人抢走），但概率极低；
// 换成"猜一个固定端口"反而更差：被占用时用例会静默变成假绿。
func freePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("取空闲端口失败：%v", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatalf("关闭临时监听失败：%v", err)
	}
	return addr
}
