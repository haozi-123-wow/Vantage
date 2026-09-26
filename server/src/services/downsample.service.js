/**
 * Vantage · 降采样服务（metrics_raw → metrics_1m / metrics_5m）
 *
 * 依据：docs/database.md §8.2（聚合 1m/5m 定时任务）、§8.3（降采样 SQL 语义）、
 *       §5.8（降采样层不分区）、决策 #38（幂等可重入）、R14
 *
 * 为什么这一层是**必需**的（而不是"优化"）
 *  原始层只保留 15 天。没有降采样，15 天之后的历史就**永久消失**；
 *  有了它，15 天以外仍有 1 分钟 / 90 天以外仍有 5 分钟粒度可查。
 *  ⛔ 因此：**删原始分区的任务必须依赖本模块已经成功跑过**，顺序不能反（见 retention.service.js）。
 *
 * 两处与文档字面不同、但结果等价的实现选择（已验证同结果，理由如下）
 *  1. **桶对齐用 epoch 取整**，而不是 §8.3 写的
 *     `date_trunc('minute', ts)` / `date_trunc('hour',ts) + ((minute/5)*5) * interval '1 minute'`。
 *     理由：`date_trunc` 对 `timestamptz` 是**按会话时区**截断的 —— 连接池里任何一处
 *     `SET timezone` 或客户端 locale 变化都会让桶边界整体偏移，而偏移后写进
 *     `(agent_id, metric, bucket)` 主键就是**错桶**（旧桶不再匹配 → 曲线出现错位台阶，且不报错）。
 *     `floor(extract(epoch …)/N)*N` 是绝对秒取整，天然就是 UTC，与时区设置无关。
 *     两种算法在 UTC 下逐位等价（例：10:07:33 的 5 分钟桶都是 10:05:00）。
 *  2. **回看窗口是一个参数 `lookbackBuckets`**，一次覆盖最近 N+1 个完整桶，
 *     而不是"当前桶 + 前 N 桶"分开算：迟到数据（Agent 重试、时钟修正）会落进**已经聚合过**的桶，
 *     靠 `ON CONFLICT DO UPDATE` 重算即可自愈。
 */

import { AppError, normalizeError } from '../utils/errors.js';

/**
 * 降采样档位（表名白名单）。
 * ⛔ 表名无法参数化，只能拼进 SQL —— 因此**只允许**取自此处的固定值。
 * ⚠️ 上报周期与档位强相关：15s 上报时 1 分钟桶含 4 个样本（有意义）；
 *    若上报周期改成 ≥60s，1 分钟档就退化成"原样拷贝一份"，届时应改用 5m + 1h 档
 *    （需加一张表 = 一次迁移）。见 design-deltas 的开放项。
 */
export const DOWNSAMPLE_TIERS = Object.freeze({
  '1m': { table: 'metrics_1m', sizeS: 60, label: '1 分钟' },
  '5m': { table: 'metrics_5m', sizeS: 300, label: '5 分钟' },
});

/** 桶起点表达式：绝对秒取整（UTC，与时区无关） */
const BUCKET_EXPR = 'to_timestamp(floor(extract(epoch from m.ts) / $2::double precision) * $2::double precision)';

/**
 * 聚合一个档位。
 *
 * @param {import('pg').Pool} pool 运行时 DML 连接池（⛔ 不是 migrator：这里是纯 DML）
 * @param {object} options
 * @param {'1m'|'5m'} options.tier
 * @param {number} [options.lookbackBuckets] 回看多少个**额外**的完整桶（默认 3）
 * @param {Date} [options.now]
 * @param {{ info?: Function, warn?: Function, debug?: Function }} [options.logger]
 * @returns {Promise<{ tier: string, table: string, from: Date, to: Date, buckets: number }>}
 */
export async function aggregateTier(pool, options) {
  const tier = DOWNSAMPLE_TIERS[options.tier];
  if (!tier) throw new AppError('invalid_request', { message: `未知降采样档位：${options.tier}` });

  const sizeS = tier.sizeS;
  const lookback = options.lookbackBuckets ?? 3;
  const nowMs = (options.now ?? new Date()).getTime();

  // 当前（未完成）桶的起点 = 排他上界；往前取 lookback+1 个完整桶
  const toMs = Math.floor(nowMs / 1000 / sizeS) * sizeS * 1000;
  const fromMs = toMs - (lookback + 1) * sizeS * 1000;
  const from = new Date(fromMs);
  const to = new Date(toMs);

  // ⚠️ 表名来自上面的白名单（不是调用方传进来的字符串）
  const sql = `
    INSERT INTO ${tier.table} (agent_id, metric, bucket, v_avg, v_min, v_max, v_last, n)
    SELECT m.agent_id,
           m.metric,
           ${BUCKET_EXPR} AS bucket,
           avg(m.value),
           min(m.value),
           max(m.value),
           -- 「按 ts 取最后一条」：同组内 ts 唯一（主键是 (agent_id, metric, ts)），故 DESC 取首个即最后一条
           (array_agg(m.value ORDER BY m.ts DESC))[1],
           count(*)::int
      FROM metrics_raw m
     WHERE m.ts >= $1::timestamptz
       AND m.ts <  $3::timestamptz
     GROUP BY m.agent_id, m.metric, ${BUCKET_EXPR}
    ON CONFLICT (agent_id, metric, bucket)
      DO UPDATE SET v_avg  = EXCLUDED.v_avg,
                    v_min  = EXCLUDED.v_min,
                    v_max  = EXCLUDED.v_max,
                    v_last = EXCLUDED.v_last,
                    n      = EXCLUDED.n`;

  const started = Date.now();
  const result = await pool.query(sql, [from, sizeS, to]);
  const buckets = result.rowCount ?? 0;

  options.logger?.debug?.(
    { tier: options.tier, table: tier.table, buckets, from: from.toISOString(), to: to.toISOString(), ms: Date.now() - started },
    '降采样完成',
  );
  if (buckets > 0) {
    options.logger?.info?.(
      { tier: options.tier, buckets, from: from.toISOString(), to: to.toISOString() },
      `${tier.label}降采样已写入`,
    );
  }

  return { tier: options.tier, table: tier.table, from, to, buckets };
}

