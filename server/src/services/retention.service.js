/**
 * Vantage · 保留期清理服务
 *
 * 依据：docs/database.md §8.1（保留期矩阵）、§8.2（清理任务规格）、决策 #11/#38/R10
 *
 * ⛔ 清理是**唯一会永久删数据**的地方，因此这里的每条规则都带一句"为什么可以删"：
 *
 *  时序层
 *   · `metrics_raw`   → 不在这里删。原始层是**按天分区**，走 `DROP TABLE`（见 partition.service.js），
 *                       秒级完成且无 VACUUM 压力；**前提是降采样已经把它汇总走**。
 *   · `metrics_1m/5m` → 不分区，只能分批 DELETE（✅ R14/决策 #49）。
 *  非时序层
 *   · `probe_results` / `process_snapshots` / `agent_ip_history` / `notification_log` / `audit_logs`
 *     → 纯历史记录，过期即无查询价值（面板最多看最近几个月）。
 *   · `silences` → 静默窗口过期后 7 天清（保留 7 天是为了"事后复盘当时静默了什么"）。
 *   · `ip_change_events` / `alert_events` → **永久保留**（决策 #11），不在此清理。
 *
 * 🔑 为什么必须**分批**：一次 `DELETE ... WHERE ts < X` 在几千万行的表上会变成
 *    长事务 —— 持有大量行锁、撑大 WAL、还挡 autovacuum。分批（默认 1 万行/批）
 *    让每批都是短事务，膨胀交给 autovacuum 慢慢回收（§5.8/§8.2 的明确要求）。
 */

import { AppError } from '../utils/errors.js';

/**
 * 清理规则表（保留期由调用方从 config 注入，这里只描述"表 / 时间列"）。
 * ⛔ 表名与列名都是**写死的白名单**（无法参数化标识符）——
 *    任何"从配置读表名"的想法都会把这里变成一个 SQL 注入口子。
 */
export const PURGE_RULES = Object.freeze({
  downsampled: {
    '1m': { table: 'metrics_1m', column: 'bucket' },
    '5m': { table: 'metrics_5m', column: 'bucket' },
  },
  nonTimeSeries: [
    { table: 'probe_results', column: 'checked_at', retentionKey: 'probeResultsDays' },
    { table: 'process_snapshots', column: 'ts', retentionKey: 'processSnapshotsDays' },
    { table: 'agent_ip_history', column: 'last_seen', retentionKey: 'agentIpHistoryDays' },
    { table: 'notification_log', column: 'ts', retentionKey: 'notificationLogDays' },
    { table: 'audit_logs', column: 'ts', retentionKey: 'auditLogsDays' },
  ],
  /** 静默窗口：不是"保留 N 天"，而是"结束后再留 N 天" */
  silences: { table: 'silences', column: 'ends_at', retentionKey: 'silenceKeepAfterEndDays' },
});

/**
 * 分批删除某张表里早于截止时间的历史行。
 *
 * 实现要点：`DELETE ... WHERE ctid IN (SELECT ctid ... ORDER BY <时间列> LIMIT n)`
 *  · 用 `ctid` 是因为 PG 的 `DELETE` **不支持 LIMIT**，而子查询里可以；
 *  · `ORDER BY <时间列>` 保证先删最旧的，即使一次跑不完（达到 maxBatches）也不会让
 *    "最老的数据永远留着"；
 *  · 每批都是**独立的自动提交事务**（刻意不包成一个大事务）。
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @param {string} input.table 白名单内的表名
 * @param {string} input.column 白名单内的时间列
 * @param {Date} input.cutoff 删除「< cutoff」的行
 * @param {number} [input.batchSize]
 * @param {number} [input.maxBatches] 单次运行最多删几批（防止一个任务跑几小时）
 * @param {{ info?: Function, warn?: Function, debug?: Function }} [input.logger]
 * @returns {Promise<{ table: string, deleted: number, batches: number, truncated: boolean }>}
 */
