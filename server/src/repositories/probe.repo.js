/**
 * Vantage · 本地探活结果数据访问（`probe_results`）
 *
 * 依据：docs/database.md §5.10、§6.1（落库顺序第 6 步）
 *
 * ⛔ 单向宗旨在这一层的体现：`probe_name` / `target` 全部来自 **Agent 本地 config.yaml**。
 *    中心只按规则判定与告警，从不新增/修改探活目标（设计 §4.6）。
 *
 * 🔑 `detail` 一律留 NULL：§2.1 的 probes[] 元素里没有 detail 字段，
 *    本期不引入「Agent 自定义结构」—— 任何未在白名单内的字段都该在 schema 层就被拒，
 *    而不是流进一个 JSONB 里长期失真。
 */

/**
 * 批量写入探活结果（与 metrics 同样用 unnest，参数个数恒定）。
 * @param {import('pg').PoolClient} client
 * @param {object} input
 * @param {string} input.agentId
 * @param {Date} input.checkedAt = server_ts（权威时间）
 * @param {Array<object>} input.probes
 * @returns {Promise<number>} 写入行数
 */
export async function insertProbeResults(client, input) {
  const { agentId, checkedAt, probes } = input;
  if (!Array.isArray(probes) || probes.length === 0) return 0;

  const names = [];
  const types = [];
  const targets = [];
  const ups = [];
  const latencies = [];
  const statusCodes = [];
  const errors = [];

  for (const probe of probes) {
    names.push(probe.name);
    types.push(probe.type);
    targets.push(probe.target);
    ups.push(probe.up === true);
    // `?? null` 保留「缺失」与「显式 null」两种写法，库层面都落 NULL
    latencies.push(probe.latency_ms ?? null);
    statusCodes.push(probe.status_code ?? null);
    errors.push(probe.error ?? null);
  }

  const result = await client.query(
    `INSERT INTO probe_results
       (agent_id, probe_name, probe_type, target, up, latency_ms, status_code, error, detail, checked_at)
     SELECT $1::uuid, s.probe_name, s.probe_type, s.target, s.up,
            s.latency_ms, s.status_code, s.error, NULL, $2::timestamptz
       FROM unnest(
              $3::text[], $4::text[], $5::text[], $6::boolean[],
              $7::float8[], $8::int[], $9::text[]
            ) AS s(probe_name, probe_type, target, up, latency_ms, status_code, error)`,
    [agentId, checkedAt, names, types, targets, ups, latencies, statusCodes, errors],
  );
  return result.rowCount ?? 0;
}

/**
 * 状态接口的 `probes: { up, down }` 取数（docs/server-status-api.md §4.3）。
 *
 * 「最近一轮」的判定 = 每机 `checked_at` **最大**的那一批。为什么是"那一批"而不是"最近 N 条"：
 * 同一次探活的所有目标由 `insertProbeResults` 在**同一条 SQL**里写入，`checked_at` 完全相同，
 * 所以「最大 checked_at」天然就是完整的一轮（⛔ 若按"最近 10 条"取，目标数不同的机器会得到不可比的口径）。
 *
 * ⚠️ `checked_at >= $2` 的窗口不可省：`probe_results` 保留 90 天，无窗口的 `max(checked_at)`
 *    会扫全表；窗口用与 snapshot 相同的 5 分钟（`services/status.service.js` 的 `OBSERVATION_WINDOW_S`）。
 * ⚠️ 窗口外一律返回 0 行 → 调用方填 `{ up: 0, down: 0 }`（⛔ 不是 null、也不是旧值）。
 *
 * @param {import('pg').Pool} pool
 * @param {{ agentIds: string[], since: Date }} input
 * @returns {Promise<Array<{ agent_id: string, up: number, down: number }>>}
 */
export async function countLatestProbeResults(pool, input) {
  const { agentIds, since } = input;
  if (!Array.isArray(agentIds) || agentIds.length === 0) return [];

  const { rows } = await pool.query(
    `WITH latest AS (
       SELECT agent_id, max(checked_at) AS at
         FROM probe_results
        WHERE agent_id = ANY($1::uuid[])
          AND checked_at >= $2::timestamptz
        GROUP BY agent_id
     )
     SELECT p.agent_id,
            count(*) FILTER (WHERE p.up)::int     AS up,
            count(*) FILTER (WHERE NOT p.up)::int AS down
       FROM probe_results p
       JOIN latest l ON l.agent_id = p.agent_id AND l.at = p.checked_at
      WHERE p.agent_id = ANY($1::uuid[])
      GROUP BY p.agent_id`,
    [agentIds, since],
  );
  return rows;
}

