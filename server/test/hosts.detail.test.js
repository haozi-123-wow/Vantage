/**
 * 主机纵深接口测试（`/api/v1/summary` 与 `/api/v1/hosts/{id}` 的四个子端点）
 *
 * 依据：docs/api.md §4.2（详情 / 探活历史 / IP 历史 / 进程 Top）、§1.2 ③（列表形状与 limit 口径）、
 *       §4.1.1 ②（会话三态矩阵）、docs/frontend.md §4.4（详情页六个区块的数据来源）
 *
 * 本文件用**真 PGlite + 真 buildApp**：要验的结论全都长在"SQL 与 HTTP 的交界处"——
 *   ① 可用率必须按**整个窗口**算（而不是按被截断后返回的那几个点）；
 *   ② `at` 语义是"该时刻**之前**最近一条"（⛔ 不是"恰好等于"）；
 *   ③ 主机不存在 → 404，而"主机存在但没有该项数据" → 200 + `null` 字段（两者不可混淆）。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { sessionCookieName } from '../src/middleware/authPanel.js';
import { createSession } from '../src/services/session.service.js';
import { PROBE_HISTORY_MAX_POINTS } from '../src/services/status.service.js';
import { PUBLIC_SLUG_ALPHABET } from '../src/utils/crypto.js';
import { createLogger } from '../src/utils/log.js';
import { createFakeRedisHash } from './helpers/fake-redis-hash.js';

// -----------------------------------------------------------------------------
// 真库（PGlite）
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
const CONFIG = loadConfig(
  {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 21).toString('base64'),
  },
  { skipEnvFile: true },
);
const COOKIE = sessionCookieName(CONFIG);

const USER_ID = '66666666-7777-8888-9999-aaaaaaaaaa00';
const A1 = '66666666-7777-8888-9999-aaaaaaaaaa01'; // 被测主机
const A2 = '66666666-7777-8888-9999-aaaaaaaaaa02'; // 对照组（disabled / 另一台在线机）
const ALL = [A1, A2];
const MISSING = '66666666-7777-8888-9999-aaaaaaaaaa09'; // 库里不存在的主机

function makeSlug(seed) {
  let x = 17;
  for (const ch of String(seed)) x = (x * 31 + ch.codePointAt(0)) % 2_147_483_647;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_647;
    out += PUBLIC_SLUG_ALPHABET[x % PUBLIC_SLUG_ALPHABET.length];
  }
  return out;
}

async function seedAgent(input) {
  const { id, name, status = 'online', ageSeconds = 5, tags = ['prod'], hostInfo = null, capabilities = null } = input;
  await run(
    `INSERT INTO agents
       (id, name, public_slug, agent_key_hash, agent_secret_enc, tags, status, last_seen_at, disabled_at,
        host_info, capabilities, last_ip, reported_ip)
     VALUES ($1, $2, $3, $4, 'v1:AAAA:BBBB:CCCC', $5::jsonb, $6,
             CASE WHEN $7::int IS NULL THEN NULL ELSE now() - make_interval(secs => $7::double precision) END,
             CASE WHEN $8::boolean THEN now() ELSE NULL END,
             $9::jsonb, $10::jsonb, '203.0.113.7'::inet, '198.51.100.7'::inet)`,
    [
      id,
      name,
      makeSlug(name),
      'b'.repeat(64),
      JSON.stringify(tags),
      status,
      ageSeconds,
      status === 'disabled',
      hostInfo ? JSON.stringify(hostInfo) : null,
      capabilities ? JSON.stringify(capabilities) : null,
    ],
  );
}

let app = null;
let redis = null;

beforeEach(async () => {
  if (app) await app.close();
  await run(`DELETE FROM probe_results WHERE agent_id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM metrics_raw WHERE agent_id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM process_snapshots WHERE agent_id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM ip_change_events WHERE agent_id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM agent_ip_history WHERE agent_id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [ALL]);

  redis = createFakeRedisHash();
  app = await buildApp({ config: CONFIG, logger: SILENT, db: { app: pool, migrator: null }, redis });
});

async function mintSession(state = 'full') {
  const { sid } = await createSession(redis, CONFIG, {
    userId: USER_ID,
    roles: ['admin'],
    totpOk: state === 'full',
    setupRequired: state === 'setup_required',
  });
  return { [COOKIE]: sid };
}

const get = (url, cookies) => app.inject({ method: 'GET', url, cookies: cookies ?? {} });

// -----------------------------------------------------------------------------
// GET /api/v1/summary
// -----------------------------------------------------------------------------

test('GET /api/v1/summary：200 + 形状与公开汇总一致，且 total 自洽（⛔ 不靠"数当前页"）', async () => {
  await seedAgent({ id: A1, name: 'web-01', status: 'online', ageSeconds: 5 });
  await seedAgent({ id: A2, name: 'old-02', status: 'disabled', ageSeconds: 5 });

  const res = await get('/api/v1/summary', await mintSession());
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(Object.keys(body).sort(), ['alerts', 'disabled', 'offline', 'online', 'total', 'updated_at']);
  assert.deepEqual(
    { total: body.total, online: body.online, offline: body.offline, disabled: body.disabled },
    { total: 2, online: 1, offline: 0, disabled: 1 },
  );
  assert.equal(body.total, body.online + body.offline + body.disabled);
  assert.deepEqual(body.alerts, { critical: 0, warn: 0, info: 0 }, '告警引擎在 M3：本期只能断言"存在且为 0"');
});

test('GET /api/v1/summary：未登录 401、受限态 403（与列表同一套三态守卫）', async () => {
  assert.equal((await get('/api/v1/summary')).statusCode, 401);
  assert.equal((await get('/api/v1/summary', await mintSession('totp_pending'))).statusCode, 403);
  assert.equal((await get('/api/v1/summary', await mintSession('setup_required'))).json().error.code, 'totp_setup_required');
});

// -----------------------------------------------------------------------------
// GET /api/v1/hosts/{id}
// -----------------------------------------------------------------------------

test('GET /api/v1/hosts/{id}：列表条目 + host_info/capabilities/current_metrics（键是**指标全名**）', async () => {
  await seedAgent({
    id: A1,
    name: 'web-01',
    hostInfo: { hostname: 'internal-1', os: 'Ubuntu 24.04', kernel: '6.8.0', arch: 'x86_64', boot_time: 1_700_000_000 },
    capabilities: { 'gpu.nvidia': true, 'probe.http': true },
  });
  for (const [metric, value] of [
    ['cpu.usage', 23.84],
    ['mem.used_pct', 38.1],
    ['disk.used_pct{device=sda1,mount=/}', 61.4],
    ['disk.used_pct{device=sdb1,mount=/data}', 80.04],
    ['net.rx_bps{device=eth0}', 1_000_000.4],
    ['gpu.util{index=0}', 44.44],
  ]) {
    await run(
      `INSERT INTO metrics_raw (agent_id, metric, value, ts)
       VALUES ($1::uuid, $2, $3, now() - interval '10 seconds')`,
      [A1, metric, value],
    );
  }

  const res = await get(`/api/v1/hosts/${A1}`, await mintSession());
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // 列表字段一个不少（前端同一张表格组件两边复用）
  assert.equal(body.id, A1);
  assert.equal(body.slug, makeSlug('web-01'));
  assert.equal(body.status, 'online');
  assert.equal(body.display_name, null);
  assert.deepEqual(body.tags, ['prod']);
  assert.equal(body.last_ip, '203.0.113.7');
  assert.equal(body.os, 'Ubuntu 24.04');
  assert.equal(body.arch, 'x86_64');
  assert.deepEqual(body.snapshot.disk_pct, 80, '五槽位快照与列表同源（MAX）');
  assert.equal(typeof body.updated_at, 'string');

  // 纵深字段
  assert.equal(body.host_info.hostname, 'internal-1', '私有域允许给原始 host 快照（排障需要）');
  assert.deepEqual(body.capabilities, { 'gpu.nvidia': true, 'probe.http': true });
  assert.deepEqual(
    Object.keys(body.current_metrics).sort(),
    [
      'cpu.usage',
      'disk.used_pct{device=sda1,mount=/}',
      'disk.used_pct{device=sdb1,mount=/data}',
      'gpu.util{index=0}',
      'mem.used_pct',
      'net.rx_bps{device=eth0}',
    ],
    '⛔ 私有详情给的是原始指标全名（含 device/mount），公开侧才做泛化',
  );
  assert.equal(body.current_metrics['disk.used_pct{device=sdb1,mount=/data}'], 80);
});

test('GET /api/v1/hosts/{id}：不存在 → 404；id 不是 UUID → 400 schema_invalid（⛔ 不撞 SQL 的 22P02）', async () => {
  const cookies = await mintSession();

  const missing = await get(`/api/v1/hosts/${MISSING}`, cookies);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'not_found');

  for (const bad of ['not-a-uuid', '123', '66666666-7777-8888-9999-aaaaaaaaaa0']) {
    const res = await get(`/api/v1/hosts/${bad}`, cookies);
    assert.equal(res.statusCode, 400, `${bad} 必须被 schema 拒掉`);
    assert.equal(res.json().error.code, 'schema_invalid');
  }
});

// -----------------------------------------------------------------------------
// GET /api/v1/hosts/{id}/probes
// -----------------------------------------------------------------------------

async function seedProbeRound(name, ageSeconds, results) {
  await run(
    `INSERT INTO probe_results (agent_id, probe_name, probe_type, target, up, latency_ms, status_code, error, checked_at)
     SELECT $1::uuid, $2, $3, $4, s.up, s.latency, s.status_code, s.error,
            now() - make_interval(secs => $5::double precision)
       FROM unnest($6::boolean[], $7::float8[], $8::int[], $9::text[])
              AS s(up, latency, status_code, error)`,
    [
      A1,
      name,
      name === 'gw' ? 'ping' : 'https',
      name === 'gw' ? '10.0.0.1' : 'https://status.example.com/health',
      ageSeconds,
      results.map((r) => r.up),
      results.map((r) => r.latency ?? null),
      results.map((r) => r.status_code ?? null),
      results.map((r) => r.error ?? null),
    ],
  );
}

test('GET /api/v1/hosts/{id}/probes：按 probe 分组 + 可用率 + 最近一次（结果按时间倒序）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  await seedProbeRound('gw', 300, [{ up: true, latency: 1.2 }]);
  await seedProbeRound('gw', 200, [{ up: false, latency: null, error: 'timeout' }]);
  await seedProbeRound('gw', 100, [{ up: true, latency: 1.5 }]);
  await seedProbeRound('api', 150, [{ up: false, latency: 900, status_code: 503, error: 'bad status' }]);

  const res = await get(`/api/v1/hosts/${A1}/probes`, await mintSession());
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(Object.keys(body).sort(), ['from', 'host_id', 'items', 'to', 'truncated', 'updated_at']);
  assert.equal(body.truncated, false);
  assert.equal(body.items.length, 2);
  // 分组顺序 = SQL 的 probe_name 升序（api 在前），前端无需再排
  assert.deepEqual(body.items.map((i) => i.name), ['api', 'gw']);

  const gw = body.items.find((i) => i.name === 'gw');
  assert.equal(gw.type, 'ping');
  assert.equal(gw.target, '10.0.0.1');
  assert.deepEqual(gw.availability.total, 3);
  assert.equal(gw.availability.up, 2);
  assert.equal(gw.availability.down, 1);
  assert.equal(gw.availability.ratio, 0.6667);
  assert.equal(gw.latest.up, true, '最近一次（100s 前）是 up');
  assert.equal(gw.latest.latency_ms, 1.5);
  assert.deepEqual(gw.results.map((r) => r.up), [true, false, true], 'results 按时间倒序');

  const api = body.items.find((i) => i.name === 'api');
  assert.equal(api.type, 'https');
  assert.equal(api.latest.status_code, 503);
  assert.equal(api.latest.error, 'bad status');
  assert.equal(api.availability.ratio, 0);
});

test('GET .../probes：可用率按**整个窗口**算 —— 结果被截断时不得虚高（⛔ 这是最容易搞错的一条）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  // 造 MAX+1 次探活：只有最早那一次是 down，其余全 up
  await run(
    `INSERT INTO probe_results (agent_id, probe_name, probe_type, target, up, checked_at)
     SELECT $1::uuid, 'gw', 'ping', '10.0.0.1', (g <> 1),
            now() - make_interval(secs => g::double precision)
       FROM generate_series(1, $2::int) AS g`,
    [A1, PROBE_HISTORY_MAX_POINTS + 1],
  );

  const res = await get(`/api/v1/hosts/${A1}/probes`, await mintSession());
  const body = res.json();
  const gw = body.items[0];

  assert.equal(body.truncated, true, '超过上限必须显式告知（⛔ 不静默丢数据）');
  assert.equal(gw.truncated, true);
  assert.equal(gw.results.length, PROBE_HISTORY_MAX_POINTS, '只返回最近 N 个点');
  assert.equal(gw.availability.total, PROBE_HISTORY_MAX_POINTS + 1, '可用率的分母是**整窗口**的探活次数');
  assert.equal(gw.availability.down, 1, '被截断掉的那次失败仍要计入 —— 否则可用率会虚高成 100%');
  assert.ok(gw.availability.ratio < 1);
});

test('GET .../probes：name/type 过滤生效；非法 type → 400；窗口超限 → 400 range_too_large', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  await seedProbeRound('gw', 100, [{ up: true }]);
  await seedProbeRound('api', 100, [{ up: true }]);
  const cookies = await mintSession();

  const onlyGw = await get(`/api/v1/hosts/${A1}/probes?name=gw`, cookies);
  assert.deepEqual(onlyGw.json().items.map((i) => i.name), ['gw']);

  const onlyPing = await get(`/api/v1/hosts/${A1}/probes?type=ping`, cookies);
  assert.deepEqual(onlyPing.json().items.map((i) => i.name), ['gw']);

  const badType = await get(`/api/v1/hosts/${A1}/probes?type=quic`, cookies);
  assert.equal(badType.statusCode, 400);
  assert.equal(badType.json().error.code, 'schema_invalid');

  // 40 天 > 30 天上限 → range_too_large（⛔ 不是 400 schema_invalid：参数合法，是范围问题）
  const tooWide = await get(
    `/api/v1/hosts/${A1}/probes?from=${encodeURIComponent(new Date(Date.now() - 40 * 86400_000).toISOString())}`,
    cookies,
  );
  assert.equal(tooWide.statusCode, 400);
  assert.equal(tooWide.json().error.code, 'range_too_large');

  // 不带时区的裸时间串必须被拒（否则会按运行环境时区解释 → 整整 8 小时的数据错位）
  const naive = await get(`/api/v1/hosts/${A1}/probes?from=${encodeURIComponent('2026-10-04 12:00:00')}`, cookies);
  assert.equal(naive.statusCode, 400);
  assert.equal(naive.json().error.details.reason, 'timezone_required');
});

test('GET .../probes：窗口内没有任何探活 → items 为空、ratio 为 null（⛔ 不是 1）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  await seedProbeRound('gw', 100, [{ up: true }]);

  const res = await get(
    `/api/v1/hosts/${A1}/probes?from=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`,
    await mintSession(),
  );
  const body = res.json();
  assert.equal(res.statusCode, 200);
  // 100s 前那条其实在 1h 窗口内；这条断言用"只查 10 分钟前到 5 分钟前"的空窗口
  assert.equal(Array.isArray(body.items), true);

  const empty = await get(
    `/api/v1/hosts/${A1}/probes?from=${encodeURIComponent(new Date(Date.now() - 600_000).toISOString())}` +
      `&to=${encodeURIComponent(new Date(Date.now() - 300_000).toISOString())}`,
    await mintSession(),
  );
  assert.deepEqual(empty.json().items, [], '窗口外不返回 —— 也不编造一行 100% 可用');
});

// -----------------------------------------------------------------------------
// GET /api/v1/hosts/{id}/ip-history
// -----------------------------------------------------------------------------

test('GET /api/v1/hosts/{id}/ip-history：区间 + 事件 + 当前 IP（两个列表语义不同，⛔ 不要试图对齐行数）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  await run(
    `INSERT INTO agent_ip_history (agent_id, ip, source, first_seen, last_seen)
     VALUES ($1::uuid, '203.0.113.7'::inet, 'remote', now() - interval '3 days', now()),
            ($1::uuid, '203.0.113.8'::inet, 'remote', now() - interval '10 days', now() - interval '4 days'),
            ($1::uuid, '198.51.100.7'::inet, 'agent_reported', now() - interval '3 days', now() - interval '1 minute')`,
    [A1],
  );
  await run(
    `INSERT INTO ip_change_events (agent_id, old_ip, new_ip, same_subnet, changed_at, source, kind, change_count)
     VALUES ($1::uuid, '203.0.113.8'::inet, '203.0.113.7'::inet, TRUE, now() - interval '3 days', 'remote', 'change', 1),
            ($1::uuid, '203.0.113.7'::inet, '10.0.0.9'::inet, FALSE, now() - interval '2 days', 'remote', 'flapping', 4)`,
    [A1],
  );

  const res = await get(`/api/v1/hosts/${A1}/ip-history`, await mintSession());
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.current_ip, '203.0.113.7', '当前 IP 取自 agents 行（与列表同源）');
  assert.equal(body.reported_ip, '198.51.100.7');
  assert.equal(body.ip_flapping, false);
  assert.equal(body.flapping_since, null);

  assert.equal(body.intervals.length, 3);
  // ⚠️ 排序是 `last_seen DESC, ip ASC` —— 测试数据必须让 last_seen 不相等，
  //    否则断言会落在"同秒时的 IP 字典序"上（看起来像排序错了）
  assert.equal(body.intervals[0].ip, '203.0.113.7', '按 last_seen 倒序');
  assert.equal(body.intervals[0].source, 'remote');
  assert.equal(body.intervals[1].ip, '198.51.100.7', '同一地址不同来源是**两行**（双源比对的基础数据）');
  assert.equal(body.intervals[1].source, 'agent_reported');
  assert.ok(body.intervals[0].first_seen < body.intervals[0].last_seen);

  assert.equal(body.events.length, 2);
  assert.equal(body.events[0].kind, 'flapping', '按 changed_at 倒序（最近的在最前）');
  assert.equal(body.events[0].change_count, 4);
  assert.equal(body.events[0].same_subnet, false);
  assert.equal(body.events[1].old_ip, '203.0.113.8');
  assert.equal(body.events[1].new_ip, '203.0.113.7');
  assert.equal(body.events[1].same_subnet, true);
});

test('GET .../ip-history：从未有过 IP 记录 → 200 + 空数组（⛔ 不是 404）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  const res = await get(`/api/v1/hosts/${A1}/ip-history`, await mintSession());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().intervals, []);
  assert.deepEqual(res.json().events, []);
});

test('GET .../ip-history：limit 非法 → 400；超上限 → 夹取（不报错）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  const cookies = await mintSession();
  assert.equal((await get(`/api/v1/hosts/${A1}/ip-history?limit=0`, cookies)).statusCode, 400);
  assert.equal((await get(`/api/v1/hosts/${A1}/ip-history?limit=abc`, cookies)).statusCode, 400);
  assert.equal((await get(`/api/v1/hosts/${A1}/ip-history?limit=99999`, cookies)).statusCode, 200);
});

// -----------------------------------------------------------------------------
// GET /api/v1/hosts/{id}/processes
// -----------------------------------------------------------------------------

test('GET /api/v1/hosts/{id}/processes：默认取最近一条；`at` 取"该时刻之前最近一条"', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  await run(
    `INSERT INTO process_snapshots (agent_id, ts, total, top)
     VALUES ($1::uuid, now() - interval '2 hours', 100, $2::jsonb),
            ($1::uuid, now() - interval '1 hour',  231, $3::jsonb)`,
    [
      A1,
      JSON.stringify([{ pid: 1, name: 'init', cpu: 0.1, mem: 1.2 }]),
      JSON.stringify([{ pid: 42, name: 'nginx', cpu: 4.5, mem: 8.8 }]),
    ],
  );
  const cookies = await mintSession();

  const latest = await get(`/api/v1/hosts/${A1}/processes`, cookies);
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.json().total, 231);
  assert.deepEqual(latest.json().top, [{ pid: 42, name: 'nginx', cpu: 4.5, mem: 8.8 }]);

  // `at` = 90 分钟前（在两次采样之间）⇒ 应取"2 小时前"那一条，而不是"没有数据"
  const at = new Date(Date.now() - 90 * 60_000).toISOString();
  const historical = await get(`/api/v1/hosts/${A1}/processes?at=${encodeURIComponent(at)}`, cookies);
  assert.equal(historical.statusCode, 200);
  assert.equal(historical.json().total, 100, '`at` 语义是"该时刻之前最近一条"，⛔ 不是"恰好等于"');
  assert.deepEqual(historical.json().top.map((p) => p.name), ['init']);

  // 未来的时间戳 ⇒ 参数写错了（返回 null 会被误读成"数据缺失"）
  const future = new Date(Date.now() + 3600_000).toISOString();
  const bad = await get(`/api/v1/hosts/${A1}/processes?at=${encodeURIComponent(future)}`, cookies);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.details.reason, 'in_future');
});

test('GET .../processes：保留期外 / 从未采集 → 200 且 at/total/top 同时为 null（⛔ 不是 0 与 []）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  const res = await get(`/api/v1/hosts/${A1}/processes`, await mintSession());
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.at, null);
  assert.equal(body.total, null);
  assert.equal(body.top, null, '"没有采集到"必须与"那一刻确实没有进程"（[]）区分开');
});

test('GET .../processes：主机不存在 → 404（与"没有数据"的 200 明确分开）', async () => {
  const res = await get(`/api/v1/hosts/${MISSING}/processes`, await mintSession());
  assert.equal(res.statusCode, 404);
});
