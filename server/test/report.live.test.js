/**
 * 真机联调测试（默认**跳过**；需要显式开启）
 *
 *   PowerShell:  $env:VANTAGE_LIVE_TEST=1; npm test
 *   或只跑这一个文件：node --test test/report.live.test.js
 *
 * 与 test/report.test.js 的分工
 *  - 那些用例用替身，验证**行为契约**（状态码、幂等、错误码、落库顺序）；
 *  - 本文件连**真实** PostgreSQL + Redis，验证替身证明不了的东西：
 *      · 迁移后的真实表结构与 CHECK 约束是否接受我们的写入；
 *      · `unnest(...)` 多数组 INSERT、`INET` 的规范化比较、`make_interval` 是否真的可用；
 *      · 分区是否存在、行是否真的落在预期的分区里；
 *      · Redis 里的 Lua 限流脚本是否真能跑（ioredis 的返回值形状）；
 *      · 幂等命中在**真实** Redis 上是否真的不写库。
 *
 * ⚠️ 会向 Vantage 自己的库写入测试数据，并**自动清理**（含级联删时序行）。
 *    ⛔ 绝不触碰其它库/其它 Agent 的数据。清理失败时会在日志里明确打印残留 id。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { SERVICE_VERSION, buildApp } from '../src/app.js';
import { loadConfig, redactUrl } from '../src/config/index.js';
import { createPool } from '../src/db/pg.js';
import { closeRedis, createRedis } from '../src/db/redis.js';
import { generatePublicSlug, hashAgentCredential, sealAgentSecret } from '../src/utils/crypto.js';
import { createLogger } from '../src/utils/log.js';
import { keys } from '../src/utils/redisKeys.js';
import { buildSignedRequest, makeReportBody, newBatchId, newNonce } from './helpers/agent-client.js';

const LIVE = process.env.VANTAGE_LIVE_TEST === '1';
const skip = LIVE ? false : '需要 VANTAGE_LIVE_TEST=1（会连真实 PG/Redis 并写入测试数据）';

/** 一次性上下文：真配置 + 真连接 + 一个专用测试 Agent */
async function createLiveContext() {
  // ⚠️ 直接读真实 .env（不 skipEnvFile），但把限流阈值压到 3 以便验证 429
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', RATELIMIT_AGENT_PER_MINUTE: '3' });
  const logger = createLogger({ level: 'warn' });
  const db = {
    app: createPool({
      connectionString: config.db.url,
      applicationName: 'vantage-core/test:live',
      max: 3,
      logger,
    }),
    migrator: null,
  };
  const redis = createRedis({
    url: config.redis.url,
    username: config.redis.username,
    password: config.redis.password,
    logger,
  });

  const agentId = randomUUID();
  const agentName = `live-test-${agentId.slice(0, 8)}`;
  const agentKey = `vk_live_${randomUUID().replace(/-/g, '')}`;
  const agentSecret = `vs_live_${randomUUID().replace(/-/g, '')}`;
  // ⚠️ 必须用 generatePublicSlug：CHECK 约束排除了易混字符 0 O 1 l I，
  //    而 UUID 的十六进制片段里必然出现 0/1
  const publicSlug = generatePublicSlug(10);

  // 便于清理：测试期间额外写入的 Redis 键（如 batch 幂等键）
  const extraRedisKeys = [];

  await db.app.query(
    `INSERT INTO agents (id, name, public_slug, agent_key_hash, agent_secret_enc, tags)
     VALUES ($1, $2, $3, $4, $5, '["live-test"]'::jsonb)`,
    [
      agentId,
      agentName,
      publicSlug,
      hashAgentCredential('key', agentKey, config.security.secretKey),
      sealAgentSecret(agentSecret, config.security.secretKey, agentId),
    ],
  );

  const agent = {
    id: agentId,
    name: agentName,
    plainKey: agentKey,
    plainSecret: agentSecret,
  };

  const app = await buildApp({ config, logger, db, redis });

  return {
    config,
    db,
    redis,
    app,
    agent,
    logger,
    extraRedisKeys,
    async cleanup() {
      const errors = [];
      // 顺序：先删有外键引用的行，再删 Agent 本体（⛔ 关系表是 ON DELETE RESTRICT）
      const statements = [
        ['DELETE FROM metrics_raw WHERE agent_id = $1', [agentId]],
        ['DELETE FROM agent_ip_history WHERE agent_id = $1', [agentId]],
        ['DELETE FROM ip_change_events WHERE agent_id = $1', [agentId]],
        ['DELETE FROM process_snapshots WHERE agent_id = $1', [agentId]],
        ['DELETE FROM probe_results WHERE agent_id = $1', [agentId]],
        // 审计行的 target 是**伪造的** agent_id（跨机越权用例），所以按 actor + detail 兜底查
        [
          `DELETE FROM audit_logs
            WHERE actor = $1 OR detail->>'header_agent_id' = $2`,
          [`agent:${agentId}`, agentId],
        ],
      ];
      for (const [sql, params] of statements) {
        try {
          await db.app.query(sql, params);
        } catch (err) {
          errors.push(`${sql.slice(0, 40)}…: ${err.message}`);
        }
      }
      try {
        await db.app.query('DELETE FROM agents WHERE id = $1', [agentId]);
      } catch (err) {
        errors.push(`agents: ${err.message}`);
      }
      // Redis：清掉本次测试用到的键（ratelimit 会挡住后续用例；batch 键留着会脏）
      try {
        const stale = await redis.keys(`*${agentId}*`);
        // batch:<ulid> 键里存的 value 就是 agent_id —— 正因如此才能按归属把它们挑出来
        // （否则只能靠 TTL 自然过期，留下 10 分钟的脏键）
        const batchKeys = await redis.keys('batch:*');
        const owned = [];
        for (const key of batchKeys) {
          if ((await redis.get(key)) === agentId) owned.push(key);
        }
        const targets = [...new Set([...stale, ...owned, ...extraRedisKeys])];
        if (targets.length > 0) await redis.del(...targets);
      } catch (err) {
        errors.push(`redis: ${err.message}`);
      }
      if (errors.length > 0) {
        logger.error({ agentId, errors }, '⚠️ 真机测试清理未完全成功，请手工删除残留');
      }
      try {
        await app.close();
      } catch {
        /* 忽略 */
      }
      await closeRedis(redis, logger);
      await db.app.end().catch(() => {});
      return errors;
    },
  };
}

