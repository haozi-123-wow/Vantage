// Package metric 实现指标序列命名与维度转义。
//
// 依据：docs/database.md §5.7.2（指标命名、维度转义与单位）、docs/agent.md §3。
//
//	基名（无维度）：cpu.usage / mem.used_pct / process.count
//	全名（含维度）：基名{维度=值,维度=值}      例：disk.used_pct{device=sda1,mount=/data}
//
// ⛔ 本文件是 Agent 侧**唯一**的拼装实现，必须与 server/src/utils/metric.js 逐字节一致。
// 两端共用 contracts/metric-names.json 做向量对齐——「实现都对但拼法不同」
// 的后果是中心 400 schema_invalid，或者更糟：同一挂载点在库里变成两条曲线且不报错。
//
// 硬规则（与 JS 侧同源）
//   - 基名全小写 `[a-z][a-z0-9_]*(\.[a-z0-9_]+)*`；维度键只允许 `[a-z0-9_]+`；
//   - 多维度按**键名字母序升序**拼接，`,` 分隔、无空格，`=` 连接键值；
//   - 必须百分号编码（大写十六进制）：`%`→`%25`、`{`→`%7B`、`}`→`%7D`、`=`→`%3D`、
//     `,`→`%2C`、空白→其码位。⚠️ `%` 必须一起转义，否则编码不是单射；
//   - 免转义保留原样：`A-Z a-z 0-9 _ / : - . @ +`（其余一律编码，宁多编不漏编）；
//   - 无维度时**不带**花括号；全名长度 ≤ 200 字符。
package metric

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// MaxNameLength 全名长度上限（与迁移脚本 vantage_is_valid_metric_name 的 CHECK 一致）。
const MaxNameLength = 200

// reservedLabelKey 保留维度键：避免与「基名」概念混淆（与 JS 侧一致）。
const reservedLabelKey = "base"

var (
	// baseRE 基名：小写字母起头，点分段。
	baseRE = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`)
	// labelKeyRE 维度键：小写字母/数字/下划线。
	labelKeyRE = regexp.MustCompile(`^[a-z0-9_]+$`)
)

// Error 指标命名错误（属请求侧问题 → 中心 400 schema_invalid）。
type Error struct{ msg string }

func (e *Error) Error() string { return e.msg }

func newError(format string, a ...any) *Error {
	return &Error{msg: fmt.Sprintf(format, a...)}
}

// isSafe 免转义字符集：`A-Z a-z 0-9 _ / : @ . + -`（其余一律百分号编码）。
func isSafe(r rune) bool {
	switch {
	case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		return true
	}
	switch r {
	case '_', '/', ':', '@', '.', '+', '-':
		return true
	}
	return false
}

// EscapeLabelValue 维度值转义：可读字符保留，其余按 UTF-8 字节逐个百分号编码。
func EscapeLabelValue(value string) (string, error) {
	if value == "" {
		return "", newError("维度值不能是空字符串（否则会产生 `{k=}` 这种非法全名）")
	}
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		if isSafe(r) {
			b.WriteRune(r)
			continue
		}
		for _, by := range []byte(string(r)) {
			fmt.Fprintf(&b, "%%%02X", by)
		}
	}
	return b.String(), nil
}

// Build 拼装序列全名：无维度时返回基名本身。
//
// labels 为 nil 或空 map 时按「无维度」处理。
func Build(base string, labels map[string]string) (string, error) {
	if base == "" {
		return "", newError("指标基名不能为空")
	}
	if !baseRE.MatchString(base) {
		return "", newError(
			"指标基名非法：%s（要求全小写，形如 cpu.usage / disk.used_pct；维度请放 labels，不要写进基名）", base)
	}

	if len(labels) == 0 {
		if len(base) > MaxNameLength {
			return "", newError("指标全名超长（%d > %d）：%s", len(base), MaxNameLength, base)
		}
		return base, nil
	}

	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		if !labelKeyRE.MatchString(k) {
			return "", newError("维度键非法：%s（只允许小写字母、数字、下划线）", k)
		}
		if k == reservedLabelKey {
			return "", newError("维度键不允许使用保留名 base")
		}
		escaped, err := EscapeLabelValue(labels[k])
		if err != nil {
			return "", err
		}
		parts = append(parts, k+"="+escaped)
	}

	full := base + "{" + strings.Join(parts, ",") + "}"
	if len(full) > MaxNameLength {
		return "", newError(
			"指标全名超长（%d > %d）：%s。常见原因：挂载点/设备名异常长，请在 Agent 侧做长度截断或改用短别名。",
			len(full), MaxNameLength, full)
	}
	return full, nil
}

// MustBuild 供包内常量与测试使用：拼装失败直接 panic（基名写错属编码期错误）。
func MustBuild(base string, labels map[string]string) string {
	full, err := Build(base, labels)
	if err != nil {
		panic(err)
	}
	return full
}
