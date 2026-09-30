// procfs.go 提供 /proc 的读写与文本解析工具（**不带构建标签**）。
//
// 依据：docs/agent.md §3（采集器规格）、§13.1（平台适配层要求）、docs/database.md §5.7.2（单位）。
//
// 职责边界：
//   - 本文件只做「把 {root}/xxx 读出来并切成字段」这类纯工具；
//   - 具体语义（哪些字段、怎么算）在各采集器文件里；
//   - ⛔ 这里不认识"Linux"：root 是注入的目录，夹具目录与真 /proc 走完全同一条代码路径。
//
// ⚠️ 踩坑提醒（都在真机上极难定位）：
//   - 所有读取函数**永不 panic、永不返回零值冒充数据**：读不到就返回 error / 空串 / 0，
//     由调用方决定"这一项本轮不出"（✅ §4.4 优雅降级）。
//   - 字段一律**按位置取 + 逐个判存在**：/proc 的行尾字段随内核版本增减
//     （diskstats 11→20 列、stat 的 guest/guest_nice…），先 `len(fields) >= N` 再下标访问，
//     并且⛔ 不要用"固定列数"的假设去校验整行 —— 那会让新内核上的一切采集静默失败。
package collector

import (
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// procPath 拼出 root 下某个 /proc 相对路径的本地路径。
//
// ⚠️ rel 一律用 `/` 分隔（与 /proc 一致），这里统一转成本机分隔符：
// 夹具在 Windows 上跑测试时必须能直接命中 `testdata\proc\net\dev`。
func procPath(root, rel string) string {
	if root == "" {
		// 正常路径不会走到这里（platform_*.go 已把空 ProcRoot 补成 DefaultProcRoot）。
		// 兜底成绝对路径而不是相对路径：相对路径会跟着进程 cwd 变，排障时极具误导性。
		root = DefaultProcRoot
		if root == "" {
			root = "/proc"
		}
	}
	return filepath.Join(root, filepath.FromSlash(rel))
}

// ReadTrimmed 读 {procRoot}/{relPath} 并去掉首尾空白；读不到返回**空串**。
//
// 这是 collector.go 的 HostInfo 直接依赖的符号（内核版本），所以签名与语义都被钉死：
// ⛔ 读不到时必须返回空串而不是 panic —— 非 root 用户、容器里没挂 /proc/sys、
//    内核裁剪都可能让这个文件不存在，而它绝不能拖垮整个采集。
func ReadTrimmed(procRoot, relPath string) string {
	s, err := readFileTrimmed(procRoot, relPath)
	if err != nil {
		return ""
	}
	return s
}

// readFileTrimmed 读文件并 trim；读不到返回 error，由调用方决定怎么降级。
//
// log 参数留给调用方：本函数不做日志，因为"读不到"在不同采集器里的严重程度不同
//（GPU 的 /proc/driver/nvidia 读不到是常态，/proc/stat 读不到则是硬故障）。
func readFileTrimmed(root, rel string) (string, error) {
	b, err := os.ReadFile(procPath(root, rel))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// readBootTime 从 {root}/stat 的 `btime` 行取开机时间（unix **秒**）；读不到返回 0。
//
// ⚠️ 单位是秒（✅ 收窄 M-5，中心 schema 把 host.boot_time 锁成整数秒）：
// 传毫秒会让面板上的"运行时长"差 1000 倍，而且这种错误不会被任何校验拦住。
// 读不到时返回 0 而不是 -1：host.boot_time 在中心是 `minimum: 0`，负数会让**整批**上报 400。
func readBootTime(procRoot string) int64 {
	content, err := readFileTrimmed(procRoot, "stat")
	if err != nil {
		return 0
	}
	for _, line := range splitLines(content) {
		if v, ok := lineUintField(line, "btime"); ok {
			return int64(v)
		}
	}
	return 0
}

// splitLines 按行切分并丢掉空行。
//
// ⚠️ 顺便吃掉行尾的 `\r`：夹具文件在 Windows 上被编辑器/脚本改成 CRLF 后，
// `MemTotal:  1 kB\r` 的最后一个字段会变成 `kB\r`，单位判断会静默失配 ——
// 这是"测试在开发机过了、在 CI 挂了"的经典来源，索性在这里一次性处理掉。
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	raw := strings.Split(s, "\n")
	out := make([]string, 0, len(raw))
	for _, l := range raw {
		l = strings.TrimRight(l, " \t\r")
		if l == "" {
			continue
		}
		out = append(out, l)
	}
	return out
}

// lineUintField 从形如 `btime 1700000000`（键值以空白分隔）的行里取无符号整数。
// 键不匹配、缺值、值非数字都返回 ok=false（⛔ 不猜、不当 0）。
func lineUintField(line, key string) (uint64, bool) {
	f := strings.Fields(line)
	if len(f) < 2 || f[0] != key {
		return 0, false
	}
	v, err := strconv.ParseUint(f[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// atoiField 取 fields[i] 的无符号整数；越界或非法返回 ok=false。
//
// ⚠️ 这是本包"按位置解析 /proc"的基石：内核版本一变，行尾字段个数就变，
// 所以每一列都必须单独判存在，而不是先卡一个总列数。
func atoiField(fields []string, i int) (uint64, bool) {
	if i < 0 || i >= len(fields) {
		return 0, false
	}
	v, err := strconv.ParseUint(fields[i], 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// atofField 取 fields[i] 的浮点；越界或非法返回 ok=false。
func atofField(fields []string, i int) (float64, bool) {
	if i < 0 || i >= len(fields) {
		return 0, false
	}
	v, err := strconv.ParseFloat(fields[i], 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// parseFloatStrict 严格解析十进制浮点（diskstats 的数字段用它）。
// ⛔ 不用 fmt.Sscanf：它会把 `12abc` 解析成 12，静默吃掉内核输出里的异常。
func parseFloatStrict(s string) (float64, bool) {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// f64 取地址：模型里的可空数值字段全是 `*float64`。
//
// ⚠️ 只在本项**确实采到了**的时候调用。`nil`（本周期没采到，中心不产出数据点）与
// `&0`（采到了，值就是 0）语义完全不同，混用会画出一条"机器突然归零"的假曲线。
func f64(v float64) *float64 { return &v }

// f64p 值 + 是否有效 → 指针（无效即 nil）。
func f64p(v float64, ok bool) *float64 {
	if !ok {
		return nil
	}
	return &v
}

// u32p 值 → 指针（进程数、连接数这类无符号整数的可空形式）。
func u32p(v uint32) *uint32 { return &v }

// clampPct 把百分比夹到 [0,100]。
//
// ⛔ 不是"美化输出"：中心 schema 对百分比是闭区间 0–100，100.0000001（浮点误差）
// 或 120（多线程进程按单核口径）会让**整批上报** 400 —— 丢的是这一批的全部指标，
// 而不是这一个数。宁可夹紧也不要整批丢。
func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// nonNeg 把不可能为负的计量夹到 ≥0。
//
// ⚠️ /proc 的采样时刻不一致（先读到 A 文件、后读到 B 文件）会让"差值"偶尔为负；
// 负数在中心是 `minimum: 0`，同样会毁掉整批上报。
func nonNeg(v float64) float64 {
	if v < 0 {
		return 0
	}
	return v
}

// warnOnce 只打印一次的 WARN。
//
// 为什么需要：缺 nvidia-smi、某个 /proc 文件不存在、挂载点 statfs 挂住 ——
// 这些都是**每周期都会重复出现**的条件。每周期刷一条会把日志淹掉，
// 真出故障时反而看不见（而且 §10 的资源预算里日志也是要花 CPU 的）。
// ⚠️ 代价是"条件恢复后又失败"不会再提醒，用一次 WARN 换日志可读性，值得。
type warnOnce struct {
	once sync.Once
}

func (w *warnOnce) warn(log *slog.Logger, msg string, args ...any) {
	if log == nil {
		log = slog.Default()
	}
	w.once.Do(func() { log.Warn(msg, args...) })
}
