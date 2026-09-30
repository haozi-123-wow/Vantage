package metric_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vantage-agent/internal/metric"
)

// ⛔ 共享向量：与中心 server/test/metric.test.js 消费**同一个文件**（仓库根的 contracts/）。
// 这是「实现都对但拼法不同」这类难查缺陷的唯一自动化防线（docs/database.md §5.7.2）。
const vectorPath = "../../../contracts/metric-names.json"

// labelValue 支持两种写法：字符串，或 {"repeat":"a","count":179}（精确构造长度边界）。
type labelValue struct {
	plain  string
	repeat string
	count  int
	isRep  bool
}

func (v *labelValue) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		v.plain, v.isRep = s, false
		return nil
	}
	var r struct {
		Repeat string `json:"repeat"`
		Count  int    `json:"count"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return err
	}
	v.repeat, v.count, v.isRep = r.Repeat, r.Count, true
	return nil
}

func (v labelValue) String() string {
	if v.isRep {
		return strings.Repeat(v.repeat, v.count)
	}
	return v.plain
}

type vectorCase struct {
	Name             string                `json:"name"`
	Base             string                `json:"base"`
	Labels           map[string]labelValue `json:"labels"`
	Full             *string               `json:"full"`
	ExpectFullLength *int                  `json:"expectFullLength"`
}

type vectorFile struct {
	Cases   []vectorCase `json:"cases"`
	Invalid []vectorCase `json:"invalid"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(vectorPath))
	if err != nil {
		t.Fatalf("读取共享测试向量失败（%s）：%v", vectorPath, err)
	}
	var vf vectorFile
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&vf); err != nil {
		t.Fatalf("解析共享测试向量失败：%v", err)
	}
	if len(vf.Cases) == 0 || len(vf.Invalid) == 0 {
		t.Fatalf("向量文件内容不完整：cases=%d invalid=%d", len(vf.Cases), len(vf.Invalid))
	}
	return vf
}

func toLabels(in map[string]labelValue) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v.String()
	}
	return out
}

// TestBuildMatchesSharedVectors：合法向量必须逐字节等于期望全名。
func TestBuildMatchesSharedVectors(t *testing.T) {
	vf := loadVectors(t)
	for _, c := range vf.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			got, err := metric.Build(c.Base, toLabels(c.Labels))

			if err != nil {
				t.Fatalf("不应失败：%v", err)
			}
			if c.Full != nil && got != *c.Full {
				t.Fatalf("全名不一致\n得到: %q\n期望: %q", got, *c.Full)
			}
			if c.ExpectFullLength != nil && len(got) != *c.ExpectFullLength {
				t.Fatalf("全名长度 %d ≠ 期望 %d：%q", len(got), *c.ExpectFullLength, got)
			}
			if len(got) > metric.MaxNameLength {
				t.Fatalf("全名超过长度上限 %d：%q（%d 字符）", metric.MaxNameLength, got, len(got))
			}
		})
	}
}

// TestBuildRejectsInvalidVectors：非法向量必须被拒绝（不比对错误文案，只要求拒绝）。
func TestBuildRejectsInvalidVectors(t *testing.T) {
	vf := loadVectors(t)
	for _, c := range vf.Invalid {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			if got, err := metric.Build(c.Base, toLabels(c.Labels)); err == nil {
				t.Fatalf("非法输入必须被拒绝，实际返回 %q", got)
			}
		})
	}
}

// TestEscapeIsInjective：转义必须是单射 —— 否则不同维度会撞成同一序列名（静默数据污染）。
func TestEscapeIsInjective(t *testing.T) {
	pairs := [][2]string{
		{"%20", " "},
		{"a%2Cb", "a,b"},
		{"a%7Bb%7D", "a{b}"},
		{"/a=b", "/a%3Db"},
	}
	seen := map[string]string{}
	for _, p := range pairs {
		a, err := metric.EscapeLabelValue(p[0])
		if err != nil {
			t.Fatalf("转义失败：%v", err)
		}
		b, err := metric.EscapeLabelValue(p[1])
		if err != nil {
			t.Fatalf("转义失败：%v", err)
		}
		if a == b {
			t.Fatalf("转义不单射：%q 与 %q 都编成 %q", p[0], p[1], a)
		}
		if prev, dup := seen[a]; dup {
			t.Fatalf("转义不单射：%q 与 %q 都编成 %q", prev, p[0], a)
		}
		seen[a] = p[0]
	}
}

// TestBuildIsDeterministicAcrossKeyOrder：map 迭代顺序随机，但结果必须与键序无关。
func TestBuildIsDeterministicAcrossKeyOrder(t *testing.T) {
	want := "disk.used_pct{device=sda1,mount=/data}"
	for i := 0; i < 200; i++ {
		got, err := metric.Build("disk.used_pct", map[string]string{"mount": "/data", "device": "sda1"})
		if err != nil {
			t.Fatalf("不应失败：%v", err)
		}
		if got != want {
			t.Fatalf("第 %d 次结果与键序有关：%q ≠ %q", i, got, want)
		}
	}
}
