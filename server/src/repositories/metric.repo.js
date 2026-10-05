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

import { AppError } from '../utils/errors.js';

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

// -----------------------------------------------------------------------------
// 时序查询（`GET /api/v1/hosts/{id}/metrics`，docs/api.md §4.3）
// -----------------------------------------------------------------------------

/**
 * 时序档位白名单。
 *
 * 🔑 一个档位 = 「曲线上点多长时间一格」＋「读哪张表」。本实现里二者**一一对应**，
 *    且**不做"在降采样表上再聚合"**（✅ 2026-10-05 定：最长只看 30 天）：
 *      · `30s` → `metrics_raw`，网格 = 上报周期（`AGENT_REPORT_PERIOD_S`，见 offline.service.js）
 *      · `1m` / `5m` → 降采样层，网格 = 表里现成的 `bucket`
 *
 * ⛔ **不再有 `15s` 档**：Agent 默认上报周期在修订 G3 已由 15s 改为 **30s**
 *    （`agent/internal/config/config.go`）。15s 的网格会让每两个桶空一个 ——
 *    前端看到的是"这台机一直在丢采集"，而真实原因是档位比上报周期还细。
 *    档位宁可偏粗：30s 网格查 15s 上报的机器只是每桶 2 个样本（agg 会处理掉），不会出现空桶。
 *
 * ⛔ 表名无法参数化（要拼进 SQL），故只允许取自此处的固定值。
 */
export const METRIC_STEPS = Object.freeze({
  '30s': { table: 'metrics_raw', sizeS: 30, timeColumn: 'ts', alignedColumn: null },
  '1m': { table: 'metrics_1m', sizeS: 60, timeColumn: 'bucket', alignedColumn: 'bucket' },
  '5m': { table: 'metrics_5m', sizeS: 300, timeColumn: 'bucket', alignedColumn: 'bucket' },
});

/**
 * `agg` → 聚合表达式。两个来源层的列名不同：raw 是单值列 `value`，
 * 降采样层是降采样时就**预先算好**的四列（`v_avg` / `v_min` / `v_max` / `v_last`）。
 *
 * ⚠️ 降采样层每个 `(agent_id, metric, bucket)` 只有一行，聚合函数实际上是恒等的；
 *    保留聚合形式只是为了与 raw 共用同一段 SQL。
 *    ⛔ 因此**不要**在这里做跨桶再聚合 —— 那个决定（不做）见上一条；
 *    真要跨桶加权平均，`n` 已经在表里，届时应写成 `sum(v_avg * n) / sum(n)`。
 */
const AGG_EXPRESSION = Object.freeze({
  avg: { raw: 'avg(value)', downsampled: 'avg(v_avg)' },
  max: { raw: 'max(value)', downsampled: 'max(v_max)' },
  min: { raw: 'min(value)', downsampled: 'min(v_min)' },
  // 「桶内最后一条」：同组内 ts 唯一（主键是 (agent_id, metric, ts)），故 DESC 取首个即最后一条
  last: { raw: '(array_agg(value ORDER BY ts DESC))[1]', downsampled: 'max(v_last)' },
});

/**
 * 组装 `metrics` 参数的 WHERE 片段（基名展开 + 全名精确匹配）。
 *
 * 🔑 基名用**区间比较**而不是 `LIKE 'base{%'`：`_` 在 LIKE 里是单字符通配符，
 *    而本项目的基名大量使用下划线（`used_pct` / `rx_bps` / `ctx_switch`）——
 *    `LIKE 'disk.used_pct{%'` 会把 `diskXused_pct{...}` 也匹配进来。
 *    区间 `[base || '{', base || '}')` 零成本且从根上避免
 *    （与 `selectLatestSeriesForAgents` 同一口径，docs/api.md §4.3）。
 *
 * ⚠️ 它是**行级谓词**（不是 JOIN），所以"请求里同时写了基名和它下面的某个全名"
 *    天然不会让同一条序列出现两次 —— 不需要额外去重。
 *
 * @param {{ fullNames: string[], bases: string[] }} input
 * @param {unknown[]} params 会被就地追加绑定值
 */
function buildMetricPredicate(input, params) {
  const clauses = [];
  if (input.fullNames.length > 0) {
    params.push(input.fullNames);
    clauses.push(`metric = ANY($${params.length}::text[])`);
  }
  for (const base of input.bases) {
    params.push(base);
    const p = `$${params.length}`;
    clauses.push(`(metric = ${p} OR (metric >= ${p} || '{' AND metric < ${p} || '}'))`);
  }
  // 请求里不可能啥也没有（路由层已保证非空），但空谓词会退化成"扫全表"，故显式 FALSE
  return clauses.length > 0 ? `(${clauses.join(' OR ')})` : 'FALSE';
}

