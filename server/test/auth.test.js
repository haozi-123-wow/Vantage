/**
 * 面板认证路由测试（B4 登录/me/登出 + B5 改密）
 *
 * 依据：docs/api.md §4.1（契约：响应形状、错误码、CSRF、限流、审计）、§4.1.1 ②（三态矩阵）、⑦（B4/B5 验收）
 *
 * 为什么用 **真 PGlite + 真 buildApp** 而不是桩 PG：
 *   这里要验证的契约几乎都"长在 SQL 与 HTTP 的交界处"——`lower(username)` 命中、审计行真的落库、
 *   `settings` 表的覆盖值真的会翻转登录行为、响应 schema 真的把敏感列挡在外面。
 *   桩只能证明"函数被调用过"；PGlite 证明的是"这条链路在 PostgreSQL 上成立"。
 *   Redis 侧用内存替身（会话语义已在 test/session.test.js 钉死，这里不重复）。
 *
 * ⚠️ 每条用例独立：beforeEach 清空 users/settings/audit_logs 并重建 app 与 Redis 替身
 *   （登录限流按 IP 计数，若共用实例，前面用例的登录会污染限流计数）。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { sessionCookieName } from '../src/middleware/authPanel.js';
import { invalidateSettingsCache } from '../src/services/settings.service.js';
import { enableTotp, insertUser, setTotpSecret } from '../src/repositories/user.repo.js';
import { hashPassword } from '../src/utils/crypto.js';
import { keys } from '../src/utils/redisKeys.js';
import { createLogger } from '../src/utils/log.js';
import { createFakeRedisHash } from './helpers/fake-redis-hash.js';

// -----------------------------------------------------------------------------
// 真库（PGlite）准备：与生产同一条迁移代码路径
// -----------------------------------------------------------------------------
const db = await PGlite.create();
await db.exec('CREATE ROLE vantage_migrator LOGIN; CREATE ROLE vantage_app LOGIN; CREATE ROLE vantage_ro LOGIN;');
await db.exec(BOOTSTRAP_SQL);

const migrations = loadMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
const migratorClient = {
  query: (sql, params) => (Array.isArray(params) && params.length > 0 ? db.query(sql, params) : db.exec(sql)),
};
for (const migration of migrations) {
  await applyOne(migratorClient, migration, false);
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

// -----------------------------------------------------------------------------
// 时钟与替身：每条用例独立（限流计数 / 会话 / 缓存互不污染）
// -----------------------------------------------------------------------------
const START_MS = Date.parse('2026-10-02T12:00:00.000Z');
let now = START_MS;

let app = null;
let redis = null;

beforeEach(async () => {
  if (app) await app.close(); // 上一条用例的实例（Fastify 不持句柄，但显式关闭让生命周期可预期）
  now = START_MS;
  await run('DELETE FROM audit_logs');
  await run('DELETE FROM settings');
  await run('DELETE FROM users');

  redis = createFakeRedisHash({ now: () => now });
  app = await buildApp({
    config: CONFIG,
    logger: SILENT,
    db: { app: pool, migrator: null },
    redis,
  });
});

after(async () => {
  if (app) await app.close();
  await db.close();
});

const CONFIG = loadConfig(
  {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 3).toString('base64'),
  },
  { skipEnvFile: true },
);
const SILENT = createLogger({ level: 'silent' });
const COOKIE = sessionCookieName(CONFIG);
const PASSWORD = 'correct-horse-1';

let seq = 0;

/** 建一个真实账号（真 Argon2 哈希）；totp=true 时把 TOTP 绑定置为"已启用" */
async function seedUser({ username = `user${(seq += 1)}`, role = 'admin', totp = false, displayName = null } = {}) {
  const row = await insertUser(pool, {
    username,
    passwordHash: await hashPassword(PASSWORD),
    role,
    displayName,
  });
  if (totp) {
    await setTotpSecret(pool, row.id, 'v1:iv:tag:ct');
    await enableTotp(pool, row.id);
  }
  return { id: row.id, username, role, password: PASSWORD };
}

function sidFrom(res) {
  const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
  const match = new RegExp(`${COOKIE}=([^;]+)`).exec(String(raw));
  return match ? match[1] : null;
}

async function login(username, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
  return { res, sid: sidFrom(res), csrf: res.json().csrf ?? null, body: res.json() };
}

const withSid = (sid) => ({ cookies: { [COOKIE]: sid } });
const withCsrf = (csrf) => ({ headers: { 'x-csrf-token': csrf } });

async function auditRows(action) {
  const { rows } = await run(
    `SELECT action, actor, actor_type, target, ip, detail FROM audit_logs WHERE action = $1 ORDER BY id`,
    [action],
  );
  return rows;
}

// -----------------------------------------------------------------------------
// B4：login
// -----------------------------------------------------------------------------

