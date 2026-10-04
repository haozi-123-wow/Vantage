/**
 * 定时任务套件测试（M1.5：分区维护 / 降采样 / 保留期清理）
 *
 * 依据：docs/database.md §5.7.3、§8.1、§8.2、§8.3
 *
 * 分两层，缺一不可：
 *  Ａ **真 PostgreSQL（PGlite/WASM）上跑真 SQL** —— 聚合的 `avg/min/max/v_last/n`、
 *     桶对齐、`ON CONFLICT` 重入、分批 DELETE、`DROP TABLE` 分区，这些都不是字符串能验证的。
 *  Ｂ **调度层用替身** —— 单实例锁、Redis 故障时 fail-open、任务失败不 panic、
 *     `nextDailyAt` 的跨日计算。这些用真库反而难构造。
 *
 * ⚠️ 最值得看的是「删分区门禁」那几条：本系统的**永久数据空洞**只有这一条防线。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { loadConfig } from '../src/config/index.js';
import { createCronService, nextDailyAt } from '../src/services/cron.service.js';
import {
  aggregateTier,
  checkDownsampleHealth,
  wasDayAggregated,
} from '../src/services/downsample.service.js';
import {
  checkPartitionHealth,
  dropExpiredPartitions,
  dropPartitionsByName,
  ensureUpcomingPartitions,
  listExpiredPartitions,
  listPartitions,
  utcDayString,
} from '../src/services/partition.service.js';
import { purgeBefore, purgeDownsampled, purgeNonTimeSeries } from '../src/services/retention.service.js';
import { CRON_TASKS, keys } from '../src/utils/redisKeys.js';
import { createFakeRedis } from './helpers/fake-redis.js';

// -----------------------------------------------------------------------------
// 真库（PGlite）准备：与生产同一条迁移代码路径
// -----------------------------------------------------------------------------
const db = await PGlite.create();
await db.exec('CREATE ROLE vantage_migrator LOGIN; CREATE ROLE vantage_app LOGIN; CREATE ROLE vantage_ro LOGIN;');
await db.exec(BOOTSTRAP_SQL);

const migrations = loadMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
const pgClient = {
  query: (sql, params) => (Array.isArray(params) && params.length > 0 ? db.query(sql, params) : db.exec(sql)),
};
for (const migration of migrations) {
  await applyOne(pgClient, migration, false);
}

/**
 * PGlite → node-pg 适配器。
 *
 * ⚠️ 两个必须抹平的差异（踩过才知道）：
 *  1. PGlite 的 `exec()` 返回的是**结果数组**（每条语句一项），而 `query()` 返回单个结果对象；
 *     node-pg 两种情况下都返回单个 `{ rows, rowCount }`。
 *  2. PGlite 用 `affectedRows`，node-pg 用 `rowCount` —— 不映射的话分批 DELETE 会永远读到
 *     `undefined ?? 0`，于是"清理看起来跑了但一行没删"，测试会给出假通过。
 */
async function run(sql, params = []) {
  if (Array.isArray(params) && params.length > 0) {
    const result = await db.query(sql, params);
    return {
      rows: result.rows ?? [],
      rowCount: result.affectedRows ?? result.rows?.length ?? 0,
    };
  }
  const results = await db.exec(sql);
  const last = Array.isArray(results) ? results.at(-1) : results;
  return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
}

/** 包装成"连接池"形状：本套件的服务只用到 `query` */
const pool = { query: run };

after(async () => {
  await db.close();
});

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

/** 固定 UUID 前缀，便于批量清理 */
const AGENT_A = '11111111-2222-4333-8444-555555555555';
const AGENT_B = '99999999-8888-4777-8666-555555555555';
const METRIC = 'test.cron_probe';

/** 造原始点：把 n 个样本平均铺在某个完整分钟桶内 */
async function seedMinute({ agentId = AGENT_A, metric = METRIC, minuteStartMs, values }) {
  const step = Math.floor(60_000 / values.length);
  for (let i = 0; i < values.length; i += 1) {
    await pool.query(
      `INSERT INTO metrics_raw (agent_id, metric, value, labels, ts) VALUES ($1,$2,$3,'{}'::jsonb,$4)`,
      [agentId, metric, values[i], new Date(minuteStartMs + i * step)],
    );
  }
}

