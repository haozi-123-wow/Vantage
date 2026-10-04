/**
 * Vantage · 离线判定（「点名」）服务
 *
 * 依据：设计 §5.3（L254「离线：`now - last_seen_at > 阈值(如 3×上报周期)`」）、
 *       §5.2（L472「离线判定（防抖，只在 online→offline 时发告警）」）、
 *       docs/database.md §8.2（离线判定任务：建议每 15–30s；「状态迁移需防抖」）、
 *       docs/api.md §2.2（`/healthz` 与 `/readyz` 之外的业务语义）
 *
 * 🔑 为什么必须有这个服务（而不是「读的时候顺手算一下」）
 *
 *   上报路径是**请求驱动**的：`POST /api/v1/agent/report` 到达时才把 `agents.status` 写成
 *   `online`（见 repositories/agent.repo.js 的 `updateAgentAfterReport`）。
 *   那么被监控机**断电/断网**时不产生任何请求 —— 没有任何东西会去改那一行。
 *   于是 `agents.status` 会永远停在 `online`：**已经死了三天的机器，面板上依然是绿的**。
 *
 *   这不是「功能缺失」，而是「一个报平安的监控系统」，比报错危险得多。
 *   要发现「该来没来」，只能由中心**主动、定时**去问一遍：这就是本服务。
 *
 * 🔑 为什么写成单条 `UPDATE ... WHERE`（而不是先 SELECT 再逐条 UPDATE）
 *
 *   本任务每 15–30s 跑一次，**与正在上报的 Agent 天然并发**。朴素写法有一个很难复现的抖动：
 *   扫出「A 已超时」→ A 恰好上报成功（把 last_seen_at 刷新到此刻）→ 扫描回来把 A 置成 offline。
 *   结果：A 明明在线，却被打上离线（下一个周期才自愈）—— 面板上表现为「机器随机闪一下离线」。
 *
 *   PG 的 `UPDATE` 在 READ COMMITTED 下会对被并发更新的行**重新求值 WHERE**：
 *   上报表先拿到行锁 → 扫描的 UPDATE 阻塞 → 上报提交 → 扫描重新判定，
 *   此时 `now() - last_seen_at` 已远小于阈值 → **该行自动被跳过**。
 *   所以我只要把「超时」这个条件写进 WHERE，就免费获得了与上报路径的串行化，
 *   ⛔ 绝不能改成「先查 id 列表，再按 id 更新」。
 *
 * 时钟口径（两侧必须一致，否则会出现「接口说在线、库说离线」）
 *   `last_seen_at` 由 **Node 进程时钟**写入（routes/agent.report.js：`request.receivedAt` ← `Date.now()`），
 *   而本服务与将来的状态接口一律用 **数据库 `now()`** 与它比较 → 两侧同为「DB 时间 − 进程时间戳」，
 *   偏差方向一致、不会互相矛盾。⛔ 不要在一处用 `now()`、另一处用 `Date.now()` 做同一个判定。
 */

/**
 * Agent 的上报周期（秒）。
 *
 * ⚠️ **必须与 Agent 侧的实际默认值对齐**：`agent/internal/config/config.go`
 *    的 `defaultConfig()` → `Report.Interval = 30s`（该文件注明「✅ 本轮修订 G3：
 *    `report.interval` 默认由 15s 改为 **30s**」，采集周期随之对齐）。
 *
 * 🔑 为什么这个数字取错会造成**假离线**：阈值 = 本值 × `offlineMultiplier`。
 *    若本值小于真实上报周期（例如取旧文档的 15s → 阈值 45s，而机器每 30s 才报一次），
 *    那么**正常上报的机器也会在两次上报之间被判离线**——表现为面板上机器随机闪离线，
 *    而且因为阈值大于扫描间隔，闪完很快又自愈，极难排查。
 *    取**大于等于**真实周期则只是把判定放宽（漏报窗口变长），不会误报。
 *    所以这个常量宁大勿小；改 Agent 默认周期时必须同步改这里。
 *
 * ⚠️ 文档现状（2026-10-04 核实）：设计 §4（「核心指标 15s」）、`docs/agent.md` 的 G3 表
 *    （「✅ 15s」）、`docs/api.md` §3.2、`docs/database.md` §8.2 仍写着 15s —— 这些是
 *    G3 修订后**未同步的陈旧描述**，以代码与 Agent 实现（30s）为准。
 */
export const AGENT_REPORT_PERIOD_S = 30;