test('login 成功：响应形状、Cookie 属性、last_login、审计全链路', async () => {
  const user = await seedUser({ displayName: '管理员甲' });
  const { res, sid, body } = await login(user.username);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(body).sort(), ['csrf', 'roles', 'totp_required', 'user']);
  assert.equal(body.totp_required, false);
  assert.deepEqual(body.roles, ['admin']);
  assert.deepEqual(body.user, {
    id: user.id,
    username: user.username,
    display_name: '管理员甲',
    role: 'admin',
    status: 'active',
    totp_enabled: false,
  });
  assert.ok(body.csrf.length >= 24);

  const setCookie = String(res.headers['set-cookie']);
  assert.match(setCookie, new RegExp(`^${COOKIE}=`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);
  assert.equal(/Domain=/i.test(setCookie), false, '⛔ 不设 Domain（避免子域共享会话）');
  assert.equal(sid.length >= 40, true, 'sid 是 256-bit 随机值的 base64url（43 字符）');

  const row = (await run(`SELECT last_login_at, last_login_ip, last_login_method FROM users WHERE id = $1`, [user.id])).rows[0];
  assert.ok(row.last_login_at instanceof Date);
  assert.equal(row.last_login_ip, '127.0.0.1');
  assert.equal(row.last_login_method, 'password');

  const audits = await auditRows('auth.login');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, user.id);
  assert.equal(audits[0].target, user.username);
  assert.equal(audits[0].detail.totp_required, false);
});

test('login：登录名大小写不敏感，响应回显库内原始写法', async () => {
  const user = await seedUser({ username: 'MixedCase' });
  const { res, body } = await login('mixedcase');
  assert.equal(res.statusCode, 200);
  assert.equal(body.user.username, user.username);
});

test('login：密码错 / 账号不存在 / 已禁用 → 同码同文，⛔ 无任何账号线索', async () => {
  const user = await seedUser();
  await run(`UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1`, [user.id]);

  const wrongPw = await login(user.username, 'wrong-password-1');
  const noUser = await login('no-such-user-9', 'whatever-pw-1');
  const disabled = await login(user.username);

  for (const { res } of [wrongPw, noUser, disabled]) {
    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, 'invalid_credentials');
    assert.equal(body.error.details, undefined, '⛔ details 不得携带区分信息');
    assert.equal('user' in body, false);
  }
  assert.equal(wrongPw.body.error.message, noUser.body.error.message);
  assert.equal(wrongPw.body.error.message, disabled.body.error.message);

  // 审计：三条失败都留痕，但 reason 恒同词（审计可被 user 角色读取，⛔ 不能写答案进去）
  const failures = await auditRows('auth.login_failed');
  assert.equal(failures.length, 3);
  for (const row of failures) assert.equal(row.detail.reason, 'invalid_credentials');
});

test('login：已绑定 TOTP → totp_required:true 且 ⛔ 不带 user/roles；受限态下 me 放行、改密被挡', async () => {
  const user = await seedUser({ totp: true });
  const { res, sid, csrf, body } = await login(user.username);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(body).sort(), ['csrf', 'totp_required']);
  assert.equal(body.totp_required, true);

  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(sid) });
  assert.equal(me.statusCode, 200, 'totp_pending 下 me 按 §4.1 放行');
  assert.equal(me.json().user.totp_enabled, true);

  const change = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/password',
    ...withSid(sid),
    ...withCsrf(csrf),
    payload: { old_password: PASSWORD, new_password: 'another-pass-9' },
  });
  assert.equal(change.statusCode, 403);
  assert.equal(change.json().error.code, 'totp_required', '⛔ 过第二步之前不许改密');
});

test('login：限流（✅ 成功与失败都计数）——第 11 次 429 + Retry-After，⛔ 无账号线索', async () => {
  const limit = CONFIG.rateLimit.loginPerWindow;
  for (let i = 0; i < limit; i += 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'no-such-user', password: 'wrong-password' },
    });
    assert.equal(res.statusCode, 401, `第 ${i + 1} 次应仍是 401`);
  }

  const blocked = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'no-such-user', password: 'wrong-password' },
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'rate_limited');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal(blocked.headers['x-ratelimit-limit'], String(limit));
  assert.equal(blocked.headers['x-ratelimit-remaining'], '0');
});

// -----------------------------------------------------------------------------
// B4：me
// -----------------------------------------------------------------------------