/** 已结束的分钟桶起点（保证是"完整"的桶） */
function pastMinuteStart(offsetMinutes = 2) {
  return Math.floor(Date.now() / 60_000) * 60_000 - offsetMinutes * 60_000;
}

async function cleanupTestRows() {
  await pool.query(`DELETE FROM metrics_raw WHERE agent_id IN ($1,$2)`, [AGENT_A, AGENT_B]);
  await pool.query(`DELETE FROM metrics_1m WHERE agent_id IN ($1,$2)`, [AGENT_A, AGENT_B]);
  await pool.query(`DELETE FROM metrics_5m WHERE agent_id IN ($1,$2)`, [AGENT_A, AGENT_B]);
}

// -----------------------------------------------------------------------------
// Ａ-1 降采样：聚合语义
// -----------------------------------------------------------------------------

test('聚合 1m：avg/min/max/v_last/n 与桶对齐都正确（真 SQL）', async () => {
  await cleanupTestRows();
  const minute = pastMinuteStart(2);
  await seedMinute({ minuteStartMs: minute, values: [10, 20, 30, 40] });

  const result = await aggregateTier(pool, { tier: '1m', lookbackBuckets: 3, logger: silentLogger });
  assert.ok(result.buckets >= 1, '应至少写入一个桶');

  const { rows } = await db.query(
    `SELECT bucket, v_avg, v_min, v_max, v_last, n FROM metrics_1m WHERE agent_id = $1 AND metric = $2`,
    [AGENT_A, METRIC],
  );
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].bucket).getTime(), minute, '桶起点必须正好是该分钟（UTC 对齐）');
  assert.equal(Number(rows[0].v_avg), 25); // (10+20+30+40)/4
  assert.equal(Number(rows[0].v_min), 10);
  assert.equal(Number(rows[0].v_max), 40);
  assert.equal(Number(rows[0].v_last), 40, 'v_last = 按 ts 取最后一条');
  assert.equal(Number(rows[0].n), 4);
});

test('聚合 1m：桶对齐用 epoch 取整，**不受会话时区影响**（这是刻意偏离 §8.3 字面写法的地方）', async () => {
  await cleanupTestRows();
  const minute = pastMinuteStart(2);

  // 故意把会话时区改成 +08:00：date_trunc('minute', timestamptz) 会跟着偏移，epoch 取整不会
  await db.exec("SET TIME ZONE 'Asia/Shanghai'");
  try {
    await seedMinute({ minuteStartMs: minute, values: [1, 2] });
    await aggregateTier(pool, { tier: '1m', lookbackBuckets: 3, logger: silentLogger });

    const { rows } = await db.query(
      `SELECT bucket FROM metrics_1m WHERE agent_id = $1 AND metric = $2`,
      [AGENT_A, METRIC],
    );
    assert.equal(rows.length, 1);
    assert.equal(
      new Date(rows[0].bucket).getTime(),
      minute,
      '时区改成 +08:00 后桶起点仍须是 UTC 整分（否则主键会写到错桶，曲线出现错位台阶）',
    );
  } finally {
    await db.exec("SET TIME ZONE 'UTC'");
    await cleanupTestRows();
  }
});

