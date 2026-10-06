/**
 * Vantage · 定时任务服务（core 内置，单实例执行）
 *
 * 依据：docs/database.md §8.2（定时任务规格）、§8.1（保留期矩阵）、
 *       决策 #50（core 内置任务 + 分布式锁）、R13/R14/R15
 *
 * 本服务当前承担**七项**任务（前六项原计划放在 M3，因"分区提前量"有硬死线而提前，见 design-deltas）：
 *
 *   create_partitions      每日 + **每次启动**   预建未来 N 天 metrics_raw 分区（幂等）
 *   drop_partitions        每日                 删 ts 全部过期的整日分区（⛔ 有降采样健康门禁）
 *   aggregate_1m           每 60s               原始层 → metrics_1m（回看 N 桶）
 *   aggregate_5m           每 300s              原始层 → metrics_5m
 *   purge_downsampled      每日                 1m > 90d、5m > 1y 分批 DELETE
 *   purge_non_timeseries   每日                 探活/进程/IP 区间/通知/审计/静默 分批 DELETE
 *   offline_sweep          每 60s              超时未上报 → agents.status = 'offline'（⛔ 防抖：只 online→offline）
 *
 * ⚠️ `offline_sweep` **不是可选的优化项**：上报路径是请求驱动的，机器断电时没有任何请求进来，
 *    `agents.status` 会永远停在 `online`（= 死了三天的机器在面板上仍是绿的）。
 *    详见 services/offline.service.js 的文件头。
 *
 * 三条不可动摇的工程规则
 *  1. **DDL 走 migrator 池，DML 走运行时池**（✅ R13）。
 *     单账号部署下 `db.migrator` 是 `null` → 统一走 `db.migrator ?? db.app`（已确认的部署事实）。
 *  2. **删原始分区前必须先证明降采样是活的**。否则会出现"原始数据删了、降采样没写进去"的
 *     **永久数据空洞**（docs/database.md §8.2 的 ➕ 建议明确点名）。
 *  3. **任务失败永不让进程崩**，只记 error 日志（M3 会把它接进告警）。
 *     维护任务故障的后果是"悄悄积累"，不是"立刻不可用"，所以绝不能因此重启服务。
 *
 * 🔑 锁的取舍：取不到锁就**跳过**（多实例时只跑一份）；但如果是 **Redis 本身不可用**导致取不到，
 *    **照跑不误**（fail-open）—— 因为所有任务都是幂等的，最坏情况是多跑一遍；
 *    而 fail-closed 的最坏情况是"分区永远建不出来 → 23514 → 丢数据"，两者代价完全不对称。
 */

import os from 'node:os';

import { AppError, normalizeError } from '../utils/errors.js';
import { CHANNEL, CRON_TASKS, keys } from '../utils/redisKeys.js';
import { publish } from '../db/redis.js';
import { checkDownsampleHealth, aggregateTier, wasDayAggregated } from './downsample.service.js';
import { markStaleAgentsOffline, offlineThresholdS } from './offline.service.js';
import {
  checkPartitionHealth,
  dropPartitionsByName,
  ensureUpcomingPartitions,
  listExpiredPartitions,
} from './partition.service.js';
import { purgeDownsampled, purgeNonTimeSeries } from './retention.service.js';

/** 安全释放锁：只有持有者本人才能删（避免超时后误删别人的锁） */
const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** 每日任务的错峰偏移（分钟）：避免四个重任务在同一秒一起压库 */
const DAILY_OFFSETS_MIN = Object.freeze({
  [CRON_TASKS.createPartitions]: 0,
  [CRON_TASKS.dropPartitions]: 10,
  [CRON_TASKS.purgeDownsampled]: 20,
  [CRON_TASKS.purgeNonTimeSeries]: 30,
});

/** 计算"下一个 UTC 时:分"的时间戳 */
export function nextDailyAt(fromMs, utcHour, offsetMin) {
  const d = new Date(fromMs);
  const todayTarget = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    utcHour,
    offsetMin,
    0,
    0,
  );
  return todayTarget > fromMs ? todayTarget : todayTarget + 86_400_000;
}

/**
 * 创建定时任务服务。
 * ⚠️ 本函数**不启动任何定时器**（`start()` 才启动）：便于测试直接调用单个任务，
 *    也让 `buildApp()` 保持"只装配 HTTP、不产生后台副作用"。
 *
 * @param {object} deps
 * @param {{ app: import('pg').Pool, migrator?: import('pg').Pool|null }} deps.db
 * @param {import('ioredis').Redis} deps.redis
 * @param {object} deps.config
 * @param {object} deps.logger
 */