test('me：full 态返回 MeResponse 形状（session 元数据 + 与登录响应同源的 csrf）', async () => {
  const user = await seedUser();
  const { sid, csrf } = await login(user.username);

  const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(sid) });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ['csrf', 'roles', 'session', 'user']);
  assert.deepEqual(body.user.id, user.id);
  assert.deepEqual(body.roles, ['admin']);
  assert.deepEqual(Object.keys(body.session).sort(), ['created_at', 'ip', 'last_seen', 'ua']);
  assert.equal(body.session.ip, '127.0.0.1');
  assert.equal(body.csrf, csrf, 'csrf 与登录响应一致（.sid 轮换时也保持稳定）');
  assert.match(body.session.created_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('me：无 Cookie → 401；伪造 Cookie → 401 并下发 Max-Age=0 清除指令', async () => {
  await seedUser();
  const anonymous = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'session_expired');

  const forged = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid('forged-sid') });
  assert.equal(forged.statusCode, 401);
  assert.match(String(forged.headers['set-cookie']), /Max-Age=0/i);
});

test('me：require_2fa=true 且未绑定 → 403 totp_setup_required（D2）；改密被挡、登出仍可用', async () => {
  const user = await seedUser();
  await run(`INSERT INTO settings (key, value) VALUES ('security.require_2fa', 'true'::jsonb)`);

  const { sid, csrf } = await login(user.username);
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(sid) });
  assert.equal(me.statusCode, 403);
  assert.equal(me.json().error.code, 'totp_setup_required');

  const change = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/password',
    ...withSid(sid),
    ...withCsrf(csrf),
    payload: { old_password: PASSWORD, new_password: 'another-pass-9' },
  });
  assert.equal(change.statusCode, 403);
  assert.equal(change.json().error.code, 'totp_setup_required');

  const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', ...withSid(sid), ...withCsrf(csrf) });
  assert.equal(out.statusCode, 204, '⛔ 受限态必须还能登出（不能把人锁死在面板里）');
});

test('settings 缓存：首次登录写 settings:cache；窗口内改库不生效；失效后立即生效（✅ R16）', async () => {
  const user = await seedUser();
  await run(`INSERT INTO settings (key, value) VALUES ('security.require_2fa', 'true'::jsonb)`);

  await login(user.username);
  assert.equal(redis.has(keys.settingsCache), true, '首次登录后应写缓存');
  assert.equal(await redis.ttl(keys.settingsCache), CONFIG.security.settingsCacheTtlS);

  // 窗口内改库：缓存仍生效 → 新登录仍进入受限态
  await run(`UPDATE settings SET value = 'false'::jsonb WHERE key = 'security.require_2fa'`);
  const cached = await login(user.username);
  const meCached = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(cached.sid) });
  assert.equal(meCached.statusCode, 403, '缓存窗口内必须仍是旧值（这正是缓存的意义）');

  // 主动失效（M3 的 PATCH /settings 必须调用同一函数）→ 立即生效
  await invalidateSettingsCache(redis);
  const fresh = await login(user.username);
  const meFresh = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(fresh.sid) });
  assert.equal(meFresh.statusCode, 200, '缓存失效后必须读到新值');
});

// -----------------------------------------------------------------------------
// B4：logout / logout-all
// -----------------------------------------------------------------------------

test('logout：204 + 清 Cookie + 会话删除 + 审计；之后再访问 me → 401', async () => {
  const user = await seedUser();
  const { sid, csrf } = await login(user.username);

  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', ...withSid(sid), ...withCsrf(csrf) });
  assert.equal(res.statusCode, 204);
  assert.match(String(res.headers['set-cookie']), /Max-Age=0/i);

  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(sid) });
  assert.equal(me.statusCode, 401);

  const audits = await auditRows('auth.logout');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, user.id);
});

test('logout：缺 CSRF 头 → 403 csrf_invalid（会话不受影响）', async () => {
  const user = await seedUser();
  const { sid } = await login(user.username);

  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', ...withSid(sid) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'csrf_invalid');

  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(sid) });
  assert.equal(me.statusCode, 200, 'CSRF 失败不得销毁会话');
});

test('logout-all：两个会话全部下线 + 审计计数', async () => {
  const user = await seedUser();
  const a = await login(user.username);
  const b = await login(user.username);

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout-all',
    ...withSid(a.sid),
    ...withCsrf(a.csrf),
  });
  assert.equal(res.statusCode, 204);

  for (const sid of [a.sid, b.sid]) {
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(sid) });
    assert.equal(me.statusCode, 401);
  }
  const audits = await auditRows('auth.logout_all');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.sessions_destroyed, 2);
});

test('审计脱敏：detail 里没有密码、csrf、sid（⛔ 审计可被 user 角色读取）', async () => {
  const user = await seedUser();
  const { sid, csrf } = await login(user.username);
  await app.inject({ method: 'POST', url: '/api/v1/auth/logout', ...withSid(sid), ...withCsrf(csrf) });
  await login(user.username, 'wrong-password-1');

  const { rows } = await run(`SELECT detail FROM audit_logs`);
  const dumped = JSON.stringify(rows.map((row) => row.detail));
  assert.equal(dumped.includes(PASSWORD), false);
  assert.equal(dumped.includes('wrong-password-1'), false);
  assert.equal(dumped.includes(csrf), false);
  assert.equal(dumped.includes(sid), false, 'sid 等价于 Cookie 值，⛔ 等同于写 Cookie');
});

