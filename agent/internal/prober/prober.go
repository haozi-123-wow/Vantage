// Package prober 实现本地探活（ping / http / https / tcp）。
//
// 依据：docs/agent.md §4（本地探活）、docs/api.md §2.1（probes[] 字段）。
//
// ⛔ 单向宗旨的落点：**探活目标只能在 Agent 本地配置**。中心不下发目标、也不下发开关，
//
//	它只存结果、判定与告警。用户新增探活 = 登录目标机改 config.yaml → reload。
//
// 三条要求（✅ §4.4 / G8 / G9）：
//  1. 非特权 ICMP 优先；不可用时**自动降级为 TCP 探测并打 WARN**（⛔ 不静默降级、⛔ 不崩溃）；
//  2. `setcap cap_net_raw+ep` 只是文档给出的 opt-in 手段，⛔ 代码里不得要求提权；
//  3. 探活失败是**结果**（`up: false` + `error`），不是异常，⛔ 不得中断上报。
package prober

import (
	"context"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/model"
)

// Prober 单条探活。
type Prober interface {
	// Name 探活名（配置里的 `name`，中心按它区分结果）。
	Name() string
	// Type ping / http / https / tcp。
	Type() string
	// Target 上报给中心的 target 字段（url 或 host）。
	Target() string
	// Interval 探活周期（来自本机配置）。
	Interval() time.Duration
	// Probe 执行一次。
	//
	// ⛔ 实现必须**总是**返回一个结果（失败也要有 up=false 与 error），
	//    不能返回 error 让调用方去猜 —— 探活失败本身就是一条有用的事实。
	Probe(ctx context.Context) model.Probe
}

// New 按配置构造探活器集合（顺序与配置一致，便于面板按序展示）。
func New(cfg *config.Config) []Prober {
	out := make([]Prober, 0, len(cfg.Probes))
	for i := range cfg.Probes {
		pb := cfg.Probes[i]
		if p, ok := newProber(&pb); ok {
			out = append(out, p)
		}
	}
	return out
}

// newProber 按类型分派；未知类型返回 false（配置校验已拦截，这里只是兜底）。
func newProber(pb *config.ProbeBlock) (Prober, bool) {
	switch pb.Type {
	case "http", "https":
		return newHTTPProber(pb), true
	case "tcp":
		return newTCPProber(pb), true
	case "ping":
		return newPingProber(pb), true
	default:
		return nil, false
	}
}

// Capabilities 汇总探活能力（probe.ping / probe.http / probe.tcp）。
//
// ⚠️ 键名必须是中心 `host.capabilities` 白名单里的键；调度器会把本结果与采集器的
// 能力合并后再上报。
//
// `probe.ping` 取决于**非特权 ICMP 是否真的可用**（ping_group_range / CAP_NET_RAW）：
// 不可用时按 ✅ G8 自动降级为 TCP 探测，并把这里声明为 false —— 面板据此提示用户
// 「本机 ping 探活已降级」，避免"探活全 down"被误判成目标不可达。
func Capabilities(ps []Prober) map[string]bool {
	out := map[string]bool{}
	for _, p := range ps {
		switch p.Type() {
		case "ping":
			out["probe.ping"] = pingAvailable()
		case "http", "https":
			out["probe.http"] = true
		case "tcp":
			out["probe.tcp"] = true
		}
	}
	return out
}