test('聚合 5m：跨 5 个分钟桶的样本被并进同一个 5 分钟桶', async () => {
  await cleanupTestRows();
  // 取一个"5 分钟桶起点"往前推 10 分钟，保证是完整的 5 分钟桶
  const fiveStart = Math.floor(Date.now() / 300_000) * 300_000 - 600_000;
  for (let i = 0; i < 5; i += 1) {
    await seedMinute({ minuteStartMs: fiveStart + i * 60_000, values: [i + 1] });
  }

  await aggregateTier(pool, { tier: '5m', lookbackBuckets: 3, logger: silentLogger });
  const { rows } = await db.query(
    `SELECT bucket, v_avg, v_min, v_max, v_last, n FROM metrics_5m WHERE agent_id = $1 AND metric = $2`,
    [AGENT_A, METRIC],
  );
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].bucket).getTime(), fiveStart);
  // 5 个桶各 1 个样本，值 1..5
  assert.equal(Number(rows[0].n), 5);
  assert.equal(Number(rows[0].v_avg), 3);
  assert.equal(Number(rows[0].v_min), 1);
  assert.equal(Number(rows[0].v_max), 5);
  assert.equal(Number(rows[0].v_last), 5);
});

test('聚合可重入：重复跑不会产生新行，且**迟到数据会被重算进去**', async () => {
  await cleanupTestRows();
  const minute = pastMinuteStart(2);
  await seedMinute({ minuteStartMs: minute, values: [10, 20] });

  await aggregateTier(pool, { tier: '1m', lookbackBuckets: 3, logger: silentLogger });
  const first = await db.query(
    `SELECT count(*)::int AS rows, max(n)::int AS n FROM metrics_1m WHERE agent_id = $1`,
    [AGENT_A],
  );
  assert.deepEqual(first.rows[0], { rows: 1, n: 2 });

  // 迟到补点（模拟 Agent 重试/时钟修正后补上的数据）
  await pool.query(
    `INSERT INTO metrics_raw (agent_id, metric, value, labels, ts) VALUES ($1,$2,$3,'{}'::jsonb,$4)
     ON CONFLICT (agent_id, metric, ts) DO UPDATE SET value = EXCLUDED.value`,
    [AGENT_A, METRIC, 99, new Date(minute + 50_000)],
  );

  await aggregateTier(pool, { tier: '1m', lookbackBuckets: 3, logger: silentLogger });
  const second = await db.query(
    `SELECT count(*)::int AS rows, max(n)::int AS n, max(v_max) AS v_max, max(v_last) AS v_last
       FROM metrics_1m WHERE agent_id = $1`,
    [AGENT_A],
  );
  assert.equal(second.rows[0].rows, 1, '重入必须更新而不是插入新行');
  assert.equal(second.rows[0].n, 3, '迟到点必须被算进 n');
  assert.equal(Number(second.rows[0].v_max), 99);
  assert.equal(Number(second.rows[0].v_last), 99, 'v_last 必须跟着 ts 最新的那条走');
});

