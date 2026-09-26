/**
 * Vantage · vantage-core 启动入口
 *
 * 职责：加载配置 → 建日志 → 连接 PG/Redis → 启动自检 → 装配并监听 → 优雅退出。
 *
 * 启动自检的取舍（故意「快速失败」）
 *  - PG 不可用 → **直接退出**：中心没有数据库时每个请求都会 503，早退比半死不活好排障；
 *  - Redis `maxmemory-policy` ≠ noeviction → **只告警不退出**：它能跑，但 nonce/幂等防护会失效（✅ R15），
 *    这种「静默降级」必须喊出来，却不该阻断上线（托管 Redis 常禁用 CONFIG）；
 *  - 运行时连接是超级用户 → **告警**：DDL 权限不应落在常规请求路径上（✅ R13）；
 *  - 存在未应用的迁移 → **告警**并提示 `npm run migrate`。
 */

import fs from 'node:fs';
import path from 'node:path';

import { SERVICE_NAME, SERVICE_VERSION, buildApp, closeApp } from './app.js';
import { SERVER_ROOT, getConfig, redactUrl } from './config/index.js';
import { assertNoDdlPrivilege, createPool, query, serverInfo } from './db/pg.js';
import { checkEvictionPolicy, createRedis, stats as redisStats } from './db/redis.js';
import { createCronService } from './services/cron.service.js';
import { createLogger } from './utils/log.js';

async function main() {
  const config = getConfig();
  const logger = createLogger({
    level: config.log.level,
    name: SERVICE_NAME,
    base: { env: config.nodeEnv, version: SERVICE_VERSION },
  });

  logger.info(
    {
      nodeEnv: config.nodeEnv,
      pg: redactUrl(config.db.url),
      redis: redactUrl(config.redis.url),
      listen: `${config.http.host}:${config.http.port}`,
      trustProxy: config.http.trustProxy,
    },
    `${SERVICE_NAME} ${SERVICE_VERSION} 启动中`,
  );

  // --- 连接与启动自检 --------------------------------------------------------
  const db = {
    app: createPool({
      connectionString: config.db.url,
      applicationName: `${SERVICE_NAME}/app`,
      max: config.db.poolMax,
      idleTimeoutMs: config.db.idleTimeoutMs,
      connectionTimeoutMs: config.db.connectionTimeoutMs,
      statementTimeoutMs: config.db.statementTimeoutMs,
      maxUses: config.db.maxUses,
      logger,
    }),
    // 仅当配置了独立的 migrator 连接时才建第二个池（✅ R13：DDL 与运行时隔离）
    migrator:
      config.db.migratorUrl && config.db.migratorUrl !== config.db.url
        ? createPool({
            connectionString: config.db.migratorUrl,
            applicationName: `${SERVICE_NAME}/migrator`,
            max: 2,
            statementTimeoutMs: 0, // 分区维护/建索引用，别被超时打断
            logger,
          })
        : null,
  };

  const redis = createRedis({
    url: config.redis.url,
    username: config.redis.username,
    password: config.redis.password,
    connectTimeoutMs: config.redis.connectTimeoutMs,
    maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
    logger,
  });

  try {
    await startupChecks({ config, logger, db, redis });
  } catch (err) {
    logger.fatal({ err, pg: redactUrl(config.db.url) }, '启动自检失败，进程退出');
    await closeDeps({ db, redis, logger });
    process.exitCode = 1;
    return;
  }

  // --- 装配与监听 ------------------------------------------------------------
  const app = await buildApp({ config, logger, db, redis });

  try {
    await app.listen({ host: config.http.host, port: config.http.port });
  } catch (err) {
    logger.fatal({ err }, '监听失败，进程退出');
    await closeApp(app, { db, redis, logger });
    process.exitCode = 1;
    return;
  }

  // --- 定时任务（✅ 决策 #50：core 内置 + 分布式锁）-------------------------
  // ⚠️ 放在 listen 之后启动：① 早于 listen 时任何失败都会变成"启动失败"（维护任务是可延迟的）；
  //    ② start() 会立即补建一次分区，把「服务停机期间漏掉的提前量」补回来。
  const cron = createCronService({ db, redis, config, logger });
  await cron.start();

  // --- 优雅退出 --------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '收到退出信号，开始优雅关闭');

    // 先停定时任务：避免关闭过程中又开始一轮聚合/DDL（正在跑的那个任务会先跑完）
    cron.stop();

    // 兜底：10s 内没关完就强退，避免容器停不下来
    const force = setTimeout(() => {
      logger.error('优雅关闭超时（10s），强制退出');
      process.exit(1);
    }, 10_000);
    force.unref();

    try {
      await closeApp(app, { db, redis, logger });
      logger.info('已优雅关闭');
      process.exitCode = 0;
    } catch (err) {
      logger.error({ err }, '关闭过程中出错');
      process.exitCode = 1;
    } finally {
      clearTimeout(force);
      // 让事件循环自然排空；若仍有句柄残留则强制退出
      setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '未处理的 Promise 拒绝（请修复，别让它静默）');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '未捕获异常，进程退出');
    void shutdown('uncaughtException');
  });
}

