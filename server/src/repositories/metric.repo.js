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

// -----------------------------------------------------------------------------
// 状态接口的「当前值」取数（docs/server-status-api.md §2.2 / §4.2）
// -----------------------------------------------------------------------------

/**
 * 状态接口要取的槽位 → 指标基名（唯一来源；`services/status.service.js` 按 slot 聚合）。
 *
 * 口径（方案 §2.2，逐条都有依据，⛔ 不要"顺手改成更合理的"）：
 *  - `cpu_pct`  = `cpu.usage` 最新值（单序列）；
 *  - `mem_pct`  = 优先 `mem.used_pct`（中心已算好的派生序列）；缺失时由 `mem.used / mem.total` 兜底；
 *  - `disk_pct` = `disk.used_pct{...}` 各挂载点取 **MAX**（=「磁盘最高占用%」，与面板列名一致）；
 *  - `net_*_bps`= `net.rx_bps{device=...}` / `net.tx_bps{device=...}` 各网卡 **SUM**；
 *  - `gpu_pct`  = `gpu.util{index=...}` 取 **MAX**；无序列时**整个字段缺省**（设计稿要求 GPU 图整块隐藏）。
 */
const CURRENT_VALUE_SERIES = Object.freeze([
  { slot: 'cpu_pct', base: 'cpu.usage' },
  { slot: 'mem_pct', base: 'mem.used_pct' },
  { slot: 'mem_used', base: 'mem.used' },
  { slot: 'mem_total', base: 'mem.total' },
  { slot: 'disk_pct', base: 'disk.used_pct' },
  { slot: 'net_rx_bps', base: 'net.rx_bps' },
  { slot: 'net_tx_bps', base: 'net.tx_bps' },
  { slot: 'gpu_pct', base: 'gpu.util' },
]);

/**
 * 一次取回**多台主机 × 多个基名**的最新值（1 条 SQL，⛔ 不按主机循环 = 不产生 N+1）。
 *
 * 🔑 写法要点（方案 §4.2，性能敏感）：
 *  1. `agent_id = ANY($1::uuid[])` 把范围锁在当前页的主机集合上（不是全表）；
 *  2. `ts >= $2` 让分区裁剪只保留最近 1–2 个 `metrics_raw_YYYYMMDD` 分区 —— 无窗口的
 *     「取最新」会退化成对所有分区的扫描，而保留期是 15 天；
 *  3. `DISTINCT ON (agent_id, metric) ... ORDER BY agent_id, metric, ts DESC` 命中主键
 *     `(agent_id, metric, ts)` 的**反向扫描**（`docs/database.md` §5.7.3 已明确「额外索引大概率冗余」，
 *     故本方案 ⛔ 不新增任何索引）；
 *  4. 带维度的基名要按**基名前缀**取全部维度序列，再在 JS 里 MAX/SUM。
 *
 * ➕ 为什么用**区间比较**而不是 `LIKE 'disk.used_pct{%'`：`_` 在 LIKE 里是单字符通配符，
 *    而本项目的基名**大量使用下划线**（`used_pct` / `rx_bps` / `ctx_switch`）——`LIKE 'disk.used_pct{%'`
 *    会把 `diskXused_pct{...}` 也匹配进来。当前命名空间下不会真的撞车，但它是**潜在**的匹配污染源，
 *    区间比较零成本，从根上避免（`docs/api-status.md` §5.2 记的待定口径即此结论）。
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @param {string[]} input.agentIds ⛔ 空数组应提前返回（调用方负责，避免无谓的 SQL）
 * @param {Date} input.since 观测窗口下界（方案 §2.2：5 分钟 = 20 × 上报周期）
 * @returns {Promise<Array<{ slot: string, agent_id: string, metric: string, value: number }>>}
 *          同一槽位可能返回多行（维度序列），聚合由调用方按 slot 语义决定
 */