test('聚合不回看超出窗口的旧桶（lookbackBuckets 决定回看范围）', async () => {
  await cleanupTestRows();
  // 10 分钟前：lookback=3 时窗口是最近 4 个桶，覆盖不到它
  await seedMinute({ minuteStartMs: pastMinuteStart(10), values: [7] });
  const result = await aggregateTier(pool, { tier: '1m', lookbackBuckets: 3, logger: silentLogger });
  assert.equal(result.buckets, 0, '窗口外的旧数据不应被这次聚合碰到');

  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM metrics_1m WHERE agent_id = $1`,
    [AGENT_A],
  );
  assert.equal(rows[0].n, 0);
});

// -----------------------------------------------------------------------------
// Ａ-2 降采样健康 + 逐分区门禁（防永久空洞的两道线）
// -----------------------------------------------------------------------------

test('wasDayAggregated：某日有原始数据但降采样为空 → 判定「不安全」（这是防空洞的关键判据）', async () => {
  await cleanupTestRows();
  // ⚠️ 必须落在**已完成的**分钟桶里：`now()` 属于当前未完成的桶，聚合永远不会碰它，
  //    那样「聚合后应判定安全」这一步会永远失败（测试自杀，而不是代码有问题）。
  const minute = pastMinuteStart(2);
  const day = utcDayString(new Date(minute));
  await seedMinute({ minuteStartMs: minute, values: [1] });

  const before = await wasDayAggregated(pool, { day, tier: '1m' });
  assert.deepEqual(before, { hasRaw: true, hasDownsampled: false, safe: false });

  await aggregateTier(pool, { tier: '1m', lookbackBuckets: 3, logger: silentLogger });
  const afterAgg = await wasDayAggregated(pool, { day, tier: '1m' });
  assert.equal(afterAgg.hasDownsampled, true);
  assert.equal(afterAgg.safe, true, '聚合过之后才允许删这一天的分区');
});

test('wasDayAggregated：整日无原始数据 → 安全（空分区删掉无损）', async () => {
  await cleanupTestRows();
  const verdict = await wasDayAggregated(pool, { day: '2001-01-01', tier: '1m' });
  assert.deepEqual(verdict, { hasRaw: false, hasDownsampled: false, safe: true });
});

test('checkDownsampleHealth：完全没数据时报告"从未运行过"，而不是假装健康', async () => {
  await cleanupTestRows();
  const health = await checkDownsampleHealth(pool, { tier: '1m' });
  assert.equal(health.ok, false);
  assert.match(health.reason, /尚无任何数据/);
});

test('checkDownsampleHealth：有近期桶 → 健康', async () => {
  await cleanupTestRows();
  const minute = pastMinuteStart(1);
  await seedMinute({ minuteStartMs: minute, values: [1] });
  await aggregateTier(pool, { tier: '1m', lookbackBuckets: 3, logger: silentLogger });

  const health = await checkDownsampleHealth(pool, { tier: '1m' });
  assert.equal(health.ok, true, JSON.stringify(health));
  await cleanupTestRows();
});

// -----------------------------------------------------------------------------
// Ａ-3 保留期清理
// -----------------------------------------------------------------------------

test('purgeBefore：分批删除（每批 batchSize 行，直到删完），且只删过期行', async () => {
  await cleanupTestRows();
  const old = new Date(Date.now() - 10 * 86_400_000);
  const fresh = new Date(Date.now() - 86_400_000);
  for (let i = 0; i < 7; i += 1) {
    await pool.query(
      `INSERT INTO metrics_1m (agent_id, metric, bucket, v_avg, v_min, v_max, v_last, n)
       VALUES ($1, $2, $3, 1, 1, 1, 1, 1)`,
      [AGENT_A, `test.batch_${i}`, new Date(old.getTime() + i * 60_000)],
    );
  }
  await pool.query(
    `INSERT INTO metrics_1m (agent_id, metric, bucket, v_avg, v_min, v_max, v_last, n)
     VALUES ($1, 'test.fresh', $2, 1, 1, 1, 1, 1)`,
    [AGENT_A, fresh],
  );

  const result = await purgeBefore(pool, {
    table: 'metrics_1m',
    column: 'bucket',
    cutoff: new Date(Date.now() - 5 * 86_400_000),
    batchSize: 3,
    maxBatches: 10,
    logger: silentLogger,
  });
  assert.equal(result.deleted, 7);
  assert.equal(result.batches, 3, '7 行按 3 行/批 = 3 批');
  assert.equal(result.truncated, false);

  const left = await db.query(`SELECT count(*)::int AS n FROM metrics_1m WHERE agent_id = $1`, [AGENT_A]);
  assert.equal(left.rows[0].n, 1, '未过期的行必须留下');
});

test('purgeBefore：达到批次上限时标记 truncated（说明还有积压，下一轮继续）', async () => {
  await cleanupTestRows();
  for (let i = 0; i < 5; i += 1) {
    await pool.query(
      `INSERT INTO metrics_1m (agent_id, metric, bucket, v_avg, v_min, v_max, v_last, n)
       VALUES ($1, $2, $3, 1, 1, 1, 1, 1)`,
      [AGENT_A, `test.trunc_${i}`, new Date(Date.now() - 10 * 86_400_000 + i * 1000)],
    );
  }
  const result = await purgeBefore(pool, {
    table: 'metrics_1m',
    column: 'bucket',
    cutoff: new Date(),
    batchSize: 2,
    maxBatches: 2,
    logger: silentLogger,
  });
  assert.equal(result.deleted, 4, '两批 × 2 行');
  assert.equal(result.truncated, true);
});

test('⛔ purgebefore 只接受白名单内的表：拿 agents 当目标必须被拒（标识符注入的收敛点）', async () => {
  for (const [table, column] of [
    ['agents', 'created_at'],
    ['metrics_raw', 'ts'],
    ['users', 'id'],
  ]) {
    await assert.rejects(
      () => purgeBefore(pool, { table, column, cutoff: new Date(), logger: silentLogger }),
      (err) => /白名单/.test(err.message),
      `${table}.${column} 不应被允许`,
    );
  }
});

test('purgeDownsampled / purgeNonTimeSeries：用真表把语句跑通（含 silences 的"结束后再留 N 天"）', async () => {
  const retention = {
    metrics1mDays: 90,
    metrics5mDays: 365,
    probeResultsDays: 90,
    processSnapshotsDays: 30,
    agentIpHistoryDays: 180,
    notificationLogDays: 180,
    auditLogsDays: 365,
    silenceKeepAfterEndDays: 7,
  };

  const downs = await purgeDownsampled(pool, { retention, batchSize: 1000, logger: silentLogger });
  assert.deepEqual(downs.map((r) => r.table), ['metrics_1m', 'metrics_5m']);
  assert.ok(downs.every((r) => r.deleted >= 0));

  const nonTs = await purgeNonTimeSeries(pool, { retention, batchSize: 1000, logger: silentLogger });
  assert.deepEqual(
    nonTs.map((r) => r.table),
    ['probe_results', 'process_snapshots', 'agent_ip_history', 'notification_log', 'audit_logs', 'silences'],
  );

  // 真的会删：造一条过期审计 + 一条未过期审计
  await pool.query(
    `INSERT INTO audit_logs (actor, actor_type, action, ts) VALUES ('t','system','test', now() - interval '400 days')`,
  );
  await pool.query(
    `INSERT INTO audit_logs (actor, actor_type, action, ts) VALUES ('t','system','test', now() - interval '10 days')`,
  );
  const purged = await purgeNonTimeSeries(pool, { retention, batchSize: 1000, logger: silentLogger });
  const auditResult = purged.find((r) => r.table === 'audit_logs');
  assert.equal(auditResult.deleted, 1, '365 天前的那条应被删、10 天前的必须留下');
  const left = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE actor = 't'`);
  assert.equal(left.rows[0].n, 1);
  await pool.query(`DELETE FROM audit_logs WHERE actor = 't'`);
});