/**
 * 取窗口内**实际存在**的序列全名（基名已展开成各维度序列）。
 *
 * ⚠️ 先取名字、再取点，是为了在**拉数据之前**就能对"展开后有多少条序列"设闸门：
 *    一个 `disk.used_pct` 在 30 个挂载点的机器上会展开成 30 条线，
 *    等把 30 × 8640 个点拉回来再判断，DB 和内存已经白烧了。
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @param {string} input.agentId
 * @param {Date} input.from 已对齐到桶边界的下界
 * @param {Date} input.to 已对齐到桶边界的上界（**排他**）
 * @param {'30s'|'1m'|'5m'} input.step
 * @param {string[]} input.fullNames 全名（精确匹配）
 * @param {string[]} input.bases 基名（精确 + 前缀展开）
 * @param {number} input.limit 最多返回多少条（调用方给 `上限 + 1`，用来判断"是否超限"）
 * @returns {Promise<string[]>} 按 `metric` 升序
 */
export async function listSeriesNamesInRange(pool, input) {
  const tier = METRIC_STEPS[input.step];
  if (!tier) throw new AppError('invalid_request', { message: `未知时序档位：${input.step}` });

  const params = [input.agentId, input.from, input.to];
  const predicate = buildMetricPredicate(input, params);

  const { rows } = await pool.query(
    `SELECT DISTINCT metric
       FROM ${tier.table}
      WHERE agent_id = $1::uuid
        AND ${tier.timeColumn} >= $2::timestamptz
        AND ${tier.timeColumn} <  $3::timestamptz
        AND ${predicate}
      ORDER BY metric
      LIMIT ${Number(input.limit)}`,
    params,
  );
  return rows.map((row) => row.metric);
}

/**
 * 取窗口内每条序列的**点**（已按档位落桶）。
 *
 * ⛔ **缺失的桶不补 0、不补 null**：桶里没有样本就是"没采集到"，
 *    补 0 会把"采集断了"画成"CPU 掉到 0"（那种假数据事后没人查得出来）。
 *    前端按点与点之间的空档直接断线。
 *
 * @param {import('pg').Pool} pool
 * @param {object} input 同 {@link listSeriesNamesInRange}，另加：
 * @param {'avg'|'max'|'min'|'last'} input.agg
 * @returns {Promise<Array<{ metric: string, bucket: Date, value: number, n: number|null }>>}
 *          按 `metric, bucket` 升序
 */
export async function selectSeriesPointsInRange(pool, input) {
  const tier = METRIC_STEPS[input.step];
  if (!tier) throw new AppError('invalid_request', { message: `未知时序档位：${input.step}` });
  const agg = AGG_EXPRESSION[input.agg];
  if (!agg) throw new AppError('invalid_request', { message: `未知聚合方式：${input.agg}` });

  const params = [input.agentId, input.from, input.to];
  const predicate = buildMetricPredicate(input, params);

  // 原始层要自己落桶（`ts` 是接收时刻，未必落在整 30 秒上）；降采样层的 `bucket` 建表时已对齐
  const bucketExpression =
    tier.alignedColumn ??
    `to_timestamp(floor(extract(epoch from ${tier.timeColumn}) / ${tier.sizeS}) * ${tier.sizeS})`;
  const valueExpression = tier.alignedColumn ? agg.downsampled : agg.raw;
  const nExpression = tier.alignedColumn ? 'max(n)' : 'count(*)::int';

  const { rows } = await pool.query(
    `SELECT s.metric, s.bucket, s.value, s.n
       FROM (
         SELECT metric,
                ${bucketExpression} AS bucket,
                ${valueExpression} AS value,
                ${nExpression} AS n
           FROM ${tier.table}
          WHERE agent_id = $1::uuid
            AND ${tier.timeColumn} >= $2::timestamptz
            AND ${tier.timeColumn} <  $3::timestamptz
            AND ${predicate}
          GROUP BY 1, 2
       ) s
      WHERE s.value IS NOT NULL
      ORDER BY s.metric, s.bucket`,
    params,
  );
  return rows.map((row) => ({
    metric: row.metric,
    bucket: row.bucket,
    value: Number(row.value),
    n: row.n === null || row.n === undefined ? null : Number(row.n),
  }));
}
