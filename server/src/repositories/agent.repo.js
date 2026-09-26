/**
 * Vantage · `agents` 表数据访问
 *
 * 依据：docs/database.md §5.1（agents 表结构）、§6.1（单次上报的落库顺序第 1–2 步）、
 *       §6.2（时间权威 = server_ts）
 *
 * ⛔ 只做 SQL，不做业务判断（分层：routes → services → repositories，见设计 §5.1）。
 * ⛔ `agent_key_hash` / `agent_secret_enc` 只允许在鉴权路径读取，不得进日志与响应。
 */

/**
 * 鉴权用查询：按 id 取凭证与状态。
 * ⛔ 刻意**不做进程内缓存**：凭证轮换后必须立即失效（✅ 决策 R1/R42，无宽限期），
 *    主键查询在这种小表上是亚毫秒级，缓存带来的「轮换后还能用几秒」是纯风险。
 *
 * ⚠️ 返回值里含 `agentKeyHash` / `agentSecretEnc` —— 调用方**只允许**在鉴权路径本地使用，
 *    ⛔ 不要把这个对象整体挂到 `request` 上或写进日志（会泄漏凭证哈希与密文信封）。
 *    接入层为此专门构造了一个"可安全记录"的子集，见 middleware/authAgent.js。
 *
 * @param {import('pg').Pool} pool
 * @param {string} agentId
 * @returns {Promise<null | { id: string, name: string, status: string, agentKeyHash: string, agentSecretEnc: string, lastIp: string|null, reportedIp: string|null, ipFlapping: boolean, capabilities: object|null, hostInfo: object|null, disabledAt: Date|null }>}
 */
export async function findAgentForAuth(pool, agentId) {
  const { rows } = await pool.query(
    `SELECT id, name, status, agent_key_hash, agent_secret_enc,
            last_ip, reported_ip, ip_flapping, capabilities, host_info, disabled_at
       FROM agents
      WHERE id = $1`,
    [agentId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    agentKeyHash: row.agent_key_hash,
    agentSecretEnc: row.agent_secret_enc,
    lastIp: row.last_ip,
    reportedIp: row.reported_ip,
    ipFlapping: row.ip_flapping,
    capabilities: row.capabilities,
    hostInfo: row.host_info,
    disabledAt: row.disabled_at,
  };
}

/**
 * 事务内锁定 Agent 行并取「IP 是否变化」。
 *
 * 🔑 为什么变化判定必须写在 SQL 里：`INET` 在 PG 内部是二进制形式，
 *    回读时的文本（`2001:db8::1`）与 Agent/反代传来的写法（`2001:0DB8:0:0::1`）**不一定逐字符相等**。
 *    若在 JS 里做字符串比较，真 IPv6 场景会在**每一次**上报都判成「IP 变化」，
 *    从而刷爆 ip_change_events 并触发 Flapping —— 这是最难查的一类假告警。
 *
 * `FOR UPDATE` 让同一 Agent 的并发批次串行化：否则两个批次可能各自读到同一个旧 IP，
 * 双双插入 change 事件（重复计数，直接污染 Flapping 判定）。
 *
 * @param {import('pg').PoolClient} client
 * @param {string} agentId
 * @param {string|null} remoteIp 本次连接来源 IP
 */
export async function lockAgentForReport(client, agentId, remoteIp) {
  const { rows } = await client.query(
    `SELECT id, name, status, last_ip, reported_ip, ip_flapping, flapping_since,
            capabilities, host_info,
            (last_ip IS DISTINCT FROM $2::inet) AS ip_changed
       FROM agents
      WHERE id = $1
        FOR UPDATE`,
    [agentId, remoteIp],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    lastIp: row.last_ip,
    reportedIp: row.reported_ip,
    ipFlapping: row.ip_flapping,
    flappingSince: row.flapping_since,
    capabilities: row.capabilities,
    hostInfo: row.host_info,
    ipChanged: row.ip_changed === true,
  };
}

/**
 * 落库第 1–2 步：心跳字段 + 时钟漂移 + host/capabilities 快照。
 * 语义：**只前进不倒退**（`COALESCE` 保证「本批没带」不覆盖既有值）。
 *
 * @param {import('pg').PoolClient} client
 * @param {object} input
 * @param {string} input.agentId
 * @param {Date} input.serverTs 权威时间
 * @param {number} input.agentTs Agent 侧 ts（unix 毫秒，只存 `last_agent_ts`）
 * @param {number} input.clockDriftMs agent_ts − server_ts（**负值表示 Agent 慢**）
 * @param {string|null} input.remoteIp 连接来源 IP
 * @param {string|null} input.reportedIp Agent 自报出口 IP
 * @param {object|null} input.hostInfo host 对象快照
 * @param {object|null} input.capabilities 能力声明快照
 */
export async function updateAgentAfterReport(client, input) {
  const { rows } = await client.query(
    `UPDATE agents
        SET last_seen_at   = $2,
            last_agent_ts  = $3,
            clock_drift_ms = $4,
            last_ip        = COALESCE($5::inet, last_ip),
            reported_ip    = COALESCE($6::inet, reported_ip),
            -- ⛔ 已 disable 的 Agent 不允许被一次上报「救活」成 online
            status         = CASE WHEN status = 'disabled' THEN status ELSE 'online' END,
            host_info      = COALESCE($7::jsonb, host_info),
            capabilities   = COALESCE($8::jsonb, capabilities)
      WHERE id = $1
      RETURNING last_seen_at, status`,
    [
      input.agentId,
      input.serverTs,
      input.agentTs,
      input.clockDriftMs,
      input.remoteIp ?? null,
      input.reportedIp ?? null,
      input.hostInfo ? JSON.stringify(input.hostInfo) : null,
      input.capabilities ? JSON.stringify(input.capabilities) : null,
    ],
  );
  return rows[0] ?? null;
}

/**
 * 置 Flapping 态（✅ 决策 #39）。
 * `flapping_since = COALESCE(...)` 保证「首次进入」的时间不被后续变化刷新，
 * 否则稳定期判定的起点会一直往后滚，永远无法自然解除。
 */
export async function markIpFlapping(client, { agentId, at }) {
  await client.query(
    `UPDATE agents
        SET ip_flapping   = TRUE,
            flapping_since = COALESCE(flapping_since, $2)
      WHERE id = $1`,
    [agentId, at],
  );
}