/**
 * 取**最近一轮**的逐条探活结果（公开 `/api/public/probes` 用）。
 *
 * 与 `countLatestProbeResults` 的区别只是"要不要明细"：两者共用「`max(checked_at)` = 最近一轮」
 * 这个判定，⛔ 不允许其中一处改成"最近 N 条"（那会让计数与明细对不上）。
 *
 * @param {import('pg').Pool} pool
 * @param {{ agentIds: string[], since: Date, limit: number }} input
 * @returns {Promise<Array<object>>} 每行 = 一条探活明细（含 agent_id、probe_name、target、up、latency_ms…）
 */
export async function selectLatestProbeRound(pool, { agentIds, since, limit }) {
  if (!Array.isArray(agentIds) || agentIds.length === 0) return [];

  const { rows } = await pool.query(
    `WITH latest AS (
       SELECT agent_id, max(checked_at) AS at
         FROM probe_results
        WHERE agent_id = ANY($1::uuid[])
          AND checked_at >= $2::timestamptz
        GROUP BY agent_id
     )
     SELECT p.agent_id, p.probe_name, p.probe_type, p.target, p.up,
            p.latency_ms, p.status_code, p.error, p.checked_at
       FROM probe_results p
       JOIN latest l ON l.agent_id = p.agent_id AND l.at = p.checked_at
      WHERE p.agent_id = ANY($1::uuid[])
      ORDER BY p.agent_id, p.probe_name
      LIMIT $3`,
    [agentIds, since, limit],
  );
  return rows;
}

/**
 * 取某台主机的**探活历史**（`GET /api/v1/hosts/{id}/probes` 用）。
 *
 * 🔑 两个"看起来可以省、其实不能省"的地方：
 *  1. **可用率必须在同一条查询里用窗口函数算**（`count(*) OVER (PARTITION BY probe_name)`）：
 *     本查询对每个 probe 只返回最近 `perProbeLimit` 个点（防止一年窗口把响应撑爆），
 *     若在 JS 里用"返回的这些点"算可用率，**被截断的探活会被系统性忽略**，
 *     于是"可用率 100%"却明明断过 —— 这类错误没人会怀疑到分页上。
 *  2. `probe_name` 分组而不是 `(name,type,target)`：Agent 的 config.yaml 里 probe 名就是它的身份，
 *     同一名字改目标属于"同一条探活的配置变更"，不该在图上裂成两条线。
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @param {string} input.agentId
 * @param {Date} input.from
 * @param {Date|null} input.to
 * @param {string|null} [input.name] 只取某个 probe
 * @param {string|null} [input.type] 只取某类（ping/http/https/tcp/dns）
 * @param {number} input.perProbeLimit 每个 probe 最多返回多少个点（取**最近**的那些）
 */
export async function selectProbeHistory(pool, input) {
  const { agentId, from, to, name = null, type = null, perProbeLimit } = input;
  const { rows } = await pool.query(
    `SELECT probe_name, probe_type, target, up, latency_ms, status_code, error, checked_at,
            total_in_window, up_in_window, first_in_window, last_in_window
       FROM (
         SELECT p.probe_name, p.probe_type, p.target, p.up, p.latency_ms, p.status_code, p.error, p.checked_at,
                row_number() OVER (PARTITION BY p.probe_name ORDER BY p.checked_at DESC) AS rn,
                -- ⚠️ 这三个必须基于**整个窗口**（不受 rn 截断影响），否则可用率会系统性偏高
                count(*)      OVER (PARTITION BY p.probe_name)                     AS total_in_window,
                count(*) FILTER (WHERE p.up) OVER (PARTITION BY p.probe_name)      AS up_in_window,
                min(p.checked_at) OVER (PARTITION BY p.probe_name)                 AS first_in_window,
                max(p.checked_at) OVER (PARTITION BY p.probe_name)                 AS last_in_window
           FROM probe_results p
          WHERE p.agent_id = $1::uuid
            AND p.checked_at >= $2::timestamptz
            AND ($3::timestamptz IS NULL OR p.checked_at <= $3::timestamptz)
            AND ($4::text IS NULL OR p.probe_name = $4)
            AND ($5::text IS NULL OR p.probe_type = $5)
       ) x
      WHERE x.rn <= $6
      ORDER BY x.probe_name ASC, x.checked_at DESC`,
    [agentId, from, to, name, type, perProbeLimit],
  );
  return rows;
}
