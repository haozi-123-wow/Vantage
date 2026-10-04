/**
 * 私有主机接口测试（`GET /api/v1/hosts`）
 *
 * 依据：docs/api.md §4.2（契约：查询参数、字段表、错误码）、§4.1.1 ②（会话三态矩阵）、
 *       §1.2 ③（`{ items, next_cursor }` 与 limit 口径）、docs/server-status-api.md §2.8/§3.3
 *
 * 本文件重点验**HTTP 层**的三件事（推导口径已由 `test/status.service.test.js` 钉死）：
 *   ① 会话三态：未登录 401、`totp_pending` 403、`setup_required` 403（复用既有中间件，⛔ 不另写判定）；
 *   ② 参数校验：`status` / `limit` / `q` 的 400 与夹取口径（⚠️ `coerceTypes:false` ⇒ 必须手写校验）；
 *   ③ 响应 schema 把可返回字段**结构性钉死** —— 凭证列与 host_info 整体回显不可能混进来。
 *
 * ⚠️ 会话**直接由 `createSession()` 铸造**而不是走一遍登录：本文件要验的是 `/hosts` 的鉴权与参数，
 *    登录链路（限流、人机验证、审计）已由 `test/auth*.test.js` 覆盖，这里再走一遍只会引入
 *    与限流计数相关的偶发失败（同一 IP 连续登录会撞 `ratelimit:login`）。
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
import { PANEL_LIMIT_MAX } from '../src/services/status.service.js';
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
    SECRET_KEY: Buffer.alloc(32, 9).toString('base64'),
  },
  { skipEnvFile: true },
);
const COOKIE = sessionCookieName(CONFIG);

const USER_ID = '55555555-6666-7777-8888-999999999900';
const A1 = '55555555-6666-7777-8888-999999999901';
const A2 = '55555555-6666-7777-8888-999999999902';
const A3 = '55555555-6666-7777-8888-999999999903';
const ALL = [A1, A2, A3];
const AGENT_KEY_HASH = 'a1b2c3d4e5f60718'.repeat(4);

function makeSlug(seed) {
  let x = 13;
  for (const ch of String(seed)) x = (x * 31 + ch.codePointAt(0)) % 2_147_483_647;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_647;
    out += PUBLIC_SLUG_ALPHABET[x % PUBLIC_SLUG_ALPHABET.length];
  }
  return out;
}

async function seedAgent({ id, name, status = 'online', ageSeconds = 5, displayName = null, tags = [], hostInfo = null, lastIp = null, clockDrift = null }) {
  await run(
    `INSERT INTO agents
       (id, name, public_slug, display_name, agent_key_hash, agent_secret_enc, tags, status,
        last_seen_at, disabled_at, host_info, last_ip, clock_drift_ms)
     VALUES ($1, $2, $3, $4, $5, 'v1:AAAA:BBBB:CCCC', $6::jsonb, $7,
             CASE WHEN $8::int IS NULL THEN NULL ELSE now() - make_interval(secs => $8::double precision) END,
             CASE WHEN $9::boolean THEN now() ELSE NULL END,
             $10::jsonb, $11::inet, $12)`,
    [
      id,
      name,
      makeSlug(name),
      displayName,
      AGENT_KEY_HASH,
      JSON.stringify(tags),
      status,
      ageSeconds,
      status === 'disabled',
      hostInfo ? JSON.stringify(hostInfo) : null,
      lastIp,
      clockDrift,
    ],
  );
}

let app = null;
let redis = null;

beforeEach(async () => {
  if (app) await app.close();
  await run(`DELETE FROM metrics_raw WHERE agent_id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM probe_results WHERE agent_id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [ALL]);

  redis = createFakeRedisHash();
  app = await buildApp({ config: CONFIG, logger: SILENT, db: { app: pool, migrator: null }, redis });
});

/** 造一个会话并返回可直接用于 inject 的 cookies（`full` / `totp_pending` / `setup_required` 三态） */
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
// 鉴权与三态（复用既有中间件）
// -----------------------------------------------------------------------------