/**
 * 离线阈值（秒）= 上报周期 × 倍数。
 * 倍数取自 `config.heartbeat.offlineMultiplier`（默认 3）→ 默认 **30 × 3 = 90s**。
 *
 * ⚠️ 为什么给 3 倍而不是 1 倍：设计 §5.3（L221）明确提过「短采集周期下重启稍慢即触发误报」——
 *    1 倍等于「丢一批就判死」，一次网络抖动或一次 `reload` 就会刷出假离线告警。
 *    ⚠️ 额外注意 Agent 的 `report.heartbeat_interval` 默认 60s：纯粹"没有指标变化"时
 *    心跳最长 60s 才发一次，因此真实的上报间隔上限是 60s 而不是 30s。90s 的阈值刚好
 *    覆盖「一批指标 + 一次心跳」的最坏间隔，余量偏紧（详见 docs/server-status-api.md §2.1）。
 * @param {object} config
 * @returns {number} 秒
 */
export function offlineThresholdS(config) {
  return AGENT_REPORT_PERIOD_S * config.heartbeat.offlineMultiplier;
}

/**
 * 把「超时未上报」的主机扫出来并置为 `offline`（**幂等、防抖**）。
 *
 * 防抖体现在 `status = 'online'` 这个前置条件上：本服务只做 `online → offline` **一次单向迁移**，
 * 因此连跑两次的第二次返回 0 行、也**不会**再次触发告警/广播（docs/database.md §8.2 的要求）。
 * 反向迁移（`offline/从未上报 → online`）由上报路径负责，见 repositories/agent.repo.js
 * 的 `updateAgentAfterReport`（L114：`CASE WHEN status = 'disabled' THEN status ELSE 'online' END`）。
 *
 * `disabled` 是**人工状态**，优先级最高、永不参与超时判定：`agents_disabled_ck` 约束保证
 * 进入 disabled 时必有 `disabled_at`，且「被禁用」这一事实不会因为机器没在跑而改变。
 *
 * @param {import('pg').Pool} pool 运行时 DML 池（⛔ 不用 migrator 池：本服务不碰 DDL）
 * @param {object} input
 * @param {number} input.thresholdS 离线阈值（秒），来自 `offlineThresholdS(config)`
 * @param {{ error?: Function, warn?: Function, debug?: Function }} [input.logger]
 * @returns {Promise<{ changed: Array<{agentId: string, name: string, lastSeenAt: Date|null}>, count: number }>}
 *          只包含**本次真正发生迁移**的行（供调用方广播/告警，⛔ 不含"本来就离线"的机器）
 */
export async function markStaleAgentsOffline(pool, input) {
  const { thresholdS, logger } = input;
  if (!Number.isFinite(thresholdS) || thresholdS <= 0) {
    throw new Error(`markStaleAgentsOffline 需要正的 thresholdS，收到：${thresholdS}`);
  }

  const { rows } = await pool.query(
    `UPDATE agents
        SET status = 'offline'
      WHERE status = 'online'
        AND (last_seen_at IS NULL
             OR now() - last_seen_at > make_interval(secs => $1::double precision))
      RETURNING id, name, last_seen_at`,
    [thresholdS],
  );

  const changed = rows.map((row) => ({
    agentId: row.id,
    name: row.name,
    // 保留**最后一次上报时间**（而不是"判定时刻"）：前端要显示的是"最后在线于何时"。
    // ⚠️ node-pg 已把 timestamptz 解析为 Date；PGlite 亦同。
    lastSeenAt: row.last_seen_at ?? null,
  }));

  if (changed.length > 0) {
    logger?.info?.(
      { count: changed.length, thresholdS, agents: changed.map((c) => c.name) },
      '离线判定：已将超时未上报的主机置为 offline',
    );
  } else {
    // debug 级：每 15–30s 一条 info 会把日志淹掉（5 台稳定时就是每天 2880 条噪声）
    logger?.debug?.({ thresholdS }, '离线判定：无主机超时');
  }

  return { changed, count: changed.length };
}

/**
 * ⛔ 本期到此为止，**不发通知**。
 *
 * 离线**告警**（写 `alert_events` + 经 `channels` 发企微/邮件）属 M3 的告警引擎。
 * 届时它应消费本函数的返回值（`changed`）而不是自己再扫一遍表 —— 否则"判定离线"这件事
 * 会出现两套实现，两边的阈值一旦漂移就会出现「面板说离线、告警没发」。
 * 参考：设计 §5.2 / §7.1、docs/database.md §8.2「离线判定 → 触发离线告警」。
 */
