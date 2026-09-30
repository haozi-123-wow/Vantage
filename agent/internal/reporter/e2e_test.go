package reporter_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
	"vantage-agent/internal/reporter"
)

// ---------------------------------------------------------------------------
// 真机端到端：真实签名 → 真实中心 → 真实 PostgreSQL
// ---------------------------------------------------------------------------
//
// 设计意图：前面所有用例用的都是 `httptest` 假中心，它们能证明"Agent 自己前后一致"，
// 但**证明不了中心真的会收下我们发的东西** —— 那需要一次真实的握手、真实的验签、
// 真实的 schema 校验、真实的落库。
//
// 报文形状取自 `contracts/wire/report-full.json`（Agent 自己产出的线上黄金字节），
// 因此这里连带的收益是：**该黄金样本在真实中心上被接受过**。
//
// 运行方式（未设置环境变量时整组跳过，所以 CI/日常 `go test` 不受影响）：
//
//	$env:VANTAGE_E2E_CENTER = "http://127.0.0.1:8080"
//	$env:VANTAGE_E2E_AGENT_ID = "<uuid>"
//	$env:VANTAGE_E2E_KEY = "vk_..."
//	$env:VANTAGE_E2E_SECRET = "vs_..."
//	go test -count=1 -run TestE2E -v ./internal/reporter/
//
// ⚠️ 会向真实库里写入数据（这是刻意的：不写库就证明不了链路通）。测试自带的
//    agent 与数据请自行清理，或使用专门的联调 Agent。

type e2eEnv struct {
	center  string
	agentID string
	key     string
	secret  string
}

func loadE2E(t *testing.T) e2eEnv {
	t.Helper()
	e := e2eEnv{
		center:  os.Getenv("VANTAGE_E2E_CENTER"),
		agentID: os.Getenv("VANTAGE_E2E_AGENT_ID"),
		key:     os.Getenv("VANTAGE_E2E_KEY"),
		secret:  os.Getenv("VANTAGE_E2E_SECRET"),
	}
	if e.center == "" || e.agentID == "" || e.key == "" || e.secret == "" {
		t.Skip("需要 VANTAGE_E2E_CENTER / VANTAGE_E2E_AGENT_ID / VANTAGE_E2E_KEY / VANTAGE_E2E_SECRET")
	}
	return e
}

// goldenReport 读入契约黄金样本，并把"批次身份"字段清空 ——
// 那些字段由 reporter 统一生成（batch_id 必须是新的，否则中心会按幂等直接返回旧响应，
// 我们就等于没测到真实写入）。
func goldenReport(t *testing.T) *model.Report {
	t.Helper()
	path := filepath.Join("..", "..", "..", "contracts", "wire", "report-full.json")
	raw, err := os.ReadFile(filepath.FromSlash(path))
	if err != nil {
		t.Fatalf("读取契约黄金样本失败（%s）：%v", path, err)
	}
	var rep model.Report
	if err := json.Unmarshal(raw, &rep); err != nil {
		t.Fatalf("解析黄金样本失败：%v", err)
	}
	// 清掉批次身份，交给 reporter 重新生成
	rep.BatchID = ""
	rep.Ts = 0
	rep.Seq = nil
	// reported_ip 清掉：它是"上一跳出口 IP"，由 reporter 自己填；样本里的
	// 203.0.113.7 是文档用的保留地址，直接发会与连接来源 IP 不一致
	rep.ReportedIP = ""
	return &rep
}

