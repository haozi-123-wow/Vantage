/**
 * 应用装配冒烟测试（**不需要真实 PG / Redis**，全部用桩替代）
 *
 * 覆盖：健康检查语义、统一错误信封、请求 ID 贯通、/api 不落缓存、5xx 不泄露细节。
 * 说明：这里刻意不引入任何 HTTP 测试框架——Fastify 的 `inject()` 已经足够，
 *       少一个依赖就少一处版本漂移（本项目的依赖越少越好维护）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SERVICE_VERSION, buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { appError } from '../src/utils/errors.js';
import { createLogger } from '../src/utils/log.js';

const CONFIG = loadConfig(
  {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 3).toString('base64'),
  },
  { skipEnvFile: true },
);

const REDIS_INFO =
  'used_memory:1048576\r\nmaxmemory_policy:noeviction\r\nevicted_keys:0\r\nconnected_clients:3\r\n';

function makeDeps({ pgOk = true, redisOk = true } = {}) {
  return {
    db: {
      app: {
        query: async () => {
          if (!pgOk) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
          return { rows: [{ ok: 1 }], rowCount: 1 };
        },
      },
      migrator: null,
    },
    redis: {
      ping: async () => {
        if (!redisOk) throw new Error('Connection is closed.');
        return 'PONG';
      },
      info: async () => REDIS_INFO,
    },
  };
}

async function makeApp(deps = makeDeps()) {
  return buildApp({
    config: CONFIG,
    logger: createLogger({ level: 'silent' }),
    db: deps.db,
    redis: deps.redis,
  });
}

test('/healthz：只证明进程活着，⛔ 不查依赖（依赖挂了也不该重启进程）', async () => {
  const app = await makeApp(makeDeps({ pgOk: false, redisOk: false }));
  const res = await app.inject({ method: 'GET', url: '/healthz' });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'vantage-core');
  assert.equal(typeof body.uptime_s, 'number');
  await app.close();
});

test('/readyz：PG + Redis 可用 → 200，并回传 evicted_keys（✅ R15 须恒为 0）', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/readyz' });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.checks.postgres.ok, true);
  assert.equal(body.checks.redis.ok, true);
  assert.deepEqual(body.checks.eviction, {
    maxmemory_policy: 'noeviction',
    evicted_keys: 0,
    used_memory_bytes: 1048576,
  });
  await app.close();
});

test('/readyz：任一依赖不可用 → 503（供编排摘流量）', async () => {
  const app = await makeApp(makeDeps({ redisOk: false }));
  const res = await app.inject({ method: 'GET', url: '/readyz' });

  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks.redis.ok, false);
  assert.equal(body.checks.postgres.ok, true);
  // 健康检查可带简短错误摘要，但必须是错误码而非连接串
  assert.equal(res.body.includes('127.0.0.1'), false);
  await app.close();
});

test('/version：暴露版本但不泄露环境变量内容', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/version' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.service, 'vantage-core');
  // ⚠️ 回归防线：app.js 传 serviceVersion、health.js 读 serviceVersion —— 名字不一致会静默退化成 '0.0.0'
  assert.equal(body.version, SERVICE_VERSION);
  assert.notEqual(body.version, '0.0.0');
  assert.equal(body.env, 'test');
  assert.equal(body.node, process.version);
  assert.equal(res.body.includes('SECRET_KEY'), false);
  assert.equal(res.body.includes(CONFIG.security.secretKey.toString('base64')), false);
  await app.close();
});

test('/healthz 也带上真实版本号（编排/排障靠它确认镜像版本）', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.json().version, SERVICE_VERSION);
  await app.close();
});

test('未命中的路由 → 404 + 统一错误信封（docs/api.md §1.3）', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

  assert.equal(res.statusCode, 404);
  assert.deepEqual(Object.keys(res.json()).sort(), ['error']);
  const { error } = res.json();
  assert.equal(error.code, 'not_found');
  assert.ok(error.request_id, '错误信封必须带 request_id');
  // /api 命名空间下不得被中间缓存
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  await app.close();
});

test('请求 ID 贯通：优先采用反代传入的 X-Request-Id，并在响应头回传', async () => {
  const app = await makeApp();

  const inbound = await app.inject({
    method: 'GET',
    url: '/healthz',
    headers: { 'x-request-id': 'trace-abc-123' },
  });
  assert.equal(inbound.headers['x-request-id'], 'trace-abc-123');

  const generated = await app.inject({ method: 'GET', url: '/healthz' });
  assert.match(generated.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  await app.close();
});

test('业务异常按登记的错误码与状态码返回；5xx 折叠为通用消息', async () => {
  const app = await makeApp();

  app.get('/__test/forbidden', async () => {
    throw appError('role_denied', { details: { need: 'admin' } });
  });
  app.get('/__test/rate-limited', async () => {
    throw appError('rate_limited', { retryAfterS: 42 });
  });
  app.get('/__test/boom', async () => {
    throw new Error('内部细节：relation "agents" does not exist at /srv/app/src/x.js');
  });

  const forbidden = await app.inject({ method: 'GET', url: '/__test/forbidden' });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, 'role_denied');
  assert.deepEqual(forbidden.json().error.details, { need: 'admin' });

  const limited = await app.inject({ method: 'GET', url: '/__test/rate-limited' });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '42');

  const boom = await app.inject({ method: 'GET', url: '/__test/boom' });
  assert.equal(boom.statusCode, 500);
  assert.equal(boom.json().error.code, 'internal_error');
  assert.equal(boom.json().error.message, '服务内部错误');
  assert.equal(boom.body.includes('agents'), false, '5xx 不得回显库内结构');
  assert.equal(boom.body.includes('/srv/app'), false, '5xx 不得回显内部路径');

  await app.close();
});

test('⛔ 单向宗旨的自动化防线：上报响应之外的接口清单里不得出现下发式端点', async () => {
  const app = await makeApp();
  const routes = app
    .printRoutes({ commonPrefix: false })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  // 当前只挂了健康检查；此处断言"不存在下发类路径"这一**永久约束**
  for (const banned of ['agent/config', 'agent/tasks', 'agent/command', 'agent/exec', 'agent/script', 'agent/upgrade']) {
    assert.equal(routes.includes(banned), false, `出现了禁止的下发式端点：${banned}`);
  }
  await app.close();
});