test('真机：一次完整上报 → 200 + 数据真的落库（表/分区/约束全部接受）', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const body = makeReportBody({
      agent_id: ctx.agent.id,
      host: { hostname: ctx.agent.name, os: 'linux', kernel: 'test', boot_time: 0, capabilities: { 'disk.io': true } },
    });
    const request = buildSignedRequest({ agent: ctx.agent, body });
    const res = await ctx.app.inject({ ...request, remoteAddress: '203.0.113.42' });

    assert.equal(res.statusCode, 200, res.body);
    const { server_ts: serverTs } = res.json();
    assert.equal(typeof serverTs, 'number');

    // --- 指标真的进了 metrics_raw，且 ts = server_ts ---
    const metrics = await ctx.db.app.query(
      `SELECT metric, value, labels, ts, tableoid::regclass::text AS partition
         FROM metrics_raw WHERE agent_id = $1 ORDER BY metric`,
      [ctx.agent.id],
    );
    assert.ok(metrics.rowCount > 10, `应写入多个序列，实际 ${metrics.rowCount}`);
    assert.ok(metrics.rows.every((row) => row.ts.getTime() === serverTs));
    // 维度写进名字，且落在预期的分区里（不是 DEFAULT 兜底分区）
    const diskRow = metrics.rows.find((row) => row.metric === 'disk.used_pct{device=sda1,mount=/}');
    assert.ok(diskRow, '缺少 disk.used_pct 序列');
    assert.equal(diskRow.value, 50);
    assert.deepEqual(diskRow.labels, { device: 'sda1', mount: '/' });
    // ⚠️ 实测（PG 18.4）：`inet::text` 会带上掩码（'203.0.113.7/32'），
    //    要看"纯地址"必须用 host()。这也是中心**绝不**用 JS 比较 IP 文本的原因
    //    （见 agent.repo.js::lockAgentForReport：变化判定一律交给 INET 在 SQL 里做）。
    assert.match(diskRow.partition, /^metrics_raw_\d{8}$/, `分区名异常：${diskRow.partition}`);

    // --- 进程快照 / 探活 / Agent 心跳 / IP 历史 ---
    const snapshot = await ctx.db.app.query(
      'SELECT total, jsonb_array_length(top) AS tops FROM process_snapshots WHERE agent_id = $1',
      [ctx.agent.id],
    );
    assert.equal(snapshot.rows[0].total, 210);
    assert.equal(snapshot.rows[0].tops, 1);

    const probes = await ctx.db.app.query(
      'SELECT probe_name, up, latency_ms, status_code FROM probe_results WHERE agent_id = $1',
      [ctx.agent.id],
    );
    assert.equal(probes.rowCount, 1);
    assert.equal(probes.rows[0].probe_name, 'site-health');
    assert.equal(probes.rows[0].status_code, 200);

    const agentRow = await ctx.db.app.query(
      `SELECT status, last_seen_at, host(last_ip) AS last_ip, last_agent_ts, clock_drift_ms,
              capabilities, host_info->>'hostname' AS hostname
         FROM agents WHERE id = $1`,
      [ctx.agent.id],
    );
    assert.equal(agentRow.rows[0].status, 'online');
    assert.equal(agentRow.rows[0].last_seen_at.getTime(), serverTs);
    assert.equal(agentRow.rows[0].last_ip, '203.0.113.42');
    assert.equal(agentRow.rows[0].hostname, ctx.agent.name);
    assert.equal(agentRow.rows[0].capabilities['disk.io'], true);
    assert.ok(Math.abs(Number(agentRow.rows[0].clock_drift_ms)) < 10_000, '时钟漂移应在秒级');

    const ipHistory = await ctx.db.app.query(
      'SELECT host(ip) AS ip, source FROM agent_ip_history WHERE agent_id = $1 ORDER BY source',
      [ctx.agent.id],
    );
    assert.deepEqual(
      ipHistory.rows.map((row) => [row.ip, row.source]),
      [
        ['203.0.113.7', 'agent_reported'],
        ['203.0.113.42', 'remote'],
      ],
    );

    // 首次记录 IP → old_ip 为 NULL（§5.6）
    const ipEvents = await ctx.db.app.query(
      'SELECT host(old_ip) AS old_ip, host(new_ip) AS new_ip, kind, source, change_count FROM ip_change_events WHERE agent_id = $1',
      [ctx.agent.id],
    );
    assert.equal(ipEvents.rowCount, 1);
    assert.equal(ipEvents.rows[0].old_ip, null);
    assert.equal(ipEvents.rows[0].new_ip, '203.0.113.42');
    assert.equal(ipEvents.rows[0].kind, 'change');
  } finally {
    await ctx.cleanup();
  }
});