func e2eReporter(t *testing.T, e e2eEnv, secret string) *reporter.Reporter {
	t.Helper()

	cfg := config.Defaults()
	cfg.Center.URL = e.center
	cfg.Center.AllowHTTP = true
	cfg.Center.Timeout = config.Duration(10 * time.Second)
	cfg.Agent.ID = e.agentID

	r, err := reporter.New(reporter.Options{
		Config:  cfg,
		AgentID: e.agentID,
		Key:     e.key,
		Secret:  []byte(secret),
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("构造 reporter 失败：%v", err)
	}
	return r
}

// TestE2EWrongSecretIsRejected 是一道**对照实验**：
//
// ⛔ 没有它，下面那条"200 成功"是无法采信的 —— 万一中心因为某种原因（比如根本没启用验签）
// 对任何请求都回 200，我们就会把"链路没通"误判成"链路通了"。
// 有了它，200 才真的说明"中心验了签、且我们签对了"。
func TestE2EWrongSecretIsRejected(t *testing.T) {
	e := loadE2E(t)
	r := e2eReporter(t, e, "vs_WRONG_SECRET_DO_NOT_USE_000000000000")

	_, err := r.Report(context.Background(), goldenReport(t))
	if err == nil {
		t.Fatal("⛔ 用错误 secret 竟然上报成功了：说明中心没有真正验签，后续所有 200 都不可信")
	}
	var se *reporter.SendError
	if !asSendError(err, &se) {
		t.Fatalf("错误类型异常：%T %v", err, err)
	}
	if se.StatusCode != 401 {
		t.Fatalf("期望 401（signature_invalid），实际 HTTP %d：%v", se.StatusCode, err)
	}
	t.Logf("对照实验通过：错误 secret 被中心以 HTTP %d 拒绝（%s）", se.StatusCode, se.Detail)
}

func TestE2ERealCenterAcceptsAgentBytes(t *testing.T) {
	e := loadE2E(t)
	r := e2eReporter(t, e, e.secret)

	resp, err := r.Report(context.Background(), goldenReport(t))
	if err != nil {
		t.Fatalf("真实中心拒绝了 Agent 的报文：%v", err)
	}
	if !resp.OK {
		t.Fatalf("响应里 ok 不为 true：%+v", resp)
	}
	if resp.ServerTS <= 0 {
		t.Fatalf("server_ts 异常：%d", resp.ServerTS)
	}
	// 时间权威（✅ 决策 #16）：server_ts 应当接近本机时间（除非本机时钟大幅偏移，
	// 那种情况下中心会另有 clock_drift 告警）
	if delta := time.Since(time.UnixMilli(resp.ServerTS)); delta > 2*time.Minute || delta < -2*time.Minute {
		t.Logf("⚠️ server_ts 与本机时间相差 %s，请检查本机时钟/NTP", delta)
	}
	t.Logf("端到端成功：attempts=%d 压缩前=%d 字节 实际发出=%d 字节 server_ts=%d",
		resp.Attempts, resp.RawBytes, resp.WireBytes, resp.ServerTS)
	t.Logf("本机出口 IP（Agent 自测）：%s", r.ReportedIP())
}

// TestE2EIdempotentReplay 复现"响应丢了、Agent 重试"这个真实场景：
// 同一批字节（同一个 batch_id）再发一次，中心必须返回同样的 200 而不是重复写库。
func TestE2EIdempotentReplay(t *testing.T) {
	e := loadE2E(t)
	r := e2eReporter(t, e, e.secret)

	prepared, err := r.Prepare(goldenReport(t))
	if err != nil {
		t.Fatalf("Prepare 失败：%v", err)
	}

	first, err := prepared.Send(context.Background(), r)
	if err != nil {
		t.Fatalf("首次发送失败：%v", err)
	}
	// 同一份字节（同 batch_id）再发一次：中心应当命中幂等键并返回 200
	second, err := prepared.Send(context.Background(), r)
	if err != nil {
		t.Fatalf("同 batch_id 重发应当被幂等接受，实际失败：%v", err)
	}
	if !second.OK {
		t.Fatalf("重发响应 ok 不为 true：%+v", second)
	}
	if first.ServerTS != second.ServerTS {
		t.Logf("⚠️ 两次 server_ts 不同（%d vs %d）：若中心返回的是「重放旧响应」应当相同，"+
			"不同则说明它可能真的写了两遍 —— 请到库里核对该 batch_id 的落库行数",
			first.ServerTS, second.ServerTS)
	}
	t.Logf("幂等重放：batch_id=%s 两次都返回 200", prepared.BatchID())
}
