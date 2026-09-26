/**
 * Vantage · 分区维护服务（metrics_raw 按天分区）
 *
 * 依据：docs/database.md §5.7.3（分区与索引）、§8.2（建分区 / Drop 分区定时任务）、
 *       §2（DDL 走独立迁移账号）、决策 #50（分区维护归属：core 内置任务 + 分布式锁）
 *
 * ⚠️ 本模块是**唯一**允许对 `metrics_raw` 执行 DDL 的地方。
 *    ⛔ 调用方必须传 **DDL 权限的连接池**（`db.migrator ?? db.app`）：
 *    单账号部署下运行时池本身就是库属主（设计允许），而一旦按 R13 拆成三角色，
 *    运行时池（vantage_app）**没有** CREATE/DROP 权限，走错池会直接 42501。
 *
 * 🔑 为什么「预建」是硬要求而不是优化项（实测结论）
 *    `metrics_raw_default` 是兜底分区。一旦某天的数据先落进兜底分区，之后给那天
 *    `CREATE TABLE ... PARTITION OF` 会失败：
 *      23514 updated partition constraint for default partition "metrics_raw_default"
 *            would be violated by some row
 *    补救只能**先删掉那天的数据**（= 丢数据）。所以必须始终留有足够的提前量：
 *    提前量不足时宁可告警，也不要指望事后补。
 */

import { AppError } from '../utils/errors.js';

/** 兜底分区名（⛔ 永不删除：它承载"提前量不足"时的写入，删了会让上报直接失败） */
export const DEFAULT_PARTITION = 'metrics_raw_default';

/** 系统生成的按天分区命名前缀（与迁移 0004 的 vantage_metrics_raw_partition_name 一致） */
const PARTITION_RE = /^metrics_raw_\d{8}$/;

/** UTC 日 → `YYYY-MM-DD`（⛔ 统一 UTC：分区边界就是 UTC 日，本地时区会让边界差一天） */
export function utcDayString(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

function addDays(dayString, days) {
  const base = Date.parse(`${dayString}T00:00:00.000Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`)) / 86_400_000);
}

/**
 * 幂等预建「今天 .. 今天+days」的按天分区。
 *
 * 幂等性来自 SQL 侧：`vantage_ensure_metrics_raw_partition(date)` 内部用
 * `to_regclass` 判断存在性（迁移 0004），因此重复调用不会报错。
 *
 * ➕ 一个刻意的实现细节：**逐个日期串行调用**（而不是一条 `generate_series` 动态 SQL）。
 *    好处是①每个分区单独成一次 DDL，出错时能明确知道是哪一天；
 *    ②与迁移期用的是**同一个函数**，行为不会分叉。
 *
 * @param {import('pg').Pool} pool DDL 连接池（migrator 或库属主）
 * @param {{ days: number, now?: Date, logger?: object }} options
 * @returns {Promise<{ created: string[], existed: string[], firstDay: string, lastDay: string }>}
 */
export async function ensureUpcomingPartitions(pool, options) {
  const days = options.days;
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('ensureUpcomingPartitions 需要 days >= 1');
  }

  const today = utcDayString(options.now ?? new Date());
  const created = [];
  const existed = [];

  // 先查一次现状，避免 N 次 to_regclass 往返（一次性拿到已有分区名集合）
  const { rows } = await pool.query(
    `SELECT c.relname::text AS name
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class    p ON p.oid = i.inhparent
      WHERE p.relname = 'metrics_raw' AND c.relname ~ '^metrics_raw_[0-9]{8}$'`,
  );
  const existing = new Set(rows.map((row) => row.name));

  for (let offset = 0; offset <= days; offset += 1) {
    const day = addDays(today, offset);
    const name = `metrics_raw_${day.replace(/-/g, '')}`;
    if (existing.has(name)) {
      existed.push(name);
      continue;
    }
    // 走迁移里的同名函数：建表 + 建 BRIN(ts) 一步到位，⛔ 不要在这里自己写 CREATE TABLE
    await pool.query('SELECT vantage_ensure_metrics_raw_partition($1::date)', [day]);
    created.push(name);
    options.logger?.info?.({ partition: name, day }, '已预建 metrics_raw 按天分区');
  }

  const lastDay = addDays(today, days);
  if (created.length > 0) {
    options.logger?.info?.(
      { created: created.length, days, lastDay },
      '分区预建完成',
    );
  }

  return { created, existed, firstDay: today, lastDay };
}

/**
 * 列出所有按天分区（含行数与覆盖情况）。
 *
 * ⚠️ `metrics_raw_default` **不在** `vantage_metrics_raw_partitions()` 的结果里（迁移函数有意排除），
 *    这里单独补上——**提前量是否够用，就看它对不对得上兜底分区里有没有行**。
 *
 * 行数用 `pg_class.reltuples`（估算，不做 count(*)）：在大分区上 count(*) 会扫全表，
 * 而这里只需要"有没有数据"这个量级判断。
 * ⛔ **绝不要把 `rows` 用于任何删除决策**：刚写入的分区在 autovacuum/ANALYZE 之前
 *    `reltuples` 仍是 0/-1。删除安全性一律靠 `downsample.service.js::wasDayAggregated` 的
 *    `EXISTS` 精确判断。
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ partitions: Array<{name: string, day: string, rows: number}>, remainingDays: number, defaultRows: number }>}
 */
