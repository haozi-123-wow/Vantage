package auth_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vantage-agent/internal/auth"
)

// ⛔ 与中心 server/test/sign.test.js 消费**同一个**向量文件。
// 文件固定放在仓库根的 contracts/：它是**接口定义**而不是测试代码，两侧测试都读同一份
// （见 contracts/README.md）。
// 「实现都对但拼法不同」的后果是 401 signature_invalid，而且极难排查（docs/agent.md §6.2）。
const sigVectorPath = "../../../contracts/agent-signature.json"

type sigVector struct {
	Name      string `json:"name"`
	Method    string `json:"method"`
	Path      string `json:"path"`
	Timestamp int64  `json:"timestamp"`
	Nonce     string `json:"nonce"`
	RawBody   string `json:"raw_body"`
	BodySHA   string `json:"body_sha256"`
	Canonical string `json:"canonical"`
	Signature string `json:"signature"`
}

type sigFile struct {
	Secret  string      `json:"secret"`
	Vectors []sigVector `json:"vectors"`
}

func loadSigVectors(t *testing.T) sigFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(sigVectorPath))
	if err != nil {
		t.Fatalf("读取签名共享向量失败（%s）：%v", sigVectorPath, err)
	}
	var sf sigFile
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&sf); err != nil {
		t.Fatalf("解析签名共享向量失败：%v", err)
	}
	if sf.Secret == "" || len(sf.Vectors) == 0 {
		t.Fatalf("签名向量文件内容不完整：secret=%q vectors=%d", sf.Secret, len(sf.Vectors))
	}
	return sf
}

// TestSignatureMatchesSharedVectors：三段必须是逐字节一致 —— body 摘要、canonical、签名。
func TestSignatureMatchesSharedVectors(t *testing.T) {
	sf := loadSigVectors(t)
	for _, v := range sf.Vectors {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			body := []byte(v.RawBody)

			if got := auth.BodySHA256Hex(body); got != v.BodySHA {
				t.Fatalf("body_sha256 不一致\n得到: %s\n期望: %s", got, v.BodySHA)
			}
			if got := auth.Canonical(v.Method, v.Path, v.Timestamp, v.Nonce, v.BodySHA); got != v.Canonical {
				t.Fatalf("canonical 不一致\n得到: %q\n期望: %q", got, v.Canonical)
			}
			if got := auth.Sign([]byte(sf.Secret), v.Method, v.Path, v.Timestamp, v.Nonce, body); got != v.Signature {
				t.Fatalf("signature 不一致\n得到: %s\n期望: %s", got, v.Signature)
			}
		})
	}
}

// TestCanonicalShape：✅ 决策 #46 —— 固定 LF、共 4 处、末尾不加换行、path 不含 host/query。
func TestCanonicalShape(t *testing.T) {
	got := auth.Canonical(auth.MethodPost, auth.ReportPath, 1758800000123, "a1b2", "deadbeef")

	if n := strings.Count(got, "\n"); n != 4 {
		t.Fatalf("LF 分隔符应为 4 处，实际 %d 处：%q", n, got)
	}
	if strings.HasSuffix(got, "\n") {
		t.Fatalf("canonical 末尾不得有换行：%q", got)
	}
	if strings.Contains(got, "\r") {
		t.Fatalf("canonical 不得含 CR（必须用 LF）：%q", got)
	}
	want := "POST\n/api/v1/agent/report\n1758800000123\na1b2\ndeadbeef"
	if got != want {
		t.Fatalf("canonical 形态不符\n得到: %q\n期望: %q", got, want)
	}
}

// TestSignatureCoversExactBytes：签名必须覆盖**发送的那份字节**——
// 任何字节变化（哪怕只是空格）都必须改变签名，否则「先解析再重序列化」这类 bug 不会被发现。
func TestSignatureCoversExactBytes(t *testing.T) {
	secret := []byte("vs_TEST_SECRET")
	base := []byte(`{"a":1}`)
	// 语义相同、字节不同：不得产生相同签名
	reserialized := []byte(`{"a": 1}`)

	s1 := auth.Sign(secret, auth.MethodPost, auth.ReportPath, 1, "n", base)
	s2 := auth.Sign(secret, auth.MethodPost, auth.ReportPath, 1, "n", reserialized)
	if s1 == s2 {
		t.Fatal("字节不同却得到相同签名：签名没有覆盖原始字节")
	}
	if s1 == auth.Sign(secret, auth.MethodPost, auth.HeartbeatPath, 1, "n", base) {
		t.Fatal("path 不同却得到相同签名")
	}
	if s1 == auth.Sign(secret, auth.MethodPost, auth.ReportPath, 2, "n", base) {
		t.Fatal("timestamp 不同却得到相同签名")
	}
	if s1 == auth.Sign(secret, auth.MethodPost, auth.ReportPath, 1, "m", base) {
		t.Fatal("nonce 不同却得到相同签名")
	}
	if s1 == auth.Sign([]byte("vs_OTHER_SECRET"), auth.MethodPost, auth.ReportPath, 1, "n", base) {
		t.Fatal("secret 不同却得到相同签名")
	}
}

// TestNewNonce：32 字符小写 hex、不重复（重复会让中心判 nonce_reused 409）。
func TestNewNonce(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		n, err := auth.NewNonce()
		if err != nil {
			t.Fatalf("生成 nonce 失败：%v", err)
		}
		if len(n) != 32 {
			t.Fatalf("nonce 长度应为 32，实际 %d：%q", len(n), n)
		}
		for _, r := range n {
			if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
				t.Fatalf("nonce 必须是小写 hex：%q", n)
			}
		}
		if seen[n] {
			t.Fatalf("nonce 重复：%q", n)
		}
		seen[n] = true
	}
}