test('真机：同 batch_id 连发两次 → 行数不变（真实 Redis 幂等）', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const batchId = newBatchId();
    ctx.extraRedisKeys.push(keys.batch(batchId));
    const body = makeReportBody({ agent_id: ctx.agent.id });

    const first = await ctx.app.inject({
      ...buildSignedRequest({ agent: ctx.agent, body: { ...body, batch_id: batchId } }),
      remoteAddress: '203.0.113.43',
    });
    assert.equal(first.statusCode, 200, first.body);

    const countAfterFirst = await ctx.db.app.query(
      'SELECT count(*)::int AS n FROM metrics_raw WHERE agent_id = $1',
      [ctx.agent.id],
    );

    const second = await ctx.app.inject({
      ...buildSignedRequest({ agent: ctx.agent, body: { ...body, batch_id: batchId }, nonce: newNonce() }),
      remoteAddress: '203.0.113.43',
    });
    assert.equal(second.statusCode, 200, second.body);

    const countAfterSecond = await ctx.db.app.query(
      'SELECT count(*)::int AS n FROM metrics_raw WHERE agent_id = $1',
      [ctx.agent.id],
    );
    assert.equal(countAfterSecond.rows[0].n, countAfterFirst.rows[0].n, '幂等命中不得再写行');
  } finally {
    await ctx.cleanup();
  }
});

