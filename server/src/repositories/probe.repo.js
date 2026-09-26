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