test('未登录 → 401 session_expired（⛔ 不是 403、也不是空列表）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  const res = await get('/api/v1/hosts');
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'session_expired');
});

test('会话三态：totp_pending → 403 totp_required；setup_required → 403 totp_setup_required', async () => {
  await seedAgent({ id: A1, name: 'web-01' });

  const pending = await get('/api/v1/hosts', await mintSession('totp_pending'));
  assert.equal(pending.statusCode, 403);
  assert.equal(pending.json().error.code, 'totp_required');

  const setup = await get('/api/v1/hosts', await mintSession('setup_required'));
  assert.equal(setup.statusCode, 403);
  assert.equal(setup.json().error.code, 'totp_setup_required');
});

test('完整会话 → 200，且响应含运维字段（IP / 漂移 / Flapping / 活动告警 / 内部 UUID）', async () => {
  await seedAgent({
    id: A1,
    name: 'web-01',
    displayName: '前端甲',
    tags: ['prod'],
    ageSeconds: 5,
    lastIp: '203.0.113.10',
    clockDrift: -250,
    hostInfo: { hostname: 'internal-1', os: 'Ubuntu 24.04', kernel: 'k', arch: 'x86_64', boot_time: 1_700_000_000, device: 'nvme-XYZ' },
  });

  const res = await get('/api/v1/hosts', await mintSession());
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(Object.keys(body).sort(), ['items', 'next_cursor', 'updated_at']);
  const host = body.items[0];
  assert.equal(host.id, A1, '私有接口必须给出内部 UUID');
  assert.equal(host.slug, makeSlug('web-01'), '同时也带公开 slug（两边表格组件复用）');
  assert.equal(host.display_name, '前端甲');
  assert.deepEqual(host.tags, ['prod']);
  assert.equal(host.status, 'online');
  assert.equal(host.os, 'Ubuntu 24.04');
  assert.equal(host.arch, 'x86_64');
  assert.equal(host.last_ip, '203.0.113.10');
  assert.equal(host.clock_drift_ms, -250, '符号口径：负值 = Agent 慢');
  assert.equal(host.ip_flapping, false);
  assert.equal(host.flapping_since, null);
  assert.equal(host.active_alerts, 0);
  assert.equal(typeof host.uptime, 'number');
  assert.equal(body.next_cursor, null);
});

test('⛔ 私有响应也不得出现凭证列或 host_info 原始对象（hostname/device 逐字段投影）', async () => {
  await seedAgent({
    id: A1,
    name: 'web-01',
    hostInfo: { hostname: 'internal-1', os: 'Ubuntu 24.04', kernel: 'k', boot_time: 1_700_000_000, device: 'nvme-XYZ' },
  });

  const res = await get('/api/v1/hosts', await mintSession());
  const text = res.body;
  assert.equal(text.includes(AGENT_KEY_HASH), false);
  assert.equal(text.includes('v1:AAAA:BBBB:CCCC'), false);
  assert.equal(text.includes('internal-1'), false, '⛔ host_info 必须逐字段投影，⛔ 不得整体回显');
  assert.equal(text.includes('nvme-XYZ'), false);
  for (const key of ['agent_key_hash', 'agent_secret_enc', 'host_info', 'capabilities', 'last_agent_ts']) {
    assert.equal(key in res.json().items[0], false, `私有条目不得含字段 ${key}`);
  }
});

// -----------------------------------------------------------------------------
// 参数校验（⚠️ coerceTypes:false ⇒ 手写校验）
// -----------------------------------------------------------------------------

test('?status= 只接受三态，非法取值 → 400 schema_invalid（⛔ 不静默忽略）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  const res = await get('/api/v1/hosts?status=magic', await mintSession());
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  assert.deepEqual(res.json().error.details.allowed, ['online', 'offline', 'disabled']);
});

