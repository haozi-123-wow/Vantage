// Package ulid 生成 ULID 作为 `batch_id`（幂等键）。
//
// 依据：docs/api.md §1.5（幂等）、docs/agent.md §5.2。
//
// 中心的 schema 用 `^[0-9A-HJKMNP-TV-Z]{26}$` 校验（Crockford Base32，故意不含 I/L/O/U
// 以免与 1/0 混淆），库里的 `batch_id` 列也是同样形状。
//
// 为什么用 ULID 而不是 UUID：它**按时间单调**（前 48 位是毫秒时间戳），
// 于是「最近几批」在库里就是按主键顺序，排查"某台机某段时间的上报"时不用额外排序。
// 后 80 位随机，避免多台机同毫秒生成同一个 id。
package ulid

import (
	"crypto/rand"
	"fmt"
	"time"
)

// crockford Crockford Base32 字母表（⛔ 不含 I L O U）。
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// Length ULID 的固定长度。
const Length = 26

// New 生成一个新 ULID（26 字符大写）。
func New() (string, error) { return NewAt(time.Now()) }

// NewAt 用指定时间生成（测试用；生产走 New）。
func NewAt(now time.Time) (string, error) {
	var id [16]byte
	ms := uint64(now.UnixMilli())
	id[0] = byte(ms >> 40)
	id[1] = byte(ms >> 32)
	id[2] = byte(ms >> 24)
	id[3] = byte(ms >> 16)
	id[4] = byte(ms >> 8)
	id[5] = byte(ms)
	if _, err := rand.Read(id[6:]); err != nil {
		return "", fmt.Errorf("生成 ULID 失败（随机源异常）：%w", err)
	}
	return encode(id), nil
}

// TimeMs 从 ULID 还原毫秒时间戳（前 10 个字符是 48 位时间戳）。
func TimeMs(s string) (int64, error) {
	if !IsValid(s) {
		return 0, fmt.Errorf("不是合法 ULID：%q", s)
	}
	var ms uint64
	for i := 0; i < 10; i++ {
		v := indexOf(s[i])
		// 第一个字符只承载 3 位，其余各 5 位 —— 累计 48 位
		if i == 0 {
			ms = uint64(v)
			continue
		}
		ms = ms<<5 | uint64(v)
	}
	return int64(ms), nil
}

// IsValid 是否是合法 ULID（长度 26 + 字母表内）。
func IsValid(s string) bool {
	if len(s) != Length {
		return false
	}
	for i := 0; i < len(s); i++ {
		if indexOf(s[i]) < 0 {
			return false
		}
	}
	return true
}

func indexOf(c byte) int {
	for i := 0; i < len(crockford); i++ {
		if crockford[i] == c {
			return i
		}
	}
	return -1
}

// encode 把 16 字节（128 位）编成 26 个 Base32 字符：
// 前 10 个字符 = 48 位时间戳（第一个字符只承载 3 位），后 16 个字符 = 80 位随机。
func encode(id [16]byte) string {
	var out [Length]byte
	out[0] = crockford[(id[0]&224)>>5]
	out[1] = crockford[id[0]&31]
	out[2] = crockford[(id[1]&248)>>3]
	out[3] = crockford[((id[1]&7)<<2)|((id[2]&192)>>6)]
	out[4] = crockford[(id[2]&62)>>1]
	out[5] = crockford[((id[2]&1)<<4)|((id[3]&240)>>4)]
	out[6] = crockford[((id[3]&15)<<1)|((id[4]&128)>>7)]
	out[7] = crockford[(id[4]&124)>>2]
	out[8] = crockford[((id[4]&3)<<3)|((id[5]&224)>>5)]
	out[9] = crockford[id[5]&31]
	out[10] = crockford[(id[6]&248)>>3]
	out[11] = crockford[((id[6]&7)<<2)|((id[7]&192)>>6)]
	out[12] = crockford[(id[7]&62)>>1]
	out[13] = crockford[((id[7]&1)<<4)|((id[8]&240)>>4)]
	out[14] = crockford[((id[8]&15)<<1)|((id[9]&128)>>7)]
	out[15] = crockford[(id[9]&124)>>2]
	out[16] = crockford[((id[9]&3)<<3)|((id[10]&224)>>5)]
	out[17] = crockford[id[10]&31]
	out[18] = crockford[(id[11]&248)>>3]
	out[19] = crockford[((id[11]&7)<<2)|((id[12]&192)>>6)]
	out[20] = crockford[(id[12]&62)>>1]
	out[21] = crockford[((id[12]&1)<<4)|((id[13]&240)>>4)]
	out[22] = crockford[((id[13]&15)<<1)|((id[14]&128)>>7)]
	out[23] = crockford[(id[14]&124)>>2]
	out[24] = crockford[((id[14]&3)<<3)|((id[15]&224)>>5)]
	out[25] = crockford[id[15]&31]
	return string(out[:])
}
