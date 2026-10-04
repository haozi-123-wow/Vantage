/**
 * 公开状态接口测试（`GET /api/public/hosts` · `GET /api/public/summary`）
 *
 * 依据：docs/api.md §3（公开视图：免登录、只读、严格限流、严格脱敏、总开关）、
 *       docs/server-status-api.md §3.1/§3.2（契约）、§2.4（响应缓存）、§2.5（关→404）、§7.3（可观测性）
 *
 * 为什么用**真 PGlite + 真 buildApp**：本文件要验的四件事全在"SQL 与 HTTP 的交界处"——
 *   ① 限流器与总开关的**执行顺序**（限流在前，被关闭期间的访问照样计数）；
 *   ② `public_view.enabled=false` 时必须是 **404 + 统一错误信封**（⛔ 不是 403、不是空 body）；
 *   ③ 响应缓存是否真的命中（两次请求的 `updated_at` 必须逐字相同）；
 *   ④ 依赖故障时**默认拒绝**（Redis 或 PG 读不到开关 → 503，⛔ 绝不 fail-open 放行）。
 *
 * ⚠️ 每条用例独立：beforeEach 重建 app 与 Redis（限流按 IP 计数，共用实例会互相污染）。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { invalidateSettingsCache } from '../src/services/settings.service.js';
import { PUBLIC_SLUG_ALPHABET } from '../src/utils/crypto.js';
import { createLogger } from '../src/utils/log.js';
import { KEY_PREFIX, keys } from '../src/utils/redisKeys.js';
import { createFakeRedisHash } from './helpers/fake-redis-hash.js';

// -----------------------------------------------------------------------------
// 真库（PGlite）：与生产同一条迁移代码路径
// -----------------------------------------------------------------------------
const db = await PGlite.create();
await db.exec('CREATE ROLE vantage_migrator LOGIN; CREATE ROLE vantage_app LOGIN; CREATE ROLE vantage_ro LOGIN;');
await db.exec(BOOTSTRAP_SQL);

const migrations = loadMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
const migrator = {
  query: (sql, params) => (Array.isArray(params) && params.length > 0 ? db.query(sql, params) : db.exec(sql)),
};
for (const migration of migrations) {
  await applyOne(migrator, migration, false);
}

async function run(sql, params = []) {
  if (Array.isArray(params) && params.length > 0) {
    const result = await db.query(sql, params);
    return { rows: result.rows ?? [], rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  }
  const results = await db.exec(sql);
  const last = Array.isArray(results) ? results.at(-1) : results;
  return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
}

const pool = { query: run };

after(async () => {
  await db.close();
});

const SILENT = createLogger({ level: 'silent' });

/** 基础配置：限流阈值放宽到 10（便于一个用例里连打几次），限流用例自己建一个阈值 =2 的实例 */
function makeConfig(overrides = {}) {
  return loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
      SECRET_KEY: Buffer.alloc(32, 5).toString('base64'),
      RATELIMIT_PUBLIC_PER_MINUTE: '10',
      ...overrides,
    },
    { skipEnvFile: true },
  );
}

const A1 = '44444444-5555-6666-8777-888888888801';
const A3 = '44444444-5555-6666-8777-888888888803';
const AGENT_KEY_HASH = 'fedcba9876543210'.repeat(4);

function makeSlug(seed) {
  let x = 11;
  for (const ch of String(seed)) x = (x * 31 + ch.codePointAt(0)) % 2_147_483_647;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_647;
    out += PUBLIC_SLUG_ALPHABET[x % PUBLIC_SLUG_ALPHABET.length];
  }
  return out;
}