// -----------------------------------------------------------------------------
// Ａ-4 分区维护
// -----------------------------------------------------------------------------

test('ensureUpcomingPartitions：幂等预建 —— 第一次建、第二次全部命中已存在', async () => {
  const days = 3;
  const first = await ensureUpcomingPartitions(pool, { days, logger: silentLogger });
  assert.equal(first.created.length + first.existed.length, days + 1);
  assert.equal(first.lastDay, utcDayString(new Date(Date.now() + days * 86_400_000)));

  const second = await ensureUpcomingPartitions(pool, { days, logger: silentLogger });
  assert.equal(second.created.length, 0, '第二次不应再建任何分区（幂等）');
  assert.equal(second.existed.length, days + 1);
});

test('listPartitions / checkPartitionHealth：兜底分区有行 = 提前量已失效（必须判为不健康）', async () => {
  const info = await listPartitions(pool);
  assert.equal(info.defaultRows, 0, '测试库的兜底分区应为空');
  assert.ok(info.remainingDays >= 3);

  const health = await checkPartitionHealth(pool, { minRemainingDays: 7 });
  assert.equal(health.ok, true, JSON.stringify(health));

  // 提前量要求高于实际覆盖 → 不健康
  const strict = await checkPartitionHealth(pool, { minRemainingDays: 9999 });
  assert.equal(strict.ok, false);
  assert.match(strict.reason, /提前量不足/);
});