/**
 * 启动自检：依赖可用性 + 关键配置约束。
 * @throws 依赖不可用时抛错（调用方据此退出）
 */
async function startupChecks({ config, logger, db, redis }) {
  // 1) PostgreSQL —— 连不上就**直接退出**：没有数据库时每个请求都会 503，早退比半死不活好排障
  let info;
  try {
    await query(db.app, 'SELECT 1', [], { logger, name: 'startup:pg' });
    info = await serverInfo(db.app);
  } catch (err) {
    throw new Error(
      `PostgreSQL 不可用（${redactUrl(config.db.url)}）：${err.code ?? err.message}。` +
        '请确认实例已启动、DATABASE_URL 指向正确的库与账号，且该库已执行 npm run migrate。',
    );
  }
  logger.info(
    { version: info.version, database: info.database, user: info.user, maxConnections: info.max_connections },
    'PostgreSQL 已连接',
  );

  const ddl = await assertNoDdlPrivilege(db.app).catch((err) => ({ ok: false, reason: err.message }));
  if (!ddl.ok) {
    logger.warn(
      { reason: ddl.reason },
      '运行时连接的数据库权限过于宽泛（建议改用最小权限角色 vantage_app，见 server/scripts/init-db.sql）',
    );
  }

  // 2) 迁移是否全部应用
  const pending = await detectPendingMigrations(db.app, logger);
  if (pending.length > 0) {
    logger.warn(
      { pending },
      `检测到 ${pending.length} 个未应用的迁移，请先执行：npm run migrate`,
    );
  }

  // 3) Redis
  if (!(await redis.ping().then((p) => p === 'PONG').catch(() => false))) {
    throw new Error(`Redis 不可用（${redactUrl(config.redis.url)}）：会话/限流/nonce 均依赖它，请先启动 Redis`);
  }
  const eviction = await checkEvictionPolicy(redis);
  if (!eviction.ok) {
    logger.warn({ reason: eviction.reason }, 'Redis 淘汰策略不符合要求（✅ R15 要求 noeviction）');
  }
  const redisInfo = await redisStats(redis).catch(() => undefined);
  logger.info(
    {
      usedMemoryBytes: redisInfo?.usedMemoryBytes,
      evictedKeys: redisInfo?.evictedKeys,
      maxmemoryPolicy: redisInfo?.maxmemoryPolicy,
    },
    'Redis 已连接（evicted_keys 必须恒为 0）',
  );
}

/** 对比 migrations 目录与 schema_migrations 表，返回未应用的迁移文件名 */
async function detectPendingMigrations(pool, logger) {
  const dir = path.join(SERVER_ROOT, 'migrations');
  if (!fs.existsSync(dir)) return [];

  let applied;
  try {
    const { rows } = await pool.query('SELECT version FROM schema_migrations');
    applied = new Set(rows.map((r) => r.version));
  } catch (err) {
    if (err?.code === '42P01') {
      logger.warn('未找到 schema_migrations 表：数据库尚未初始化，请执行 npm run migrate');
      return fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
    }
    throw err;
  }

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
      const match = /^(\d+)_/.exec(f);
      return match ? !applied.has(match[1]) : false;
    });
}

/**
 * 自检失败时的清理：只断依赖，不碰未创建的 app。
 * ⛔ Redis 可能仍在重连，必须显式 disconnect，否则进程不退出。
 */
async function closeDeps({ db, redis, logger }) {
  try {
    redis.disconnect();
  } catch (err) {
    logger?.warn({ err }, 'Redis 断开失败');
  }
  await db.app?.end().catch((err) => logger?.warn({ err }, 'PG 连接池关闭失败'));
  await db.migrator?.end().catch((err) => logger?.warn({ err }, 'PG 迁移池关闭失败'));
}

/**
 * 顶层兜底：配置/启动期异常必须给出**人能读懂的一句话**，而不是一大段栈。
 * ⛔ 不回显任何连接串/密钥（相关消息里已用 redactUrl 处理过）。
 */
main().catch((err) => {
  const headline = err?.code === 'CONFIG_INVALID' ? '配置校验失败，进程退出' : '启动失败，进程退出';
  console.error(`\n✖ ${headline}\n${err?.message ?? err}\n`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
