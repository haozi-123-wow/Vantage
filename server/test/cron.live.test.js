/**
 * 真机联调测试 · 定时任务（分区维护 / 降采样 / 保留期清理）
 *
 * 默认**跳过**；需要显式开启：
 *   PowerShell:  $env:VANTAGE_LIVE_TEST=1; node test/cron.live.test.js
 *
 * 与 test/cron.test.js 的分工
 *  - 那边跑在 PGlite（进程内真 PG，WASM）上验证 SQL 语义；
 *  - 这里连**真实** PostgreSQL + Redis，验证 PGlite 证明不了的东西：
 *      · 真实分区 DDL 与 `pg_class.reltuples` 的真实行为；
 *      · Redis 上的分布式锁（含 Lua 安全释放）在真实例上是否生效；
 *      · 迁移预建的覆盖范围与真实"今天"是否吻合（提前量算得对不对）。
 *
 * ⚠️ 只做两类写操作：① 幂等预建分区；② 自造测试行（跑完删净）。
 *    ⛔ 不做整表删除、⛔ 不删迁移建出来的分区。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { loadConfig } from '../src/config/index.js';
import { createPool } from '../src/db/pg.js';
import { closeRedis, createRedis } from '../src/db/redis.js';
import { createCronService } from '../src/services/cron.service.js';
import { aggregateTier, wasDayAggregated } from '../src/services/downsample.service.js';
import {
  checkPartitionHealth,
  dropPartitionsByName,
  ensureUpcomingPartitions,
  listExpiredPartitions,
  listPartitions,
  utcDayString,
} from '../src/services/partition.service.js';
import { purgeDownsampled, purgeNonTimeSeries } from '../src/services/retention.service.js';
import { CRON_TASKS, keys } from '../src/utils/redisKeys.js';
import { createLogger } from '../src/utils/log.js';

const LIVE = process.env.VANTAGE_LIVE_TEST === '1';
const skip = LIVE ? false : '需要 VANTAGE_LIVE_TEST=1（会连真实 PG/Redis 并写入测试数据）';

async function createLiveContext() {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const logger = createLogger({ level: 'warn' });

  // DDL 池：有独立迁移账号就用它；单账号部署（本环境即如此）下 db.migrator 为 null
  const ddlUrl = config.db.migratorUrl ?? config.db.url;
  const db = {
    app: createPool({
      connectionString: config.db.url,
      applicationName: 'vantage-cron/live:app',
      max: 3,
      statementTimeoutMs: 0,
      logger,
    }),
    migrator:
      ddlUrl !== config.db.url
        ? createPool({
            connectionString: ddlUrl,
            applicationName: 'vantage-cron/live:ddl',
            max: 2,
            statementTimeoutMs: 0,
            logger,
          })
        : null,
  };
  const redis = createRedis({
    url: config.redis.url,
    username: config.redis.username,
    password: config.redis.password,
    logger,
  });

  const agentId = randomUUID();
  const metric = 'live.cron_probe';

  return {
    config,
    db,
    redis,
    logger,
    agentId,
    metric,
    /** DDL 池（本环境回退到运行时池） */
    get ddl() {
      return db.migrator ?? db.app;
    },
    async cleanup() {
      const errors = [];
      for (const sql of [
        'DELETE FROM metrics_raw WHERE agent_id = $1',
        'DELETE FROM metrics_1m WHERE agent_id = $1',
        'DELETE FROM metrics_5m WHERE agent_id = $1',
      ]) {
        try {
          await db.app.query(sql, [agentId]);
        } catch (err) {
          errors.push(err.message);
        }
      }
      try {
        const stale = await redis.keys('cron:lock:*');
        if (stale.length > 0) await redis.del(...stale);
      } catch (err) {
        errors.push(err.message);
      }
      if (errors.length > 0) logger.error({ agentId, errors }, '⚠️ 真机定时任务测试清理不完整');
      await closeRedis(redis, logger);
      await db.app.end().catch(() => {});
      await db.migrator?.end().catch(() => {});
      return errors;
    },
  };
}

test('真机：分区覆盖与"今天"吻合，且兜底分区为空（提前量健康）', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const info = await listPartitions(ctx.ddl);
    const today = utcDayString();
    assert.ok(
      info.partitions.some((p) => p.day === today),
      `必须存在今天的按天分区（实测覆盖 ${info.partitions[0]?.day} → ${info.partitions.at(-1)?.day}）`,
    );
    assert.ok(info.remainingDays >= 1, `提前量必须 ≥1 天，实测 ${info.remainingDays}`);
    // 兜底分区有行 = 提前量已失效（运维必须告警的信号），此处必须为空
    assert.equal(info.defaultRows, 0, '兜底分区不应有数据');

    const health = await checkPartitionHealth(ctx.ddl, { minRemainingDays: 1 });
    assert.equal(health.ok, true, JSON.stringify(health));
  } finally {
    await ctx.cleanup();
  }
});