// -----------------------------------------------------------------------------
// B5：POST /api/v1/auth/password
// -----------------------------------------------------------------------------

test('改密成功：204 + 轮换 sid；旧 sid 失效、新 sid 可用；旧密码失效、新密码可登录', async () => {
  const user = await seedUser();
  const first = await login(user.username);

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/password',
    ...withSid(first.sid),
    ...withCsrf(first.csrf),
    payload: { old_password: PASSWORD, new_password: 'brand-new-pass-9' },
  });
  assert.equal(res.statusCode, 204);
  const newSid = sidFrom(res);
  assert.ok(newSid);
  assert.notEqual(newSid, first.sid, '✅ 决策 #32：改密后 sid 必须轮换');

  const oldMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(first.sid) });
  assert.equal(oldMe.statusCode, 401, '旧 sid 必须立即失效');
  const newMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(newSid) });
  assert.equal(newMe.statusCode, 200);

  const oldLogin = await login(user.username);
  assert.equal(oldLogin.res.statusCode, 401, '旧密码必须失效');
  const newLogin = await login(user.username, 'brand-new-pass-9');
  assert.equal(newLogin.res.statusCode, 200);

  const audits = await auditRows('auth.password_change');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.other_sessions_kicked, 0);
});

test('改密后其它会话被踢（保留当前那个）', async () => {
  const user = await seedUser();
  const a = await login(user.username);
  const b = await login(user.username);

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/password',
    ...withSid(a.sid),
    ...withCsrf(a.csrf),
    payload: { old_password: PASSWORD, new_password: 'brand-new-pass-9' },
  });
  assert.equal(res.statusCode, 204);

  const meB = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(b.sid) });
  assert.equal(meB.statusCode, 401, '其它会话必须被踢');
  const meA = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    cookies: { [COOKIE]: sidFrom(res) },
  });
  assert.equal(meA.statusCode, 200, '发起改密的会话保留');

  const audits = await auditRows('auth.password_change');
  assert.equal(audits[0].detail.other_sessions_kicked, 1);
});

test('改密：旧密码错 → 401，哈希未变（旧密码仍可登录），审计 password_change_failed', async () => {
  const user = await seedUser();
  const { sid, csrf } = await login(user.username);

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/password',
    ...withSid(sid),
    ...withCsrf(csrf),
    payload: { old_password: 'totally-wrong-1', new_password: 'brand-new-pass-9' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'invalid_credentials');

  const still = await login(user.username);
  assert.equal(still.res.statusCode, 200, '旧密码必须仍然有效（哈希未被改动）');
  assert.equal((await auditRows('auth.password_change_failed')).length, 1);
});

test('改密：新密码与旧密码相同 → 400 invalid_request（§4.1.1 ⑧ D4 建议）', async () => {
  const user = await seedUser();
  const { sid, csrf } = await login(user.username);

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/password',
    ...withSid(sid),
    ...withCsrf(csrf),
    payload: { old_password: PASSWORD, new_password: PASSWORD },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'invalid_request');
});

test('改密：新密码 7 位 / 129 位 → 400 schema_invalid（长度 8–128 在 schema 卡边界）', async () => {
  const user = await seedUser();
  const { sid, csrf } = await login(user.username);

  for (const newPassword of ['short7x', 'x'.repeat(129)]) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      ...withSid(sid),
      ...withCsrf(csrf),
      payload: { old_password: PASSWORD, new_password: newPassword },
    });
    assert.equal(res.statusCode, 400, `长度 ${newPassword.length} 应被 schema 拒绝`);
    assert.equal(res.json().error.code, 'schema_invalid');
  }
});

test('改密：缺 CSRF → 403 csrf_invalid；未过 2FA（totp_pending）→ 403 totp_required', async () => {
  const user = await seedUser();
  const { sid, csrf } = await login(user.username);

  const noCsrf = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/password',
    ...withSid(sid),
    payload: { old_password: PASSWORD, new_password: 'brand-new-pass-9' },
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json().error.code, 'csrf_invalid');

  const totpUser = await seedUser({ totp: true });
  const pending = await login(totpUser.username);
  const restricted = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/password',
    ...withSid(pending.sid),
    ...withCsrf(pending.csrf),
    payload: { old_password: PASSWORD, new_password: 'brand-new-pass-9' },
  });
  assert.equal(restricted.statusCode, 403);
  assert.equal(restricted.json().error.code, 'totp_required');
});