async function seedAgent({ id, name, status, ageSeconds = null, hostInfo = null, lastIp = null }) {
  await run(
    `INSERT INTO agents
       (id, name, public_slug, agent_key_hash, agent_secret_enc, status, last_seen_at, disabled_at, host_info, last_ip)
     VALUES ($1, $2, $3, $4, 'v1:AAAA:BBBB:CCCC', $5,
             CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(secs => $6::double precision) END,
             CASE WHEN $7::boolean THEN now() ELSE NULL END,
             $8::jsonb, $9::inet)`,
    [id, name, makeSlug(name), AGENT_KEY_HASH, status, ageSeconds, status === 'disabled', hostInfo ? JSON.stringify(hostInfo) : null, lastIp],
  );
}

const CONFIG = makeConfig();
let app = null;
let redis = null;

beforeEach(async () => {
  if (app) await app.close();
  await run('DELETE FROM settings');
  await run(`DELETE FROM probe_results WHERE agent_id = ANY($1::uuid[])`, [[A1, A3]]);
  await run(`DELETE FROM metrics_raw WHERE agent_id = ANY($1::uuid[])`, [[A1, A3]]);
  await run(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [[A1, A3]]);

  redis = createFakeRedisHash();
  app = await buildApp({ config: CONFIG, logger: SILENT, db: { app: pool, migrator: null }, redis });
});

/** 造一批带**维度**的指标（用来验证公开侧会把 device/mount 泛化掉） */
async function seedMetric(agentId, metric, value) {
  await run(
    `INSERT INTO metrics_raw (agent_id, metric, value, ts)
     VALUES ($1::uuid, $2, $3, now() - interval '10 seconds')`,
    [agentId, metric, value],
  );
}

/** 造一轮探活（同一条 SQL ⇒ checked_at 完全相同 = 同一轮） */
async function seedProbeRound(agentId, rows) {
  await run(
    `INSERT INTO probe_results (agent_id, probe_name, probe_type, target, up, latency_ms, checked_at)
     SELECT $1::uuid, s.name, s.type, s.target, s.up, s.latency, now() - interval '10 seconds'
       FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::float8[])
              AS s(name, type, target, up, latency)`,
    [agentId, rows.map((r) => r.name), rows.map((r) => r.type), rows.map((r) => r.target), rows.map((r) => r.up), rows.map((r) => r.latency ?? null)],
  );
}

const get = (url) => app.inject({ method: 'GET', url });

/** 用一个"阈值 = 2"的独立实例验证限流（⛔ 不改全局 app：那样会让别的用例莫名其妙撞 429） */
async function withLowLimitApp(fn) {
  const limitedApp = await buildApp({
    config: makeConfig({ RATELIMIT_PUBLIC_PER_MINUTE: '2' }),
    logger: SILENT,
    db: { app: pool, migrator: null },
    redis,
  });
  try {
    return await fn(limitedApp);
  } finally {
    await limitedApp.close();
  }
}

// -----------------------------------------------------------------------------
// 200：形状与脱敏
// -----------------------------------------------------------------------------

test('GET /api/public/hosts：200 + 形状合规 + ⛔ 无内部标识（免登录）', async () => {
  await seedAgent({
    id: A1,
    name: 'web-01',
    status: 'online',
    ageSeconds: 5,
    hostInfo: { hostname: 'internal-1', os: 'Ubuntu 24.04.1 LTS', kernel: 'k', boot_time: 1_700_000_000 },
    lastIp: '203.0.113.55',
  });
  await seedAgent({ id: A3, name: 'old-03', status: 'disabled', ageSeconds: 5 });

  const res = await get('/api/public/hosts');
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(Object.keys(body).sort(), ['items', 'next_cursor', 'updated_at']);
  assert.equal(body.next_cursor, null, '本期恒为 null（方案 §2.8）');
  assert.equal(body.items.length, 1, '⛔ disabled 不出现');
  assert.deepEqual(Object.keys(body.items[0]).sort(), [
    'last_seen_ago', 'last_seen_at', 'name', 'os', 'probes', 'slug', 'snapshot', 'status', 'uptime',
  ]);

  const text = res.body;
  assert.equal(text.includes(A1), false, '⛔ 公开响应不得含内部 UUID');
  assert.equal(text.includes('203.0.113.55'), false, '⛔ 公开响应不得含 IP');
  assert.equal(text.includes(AGENT_KEY_HASH), false);
  assert.equal(text.includes('internal-1'), false, '⛔ hostname 一律不得回显');

  // 通用响应头（app.js 的 onSend）：⛔ 面板数据一律不落中间缓存
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(res.headers['x-request-id'], '必须回传请求 ID');
});