/**
 * 聚合全部档位（1m 先、5m 后）。
 *
 * ⚠️ 顺序有讲究：5m 桶应该建立在**已聚合好的 1m 数据**之上（若将来改成 roll-up 链路）；
 *    当前实现里两个档位都直接读原始层（§8.3 的规格就是这么写的），
 *    因此这里的顺序只影响"先看到哪一层的数据"，不影响正确性。
 *    保持固定顺序是为了让日志与排障可预期。
 */
export async function aggregateAllTiers(pool, options = {}) {
  const results = [];
  for (const key of Object.keys(DOWNSAMPLE_TIERS)) {
    try {
      results.push(await aggregateTier(pool, { ...options, tier: key }));
    } catch (err) {
      // 单个档位失败不阻断另一档；但必须让调用方知道（cron 会记 error 日志）
      throw normalizeError(err, { logger: options.logger });
    }
  }
  return results;
}

/**
 * 某个 UTC 日的原始数据**是否已经被聚合走**（逐分区门禁）。
 *
 * 🔑 为什么"全局健康检查"不够：它只能证明"聚合任务最近活着"，
 *    证明不了"**这一天**的数据被聚合过"。反例：聚合坏了 20 天、5 分钟前刚修好 ——
 *    最近桶有数据（健康检查通过），但 15–20 天前那几天的原始数据从没被聚合，
 *    此时删掉那些分区就是**永久数据空洞**。
 *
 * 判定：该日有原始行、但降采样层在该日**一行都没有** → 判定为"未被聚合"，拒绝删除。
 * 代价：一次 `metrics_raw` 该日分区的 `EXISTS`（有 BRIN 与分区裁剪，且只扫到第一行即返回）。
 *
 * @param {import('pg').Pool} pool
 * @param {{ day: string, tier?: '1m'|'5m' }} options day = `YYYY-MM-DD`
 * @returns {Promise<{ hasRaw: boolean, hasDownsampled: boolean, safe: boolean }>}
 */
export async function wasDayAggregated(pool, { day, tier = '1m' }) {
  const spec = DOWNSAMPLE_TIERS[tier];
  if (!spec) throw new AppError('invalid_request', { message: `未知降采样档位：${tier}` });

  const from = `${day}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 86_400_000).toISOString();

  const { rows } = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM metrics_raw WHERE ts >= $1::timestamptz AND ts < $2::timestamptz) AS has_raw,
       EXISTS (SELECT 1 FROM ${spec.table} WHERE bucket >= $1::timestamptz AND bucket < $2::timestamptz) AS has_down`,
    [from, to],
  );
  const hasRaw = rows[0]?.has_raw === true;
  const hasDownsampled = rows[0]?.has_down === true;
  // 没有原始行 → 这一天本来就是空的，删不删都无损
  return { hasRaw, hasDownsampled, safe: !hasRaw || hasDownsampled };
}

/**
 * 聚合健康检查：最近一个**已完成**桶是否已有数据。
 *
 * ➕ 用途：cron 的失败告警兜底。**"原始数据删了、降采样没写进去" = 永久数据空洞**，
 *    这是本系统最难被发现、也最不可逆的一类故障（docs/database.md §8.2 的 ➕ 建议）。
 *    因此在删原始分区之前，必须先确认降采样是**活着**的。
 *
 * @returns {Promise<{ ok: boolean, reason?: string, staleBuckets?: number }>}
 */
export async function checkDownsampleHealth(pool, { tier = '1m', now = new Date(), toleranceBuckets = 5 } = {}) {
  const spec = DOWNSAMPLE_TIERS[tier];
  if (!spec) throw new AppError('invalid_request', { message: `未知降采样档位：${tier}` });

  const toMs = Math.floor(now.getTime() / 1000 / spec.sizeS) * spec.sizeS * 1000;
  const expectedBucket = new Date(toMs - spec.sizeS * 1000); // 最近一个完整桶

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM ${spec.table} WHERE bucket = $1::timestamptz`,
    [expectedBucket],
  );
  if ((rows[0]?.n ?? 0) > 0) return { ok: true };

  // 没有该桶 → 再看这张表到底停在哪一桶（用于日志里给出可操作的线索）
  const last = await pool.query(`SELECT max(bucket) AS last FROM ${spec.table}`);
  const lastBucket = last.rows[0]?.last ?? null;
  if (!lastBucket) {
    return { ok: false, reason: `${spec.table} 尚无任何数据（聚合任务可能从未成功运行）` };
  }
  const staleBuckets = Math.round((expectedBucket.getTime() - new Date(lastBucket).getTime()) / (spec.sizeS * 1000));
  return {
    ok: staleBuckets <= toleranceBuckets,
    reason:
      staleBuckets > toleranceBuckets
        ? `${spec.table} 停更 ${staleBuckets} 个桶（最后 ${new Date(lastBucket).toISOString()}，期望 ${expectedBucket.toISOString()}）`
        : undefined,
    staleBuckets,
  };
}
