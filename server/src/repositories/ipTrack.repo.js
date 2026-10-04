/**
 * Vantage · IP 追踪数据访问（`agent_ip_history` / `ip_change_events`）
 *
 * 依据：docs/database.md §5.5（IP 出现区间）、§5.6（IP 变化与 Flapping 事件）、
 *       §6.1（落库顺序第 3 步）
 *
 * 两个不可动摇的口径
 *  - `agent_ip_history` 是**区间**表：同一 (agent_id, ip, source) 连续上报只推 `last_seen`
 *    （唯一索引 `agent_ip_history_upsert_uidx` 就是 ON CONFLICT 目标）；
 *  - `change_count` 用**本表自身**在窗口内的行数计算，不引入 Redis 计数器 ——
 *    计数器与库表会分叉（Redis 重启/被 flush 后计数归零，Flapping 判定就永久失真），
 *    而这张表本来就小，窗口内 count 走 `ip_change_events_agent_idx` 是廉价且权威的。
 */

/**
 * 区间 UPSERT。
 * 🔑 `ON CONFLICT` 的目标是**唯一索引**而非唯一约束（迁移 0003 用的是 CREATE UNIQUE INDEX），
 *    因此必须写成 `ON CONFLICT (agent_id, ip, source)` 显式列形式，不能依赖 `ON CONSTRAINT`。
 *
 * ⚠️ IP 的**规范化交给 INET 类型**：`$2::inet` 会吃掉 `2001:0DB8::1` / `2001:db8::1` 的写法差异，
 *    于是「同一地址不同写法」不会创建两行区间。JS 侧只做「该不该记」的判断。
 *
 * @param {import('pg').PoolClient} client
 * @param {{ agentId: string, ip: string, source: 'remote'|'agent_reported', at: Date }} input
 */
export async function upsertIpHistory(client, input) {
  const { rows } = await client.query(
    `INSERT INTO agent_ip_history (agent_id, ip, source, first_seen, last_seen)
     VALUES ($1, $2::inet, $3, $4, $4)
     ON CONFLICT (agent_id, ip, source)
       DO UPDATE SET last_seen = GREATEST(agent_ip_history.last_seen, EXCLUDED.last_seen)
     RETURNING id, (xmax = 0) AS inserted`,
    [input.agentId, input.ip, input.source, input.at],
  );
  return rows[0] ?? null;
}

/**
 * 记一条 IP 变化 / Flapping 事件。
 * @param {import('pg').PoolClient} client
 * @param {object} input
 * @param {string} input.agentId
 * @param {string|null} input.oldIp 首次记录 IP 时为 NULL（§5.6）
 * @param {string} input.newIp
 * @param {'remote'|'agent_reported'} input.source
 * @param {'change'|'flapping'} input.kind
 * @param {number} input.changeCount windowS 窗口内的变化次数（含本次）
 * @param {Date} input.at
 * @param {boolean|null} [input.sameSubnet] 见 README 开放项 M-7：无前缀长度策略时留 NULL
 * @param {string|null} [input.subnetPrev]
 * @param {string|null} [input.subnetNext]
 */
export async function insertIpChangeEvent(client, input) {
  const { rows } = await client.query(
    `INSERT INTO ip_change_events
       (agent_id, old_ip, new_ip, same_subnet, changed_at, source, kind, change_count, subnet_prev, subnet_next)
     VALUES ($1, $2::inet, $3::inet, $4, $5, $6, $7, $8, $9::cidr, $10::cidr)
     RETURNING id`,
    [
      input.agentId,
      input.oldIp ?? null,
      input.newIp,
      input.sameSubnet ?? null,
      input.at,
      input.source,
      input.kind,
      input.changeCount,
      input.subnetPrev ?? null,
      input.subnetNext ?? null,
    ],
  );
  return rows[0]?.id;
}

/**
 * 窗口内（含本次之前）的 IP 变化次数。
 * ⚠️ 时间基准用 `$2`（= serverTs）而非 `now()`：整批数据都锚在同一个 server_ts 上，
 *    混用两个时钟会让窗口边界在同一次上报里出现两个解释。
 */
export async function countRecentIpChanges(client, { agentId, at, windowS }) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n
       FROM ip_change_events
      WHERE agent_id = $1
        AND kind = 'change'
        AND changed_at > $2::timestamptz - make_interval(secs => $3::double precision)`,
    [agentId, at, windowS],
  );
  return rows[0]?.n ?? 0;
}

// -----------------------------------------------------------------------------
// 读路径（`GET /api/v1/hosts/{id}/ip-history`，docs/api.md §4.2 / 设计 §8）
// -----------------------------------------------------------------------------

/**
 * IP **出现区间**列表（每 (ip, source) 一行，最近出现的在前）。
 *
 * ⚠️ `ip` / `source` 是区间表的**主键维度**，同一地址换来源（remote ↔ agent_reported）是两行 ——
 *    这不是重复，而是"双源比对"的基础数据（设计 §8），前端必须按 `source` 分开看。
 * ⚠️ `INET` 一律经 `host()` 转文本（IPv6 带掩码时会出 `::1/128`）。
 *
 * @param {import('pg').Pool} pool
 * @param {{ agentId: string, limit: number }} input
 */
export async function listIpIntervals(pool, { agentId, limit }) {
  const { rows } = await pool.query(
    `SELECT host(ip) AS ip, source, first_seen, last_seen
       FROM agent_ip_history
      WHERE agent_id = $1::uuid
      ORDER BY last_seen DESC, ip ASC
      LIMIT $2`,
    [agentId, limit],
  );
  return rows;
}

/**
 * IP 变化 / Flapping **事件**列表（最近发生的在前）。
 * ⚠️ 该表**永久保留**（决策 #11），因此必须 `LIMIT`（前端时间线只需要最近若干条）。
 * ⚠️ `kind='flapping'` 的行是"进入 Flapping 态"这一个事件本身，不是第 N 次变化 —— 面板按不同样式渲染。
 *
 * @param {import('pg').Pool} pool
 * @param {{ agentId: string, limit: number }} input
 */
export async function listIpChangeEvents(pool, { agentId, limit }) {
  const { rows } = await pool.query(
    `SELECT host(old_ip) AS old_ip, host(new_ip) AS new_ip, same_subnet, changed_at,
            source, kind, change_count, host(subnet_prev) AS subnet_prev, host(subnet_next) AS subnet_next
       FROM ip_change_events
      WHERE agent_id = $1::uuid
      ORDER BY changed_at DESC
      LIMIT $2`,
    [agentId, limit],
  );
  return rows;
}