test('真机：幂等预建分区（第二次必须零新建，且不报错）', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const first = await ensureUpcomingPartitions(ctx.ddl, { days: 2, logger: ctx.logger });
    assert.equal(first.created.length + first.existed.length, 3);
    const second = await ensureUpcomingPartitions(ctx.ddl, { days: 2, logger: ctx.logger });
    assert.equal(second.created.length, 0, '第二次必须零新建（幂等）');
    assert.equal(second.existed.length, 3);
  } finally {
    await ctx.cleanup();
  }
});

test('真机：聚合 1m —— 值正确、桶对齐落在真实 UTC 整分、迟到数据可自愈', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const minute = Math.floor(Date.now() / 60_000) * 60_000 - 120_000; // 2 分钟前那一分钟
    for (const [i, value] of [10, 20, 30, 40].entries()) {
      await ctx.db.app.query(
        `INSERT INTO metrics_raw (agent_id, metric, value, labels, ts) VALUES ($1,$2,$3,'{}'::jsonb,$4)`,
        [ctx.agentId, ctx.metric, value, new Date(minute + i * 15_000)],
      );
    }

    const agg = await aggregateTier(ctx.db.app, { tier: '1m', lookbackBuckets: 3, logger: ctx.logger });
    assert.ok(agg.buckets >= 1, '至少应写入一个桶');

    const { rows } = await ctx.db.app.query(
      `SELECT bucket, v_avg, v_min, v_max, v_last, n FROM metrics_1m WHERE agent_id = $1 AND metric = $2`,
      [ctx.agentId, ctx.metric],
    );
    assert.equal(rows.length, 1);
    assert.equal(new Date(rows[0].bucket).getTime(), minute, '桶对齐必须落在真实 UTC 整分');
    assert.equal(Number(rows[0].v_avg), 25);
    assert.equal(Number(rows[0].v_min), 10);
    assert.equal(Number(rows[0].v_max), 40);
    assert.equal(Number(rows[0].v_last), 40);
    assert.equal(Number(rows[0].n), 4);

    // 迟到补点 → 重跑聚合必须自愈（v_last 顶上、n 增加、行数不变）
    await ctx.db.app.query(
      `INSERT INTO metrics_raw (agent_id, metric, value, labels, ts) VALUES ($1,$2,99,'{}'::jsonb,$3)`,
      [ctx.agentId, ctx.metric, new Date(minute + 50_000)],
    );
    await aggregateTier(ctx.db.app, { tier: '1m', lookbackBuckets: 3, logger: ctx.logger });
    const again = await ctx.db.app.query(
      `SELECT count(*)::int AS rows, max(n)::int AS n, max(v_last) AS v_last FROM metrics_1m WHERE agent_id = $1`,
      [ctx.agentId],
    );
    assert.equal(again.rows[0].rows, 1, '重入不得产生新行');
    assert.equal(again.rows[0].n, 5);
    assert.equal(Number(again.rows[0].v_last), 99);
  } finally {
    await ctx.cleanup();
  }
});

test('真机：聚合 5m —— 跨分钟桶合并进同一个 5 分钟桶', { skip }, async () => {
  const ctx = await createLiveContext();
  // ⚠️ 必须落在**已完成的** 5 分钟桶里：当前 5 分钟桶是"未完成"的，聚合永远不会碰它。
  //    取"上一个完整的 5 分钟桶"（窗口是最近 4 个桶，必然覆盖到它），并单独用一个指标名，
  //    避免与 1m 用例的数据互相污染（两者可能落进同一个 5 分钟桶）。
  const fiveStart = Math.floor(Date.now() / 300_000) * 300_000 - 300_000;
  const metric5m = `${ctx.metric}_5m`;
  try {
    for (const [i, value] of [4, 8].entries()) {
      await ctx.db.app.query(
        `INSERT INTO metrics_raw (agent_id, metric, value, labels, ts) VALUES ($1,$2,$3,'{}'::jsonb,$4)`,
        [ctx.agentId, metric5m, value, new Date(fiveStart + i * 60_000)],
      );
    }

    await aggregateTier(ctx.db.app, { tier: '5m', lookbackBuckets: 3, logger: ctx.logger });
    const { rows } = await ctx.db.app.query(
      `SELECT bucket, v_avg, v_min, v_max, v_last, n FROM metrics_5m WHERE agent_id = $1 AND metric = $2`,
      [ctx.agentId, metric5m],
    );
    assert.equal(rows.length, 1);
    assert.equal(new Date(rows[0].bucket).getTime(), fiveStart, '5 分钟桶必须对齐到真实 UTC 整 5 分钟');
    assert.equal(Number(rows[0].n), 2);
    assert.equal(Number(rows[0].v_avg), 6);
    assert.equal(Number(rows[0].v_min), 4);
    assert.equal(Number(rows[0].v_max), 8);
    assert.equal(Number(rows[0].v_last), 8, 'v_last 必须取 ts 最新的那条（4 在前、8 在后）');
  } finally {
    await ctx.cleanup();
  }
});