export async function listPartitions(pool) {
  const { rows } = await pool.query(
    `SELECT c.relname::text AS name,
            to_char(to_date(substring(c.relname from 'metrics_raw_([0-9]{8})$'), 'YYYYMMDD'), 'YYYY-MM-DD') AS day,
            GREATEST(c.reltuples, 0)::bigint::text AS rows,
            i.inhrelid
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class    p ON p.oid = i.inhparent
      WHERE p.relname = 'metrics_raw'
      ORDER BY 2`,
  );

  const partitions = rows
    .filter((row) => PARTITION_RE.test(row.name))
    .map((row) => ({ name: row.name, day: row.day, rows: Number(row.rows) }));

  const defaultRow = rows.find((row) => row.name === DEFAULT_PARTITION);
  let defaultRows = Number(defaultRow?.rows ?? 0);
  if (!defaultRow) defaultRows = 0;

  const today = utcDayString();
  const last = partitions.at(-1)?.day;
  return {
    partitions,
    remainingDays: last ? daysBetween(today, last) : 0,
    defaultRows,
  };
}

/**
 * 列出「ts 全部早于 now()-olderThanDays」的整日分区（**只列不删**）。
 *
 * ⛔ 三条安全规则（缺一不可）
 *  1. **永不删兜底分区**：`metrics_raw_default` 的行可能横跨所有未预建的日期，
 *     删了等于删掉"提前量不足期间"的全部数据，而且上报会立刻失去落点；
 *  2. **只认形状正确的名字**（`metrics_raw_YYYYMMDD`）：防止把父表或别的对象拼进来；
 *  3. **整天都过期才删**：按分区名里的日期判断，而不是看 `max(ts)`——
 *     分区名就是 UTC 日边界，用日期判断才是精确且不需要扫表的。
 *
 * 🔑 拆出「列」与「删」两步，是为了让调用方（cron）能在中间插入**逐分区门禁**
 *    （"这一天的原始数据真的已经被聚合走了吗？"）——那才是防止永久数据空洞的关键，
 *    而全局健康检查只能证明"聚合任务最近活着"，证明不了"这天的数据被聚合过"。
 */
export async function listExpiredPartitions(pool, { olderThanDays, now = new Date() } = {}) {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
    throw new Error('listExpiredPartitions 需要 olderThanDays >= 1（⛔ 不允许一刀切清空）');
  }
  const cutoff = utcDayString(new Date(now.getTime() - olderThanDays * 86_400_000));
  const info = await listPartitions(pool);
  const expired = info.partitions.filter(
    (partition) =>
      partition.name !== DEFAULT_PARTITION && PARTITION_RE.test(partition.name) && partition.day < cutoff,
  );
  return { expired, cutoff };
}

/**
 * 按名字删除分区（**唯一的物理删除入口**）。
 * @param {import('pg').Pool} pool DDL 连接池
 * @param {string[]} names 必须来自 listPartitions/listExpiredPartitions
 */
export async function dropPartitionsByName(pool, names, { logger } = {}) {
  const dropped = [];
  for (const name of names) {
    if (name === DEFAULT_PARTITION || !PARTITION_RE.test(name)) continue; // 规则 1 + 2，二次把关
    // ⛔ 名字来自 pg_class（系统目录）且已被白名单约束；此处仍用 %I 二次转义，杜绝注入
    await pool.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
    dropped.push(name);
    logger?.info?.({ partition: name }, '过期分区已删除');
  }
  return dropped;
}

/**
 * 「列出过期分区 + 全部删除」的便捷入口（CLI 用）。
 * ⛔ cron **不要**用它：cron 必须走 list → 逐分区门禁 → drop 三步。
 */
export async function dropExpiredPartitions(pool, options) {
  const { dryRun = false, logger } = options;
  const { expired, cutoff } = await listExpiredPartitions(pool, options);
  const dropped = dryRun ? expired.map((p) => p.name) : await dropPartitionsByName(pool, expired.map((p) => p.name), { logger });

  logger?.info?.(
    { dropped: dropped.length, cutoff, dryRun },
    dryRun ? '分区 Drop 预演完成（未执行）' : '过期分区已删除',
  );

  return { dropped, cutoff };
}

/** 标识符转义（自建，避免为此引入依赖）：双写双引号并整体加引号 */
function quoteIdent(name) {
  if (typeof name !== 'string' || name === '') throw new AppError('invalid_request');
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * 提前量健康检查：兜底分区有行 = 说明预建没跟上（✅ 这是运维必须告警的信号，而不是"正常现象"）。
 * @returns {Promise<{ ok: boolean, reason?: string, remainingDays: number, defaultRows: number }>}
 */
export async function checkPartitionHealth(pool, { minRemainingDays = 7 } = {}) {
  const info = await listPartitions(pool);
  if (info.defaultRows > 0) {
    return {
      ok: false,
      reason:
        `兜底分区 metrics_raw_default 已有约 ${info.defaultRows} 行：说明某些日期没有预建分区。` +
        '⚠️ 这些日期**无法事后补建**（23514），需先清理该日数据再建分区。请检查分区维护任务是否在运行。',
      remainingDays: info.remainingDays,
      defaultRows: info.defaultRows,
    };
  }
  if (info.remainingDays < minRemainingDays) {
    return {
      ok: false,
      reason: `分区提前量不足：仅剩 ${info.remainingDays} 天（要求 ≥ ${minRemainingDays} 天）`,
      remainingDays: info.remainingDays,
      defaultRows: info.defaultRows,
    };
  }
  return { ok: true, remainingDays: info.remainingDays, defaultRows: info.defaultRows };
}