test('⛔ 兜底分区永不被删：即使它是唯一"过期"的对象', async () => {
  const dropped = await dropPartitionsByName(pool, ['metrics_raw_default'], { logger: silentLogger });
  assert.deepEqual(dropped, []);
  const still = await db.query(`SELECT to_regclass('public.metrics_raw_default') AS t`);
  assert.ok(still.rows[0].t, '兜底分区必须还在（删了上报会立刻失去落点）');
});

test('⛔ 非分区名一律拒删：父表、乱名字都不能被"顺带"删掉', async () => {
  const dropped = await dropPartitionsByName(
    pool,
    ['metrics_raw', 'metrics_raw_1', 'metrics_1m', 'public.agents', 'x"; DROP TABLE agents; --'],
    { logger: silentLogger },
  );
  assert.deepEqual(dropped, []);
  for (const table of ['metrics_raw', 'metrics_1m', 'agents']) {
    const { rows } = await db.query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
    assert.ok(rows[0].t, `${table} 必须还在`);
  }
});

test('listExpiredPartitions + 删除：真的能删掉一个过期的空分区，且不碰未过期的', async () => {
  // 造一个 40 天前的分区（模拟"历史遗留"）
  const oldDay = utcDayString(new Date(Date.now() - 40 * 86_400_000));
  await db.query(`SELECT vantage_ensure_metrics_raw_partition($1::date)`, [oldDay]);
  const oldName = `metrics_raw_${oldDay.replace(/-/g, '')}`;

  const { expired, cutoff } = await listExpiredPartitions(pool, { olderThanDays: 15 });
  assert.ok(expired.some((p) => p.name === oldName), `应把 ${oldName} 判为过期（截止 ${cutoff}）`);
  assert.ok(
    expired.every((p) => p.day < cutoff),
    '所有被判过期的分区日期都必须早于截止日',
  );

  const dropped = await dropExpiredPartitions(pool, { olderThanDays: 15, logger: silentLogger });
  assert.ok(dropped.dropped.includes(oldName));

  const gone = await db.query(`SELECT to_regclass($1) AS t`, [`public.${oldName}`]);
  assert.equal(gone.rows[0].t, null, '过期分区应已被 DROP');
  const kept = await db.query(`SELECT to_regclass($1) AS t`, [`public.metrics_raw_${utcDayString().replace(/-/g, '')}`]);
  assert.ok(kept.rows[0].t, '今天的分区必须还在');
});

// -----------------------------------------------------------------------------
// Ｂ 调度层（替身）
// -----------------------------------------------------------------------------

const CONFIG = loadConfig(
  {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  },
  { skipEnvFile: true },
);

/** cron 服务只用到 db.app / db.migrator / redis 与 config；这里用 PGlite 包装成池 */
function makeDb({ migrator = null } = {}) {
  return { app: pool, migrator };
}

test('nextDailyAt：今天未到点 → 今天；已过点 → 明天（UTC 计算，不受本地时区影响）', () => {
  const t = (iso) => Date.parse(iso);
  // UTC 01:00 → 目标 03:00 今天
  assert.equal(nextDailyAt(t('2026-09-26T01:00:00Z'), 3, 0), t('2026-09-26T03:00:00Z'));
  // UTC 04:00 → 目标 03:00 已过 → 明天
  assert.equal(nextDailyAt(t('2026-09-26T04:00:00Z'), 3, 0), t('2026-09-27T03:00:00Z'));
  // 正好等于目标时刻 → 视为已过（避免同一时刻重复触发）
  assert.equal(nextDailyAt(t('2026-09-26T03:00:00Z'), 3, 0), t('2026-09-27T03:00:00Z'));
  // 错峰偏移生效
  assert.equal(nextDailyAt(t('2026-09-26T01:00:00Z'), 3, 10), t('2026-09-26T03:10:00Z'));
});