export async function purgeBefore(pool, input) {
  const { table, column, cutoff } = input;
  const batchSize = input.batchSize ?? 10_000;
  const maxBatches = input.maxBatches ?? 50;

  assertAllowed(table, column);

  let deleted = 0;
  let batches = 0;
  let truncated = false;

  for (let i = 0; i < maxBatches; i += 1) {
    const result = await pool.query(
      `DELETE FROM ${table}
        WHERE ctid IN (
              SELECT ctid FROM ${table}
               WHERE ${column} < $1::timestamptz
               ORDER BY ${column}
               LIMIT $2
            )`,
      [cutoff, batchSize],
    );
    const rows = result.rowCount ?? 0;
    deleted += rows;
    batches += 1;
    if (rows < batchSize) break;
    if (i === maxBatches - 1) truncated = true;
  }

  if (deleted > 0) {
    input.logger?.info?.(
      { table, column, cutoff: cutoff.toISOString(), deleted, batches, truncated },
      '保留期清理：已删除过期数据',
    );
  } else {
    input.logger?.debug?.({ table, cutoff: cutoff.toISOString() }, '保留期清理：无过期数据');
  }
  if (truncated) {
    // 不是错误：说明积压很多，下一轮会继续删（分批的意义正在于此）
    input.logger?.warn?.(
      { table, deleted, batches, maxBatches },
      '保留期清理达到单次批次上限，剩余数据将在下一轮继续删除',
    );
  }

  return { table, deleted, batches, truncated };
}

/**
 * 清理降采样层（1m / 5m）。
 * @param {import('pg').Pool} pool
 * @param {{ retention: object, now?: Date, batchSize?: number, maxBatches?: number, logger?: object }} options
 */
export async function purgeDownsampled(pool, options) {
  const now = options.now ?? new Date();
  const results = [];

  const plan = [
    { tier: '1m', days: options.retention.metrics1mDays },
    { tier: '5m', days: options.retention.metrics5mDays },
  ];

  for (const { tier, days } of plan) {
    const spec = PURGE_RULES.downsampled[tier];
    if (!spec) throw new AppError('invalid_request', { message: `未知降采样档位：${tier}` });
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    results.push(
      await purgeBefore(pool, {
        ...spec,
        cutoff,
        batchSize: options.batchSize,
        maxBatches: options.maxBatches,
        logger: options.logger,
      }),
    );
  }

  return results;
}

/**
 * 清理非时序表 + 过期静默窗口。
 * @param {import('pg').Pool} pool
 * @param {{ retention: object, now?: Date, batchSize?: number, maxBatches?: number, logger?: object }} options
 */
export async function purgeNonTimeSeries(pool, options) {
  const now = options.now ?? new Date();
  const retention = options.retention;
  const results = [];

  const plan = [
    ...PURGE_RULES.nonTimeSeries,
    // 静默窗口：语义是"结束后再留 N 天"，N 可以为 0（立即清）
    PURGE_RULES.silences,
  ];

  for (const rule of plan) {
    const days = retention[rule.retentionKey];
    if (!Number.isFinite(days)) {
      options.logger?.warn?.({ rule }, '保留期配置缺失，跳过该表的清理');
      continue;
    }
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    results.push(
      await purgeBefore(pool, {
        table: rule.table,
        column: rule.column,
        cutoff,
        batchSize: options.batchSize,
        maxBatches: options.maxBatches,
        logger: options.logger,
      }),
    );
  }

  return results;
}

/** 只允许白名单内的表/列组合（把"标识符注入"的可能性收敛为零） */
function assertAllowed(table, column) {
  const allowed = new Set();
  for (const spec of Object.values(PURGE_RULES.downsampled)) allowed.add(`${spec.table}.${spec.column}`);
  for (const spec of PURGE_RULES.nonTimeSeries) allowed.add(`${spec.table}.${spec.column}`);
  allowed.add(`${PURGE_RULES.silences.table}.${PURGE_RULES.silences.column}`);

  if (!allowed.has(`${table}.${column}`)) {
    throw new AppError('invalid_request', {
      message: `清理目标不在白名单内：${table}.${column}`,
    });
  }
}