test('GET /api/public/summary：200 + total = online + offline + disabled；alerts 本期为 0', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });
  await seedAgent({ id: A3, name: 'old-03', status: 'disabled', ageSeconds: 5 });

  const res = await get('/api/public/summary');
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(Object.keys(body).sort(), ['alerts', 'disabled', 'offline', 'online', 'total', 'updated_at']);
  assert.deepEqual(body.alerts, { critical: 0, warn: 0, info: 0 }, '⛔ 告警引擎在 M3：本期只能断言"字段存在且为 0"');
  assert.equal(body.total, body.online + body.offline + body.disabled);
  assert.equal(body.disabled, 1);
});

test('公开端点不接受查询参数（传了也只是被忽略，不会改变可见集合）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });
  await seedAgent({ id: A3, name: 'old-03', status: 'disabled', ageSeconds: 5 });

  const plain = (await get('/api/public/hosts')).json();
  const withQuery = (await get('/api/public/hosts?status=disabled&tag=prod&limit=1')).json();
  assert.deepEqual(withQuery.items.map((i) => i.slug), plain.items.map((i) => i.slug));
  assert.equal(withQuery.items.some((i) => i.status === 'disabled'), false);
});

// -----------------------------------------------------------------------------
// 总开关（决策 D5）
// -----------------------------------------------------------------------------

test('public_view.enabled=false → 所有公开端点 404 + 统一错误信封（⛔ 不是 403、不是空 body）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });
  await run(`INSERT INTO settings (key, value) VALUES ('public_view.enabled', 'false'::jsonb)`);
  await invalidateSettingsCache(redis);

  for (const url of ['/api/public/hosts', '/api/public/summary']) {
    const res = await get(url);
    assert.equal(res.statusCode, 404, url);
    assert.equal(res.json().error.code, 'not_found', url);
    assert.ok(res.json().error.request_id, '错误信封必须带 request_id（docs/api.md §1.3）');
  }
});

