/**
 * Vantage · 健康检查与版本端点
 *
 * 依据：docs/api.md §1.3（503 upstream_unavailable 语义）、docs/database.md §7（须监控 evicted_keys）
 *
 * 为什么单独放在根路径而不是 `/api/*`
 *  - 这三个端点是**运维/编排用**，不属于面板 API 契约：不受 `/api` 限流与鉴权影响，
 *    也不使用 §1.3 的错误信封（编排器只关心状态码 + 简短 JSON）。
 *  - `/healthz` 与 `/readyz` **语义不同**：前者只证明进程活着（不碰任何依赖），
 *    后者证明依赖可用（PG/Redis）。⛔ 不要把二者混成一个端点，否则依赖抖动会引发无谓重启。
 */

import { ping as pgPing } from '../db/pg.js';
import { ping as redisPing, stats as redisStats } from '../db/redis.js';

/** 依赖探活的硬超时：健康检查本身绝不能挂住（否则反代超时也会误判为服务死亡） */
const CHECK_TIMEOUT_MS = 3_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 探活超时（>${ms}ms）`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function timed(fn) {
  const started = process.hrtime.bigint();
  try {
    await fn();
    return { ok: true, ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6) };
  } catch (err) {
    return {
      ok: false,
      ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      // 健康检查可暴露错误摘要（运维面向），⛔ 但绝不包含连接串/密钥
      error: err?.code ? `${err.code}` : (err?.message ?? 'unknown'),
    };
  }
}

/**
 * 注册健康检查路由。
 * @param {import('fastify').FastifyInstance} app
 * @param {{ serviceName: string, serviceVersion: string }} opts
 */
export async function registerHealthRoutes(app, opts) {
  const serviceName = opts?.serviceName ?? 'vantage-core';
  const serviceVersion = opts?.serviceVersion ?? '0.0.0';

  /** 存活探针：只反映进程本身，⛔ 不查任何依赖 */
  app.get('/healthz', { logLevel: 'warn' }, async () => ({
    ok: true,
    service: serviceName,
    version: serviceVersion,
    uptime_s: Math.round(process.uptime()),
  }));

  /** 版本信息：便于排障时确认容器镜像与代码版本（⛔ 不暴露环境变量内容） */
  app.get('/version', { logLevel: 'warn' }, async () => ({
    service: serviceName,
    version: serviceVersion,
    node: process.version,
    env: app.config.nodeEnv,
  }));

  /**
   * 就绪探针：PG + Redis 可用才返回 200，否则 503（供编排摘流量）。
   * 顺带回传 Redis 的 `evicted_keys` —— ✅ R15 要求它**恒为 0**，否则 nonce/幂等键被驱逐。
   */
  app.get('/readyz', { logLevel: 'warn' }, async (req, reply) => {
    const { db, redis, startupChecks } = app.deps;

    if (!startupChecks) {
      return { ok: true, service: serviceName, checks: { skipped: true } };
    }

    const [pg, rd] = await Promise.all([
      timed(() => withTimeout(pgPing(db.app), CHECK_TIMEOUT_MS, 'PostgreSQL')),
      timed(() => withTimeout(redisPing(redis), CHECK_TIMEOUT_MS, 'Redis')),
    ]);

    let redisDetail;
    if (rd.ok) {
      redisDetail = await redisStats(redis).catch(() => undefined);
    }

    const ok = pg.ok && rd.ok;
    const body = {
      ok,
      service: serviceName,
      version: serviceVersion,
      checks: {
        postgres: pg,
        redis: rd,
        ...(redisDetail
          ? {
              eviction: {
                maxmemory_policy: redisDetail.maxmemoryPolicy,
                evicted_keys: redisDetail.evictedKeys,
                used_memory_bytes: redisDetail.usedMemoryBytes,
              },
            }
          : {}),
      },
    };

    if (!ok) {
      req.log.error({ checks: body.checks }, '就绪检查未通过');
      reply.code(503);
    }
    return body;
  });
}