test('真机：同 nonce 重放 → 409（真实 Redis SETNX）', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const nonce = newNonce();
    const first = await ctx.app.inject({
      ...buildSignedRequest({ agent: ctx.agent, body: makeReportBody({ agent_id: ctx.agent.id }), nonce }),
      remoteAddress: '203.0.113.44',
    });
    assert.equal(first.statusCode, 200, first.body);

    const replay = await ctx.app.inject({
      ...buildSignedRequest({ agent: ctx.agent, body: makeReportBody({ agent_id: ctx.agent.id }), nonce }),
      remoteAddress: '203.0.113.44',
    });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error.code, 'nonce_reused');

    // 键确实存在于真实 Redis，且带预期 TTL
    const ttl = await ctx.redis.ttl(keys.nonce(ctx.agent.id, nonce));
    assert.ok(ttl > 0 && ttl <= ctx.config.security.nonceTtlS, `TTL 异常：${ttl}`);
  } finally {
    await ctx.cleanup();
  }
});

test('真机：限流 Lua 脚本在真实 Redis 上生效（第 4 次 429）', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await ctx.app.inject({
        ...buildSignedRequest({ agent: ctx.agent, body: makeReportBody({ agent_id: ctx.agent.id }) }),
        remoteAddress: '203.0.113.45',
      });
      statuses.push(res.statusCode);
      if (i === 3) {
        assert.equal(res.statusCode, 429);
        assert.equal(res.json().error.code, 'rate_limited');
        assert.ok(res.headers['retry-after']);
      }
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    // Lua 返回的计数被正确解读（阈值 3）
    const counter = await ctx.redis.get(keys.rateLimitAgent(ctx.agent.id));
    assert.equal(Number(counter), 4);
  } finally {
    await ctx.cleanup();
  }
});

test('真机：/version 与 /readyz 反映真实依赖（含 evicted_keys 必须为 0）', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const version = await ctx.app.inject({ method: 'GET', url: '/version' });
    assert.equal(version.statusCode, 200);
    assert.equal(version.json().version, SERVICE_VERSION);

    const ready = await ctx.app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(ready.statusCode, 200, ready.body);
    const body = ready.json();
    assert.equal(body.checks.postgres.ok, true);
    assert.equal(body.checks.redis.ok, true);
    assert.equal(body.checks.eviction.evicted_keys, 0, '✅ R15：evicted_keys 必须恒为 0');
    // ⛔ 依赖凭据绝不能出现在响应里（口令从连接串里取出来比对）
    const pgPassword = decodeURIComponent(new URL(ctx.config.db.url).password);
    if (pgPassword) assert.equal(ready.body.includes(pgPassword), false, '响应体泄露了 PG 口令');
    if (ctx.config.redis.password) {
      assert.equal(ready.body.includes(ctx.config.redis.password), false, '响应体泄露了 Redis 口令');
    }
  } finally {
    await ctx.cleanup();
  }
});

test('真机：跨机越权会真的写进 audit_logs', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    const res = await ctx.app.inject({
      ...buildSignedRequest({
        agent: ctx.agent,
        body: makeReportBody({ agent_id: randomUUID() }),
      }),
      remoteAddress: '203.0.113.46',
    });
    assert.equal(res.statusCode, 400);

    const byActor = await ctx.db.app.query(
      `SELECT action, actor_type, host(ip) AS ip, detail
         FROM audit_logs WHERE actor = $1 ORDER BY id DESC LIMIT 1`,
      [`agent:${ctx.agent.id}`],
    );
    assert.equal(byActor.rowCount, 1, '跨机越权必须留下审计行');
    assert.equal(byActor.rows[0].action, 'agent.report.identity_mismatch');
    assert.equal(byActor.rows[0].actor_type, 'agent');
    assert.equal(byActor.rows[0].ip, '203.0.113.46');
    assert.equal(byActor.rows[0].detail.header_agent_id, ctx.agent.id);
    assert.notEqual(byActor.rows[0].detail.body_agent_id, ctx.agent.id);
  } finally {
    await ctx.cleanup();
  }
});

test('真机：调用 /api/v1/agent/report 之外的下发式路径一律 404（单向宗旨）', { skip }, async () => {
  const ctx = await createLiveContext();
  try {
    for (const url of ['/api/v1/agent/config', '/api/v1/agent/tasks', '/api/v1/agent/command']) {
      const res = await ctx.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, `${url} 不应存在`);
    }
    // 排障日志里用的脱敏连接串不得包含口令
    const pgPassword = decodeURIComponent(new URL(ctx.config.db.url).password);
    if (pgPassword) assert.equal(redactUrl(ctx.config.db.url).includes(pgPassword), false);
  } finally {
    await ctx.cleanup();
  }
});
