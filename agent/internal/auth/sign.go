// Package auth 负责本机凭证加载与上行报文的 HMAC 签名。
//
// 依据：docs/agent.md §6、docs/api.md §2.1、决策 #37/#46。
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
)

const (
	// MethodPost 上报只用 POST（center 无任何其他方法的上行端点）。
	MethodPost = "POST"
	// ReportPath 完整上报端点。
	ReportPath = "/api/v1/agent/report"
	// HeartbeatPath 心跳端点。
	HeartbeatPath = "/api/v1/agent/heartbeat"
	// NonceBytes nonce 随机字节数（hex 后 32 字符，✅ §6.2 建议 ≥16 字节）。
	NonceBytes = 16
)

// BodySHA256Hex 报文体的 sha256（hex 小写）。
//
// ⛔ 必须对**签名用的同一份字节**求值：即 JSON 序列化之后的原始字节，
// 不对 gzip 后的字节、也绝不是「反序列化再序列化」的结果（✅ 决策 #35）。
func BodySHA256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// Canonical 拼装签名串。
//
//	"POST" + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(raw_body)
//
// ✅ 决策 #46：分隔符固定 LF(0x0A)、共 4 处、**末尾不加换行**；path 仅路径（⛔ 不含 host/query）；
// timestamp 为十进制 ASCII unix **毫秒**（无前导零、无正号）。
func Canonical(method, path string, tsMs int64, nonce, bodySHA256 string) string {
	return method + "\n" + path + "\n" + strconv.FormatInt(tsMs, 10) + "\n" + nonce + "\n" + bodySHA256
}

// Sign 计算签名字节串（hex 小写）。
func Sign(secret []byte, method, path string, tsMs int64, nonce string, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	// Write 永不返回错误（hash.Hash 的约定），无需处理。
	_, _ = mac.Write([]byte(Canonical(method, path, tsMs, nonce, BodySHA256Hex(body))))
	return hex.EncodeToString(mac.Sum(nil))
}

// NewNonce 生成 32 字符 hex 随机 nonce。
func NewNonce() (string, error) {
	b := make([]byte, NonceBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("生成 nonce 失败（随机源异常）：%w", err)
	}
	return hex.EncodeToString(b), nil
}