export function createCronService({ db, redis, config, logger }) {
  /** ⛔ R13：DDL 只允许走这个池；单账号部署下回退到运行时池 */
  const ddlPool = db.migrator ?? db.app;
  const lockTtlS = config.cron.lockTtlS;
  const instanceId = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

  /** 任务定义：intervalMs 与 daily 二选一 */
  const tasks = [
    {
      name: CRON_TASKS.createPartitions,
      daily: true,
      run: async () => {
        const result = await ensureUpcomingPartitions(ddlPool, {
          days: config.retention.partitionPreCreateDays,
          logger,
        });
        const health = await checkPartitionHealth(ddlPool, {
          minRemainingDays: config.cron.partitionMinRemainingDays,
        });
        if (!health.ok) {
          // 提前量不足或兜底分区已有数据 —— 这两种都属于"已经在丢分区结构"的状态，必须喊出来
          logger.error({ health }, '⚠️ 分区提前量异常（兜底分区有数据 = 某些日期已无法事后补建）');
        }
        return { created: result.created.length, existed: result.existed.length, lastDay: result.lastDay };
      },
    },
    {
      name: CRON_TASKS.dropPartitions,
      daily: true,
      run: async () => {
        // ---- ① 先只"列"出该删的（避免新库上因为"降采样还没数据"而永远拒绝删） ----
        const { expired, cutoff } = await listExpiredPartitions(ddlPool, {
          olderThanDays: config.retention.metricsRawDays,
        });
        if (expired.length === 0) return { dropped: 0, cutoff };

        // ---- ② 全局门禁：降采样任务最近是否还活着（证明"机制在跑"） ----
        // ⚠️ 容差按"时间"给而不是按桶数：1m 档容忍 15 分钟、5m 档容忍 60 分钟的空档，
        //    这样服务重启/短时抖动不会把"删分区"永久卡死；真正的安全性交给 ③。
        const [h1m, h5m] = await Promise.all([
          checkDownsampleHealth(db.app, { tier: '1m', toleranceBuckets: 15 }),
          checkDownsampleHealth(db.app, { tier: '5m', toleranceBuckets: 12 }),
        ]);
        const unhealthy = [h1m, h5m].filter((h) => !h.ok);
        if (unhealthy.length > 0) {
          const reason = unhealthy.map((h) => h.reason ?? '未知原因').join('；');
          logger.error(
            { wouldDrop: expired.length, cutoff, reason },
            '⛔ 拒绝删除过期原始分区：降采样任务近期没有产出（请先修复聚合，docs/database.md §8.2）',
          );
          return { dropped: 0, refused: true, reason };
        }

        // ---- ③ 逐分区门禁（**真正**的安全线）：这一天的原始数据必须已经被聚合走 ----
        // 全局健康检查证明不了这件事：聚合坏 20 天后刚修好时，
        // 最近桶是有的（②通过），但 15–20 天前那几天从没被聚合 —— 删掉就是永久空洞。
        //
        // ⛔ 刻意**不用** `partition.rows`（reltuples 估算值）做"空分区快速通道"：
        //    刚写入的分区在 autovacuum/ANALYZE 之前 reltuples 仍是 0/-1，
        //    拿它当"没数据"会把**有数据的**分区直接删掉 = 静默丢数据。
        //    `wasDayAggregated` 内部用 `EXISTS` 精确判断（有分区裁剪 + BRIN，代价很小），
        //    空分区在那里自然得到 safe=true。
        const unsafe = [];
        const safe = [];
        for (const partition of expired) {
          const verdict = await wasDayAggregated(db.app, { day: partition.day, tier: '1m' });
          if (verdict.safe) safe.push(partition);
          else unsafe.push({ name: partition.name, day: partition.day, rawEstimate: partition.rows });
        }

        if (unsafe.length > 0) {
          logger.error(
            { unsafe: unsafe.map((p) => p.name) },
            '⛔ 拒绝删除这些过期分区：该日有原始数据但降采样层一行都没有（删除会造成永久数据空洞）',
          );
        }
        if (safe.length === 0) return { dropped: 0, refused: unsafe.length > 0, unsafe: unsafe.length };

        const dropped = await dropPartitionsByName(ddlPool, safe.map((p) => p.name), { logger });
        return { dropped: dropped.length, cutoff, unsafe: unsafe.length };
      },
    },
    {
      name: CRON_TASKS.aggregate1m,
      intervalMs: config.cron.aggregate1mIntervalS * 1000,
      run: () =>
        aggregateTier(db.app, {
          tier: '1m',
          lookbackBuckets: config.cron.lookbackBuckets,
          logger,
        }),
    },
    {
      name: CRON_TASKS.aggregate5m,
      intervalMs: config.cron.aggregate5mIntervalS * 1000,
      run: () =>
        aggregateTier(db.app, {
          tier: '5m',
          lookbackBuckets: config.cron.lookbackBuckets,
          logger,
        }),
    },
    {
      name: CRON_TASKS.purgeDownsampled,
      daily: true,
      run: () =>
        purgeDownsampled(db.app, {
          retention: config.retention,
          batchSize: config.retention.deleteBatchSize,
          maxBatches: config.cron.maxPurgeBatches,
          logger,
        }),
    },
    {
      name: CRON_TASKS.purgeNonTimeSeries,
      daily: true,
      run: () =>
        purgeNonTimeSeries(db.app, {
          retention: config.retention,
          batchSize: config.retention.deleteBatchSize,
          maxBatches: config.cron.maxPurgeBatches,
          logger,
        }),
    },
    {
      /**
       * 离线判定（「点名」）：把超时未上报的主机置为 `offline`。
       *
       * 频率取自 `config.heartbeat.sweepIntervalS`（默认 60s，docs/database.md §8.2 的口径）
       * —— 这个配置项本来就是为它存在的，⛔ 不要另加一个 env。
       *
       * 为什么要**广播**：`services/ingest.service.js` 的 `publishDeltas()` 里那条
       * 「`offline/从未上报 → online` 才广播」的逻辑，其存在的唯一意义就是给浏览器补发
       * 「恢复」增量；如果离线这件事从不广播，那么「离线 → 恢复」这个**状态对**永远不完整：
       * 前端只能自己轮询才发现某台机器掉线了。两者共用同一频道（`live:metrics`）与同一
       * 消息形状（docs/api.md §5.2 的 `delta`），原因是 M3 的 WS 层要**原样转发**，不翻译第二遍。
       */
      name: CRON_TASKS.offlineSweep,
      intervalMs: config.heartbeat.sweepIntervalS * 1000,
      run: async () => {
        const thresholdS = offlineThresholdS(config);
        const { changed } = await markStaleAgentsOffline(db.app, { thresholdS, logger });

        // ⛔ 扇出失败绝不能让「离线判定」这个任务算失败：状态已经落库了，
        //    重跑也不会再返回值（幂等），失败只影响实时推送、下次刷新页面即自愈。
        if (changed.length > 0) {
          await publishOfflineDeltas(changed).catch((err) => {
            logger.warn({ err, count: changed.length }, 'status:offline 扇出失败（状态已入库，不影响判定）');
          });
        }

        return { offline: changed.length, thresholdS, agents: changed.map((c) => c.name) };
      },
    },
  ];

  const byName = new Map(tasks.map((task) => [task.name, task]));

  /**
   * 把「刚刚掉线」的主机扇出给实时层（与 `ingest.service.js` 的 `publishDeltas` 同频道同形状）。
   *
   * ⚠️ `ts` 用**当前时刻**（= 判定/广播时刻），而不是 `last_seen_at`（= 该机最后一次上报，可能已过去几小时）。
   *    前端拿 `ts` 当"这条增量的发生时间"，拿 `last_seen_at` 当"最后在线于何时"展示 —— 两者语义不同，
   *    混用会让面板显示"最后上报时间 = 刚刚"（在机器已经离线三天时尤其离谱）。
   * ⚠️ `last_seen_at` 为该机最后一次上报时间；`last_seen_at IS NULL`（从未上报过）时**不发这个字段**，
   *    与 `ingest.service.js` 在 status 增量里总是带 `last_seen_at: serverTs.toISOString()` 的形状保持一致。
   * @param {Array<{ agentId: string, name: string, lastSeenAt: Date|null }>} changed
   */
  async function publishOfflineDeltas(changed) {
    const ts = Date.now();
    const commands = changed.map((item) => [
      CHANNEL.liveMetrics,
      JSON.stringify({
        type: 'delta',
        ts,
        channel: 'status',
        agent_id: item.agentId,
        status: 'offline',
        ...(item.lastSeenAt ? { last_seen_at: new Date(item.lastSeenAt).toISOString() } : {}),
      }),
    ]);
    await publish(redis, commands);
    logger.debug({ count: commands.length }, 'status:offline 已扇出');
  }

  // --- 调度状态 -------------------------------------------------------------
  let timer = null;
  let running = false;
  /** 每个任务的统计（供 /readyz 或排障打印；⛔ 不入库） */
  const stats = new Map();

  function schedule(task, fromMs) {
    if (task.daily) {
      task.nextAt = nextDailyAt(fromMs, config.cron.dailyUtcHour, DAILY_OFFSETS_MIN[task.name] ?? 0);
    } else {
      task.nextAt = fromMs + task.intervalMs;
    }
  }

  /** 取执行权：多实例只跑一份；Redis 挂了则放行（fail-open，理由见文件头） */
  async function acquire(taskName) {
    const key = keys.cronLock(taskName);
    const token = `${instanceId}:${Date.now()}`;
    try {
      const claimed = await redis.set(key, token, 'EX', lockTtlS, 'NX');
      if (claimed === null) return { acquired: false, reason: 'held_by_other' };
      return { acquired: true, key, token };
    } catch (err) {
      logger.warn(
        { err, task: taskName },
        '⛔ Redis 不可用：本次跳过分布式锁直接执行（所有任务幂等，多实例最坏只是重复跑一遍）',
      );
      return { acquired: true, key: null, token: null };
    }
  }

  async function release(claim) {
    if (!claim.key) return;
    try {
      await redis.eval(RELEASE_LOCK_LUA, 1, claim.key, claim.token);
    } catch (err) {
      logger.warn({ err }, '释放 cron 锁失败（锁会按 TTL 自动过期）');
    }
  }

  /**
   * 执行一个任务（带锁 + 全量异常兜底）。
   * 供调度器与测试/运维手动触发共用。
   */
  async function runTask(name, { force = false, now = Date.now() } = {}) {
    const task = byName.get(name);
    if (!task) throw new AppError('invalid_request', { message: `未知定时任务：${name}` });

    const claim = await acquire(name);
    if (!claim.acquired) {
      logger.debug({ task: name }, '定时任务被其它实例持有，跳过');
      return { task: name, skipped: true };
    }

    const started = Date.now();
    try {
      const result = await task.run();
      const ms = Date.now() - started;
      stats.set(name, { at: new Date(now).toISOString(), ms, ok: true });
      logger.info({ task: name, ms, result }, '定时任务完成');
      return { task: name, ok: true, ms, result };
    } catch (err) {
      const ms = Date.now() - started;
      const appErr = normalizeError(err, { logger });
      stats.set(name, { at: new Date(now).toISOString(), ms, ok: false, error: appErr.code });
      // ⛔ 只记日志，绝不向上抛：维护任务失败不能让进程崩（M3 会接进告警）
      logger.error(
        { err, task: name, ms, code: appErr.code },
        '⛔ 定时任务失败（已记录；维护任务故障会静默积累，请尽快排查）',
      );
      return { task: name, ok: false, ms, error: appErr.code };
    } finally {
      await release(claim);
    }
  }

  async function tick() {
    for (const task of tasks) {
      if (task.nextAt > Date.now()) continue;
      // 先推进下次时间再执行：任务失败也不会卡在"永远到期"的死循环
      schedule(task, Date.now());
      await runTask(task.name);
    }
  }

  function loop() {
    timer = setTimeout(async () => {
      try {
        if (running) await tick();
      } catch (err) {
        // tick 自身出问题（不该发生，因为 runTask 已兜底）——记下来，继续下一轮
        logger.error({ err }, '定时任务调度循环异常');
      } finally {
        if (running) loop();
      }
    }, 1000);
    // unref：不阻止进程退出（优雅关闭时不会被这个定时器挂住）
    timer.unref?.();
  }

  return {
    /** 任务名清单（测试/运维用） */
    taskNames: tasks.map((task) => task.name),
    /** 当前调度状态（⛔ 仅供日志/排障） */
    status() {
      return tasks.map((task) => ({
        name: task.name,
        next_at: new Date(task.nextAt ?? 0).toISOString(),
        ...(stats.get(task.name) ?? {}),
      }));
    },
    runTask,

    /**
     * 启动调度：立即补建一次分区，然后按计划循环。
     * ⚠️ 立即补建是**故意的**：部署/重启后第一件事就是把提前量补回来，
     *    否则"服务停了 8 天再启动"就会直接踩到兜底分区。
     */
    async start() {
      if (running) return;
      const nowMs = Date.now();
      for (const task of tasks) schedule(task, nowMs);

      if (!config.cron.enabled) {
        logger.warn('CRON_ENABLED=false：定时任务未启动（分区预建/降采样/保留期清理全部不会执行）');
        return;
      }

      running = true;
      // 启动时先跑一次"建分区"，把提前量补回来；其余任务等各自的计划时间
      await runTask(CRON_TASKS.createPartitions);
      loop();
      logger.info(
        { instance: instanceId, tasks: tasks.length, dailyUtcHour: config.cron.dailyUtcHour },
        '定时任务已启动',
      );
    },

    /** 停止调度（优雅关闭时调用；正在执行的任务会先跑完） */
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      logger.info('定时任务已停止');
    },
  };
}