export async function selectLatestSeriesForAgents(pool, input) {
  const { agentIds, since } = input;
  if (!Array.isArray(agentIds) || agentIds.length === 0) return [];

  const count = CURRENT_VALUE_SERIES.length;
  // 参数：$1 = agentIds、$2 = since、$3.. = slot、$3+count.. = base
  // ⛔ 槽位名与基名一律走**绑定参数**（不做字符串插值）——即便它们来自本文件的冻结常量，
  //    也保持"SQL 里不出现任何由数据拼出的片段"这一可审计形式。
  const branches = CURRENT_VALUE_SERIES.map((_entry, index) => {
    const slotParam = `$${index + 3}`;
    const baseParam = `$${index + 3 + count}`;
    return `SELECT ${slotParam}::text AS slot, s.agent_id, s.metric, s.value
              FROM (
                SELECT DISTINCT ON (agent_id, metric) agent_id, metric, value
                  FROM metrics_raw
                 WHERE agent_id = ANY($1::uuid[])
                   AND ts >= $2::timestamptz
                   AND metric >= ${baseParam}
                   AND metric <  ${baseParam} || chr(256)
                   AND (metric = ${baseParam}
                        OR left(metric, length(${baseParam}) + 1) = ${baseParam} || '{')
                 ORDER BY agent_id, metric, ts DESC
              ) s`;
  });

  const { rows } = await pool.query(branches.join('\nUNION ALL\n'), [
    agentIds,
    since,
    ...CURRENT_VALUE_SERIES.map((entry) => entry.slot),
    ...CURRENT_VALUE_SERIES.map((entry) => entry.base),
  ]);
  return rows;
}

/**
 * 取**单台**主机在观测窗口内的**全部序列当前值**（`GET /api/v1/hosts/{id}` 的完整快照用）。
 *
 * 与 `selectLatestSeriesForAgents` 的差别：那边只取 6 个固定槽位（列表页够用），
 * 这边把该机所有序列都取回来（每核、各分区、各网卡、GPU…），键是**指标全名**。
 *
 * 🔑 为什么私有详情可以给全量、而列表不能：列表是 N 台机的横向对比（6 个槽位 ≈ 每台 6 个数），
 *    详情是**一台机**的纵深展开；序列数受上报 schema 的数组上限约束（如 ≤16 GPU、磁盘/网卡各自有上限），
 *    最坏情况约几百条，仍在单条响应可承受范围内。
 *
 * ⚠️ 与列表同样受**观测窗口**约束（`services/status.service.js` 的 `OBSERVATION_WINDOW_S`）：
 *    窗口外的旧序列不返回（⛔ 不把 5 天前的读数当"当前值"）。
 *
 * @param {import('pg').Pool} pool
 * @param {{ agentId: string, since: Date }} input
 * @returns {Promise<Array<{ metric: string, value: number }>>}
 */
export async function selectCurrentSeriesForAgent(pool, { agentId, since }) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (metric) metric, value
       FROM metrics_raw
      WHERE agent_id = $1::uuid
        AND ts >= $2::timestamptz
      ORDER BY metric, ts DESC`,
    [agentId, since],
  );
  return rows;
}

/**
 * 取某台主机**最近一条（或 `at` 之前最近一条）**进程快照。
 *
 * 「`at` 省略时取最近一条」是 ✅ 已定的口径（docs/api.md §4.2）；`at` 给定时取其**之前**
 * 最近的一条 —— 语义是「那一刻的进程长什么样」，而不是"恰好等于那一刻"（采样是周期性的，
 * 要求时间戳严格相等等于永远查不到）。
 *
 * ⚠️ `process_snapshots` 保留 30 天（✅ R10）：更早的时间点返回 `null`（⛔ 不是空数组 ——
 *    两者在 UI 上必须能区分"没有采集"与"那一刻确实没有进程"）。
 *
 * @param {import('pg').Pool} pool
 * @param {{ agentId: string, at: Date|null }} input
 * @returns {Promise<{ ts: Date, total: number, top: Array<object> }|null>}
 */
export async function selectLatestProcessSnapshot(pool, { agentId, at = null }) {
  const { rows } = await pool.query(
    `SELECT ts, total, top
       FROM process_snapshots
      WHERE agent_id = $1::uuid
        AND ($2::timestamptz IS NULL OR ts <= $2::timestamptz)
      ORDER BY ts DESC
      LIMIT 1`,
    [agentId, at],
  );
  return rows[0] ?? null;
}