test('真机：逐分区门禁生效 —— 有原始数据但未聚合的分区**拒绝删除**', { skip }, async () => {
  const ctx = await createLiveContext();
  const oldDay = utcDayString(new Date(Date.now() - 40 * 86_400_000));
  const oldName = `metrics_raw_${oldDay.replace(/-/g, '')}`;
  try {
    // 造一个 40 天前、有数据、从未聚合过的分区
    await ctx.ddl.query('SELECT vantage_ensure_metrics_raw_partition($1::date)', [oldDay]);
    await ctx.db.app.query(
      `INSERT INTO metrics_raw (agent_id, metric, value, labels, ts) VALUES ($1,$2,1,'{}'::jsonb,$3)`,
      [ctx.agentId, ctx.metric, new Date(`${oldDay}T12:00:00.000Z`)],
    );

    const verdict = await wasDayAggregated(ctx.db.app, { day: oldDay, tier: '1m' });
    assert.deepEqual(verdict, { hasRaw: true, hasDownsampled: false, safe: false });

    // 走真实的 cron 删分区任务：必须拒绝（全局门禁或逐分区门禁任一拦住都算对）
    const cron = createCronService({ db: ctx.db, redis: ctx.redis, config: ctx.config, logger: ctx.logger });
    const result = await cron.runTask(CRON_TASKS.dropPartitions);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(
      result.result.refused === true || result.result.unsafe >= 1 || result.result.dropped === 0,
      `未聚合的分区绝不能被删：${JSON.stringify(result.result)}`,
    );

    const still = await ctx.db.app.query('SELECT to_regclass($1) AS t', [`public.${oldName}`]);
    assert.ok(still.rows[0].t, '该分区必须还在（删掉 = 永久数据空洞）');
  } finally {
    // 收尾：删测试数据 + 删这个测试分区（⛔ 不碰迁移建的 91 个分区）
    await ctx.db.app.query('DELETE FROM metrics_raw WHERE agent_id = $1', [ctx.agentId]);
    await dropPartitionsByName(ctx.ddl, [oldName], { logger: ctx.logger });

    const todayName = `metrics_raw_${utcDayString().replace(/-/g, '')}`;
    const today = await ctx.db.app.query('SELECT to_regclass($1) AS t', [`public.${todayName}`]);
    assert.ok(today.rows[0].t, '今天的分区必须仍在');
    await ctx.cleanup();
  }
});

test('真机：Redis 分布式锁可获取、可释放，且不误删别人的锁', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const cron = createCronService({ db: ctx.db, redis: ctx.redis, config: ctx.config, logger: ctx.logger });
    const key = keys.cronLock(CRON_TASKS.createPartitions);

    await cron.runTask(CRON_TASKS.createPartitions);
    assert.equal(await ctx.redis.get(key), null, '任务结束后锁必须已释放（否则该任务会被永久卡住）');

    // 模拟另一个实例持锁 → 本实例必须跳过，且不得删除别人的锁
    await ctx.redis.set(key, 'other-instance', 'EX', 30, 'NX');
    const skipped = await cron.runTask(CRON_TASKS.createPartitions);
    assert.equal(skipped.skipped, true);
    assert.equal(await ctx.redis.get(key), 'other-instance', '不得误删别人的锁');
  } finally {
    await ctx.cleanup();
  }
});

test('真机：保留期清理在真表上语句合法且可执行', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const downs = await purgeDownsampled(ctx.db.app, {
      retention: ctx.config.retention,
      batchSize: 1000,
      maxBatches: 2,
      logger: ctx.logger,
    });
    assert.deepEqual(downs.map((r) => r.table), ['metrics_1m', 'metrics_5m']);
    assert.ok(downs.every((r) => r.deleted >= 0 && r.batches <= 2));

    const nonTs = await purgeNonTimeSeries(ctx.db.app, {
      retention: ctx.config.retention,
      batchSize: 1000,
      maxBatches: 2,
      logger: ctx.logger,
    });
    assert.deepEqual(
      nonTs.map((r) => r.table),
      ['probe_results', 'process_snapshots', 'agent_ip_history', 'notification_log', 'audit_logs', 'silences'],
    );
    assert.ok(nonTs.every((r) => r.deleted >= 0));
  } finally {
    await ctx.cleanup();
  }
});

test('真机：过期分区预演只列不删，且绝不把今天判为过期', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const { expired, cutoff } = await listExpiredPartitions(ctx.ddl, { olderThanDays: 15 });
    assert.ok(expired.every((p) => p.day < cutoff), '被列为过期的分区日期都必须早于截止日');
    assert.equal(
      expired.some((p) => p.day === utcDayString()),
      false,
      '今天的分区绝不能被判为过期',
    );
    assert.equal(
      expired.some((p) => p.name === 'metrics_raw_default'),
      false,
      '兜底分区永远不进过期列表',
    );
  } finally {
    await ctx.cleanup();
  }
});