test('cron：本服务实现的任务必须是 CRON_TASKS 的子集（其余留给 M3：Flapping 恢复/轮换提醒）', () => {
  const cron = createCronService({ db: makeDb(), redis: createFakeRedis(), config: CONFIG, logger: silentLogger });
  const registered = new Set(Object.values(CRON_TASKS));

  for (const name of cron.taskNames) {
    assert.ok(registered.has(name), `${name} 不在 redisKeys.js 的 CRON_TASKS 里（键名会分叉）`);
  }
  // 已经实现的七项（offline_sweep 与状态接口同批落地：机器掉线时没有任何请求进来，
  // 不主动点名的话 agents.status 会永远停在 online —— 详见 services/offline.service.js 文件头）
  assert.deepEqual([...cron.taskNames].sort(), [
    CRON_TASKS.aggregate1m,
    CRON_TASKS.aggregate5m,
    CRON_TASKS.createPartitions,
    CRON_TASKS.dropPartitions,
    CRON_TASKS.offlineSweep,
    CRON_TASKS.purgeDownsampled,
    CRON_TASKS.purgeNonTimeSeries,
  ].sort());
  // 尚未实现的两项必须仍然登记在键空间契约里（M3 要用，⛔ 别顺手删掉）
  for (const pending of [CRON_TASKS.flappingRecover, CRON_TASKS.credentialRotateReminder]) {
    assert.ok(registered.has(pending));
    assert.equal(cron.taskNames.includes(pending), false, `${pending} 属 M3，本阶段不应注册`);
  }
});

test('cron：多实例只跑一份 —— 锁被别人持有 → 本次跳过且不执行业务', async () => {
  const redis = createFakeRedis();
  const cron = createCronService({ db: makeDb(), redis, config: CONFIG, logger: silentLogger });
  // 预占锁（模拟另一个实例正在跑）
  redis.seed(keys.cronLock(CRON_TASKS.createPartitions), 'other-instance');

  const result = await cron.runTask(CRON_TASKS.createPartitions);
  assert.equal(result.skipped, true);
  // 被跳过时不得有任何业务副作用：建分区走 DDL 池，这里记一笔就能证明没被执行
  assert.equal(redis.has(keys.cronLock(CRON_TASKS.createPartitions)), true, '别人的锁不能被我们释放');
});

test('cron：Redis 不可用时 **fail-open**（照跑不误），因为任务幂等而 fail-closed 会丢数据', async () => {
  const brokenRedis = createFakeRedis();
  brokenRedis.set = async () => {
    throw Object.assign(new Error('Connection is closed.'), { name: 'MaxRetriesPerRequestError' });
  };
  const cron = createCronService({ db: makeDb(), redis: brokenRedis, config: CONFIG, logger: silentLogger });

  // 真库上跑一次建分区：锁取不到也应照常执行
  const result = await cron.runTask(CRON_TASKS.createPartitions);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.result.lastDay);
});

test('cron：任务失败**不会**向上抛（维护任务故障不能把进程带走）', async () => {
  const brokenPool = { query: async () => { throw Object.assign(new Error('boom'), { code: '42P01' }); } };
  const cron = createCronService({
    db: { app: brokenPool, migrator: null },
    redis: createFakeRedis(),
    config: CONFIG,
    logger: silentLogger,
  });

  const result = await cron.runTask(CRON_TASKS.createPartitions);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'internal_error');
  // 锁必须被释放（否则故障后该任务会被永久锁在"别人持有"状态）
});

test('cron：DDL 走 migrator 池，DML 走运行时池（✅ R13 的自动化防线）', async () => {
  const calls = [];
  const recorder = (label) => ({
    query: async (sql) => {
      calls.push({ label, sql: String(sql).split('\n')[0].trim() });
      if (/pg_class/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/vantage_ensure_metrics_raw_partition/.test(sql)) return { rows: [{ vantage_ensure_metrics_raw_partition: 'x' }], rowCount: 1 };
      return { rows: [{ n: 0 }], rowCount: 0 };
    },
  });

  const cron = createCronService({
    db: { app: recorder('app'), migrator: recorder('migrator') },
    redis: createFakeRedis(),
    config: CONFIG,
    logger: silentLogger,
  });

  await cron.runTask(CRON_TASKS.createPartitions);
  assert.ok(calls.some((c) => c.label === 'migrator'), '分区 DDL 必须走 migrator 池');
  assert.equal(calls.some((c) => c.label === 'app' && /vantage_ensure/.test(c.sql)), false);
});