test('?limit= 非正整数 → 400；超上限 → 夹取到 200（⛔ 不因为"要得太多"就拒绝整个请求）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  const cookies = await mintSession();

  for (const bad of ['abc', '-1', '0', '1.5']) {
    const res = await get(`/api/v1/hosts?limit=${encodeURIComponent(bad)}`, cookies);
    assert.equal(res.statusCode, 400, `limit=${bad} 必须被拒`);
    assert.equal(res.json().error.code, 'schema_invalid');
  }

  // ⚠️ 空串按**未提供**处理（与 `?q=` / `?tag=` 同一口径）：前端"清空筛选"时不该报错
  const empty = await get('/api/v1/hosts?limit=', cookies);
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().items.length, 1);

  const clamped = await get(`/api/v1/hosts?limit=${PANEL_LIMIT_MAX + 500}`, cookies);
  assert.equal(clamped.statusCode, 200, '超上限只夹取，不报错');
  assert.equal(clamped.json().items.length, 1);

  const ok = await get('/api/v1/hosts?limit=1', cookies);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().items.length, 1);
});

test('?q= 超长（>64）→ 400；重复参数（数组）→ 400（⛔ 不"取第一个"）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  const cookies = await mintSession();

  const tooLong = await get(`/api/v1/hosts?q=${'x'.repeat(65)}`, cookies);
  assert.equal(tooLong.statusCode, 400);

  const repeated = await get('/api/v1/hosts?status=online&status=offline', cookies);
  assert.equal(repeated.statusCode, 400);
});

test('?cursor= 本期被**忽略**（⛔ 不返回 400 —— 前端骨架已经带着它）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  const res = await get('/api/v1/hosts?cursor=anything', await mintSession());
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().next_cursor, null, '形状合规但没有下一页');
});

test('未知查询参数被忽略（不 400）：前端可能带缓存击穿参数', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  const res = await get('/api/v1/hosts?_t=1730000000&foo=bar', await mintSession());
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().items.length, 1);
});

// -----------------------------------------------------------------------------
// 过滤与开关交互
// -----------------------------------------------------------------------------

test('过滤生效：?status= / ?tag= / ?q= 组合（HTTP 层透传 + LIKE 转义）', async () => {
  await seedAgent({ id: A1, name: 'web-01', tags: ['prod'], ageSeconds: 5 });
  await seedAgent({ id: A2, name: 'db-02', tags: ['prod'], status: 'offline', ageSeconds: 400 });
  await seedAgent({ id: A3, name: 'dev-03', tags: ['dev'], ageSeconds: 5 });
  const cookies = await mintSession();

  const online = await get('/api/v1/hosts?status=online', cookies);
  assert.deepEqual(online.json().items.map((i) => i.id).sort(), [A1, A3].sort());

  const prod = await get('/api/v1/hosts?tag=prod', cookies);
  assert.deepEqual(prod.json().items.map((i) => i.id).sort(), [A1, A2].sort());

  const search = await get('/api/v1/hosts?q=web', cookies);
  assert.deepEqual(search.json().items.map((i) => i.id), [A1]);

  // `_` 必须按字面匹配（前端传原样文本，转义在服务端做）
  const underscore = await get('/api/v1/hosts?q=web_01', cookies);
  assert.deepEqual(underscore.json().items, [], 'web-01 不得被 web_01 命中（`_` 不是通配符）');

  // 空串按"未提供"处理（搜索框清空后照原样提交是常见行为）：⛔ 不 400、也不返回空列表
  const emptyQ = await get('/api/v1/hosts?q=', cookies);
  assert.equal(emptyQ.statusCode, 200);
  assert.equal(emptyQ.json().items.length, 3);
  const emptyTag = await get('/api/v1/hosts?tag=', cookies);
  assert.equal(emptyTag.statusCode, 200);
  assert.equal(emptyTag.json().items.length, 3);
});

test('私有接口不受公开总开关影响（关掉公开视图后面板照常用）', async () => {
  await seedAgent({ id: A1, name: 'web-01' });
  await run(`INSERT INTO settings (key, value) VALUES ('public_view.enabled', 'false'::jsonb)`);
  // ⚠️ 故意**不**失效 settings 缓存之外的东西：私有路由根本不读这个开关
  const res = await get('/api/v1/hosts', await mintSession());
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().items.length, 1);
});
