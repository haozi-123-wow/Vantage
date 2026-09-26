/**
 * Vantage · 时序与非时序观测数据访问（`metrics_raw` / `process_snapshots`）
 *
 * 依据：docs/database.md §5.7（metrics_raw 按天分区）、§5.9（process_snapshots）、
 *       §6.1（落库顺序第 4–5 步）、§6.2（幂等写入 / 时间权威 = server_ts）
 *
 * 批量写入用 `unnest(数组...)` 而不是拼 N 组 `($1,$2,$3)`：
 *  - 参数个数**恒定 5 个**，与批内序列数无关（拼值方式在 1000+ 序列时会撞 PostgreSQL 的
 *    65535 参数上限，而那正好是 256 核 + 64 盘 + 64 网卡 + 16 GPU 的最坏批次）；
 *  - PG 只需解析一次语句，同一连接上后续批次命中 prepared statement 缓存。
 *
 * ⛔ `ts` 一律等于 `server_ts`（决策 #16）：Agent 侧时间只进 `agents.last_agent_ts`。
 */

/**
 * 批量写入原始指标。
 *
 * `ON CONFLICT ... DO UPDATE`（而非 DO NOTHING）的理由：主键是 (agent_id, metric, ts)，
 * 而 `ts` 是**毫秒**精度的接收时间 —— 同一 Agent 的两个批次理论上可能落在同一毫秒
 * （心跳与上报并发、或 Agent 重试）。DO UPDATE 让这种极小概率事件变成幂等覆盖，
 * 而不是把一整批数据变成一个 500。批内重复已由 services/metrics.service.js 提前拒绝。
 *
 * @param {import('pg').PoolClient} client
 * @param {object} input
 * @param {string} input.agentId
 * @param {Date} input.serverTs
 * @param {Array<{ metric: string, value: number, labels: Record<string,string> }>} input.series
 * @returns {Promise<number>} 受影响行数
 */
export async function insertMetricsRaw(client, input) {
  const { agentId, serverTs, series } = input;
  if (!Array.isArray(series) || series.length === 0) return 0;

  const metrics = [];
  const values = [];
  const labels = [];
  for (const point of series) {
    metrics.push(point.metric);
    values.push(point.value);
    // labels 走 text[] 再转型：直接传 jsonb[] 需要把每个元素序列化成 PG 数组字面量，
    // 嵌套引号极易出错；text[] 里放 JSON 文本再 `::jsonb` 是最不容易出错的形式。
    labels.push(JSON.stringify(point.labels ?? {}));
  }

  const result = await client.query(
    `INSERT INTO metrics_raw (agent_id, metric, value, labels, ts)
     SELECT $1::uuid, s.metric, s.value, s.labels_json::jsonb, $2::timestamptz
       FROM unnest($3::text[], $4::float8[], $5::text[]) AS s(metric, value, labels_json)
     ON CONFLICT (agent_id, metric, ts)
       DO UPDATE SET value = EXCLUDED.value, labels = EXCLUDED.labels`,
    [agentId, serverTs, metrics, values, labels],
  );
  return result.rowCount ?? 0;
}

/**
 * 写一条进程快照（Top-N 落这里，⛔ 不进 metrics_raw 时序）。
 * @param {import('pg').PoolClient} client
 * @param {{ agentId: string, serverTs: Date, total: number, top: Array<object> }} input
 */
export async function insertProcessSnapshot(client, input) {
  const { rows } = await client.query(
    `INSERT INTO process_snapshots (agent_id, ts, total, top)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [input.agentId, input.serverTs, input.total, JSON.stringify(input.top ?? [])],
  );
  return rows[0]?.id;
}