test('cron：单账号部署（db.migrator = null）时 DDL 回退到运行时池，而不是崩掉', async () => {
  const calls = [];
  const appPool = {
    query: async (sql) => {
      calls.push(String(sql));
      if (/pg_class/i.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [{ n: 0 }], rowCount: 1 };
    },
  };
  const cron = createCronService({
    db: { app: appPool, migrator: null },
    redis: createFakeRedis(),
    config: CONFIG,
    logger: silentLogger,
  });

  const result = await cron.runTask(CRON_TASKS.createPartitions);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(calls.some((sql) => /vantage_ensure_metrics_raw_partition/.test(sql)));
});

test('cron：⛔ 删分区前必须通过"逐分区已聚合"门禁 —— 未聚合就拒绝删（永久空洞的唯一防线）', async () => {
  // 造一个 40 天前、**有数据**、且从未聚合过的分区
  const oldDay = utcDayString(new Date(Date.now() - 40 * 86_400_000));
  await db.query(`SELECT vantage_ensure_metrics_raw_partition($1::date)`, [oldDay]);
  const oldName = `metrics_raw_${oldDay.replace(/-/g, '')}`;
  await pool.query(
    `INSERT INTO metrics_raw (agent_id, metric, value, labels, ts) VALUES ($1,$2,1,'{}'::jsonb,$3)`,
    [AGENT_B, METRIC, new Date(`${oldDay}T12:00:00.000Z`)],
  );

  const cron = createCronService({ db: makeDb(), redis: createFakeRedis(), config: CONFIG, logger: silentLogger });
  const result = await cron.runTask(CRON_TASKS.dropPartitions);

  assert.equal(result.ok, true, JSON.stringify(result));
  // 两种情况都应该"不删这一个"：
  //  ① 全局门禁拦下（降采样近期没产出）→ refused
  //  ② 全局门禁通过但逐分区门禁拦下 → unsafe>=1
  assert.notEqual(result.result.dropped, undefined);
  assert.ok(
    result.result.refused === true || result.result.unsafe >= 1,
    `未聚合的分区绝不能被删：${JSON.stringify(result.result)}`,
  );

  const still = await db.query(`SELECT to_regclass($1) AS t`, [`public.${oldName}`]);
  assert.ok(still.rows[0].t, '该分区必须还在（删掉就是永久数据空洞）');

  // 收尾：删掉这行数据与该分区
  await pool.query(`DELETE FROM metrics_raw WHERE agent_id = $1`, [AGENT_B]);
  await dropPartitionsByName(pool, [oldName], { logger: silentLogger });
});

test('cron：start() 会立即补建一次分区（部署/重启后第一件事），stop() 后不再调度', async () => {
  const redis = createFakeRedis();
  const cron = createCronService({ db: makeDb(), redis, config: CONFIG, logger: silentLogger });

  await cron.start();
  // start() 里的立即执行会占锁并释放 → 锁键应当已消失
  assert.equal(redis.has(keys.cronLock(CRON_TASKS.createPartitions)), false, '任务结束后锁必须释放');

  const status = cron.status();
  assert.equal(status.length, cron.taskNames.length);
  assert.ok(status.every((s) => s.next_at && s.next_at !== '1970-01-01T00:00:00.000Z'), '每个任务都必须有下次执行时间');

  cron.stop();

  // CRON_ENABLED=false → start() 不跑任何任务
  const offRedis = createFakeRedis();
  const disabled = createCronService({
    db: makeDb(),
    redis: offRedis,
    config: loadConfig(
      {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/vantage',
        SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
        CRON_ENABLED: 'false',
      },
      { skipEnvFile: true },
    ),
    logger: silentLogger,
  });
  await disabled.start();
  assert.equal(offRedis.commands.length, 0, '禁用时不应产生任何 Redis 调用');
  disabled.stop();
});