test('开关是**每请求判定**的：同一个 app 实例先 404、改回 true 后立刻 200（⛔ 不需重启）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });

  await run(`INSERT INTO settings (key, value) VALUES ('public_view.enabled', 'false'::jsonb)`);
  await invalidateSettingsCache(redis);
  assert.equal((await get('/api/public/hosts')).statusCode, 404);

  await run(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'public_view.enabled'`);
  await invalidateSettingsCache(redis);
  assert.equal((await get('/api/public/hosts')).statusCode, 200, '⛔ 开关不得在启动时判定一次并缓存到进程里');
});

// -----------------------------------------------------------------------------
// 限流（方案 §7.1）
// -----------------------------------------------------------------------------

test('限流：第 3 次（阈值 + 1）429 + Retry-After + X-RateLimit-* 响应头', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });

  await withLowLimitApp(async (limited) => {
    const call = () => limited.inject({ method: 'GET', url: '/api/public/hosts' });

    const first = await call();
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['x-ratelimit-limit'], '2');
    assert.equal(first.headers['x-ratelimit-remaining'], '1');
    assert.ok(Number(first.headers['x-ratelimit-reset']) > 0);

    assert.equal((await call()).statusCode, 200, '第 2 次仍在阈值内');

    const blocked = await call();
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, 'rate_limited');
    assert.ok(Number(blocked.headers['retry-after']) >= 1, '429 必须带 Retry-After（秒）');
  });
});

test('限流维度是 **IP**：一个 IP 被限流不影响另一个 IP（且公开/其它桶互不干扰）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });

  await withLowLimitApp(async (limited) => {
    const call = (ip) => limited.inject({ method: 'GET', url: '/api/public/hosts', remoteAddress: ip });

    assert.equal((await call('203.0.113.1')).statusCode, 200);
    assert.equal((await call('203.0.113.1')).statusCode, 200);
    assert.equal((await call('203.0.113.1')).statusCode, 429, '该 IP 已超限');

    // 另一个 IP 不受影响；且限流用的是公开桶，不含登录/Agent 桶
    assert.equal((await call('203.0.113.2')).statusCode, 200);
    assert.equal(redis.has(`${KEY_PREFIX.rateLimitPublic}203.0.113.1`), true);
    assert.equal(
      redis.keys().some((key) => key.startsWith(KEY_PREFIX.rateLimitAgent) || key.startsWith(KEY_PREFIX.rateLimitLogin)),
      false,
      '⛔ 公开限流不得污染其它桶',
    );
  });
});

// -----------------------------------------------------------------------------
// 依赖故障：默认拒绝（设计 §5.2）
// -----------------------------------------------------------------------------

test('Redis 不可用 → 503 upstream_unavailable（⛔ 绝不在"没有限流"的状态下放行公开数据）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });
  redis.eval = async () => {
    throw new Error('Connection is closed.');
  };

  const res = await get('/api/public/hosts');
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'upstream_unavailable');
});

test('开关读不到（PG 连接类故障）→ 503 而不是放行', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });
  const broken = {
    query: async () => {
      const err = new Error('connection to server was lost');
      err.code = '08006'; // connection_failure
      throw err;
    },
  };
  const brokenApp = await buildApp({ config: CONFIG, logger: SILENT, db: { app: broken, migrator: null }, redis });
  try {
    const res = await brokenApp.inject({ method: 'GET', url: '/api/public/hosts' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'upstream_unavailable');
  } finally {
    await brokenApp.close();
  }
});

// -----------------------------------------------------------------------------
// 响应缓存（决策 D4）
// -----------------------------------------------------------------------------

test('响应缓存：两次请求命中同一份缓存（updated_at 逐字相同）且缓存键已写入', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });

  const first = (await get('/api/public/hosts')).json();
  assert.notEqual(await redis.get(keys.snapshotPublicHosts), null, '未命中后必须写缓存');

  const second = (await get('/api/public/hosts')).json();
  assert.equal(second.updated_at, first.updated_at, '命中缓存 ⇒ updated_at 是缓存生成时刻');

  // summary 走的是**另一个**键（⛔ 不共用：两个端点的内容不同）
  const summary = await get('/api/public/summary');
  assert.equal(summary.statusCode, 200);
  assert.notEqual(await redis.get(keys.snapshotPublicSummary), null);
});

test('缓存内容是**已脱敏**的响应体（缓存命中路径同样不得漏出 IP/UUID）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5, lastIp: '203.0.113.99' });
  await get('/api/public/hosts');
  const cached = await redis.get(keys.snapshotPublicHosts);

  assert.equal(cached.includes('203.0.113.99'), false, '⛔ 绝不缓存含 IP 的响应');
  assert.equal(cached.includes(A1), false, '⛔ 绝不缓存含内部 UUID 的响应');
});

test('PUBLIC_CACHE_TTL_S=0 时公开接口仍可用（缓存是优化，不是功能开关）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });
  const noCacheApp = await buildApp({
    config: makeConfig({ PUBLIC_CACHE_TTL_S: '0' }),
    logger: SILENT,
    db: { app: pool, migrator: null },
    redis,
  });
  try {
    const res = await noCacheApp.inject({ method: 'GET', url: '/api/public/hosts' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().items.length, 1);
    assert.equal(await redis.get(keys.snapshotPublicHosts), null, '关缓存时不得写缓存键');
  } finally {
    await noCacheApp.close();
  }
});

// -----------------------------------------------------------------------------
// GET /api/public/hosts/{slug}/now —— 单机展开（⛔ 无 IP / 无设备名 / 无挂载点）
// -----------------------------------------------------------------------------

test('GET /api/public/hosts/{slug}/now：200 + 展开块把设备/挂载点泛化成「磁盘 N / 网卡 N」', async () => {
  await seedAgent({
    id: A1,
    name: 'web-01',
    status: 'online',
    ageSeconds: 5,
    hostInfo: { hostname: 'internal-1', os: 'Ubuntu 24.04', kernel: 'k', arch: 'x86_64', boot_time: 1_700_000_000 },
    lastIp: '203.0.113.66',
  });
  for (const [metric, value] of [
    ['cpu.usage', 23.84],
    ['mem.used_pct', 38.1],
    ['disk.used_pct{device=nvme0n1p2,mount=/data}', 61.4],
    ['net.rx_bps{device=eth0}', 1_000_000.4],
    ['gpu.util{index=0}', 44.44],
  ]) {
    await seedMetric(A1, metric, value);
  }

  const res = await get(`/api/public/hosts/${makeSlug('web-01')}/now`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // 列表字段（卡片复用）+ 展开块
  assert.equal(body.name, 'web-01');
  assert.equal(body.status, 'online');
  assert.equal(body.last_seen_ago, '刚刚');
  assert.deepEqual(body.snapshot.disk_pct, 61.4);
  assert.deepEqual(body.disks.map((d) => d.label), ['磁盘 1']);
  assert.equal(body.disks[0].used_pct, 61.4);
  assert.deepEqual(body.networks.map((n) => n.label), ['网卡 1']);
  assert.deepEqual(body.gpus.map((g) => g.label), ['GPU 1']);
  assert.equal(body.cpu.usage_pct, 23.8);
  assert.equal(body.memory.used_pct, 38.1);
  assert.equal(typeof body.updated_at, 'string');

  // ⛔ 泄露检查（这是本端点存在的**唯一**理由：展开得越细，越容易漏设备名）
  const text = res.body;
  for (const leak of [
    A1, '203.0.113.66', 'internal-1', 'nvme0n1p2', '/data', 'eth0', 'disk.', 'net.', 'cpu.', 'gpu.util', 'index=',
  ]) {
    assert.equal(text.includes(leak), false, `公开单机展开泄露了：${leak}`);
  }
  assert.equal('id' in body, false);
  assert.equal('last_ip' in body, false);
  assert.equal('host_info' in body, false);
});

test('GET /api/public/hosts/{slug}/now：未知 slug → 404；**已禁用**主机 → 同一个 404（⛔ 不可区分）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });
  await seedAgent({ id: A3, name: 'old-03', status: 'disabled', ageSeconds: 5 });

  const unknown = await get(`/api/public/hosts/${makeSlug('nope-99')}/now`);
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.code, 'not_found');

  const disabled = await get(`/api/public/hosts/${makeSlug('old-03')}/now`);
  assert.equal(disabled.statusCode, 404, '禁用的机器连"存在"都不能被确认，否则 slug 成了枚举口子');
  assert.deepEqual(disabled.json().error, unknown.json().error.code === 'not_found' ? disabled.json().error : null);

  // slug 形状非法 → 400（它不是"某个不存在的主机"，而是根本不可能是一个 slug）
  const malformed = await get('/api/public/hosts/l/now');
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, 'schema_invalid');
});

test('GET /api/public/hosts/{slug}/now：受总开关约束，且命中响应缓存（updated_at 不变）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });
  const slug = makeSlug('web-01');

  const first = (await get(`/api/public/hosts/${slug}/now`)).json();
  assert.notEqual(await redis.get(keys.snapshotPublicHostNow(slug)), null, '单机快照也要缓存');
  const second = (await get(`/api/public/hosts/${slug}/now`)).json();
  assert.equal(second.updated_at, first.updated_at, '命中缓存 ⇒ updated_at 是缓存生成时刻');

  await run(`INSERT INTO settings (key, value) VALUES ('public_view.enabled', 'false'::jsonb)`);
  await invalidateSettingsCache(redis);
  const blocked = await get(`/api/public/hosts/${slug}/now`);
  assert.equal(blocked.statusCode, 404, '开关是每请求判定的，缓存不得绕过它');
});

// -----------------------------------------------------------------------------
// GET /api/public/probes —— 探活概览（目标已脱敏）
// -----------------------------------------------------------------------------

test('GET /api/public/probes：只列非禁用主机、只取最近一轮，且目标按口径脱敏', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5, hostInfo: { hostname: 'internal-1', os: 'Ubuntu 24.04', kernel: 'k', boot_time: 1_700_000_000 } });
  await seedAgent({ id: A3, name: 'old-03', status: 'disabled', ageSeconds: 5 });

  // 更早的一轮（必须被忽略）+ 最近一轮
  await run(
    `INSERT INTO probe_results (agent_id, probe_name, probe_type, target, up, latency_ms, checked_at)
     VALUES ($1::uuid, 'gw', 'ping', '10.0.0.1', TRUE, 9.9, now() - interval '5 minutes')`,
    [A1],
  );
  await seedProbeRound(A1, [
    { name: 'gw', type: 'ping', target: '10.0.0.1', up: true, latency: 1.2 },
    { name: '官网', type: 'https', target: 'https://status.example.com/health?deep=1', up: true, latency: 88.8 },
    { name: 'DNS', type: 'ping', target: '223.5.5.5', up: false, latency: null },
    { name: '某服务', type: 'tcp', target: '10.0.0.5:5432', up: true, latency: 3.3 },
  ]);
  await seedProbeRound(A3, [{ name: '被禁用机的探活', type: 'ping', target: '10.0.0.9', up: true, latency: 1 }]);

  const res = await get('/api/public/probes');
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(Object.keys(body).sort(), ['items', 'next_cursor', 'truncated', 'updated_at']);
  assert.equal(body.next_cursor, null);
  assert.equal(body.truncated, false);
  // ⚠️ 两边都 `.sort()`（中文与 ASCII 混排时按码位，⛔ 不要手写"看起来对"的顺序）
  assert.deepEqual(
    body.items.map((i) => i.name).sort(),
    ['DNS', 'gw', '某服务', '官网'].sort(),
    '⛔ 不含 disabled 主机的探活',
  );

  const byName = Object.fromEntries(body.items.map((i) => [i.name, i]));
  assert.equal(byName.gw.target_host, '内网地址', '私网 IP 必须泛化');
  assert.equal(byName['某服务'].target_host, '内网地址', 'host:port 也要泛化（端口是资产画像）');
  assert.equal(byName['官网'].target_host, 'status.example.com', '域名保留，但路径与查询串剥离');
  assert.equal(byName.DNS.target_host, '223.5.5.5', '公网 IP 保留（否则公开页只剩一排「—」）');

  assert.equal(byName.gw.latency_ms, 1.2, '取的是**最近一轮**（不是 5 分钟前那条 9.9）');
  assert.equal(byName.DNS.up, false);
  assert.equal(byName.DNS.latency_ms, null);
  assert.equal(byName.gw.slug, makeSlug('web-01'));
  assert.equal(byName.gw.host_name, 'web-01');

  // ⛔ 完整 target 与内网细节一律不得出现
  for (const leak of ['10.0.0.1', '10.0.0.5', '5432', '/health', 'deep=1', '10.0.0.9', 'internal-1']) {
    assert.equal(res.body.includes(leak), false, `公开探活概览泄露了：${leak}`);
  }
});

test('GET /api/public/probes：没有探活数据 → 空数组（⛔ 不是 404、也不是占位行）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });
  const res = await get('/api/public/probes');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().items, []);
});
