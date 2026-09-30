package model_test

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"vantage-agent/internal/model"
)

// -update 重新生成 contracts/wire/*.json（改了报文结构才用）。
var update = flag.Bool("update", false, "重新生成线上的黄金样本")

// ⛔ 黄金样本固定放在仓库根的 contracts/（见 contracts/README.md）：它是两端共享的接口定义，
// 放 agent/testdata/ 或 server/test/ 都会让另一侧的测试产生跨目录依赖。
const wireDir = "../../../contracts/wire"

func f(v float64) *float64 { return &v }
func b(v bool) *bool       { return &v }
func u(v uint64) *uint64   { return &v }
func i(v int) *int         { return &v }
func s(v string) *string   { return &v }

// wireBytes 产出**线上真实字节**：紧凑 JSON、不转义 HTML（与 reporter 用的编码器一致）。
func wireBytes(t *testing.T, v any) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// fixtures 三份样本：完整报（覆盖每一个可选字段）、最小报（只有中心要求的必填项）、心跳。
//
// ⚠️ 值全部写死（不用 time.Now / 随机数），否则黄金样本每次都不一样、比对就没意义了。
func fixtures() map[string]any {
	full := &model.Report{
		AgentID: "11111111-2222-3333-4444-555555555555",
		BatchID: "01J000000000000000000000AA",
		Ts:      1758800000123,
		Seq:     u(7),
		Host: &model.Host{
			Hostname: "node-a", OS: "linux", Kernel: "6.6.0-28-generic", Arch: "amd64",
			BootTime: 1758790000,
			Capabilities: &model.Capabilities{
				DiskInode: b(true), DiskIO: b(true), NetConnCount: b(true),
				GPUNvidia: b(false), GPUAMD: b(false), ProcessTop: b(true),
				ProbePing: b(true), ProbeHTTP: b(true), ProbeTCP: b(true), Docker: b(false),
			},
		},
		ReportedIP: "203.0.113.7",
		Metrics: &model.Metrics{
			CPU: &model.CPU{
				Usage:     f(12.5),
				Cores:     []float64{10, 20, 0, 20},
				Load:      []float64{0.5, 0.42, 0.31},
				CtxSwitch: f(1234.5),
			},
			Mem: &model.Mem{
				Total: f(16777216000), Used: f(8123456789), Available: f(8000000000),
				Cached: f(3000000000), Buffers: f(123456789),
				Swap: &model.Swap{Total: f(2147483648), Used: f(0)},
			},
			Disk: []model.Disk{{
				Mount: "/", Device: "nvme0n1p2",
				Total: f(500107862016), Used: f(250053931008), InodeUsed: f(12.5),
				ReadBps: f(1048576), WriteBps: f(524288), ReadIOPS: f(120.5), WriteIOPS: f(60.25),
				LatencyMS: f(1.25),
			}},
			Net: []model.Net{{
				Device: "eth0", RxBps: f(2048.5), TxBps: f(1024.25),
				RxTotal: f(123456789), TxTotal: f(98765432), ConnCount: func() *uint32 { v := uint32(42); return &v }(),
				Err: f(0), Drop: f(1.5),
			}},
			GPU: []model.GPU{{
				Index: 0, Util: f(95), MemUsed: f(4294967296), MemTotal: f(8589934592),
				Temp: f(72.5), Power: f(180.25),
			}},
			Process: &model.Process{
				Count: 231,
				Top:   []model.ProcessTop{{Pid: 1234, Name: "nginx", CPU: f(3.5), Mem: f(104857600)}},
			},
			Agent: &model.Self{MemRSS: f(18874368), ReportFailures: func() *uint64 { v := uint64(0); return &v }(), ReloadOK: b(true)},
		},
		Probes: []model.Probe{
			{Name: "site-health", Type: "https", Target: "https://example.com/healthz", Up: true, LatencyMS: f(123.5), StatusCode: i(200)},
			{Name: "public-gw", Type: "ping", Target: "1.1.1.1", Up: false, Error: s("i/o timeout")},
		},
	}

	minimal := &model.Report{
		AgentID: "11111111-2222-3333-4444-555555555555",
		BatchID: "01J000000000000000000000CC",
		Ts:      1758800060000,
		Metrics: &model.Metrics{
			CPU: &model.CPU{Usage: f(0)},
			Mem: &model.Mem{Total: f(1073741824)},
		},
	}

	heartbeat := &model.Heartbeat{
		AgentID: "11111111-2222-3333-4444-555555555555",
		BatchID: "01J000000000000000000000BB",
		Ts:      1758800060000,
		Seq:     u(8),
	}

	return map[string]any{
		"report-full.json":    full,
		"report-minimal.json": minimal,
		"heartbeat.json":      heartbeat,
	}
}

// TestWireFixtures 生成 / 比对线上的黄金样本，并顺手做本地校验。
//
// 这些文件随后被 server/test/agentwire.test.js 送进**中心的真实链路**
// （gzip → 签名 → schema → 摊平 → 落库参数）再跑一遍 ——
// 跨语言地钉死「Agent 以为的字段」与「中心要求的字段」是同一套。
func TestWireFixtures(t *testing.T) {
	if err := os.MkdirAll(filepath.FromSlash(wireDir), 0o755); err != nil {
		t.Fatalf("创建 %s 失败：%v", wireDir, err)
	}

	for name, v := range fixtures() {
		v := v
		t.Run(name, func(t *testing.T) {
			got := wireBytes(t, v)
			path := filepath.Join(filepath.FromSlash(wireDir), name)

			if *update {
				if err := os.WriteFile(path, append(got, '\n'), 0o644); err != nil {
					t.Fatalf("写入黄金样本失败：%v", err)
				}
				t.Logf("已更新 %s（%d 字节）", path, len(got))
				return
			}

			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("读取黄金样本失败（首次请跑 go test -run TestWireFixtures -update）：%v", err)
			}
			want = bytes.TrimRight(want, "\n")
			if !bytes.Equal(got, want) {
				t.Fatalf("线上字节与黄金样本不一致\n得到: %s\n期望: %s", got, want)
			}

			// 本地校验：完整样本与最小样本都必须通过
			switch r := v.(type) {
			case *model.Report:
				if err := r.Validate(); err != nil {
					t.Fatalf("样本未通过本地校验：%v", err)
				}
			case *model.Heartbeat:
				if err := r.Validate(); err != nil {
					t.Fatalf("样本未通过本地校验：%v", err)
				}
			}
		})
	}
}
