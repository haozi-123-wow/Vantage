/**
 * 面板 2FA 路由测试（B6 绑定/解绑 + B7 第二步/恢复码/防重放）
 *
 * 依据：docs/api.md §4.1（契约：6 个端点的响应形状与错误码）、§4.1.1 ②（三态矩阵）、
 *       ④（totp:used 防重放）、⑤（TOTP/恢复码）、⑧（D1/D3/D5/D6/D7）、§6.2 用例 12–14
 *
 * 与 auth.test.js 同一取向：真 PGlite + 真 buildApp（契约长在 SQL 与 HTTP 的交界处——
 * 恢复码哈希真的落库、used_at 真的置位、解绑真的清空、审计真的脱敏）。
 *
 * 时间控制：node:test 的 `t.mock.timers` 只劫持 **Date**（TOTP 步号、Redis TTL、滑动会话
 * 全部经 Date.now 取时）——"同一步重放"与"+31s 下一步"无需真实等待。
 * ⚠️ 本文件里涉及步号的断言都建立在"测试进程足够快、真实时间不跨步"上；对可能跨步的
 *   用例（重放）一律显式 mock 时钟，不做隐式假设。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { createPanelAuth, sessionCookieName } from '../src/middleware/authPanel.js';
import { enableTotp, insertUser, setTotpSecret } from '../src/repositories/user.repo.js';
import { decryptSecret, encryptSecret, hashPassword, hashRecoveryCode, totpSecretAad } from '../src/utils/crypto.js';
import { generateTotpSecret, totpCode } from '../src/utils/totp.js';
import { keys } from '../src/utils/redisKeys.js';
import { createLogger } from '../src/utils/log.js';
import { createFakeRedisHash } from './helpers/fake-redis-hash.js';

// -----------------------------------------------------------------------------
// 真库（PGlite）：与生产同一条迁移代码路径（同 auth.test.js）
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

/** 池形状：query + connect（后者供 withTransaction 使用，见 user.repo.test.js 的先例） */
const pool = {
  query: run,
  connect: async () => ({ query: run, release: () => {} }),
};

// -----------------------------------------------------------------------------
// 夹具：每条用例独立（限流计数 / 会话 / Redis 键互不污染）
// -----------------------------------------------------------------------------
let app = null;
let redis = null;

beforeEach(async () => {
  if (app) await app.close();
  await run('DELETE FROM audit_logs');
  await run('DELETE FROM settings');
  await run('DELETE FROM users');
  await run('DELETE FROM user_recovery_codes');

  redis = createFakeRedisHash({ now: () => Date.now() });
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
    SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  },
  { skipEnvFile: true },
);
const SILENT = createLogger({ level: 'silent' });
const COOKIE = sessionCookieName(CONFIG);
const PASSWORD = 'correct-horse-1';

let seq = 0;

async function seedUser({ username = `u${(seq += 1)}`, role = 'admin' } = {}) {
  const row = await insertUser(pool, { username, passwordHash: await hashPassword(PASSWORD), role });
  return { id: row.id, username, role };
}

/** 造一个"已真实绑定 TOTP"的账号：密文信封可解密（区别于 auth.test.js 的桩信封） */
async function seedBoundTotpUser() {
  const user = await seedUser();
  const secret = generateTotpSecret();
  await setTotpSecret(pool, user.id, encryptSecret(secret, CONFIG.security.secretKey, totpSecretAad(user.id)));
  await enableTotp(pool, user.id);
  return { ...user, secret };
}

/** 当前时刻某密钥的验证码（配合 mock.timers 可回放/跨步） */
const codeFor = (secret, at = Date.now()) => totpCode(secret, { time: at });
/** 异源密钥的验证码：与被测账号的密钥必不匹配（HMAC 不同源），作"错误验证码"用 */
const wrongCode = (at = Date.now()) => totpCode('JBSWY3DPEHPK3PXP', { time: at });

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

async function post(path, sess, payload) {
  return app.inject({ method: 'POST', url: path, ...withSid(sess.sid), ...withCsrf(sess.csrf), payload });
}

async function me(sid) {
  return app.inject({ method: 'GET', url: '/api/v1/auth/me', ...withSid(sid) });
}

async function auditRows(action) {
  const { rows } = await run(`SELECT actor, target, detail FROM audit_logs WHERE action = $1 ORDER BY id`, [action]);
  return rows;
}

/**
 * 完整绑定流（setup → enable）：返回 enable 后的完整态会话与 10 个明文恢复码。
 * csrf 跨 sid 轮换保持不变（§4.1.1 ①），因此沿用登录时的 csrf。
 */
async function bindTotp(user) {
  const l = await login(user.username);
  assert.equal(l.res.statusCode, 200);
  const s = await post('/api/v1/auth/2fa/setup', l, {});
  assert.equal(s.statusCode, 200, `setup 应成功：${s.body}`);
  const code = codeFor(s.json().secret);
  const e = await post('/api/v1/auth/2fa/enable', l, { code });
  assert.equal(e.statusCode, 200, `enable 应成功：${e.body}`);
  return {
    login: l,
    setup: s.json(),
    enable: e.json(),
    sid: sidFrom(e),
    csrf: l.csrf,
    codes: e.json().recovery_codes,
  };
}

async function totpEnvelope(userId) {
  const { rows } = await run(`SELECT totp_secret_enc, totp_enabled FROM users WHERE id = $1`, [userId]);
  return rows[0];
}

async function recoveryRow(userId, code) {
  const hash = hashRecoveryCode(code, CONFIG.security.secretKey);
  const { rows } = await run(
    `SELECT code_hash, used_at FROM user_recovery_codes WHERE user_id = $1 AND code_hash = $2`,
    [userId, hash],
  );
  return rows[0] ?? null;
}

// -----------------------------------------------------------------------------
// B6：POST /api/v1/auth/2fa/setup
// -----------------------------------------------------------------------------

test('setup：返回 {secret, otpauth_uri, qr_svg}；库里只落密文、totp_enabled 仍为 false；审计 user.2fa_setup', async () => {
  const user = await seedUser();
  const l = await login(user.username);

  const res = await post('/api/v1/auth/2fa/setup', l, {});
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ['otpauth_uri', 'qr_svg', 'secret']);

  assert.match(body.secret, /^[A-Z2-7]{32}$/, '20 字节 → 32 字符无填充 Base32');
  assert.ok(body.otpauth_uri.startsWith(`otpauth://totp/Vantage%3A${encodeURIComponent(user.username)}?`));
  assert.ok(body.otpauth_uri.includes(`secret=${body.secret}`));
  assert.ok(body.otpauth_uri.includes('issuer=Vantage'));
  assert.ok(body.otpauth_uri.includes('digits=6'));
  assert.ok(body.otpauth_uri.includes('period=30'));
  assert.ok(body.qr_svg.startsWith('<svg'), 'qr_svg 是 SVG 文本（qrcode 服务端渲染）');
  assert.ok(body.qr_svg.includes('</svg>'));

  const row = await totpEnvelope(user.id);
  assert.equal(row.totp_enabled, false, '⛔ enable 之前不得生效');
  assert.match(row.totp_secret_enc, /^v1:/, '库里是 v1 信封密文');
  assert.equal(
    decryptSecret(row.totp_secret_enc, CONFIG.security.secretKey, totpSecretAad(user.id)),
    body.secret,
    '密文可按 AAD 解回明文（AAD 绑定 user_id）',
  );

  const audits = await auditRows('user.2fa_setup');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, user.id);
  assert.equal(audits[0].target, user.username);
  assert.equal(JSON.stringify(audits[0].detail).includes(body.secret), false, '⛔ secret 不进审计');
});

test('setup：已绑定账号（含 totp_pending 态）→ 409 conflict，且旧密文不被覆盖（§4.1.1 ⑧ D7 收敛）', async () => {
  const bound = await seedBoundTotpUser();
  const l = await login(bound.username); // 绑定账号登录 → totp_pending
  const before = await totpEnvelope(bound.id);

  const res = await post('/api/v1/auth/2fa/setup', l, {});
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'conflict');

  const afterRow = await totpEnvelope(bound.id);
  assert.equal(afterRow.totp_secret_enc, before.totp_secret_enc, '⛔ 拒绝时不得动库（防"换绑再自验"绕过 2FA）');
});

test('setup：未绑定时可重新 setup（换码）；旧 secret 失效、新 secret 的码可 enable', async () => {
  const user = await seedUser();
  const l = await login(user.username);

  const first = await post('/api/v1/auth/2fa/setup', l, {});
  const second = await post('/api/v1/auth/2fa/setup', l, {});
  assert.equal(second.statusCode, 200);
  assert.notEqual(first.json().secret, second.json().secret, '两次 setup 必须是不同密钥');

  const row = await totpEnvelope(user.id);
  assert.equal(decryptSecret(row.totp_secret_enc, CONFIG.security.secretKey, totpSecretAad(user.id)), second.json().secret);

  const e = await post('/api/v1/auth/2fa/enable', l, { code: codeFor(second.json().secret) });
  assert.equal(e.statusCode, 200, '用最新一次 setup 的密钥验证码 enable 应成功');
});

test('setup：无会话 → 401；缺 CSRF → 403 csrf_invalid', async () => {
  const user = await seedUser();

  const anon = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/setup', payload: {} });
  assert.equal(anon.statusCode, 401);

  const l = await login(user.username);
  const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/setup', ...withSid(l.sid), payload: {} });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json().error.code, 'csrf_invalid');
});

// -----------------------------------------------------------------------------
// B6：POST /api/v1/auth/2fa/enable
// -----------------------------------------------------------------------------

test('enable：验码通过 → 10 个恢复码（明文仅此一次）+ 绑定生效 + sid 轮换 + 会话转 full + 审计', async () => {
  const user = await seedUser();
  const l = await login(user.username);
  const s = await post('/api/v1/auth/2fa/setup', l, {});
  const secret = s.json().secret;

  const res = await post('/api/v1/auth/2fa/enable', l, { code: codeFor(secret) });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ['recovery_codes', 'remaining_recovery_codes']);
  assert.equal(body.remaining_recovery_codes, 10);
  assert.equal(body.recovery_codes.length, 10);
  assert.equal(new Set(body.recovery_codes).size, 10, '批内不得重复');
  for (const code of body.recovery_codes) {
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/, 'Crockford Base32，5+5 连字符（无 I/L/O/U）');
  }

  const row = await totpEnvelope(user.id);
  assert.equal(row.totp_enabled, true);

  // 库里只有哈希，且与明文一一对应
  const { rows: hashRows } = await run(`SELECT code_hash FROM user_recovery_codes WHERE user_id = $1`, [user.id]);
  const expected = new Set(body.recovery_codes.map((c) => hashRecoveryCode(c, CONFIG.security.secretKey)));
  assert.equal(hashRows.length, 10);
  for (const { code_hash } of hashRows) assert.equal(expected.has(code_hash), true, '哈希必须来自本次下发的明文');

  const newSid = sidFrom(res);
  assert.notEqual(newSid, l.sid, '✅ 决策 #32：绑定成功后 sid 必须轮换');
  assert.equal((await me(l.sid)).statusCode, 401, '旧 sid 失效');
  const meRes = await me(newSid);
  assert.equal(meRes.statusCode, 200, 'enable 后会话直接进入 full（刚用验证码证明过持有）');
  assert.equal(meRes.json().user.totp_enabled, true);

  const audits = await auditRows('user.2fa_enable');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.recovery_codes, 10);
});

test('enable：验证码错误 → 400 invalid_totp，绑定不生效，审计 user.2fa_enable_failed', async () => {
  const user = await seedUser();
  const l = await login(user.username);
  await post('/api/v1/auth/2fa/setup', l, {});

  const res = await post('/api/v1/auth/2fa/enable', l, { code: wrongCode() });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'invalid_totp');

  const row = await totpEnvelope(user.id);
  assert.equal(row.totp_enabled, false, '验证失败不得绑定');

  const audits = await auditRows('user.2fa_enable_failed');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.reason, 'invalid_totp');
});

test('enable：totp_pending 态 → 403 totp_required（矩阵②：pending 不许重复绑定）', async () => {
  const bound = await seedBoundTotpUser();
  const l = await login(bound.username); // pending

  const res = await post('/api/v1/auth/2fa/enable', l, { code: codeFor(bound.secret) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'totp_required');
});

test('enable：未 setup（无待确认密钥）→ 400 invalid_request', async () => {
  const user = await seedUser();
  const l = await login(user.username);

  const res = await post('/api/v1/auth/2fa/enable', l, { code: codeFor(generateTotpSecret()) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'invalid_request');
});

test('✅ B7 核心：require_2fa 受限态全链路——登录 → me 403 → setup → enable → me 200（受限解除）', async () => {
  const user = await seedUser();
  await run(`INSERT INTO settings (key, value) VALUES ('security.require_2fa', 'true'::jsonb)`);

  const l = await login(user.username);
  assert.equal(l.body.totp_required, false, '未绑定账号登录仍是成功形态（引导交给 me）');
  const blocked = await me(l.sid);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, 'totp_setup_required');

  const s = await post('/api/v1/auth/2fa/setup', l, {});
  assert.equal(s.statusCode, 200, '受限态必须能拿到绑定二维码');

  const e = await post('/api/v1/auth/2fa/enable', l, { code: codeFor(s.json().secret) });
  assert.equal(e.statusCode, 200, '受限态必须能完成绑定');

  const freed = await me(sidFrom(e));
  assert.equal(freed.statusCode, 200, '绑定完成后受限解除');
  assert.equal(freed.json().user.totp_enabled, true);
});

// -----------------------------------------------------------------------------
// B7：POST /api/v1/auth/2fa/verify（登录第二步）与防重放
// -----------------------------------------------------------------------------

test('verify：正确码 → 204 + sid 轮换 + 会话转 full；审计 auth.2fa_verify', async () => {
  const bound = await seedBoundTotpUser();
  const l = await login(bound.username);

  const res = await post('/api/v1/auth/2fa/verify', l, { code: codeFor(bound.secret) });
  assert.equal(res.statusCode, 204);
  const newSid = sidFrom(res);
  assert.notEqual(newSid, l.sid, '✅ 决策 #32：过 2FA 后 sid 必须轮换');
  assert.equal((await me(l.sid)).statusCode, 401);
  assert.equal((await me(newSid)).statusCode, 200);

  const audits = await auditRows('auth.2fa_verify');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, bound.id);
});

test('verify：错误码 → 400 invalid_totp，会话仍是 pending，审计 auth.2fa_verify_failed', async () => {
  const bound = await seedBoundTotpUser();
  const l = await login(bound.username);

  const res = await post('/api/v1/auth/2fa/verify', l, { code: wrongCode() });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'invalid_totp');

  // 仍受限：业务接口被挡（改密要求完整态，借用它当"是否 full"的探针）
  const probe = await post('/api/v1/auth/password', l, { old_password: PASSWORD, new_password: 'another-pass-9' });
  assert.equal(probe.statusCode, 403);
  assert.equal(probe.json().error.code, 'totp_required');

  const audits = await auditRows('auth.2fa_verify_failed');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.reason, 'invalid_totp');
});

test('verify：同一验证码（同一步号）重放 → 400 + 审计 reason=replayed_step；+31s 新步号放行（§4.1.1 ④）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  const bound = await seedBoundTotpUser();
  const first = await login(bound.username);
  const code = codeFor(bound.secret);

  const ok = await post('/api/v1/auth/2fa/verify', first, { code });
  assert.equal(ok.statusCode, 204, '首次使用应放行');
  assert.equal(await redis.ttl(keys.totpUsed(bound.id)), 90, '步号认领键 TTL=90s');

  // 同一步号、另一个 pending 会话重放 → 拒绝
  const second = await login(bound.username);
  const replay = await post('/api/v1/auth/2fa/verify', second, { code });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().error.code, 'invalid_totp');
  assert.equal((await auditRows('auth.2fa_verify_failed')).at(-1).detail.reason, 'replayed_step');

  // 时间前进 31s（下一步）：新码放行，防重放不是"拉黑账号"
  t.mock.timers.tick(31_000);
  const next = await post('/api/v1/auth/2fa/verify', second, { code: codeFor(bound.secret) });
  assert.equal(next.statusCode, 204, '下一步的码必须放行');
});

test('verify：与 login 共享限流桶（§6.2 用例 14）——第 limit 次 verify 被 429', async () => {
  const bound = await seedBoundTotpUser();
  const l = await login(bound.username); // 桶计数 1
  const limit = CONFIG.rateLimit.loginPerWindow;

  for (let i = 1; i <= limit - 1; i += 1) {
    const res = await post('/api/v1/auth/2fa/verify', l, { code: wrongCode() });
    assert.equal(res.statusCode, 400, `第 ${i} 次 verify（桶计数 ${1 + i}）应仍是 400`);
  }
  const blocked = await post('/api/v1/auth/2fa/verify', l, { code: wrongCode() });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'rate_limited');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
});

// -----------------------------------------------------------------------------
// B7：POST /api/v1/auth/2fa/recovery/verify 与 regenerate
// -----------------------------------------------------------------------------

test('recovery/verify：恢复码过第二步 → 200 带剩余数 + sid 轮换 + used_at 置位 + 审计 user.recovery_used', async () => {
  const bound = await seedBoundTotpUser();
  const { sid, csrf, codes } = await bindTotp(bound);

  const res = await post('/api/v1/auth/2fa/recovery/verify', { sid, csrf }, { code: codes[0] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { remaining_recovery_codes: 9 });

  const newSid = sidFrom(res);
  assert.notEqual(newSid, sid, '恢复码验证成功后 sid 必须轮换');
  assert.equal((await me(newSid)).statusCode, 200);

  const row = await recoveryRow(bound.id, codes[0]);
  assert.ok(row, '该码的哈希行存在');
  assert.ok(row.used_at, 'used_at 已置位（用后即废）');

  const audits = await auditRows('user.recovery_used');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.remaining_recovery_codes, 9);
});

test('recovery/verify：同一码第二次 → 400（用后即废，§6.2 用例 13）；错误码 → 400 + 审计', async () => {
  const bound = await seedBoundTotpUser();
  const { sid, csrf, codes } = await bindTotp(bound);

  const first = await post('/api/v1/auth/2fa/recovery/verify', { sid, csrf }, { code: codes[0] });
  assert.equal(first.statusCode, 200);
  const newSid = sidFrom(first);

  const replay = await post('/api/v1/auth/2fa/recovery/verify', { sid: newSid, csrf }, { code: codes[0] });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().error.code, 'invalid_totp');

  const wrong = await post('/api/v1/auth/2fa/recovery/verify', { sid: newSid, csrf }, { code: 'AAAAA-BBBBB' });
  assert.equal(wrong.statusCode, 400);

  const failed = await auditRows('user.recovery_verify_failed');
  assert.equal(failed.length, 2);
  for (const row of failed) assert.equal(row.detail.reason, 'invalid_code');

  const { rows } = await run(`SELECT detail FROM audit_logs WHERE action = 'user.recovery_used'`);
  assert.equal(JSON.stringify(rows).includes(codes[0]), false, '⛔ 恢复码明文不进审计');
});

test('recovery/verify：大小写/缺连字符的输入仍命中（归一化在哈希口径内）', async () => {
  const bound = await seedBoundTotpUser();
  const { sid, csrf, codes } = await bindTotp(bound);

  const sloppy = codes[1].replace('-', '').toLowerCase();
  const res = await post('/api/v1/auth/2fa/recovery/verify', { sid, csrf }, { code: sloppy });
  assert.equal(res.statusCode, 200, '小写 + 无连字符必须仍命中同一哈希');
  assert.equal(res.json().remaining_recovery_codes, 9);
});

test('regenerate：full 态 → 新 10 码，旧码整批作废；审计 user.recovery_regenerate', async () => {
  const bound = await seedBoundTotpUser();
  const { sid, csrf, codes } = await bindTotp(bound);

  const res = await post('/api/v1/auth/2fa/recovery/regenerate', { sid, csrf }, {});
  assert.equal(res.statusCode, 200);
  const fresh = res.json();
  assert.equal(fresh.recovery_codes.length, 10);
  assert.equal(fresh.remaining_recovery_codes, 10);
  for (const old of codes) {
    assert.equal(fresh.recovery_codes.includes(old), false, '新批不得与旧批重叠');
  }

  const { rows: hashRows } = await run(`SELECT code_hash FROM user_recovery_codes WHERE user_id = $1`, [bound.id]);
  assert.equal(hashRows.length, 10, '整批替换：库里恰好 10 行');
  const expected = new Set(fresh.recovery_codes.map((c) => hashRecoveryCode(c, CONFIG.security.secretKey)));
  for (const { code_hash } of hashRows) assert.equal(expected.has(code_hash), true, '旧哈希必须已被替换');

  // 旧码已不可用
  const oldTry = await post('/api/v1/auth/2fa/recovery/verify', { sid, csrf }, { code: codes[0] });
  assert.equal(oldTry.statusCode, 400, '旧码必须已作废');

  const audits = await auditRows('user.recovery_regenerate');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.recovery_codes, 10);
});

test('regenerate：pending 态 → 403 totp_required；未绑定 → 409 conflict', async () => {
  const bound = await seedBoundTotpUser();
  const pending = await login(bound.username);
  const resPending = await post('/api/v1/auth/2fa/recovery/regenerate', pending, {});
  assert.equal(resPending.statusCode, 403);
  assert.equal(resPending.json().error.code, 'totp_required');

  const plain = await seedUser();
  const l = await login(plain.username);
  const resUnbound = await post('/api/v1/auth/2fa/recovery/regenerate', l, {});
  assert.equal(resUnbound.statusCode, 409);
  assert.equal(resUnbound.json().error.code, 'conflict');
});

// -----------------------------------------------------------------------------
// B6：POST /api/v1/auth/2fa/disable（D3 / D5）
// -----------------------------------------------------------------------------

test('disable：密码二次确认 → 204；解绑 + 密文清空 + 恢复码整批作废（D5）；重新登录无第二步', async () => {
  const bound = await seedBoundTotpUser();
  const { sid, csrf, codes } = await bindTotp(bound);

  const wrongPw = await post('/api/v1/auth/2fa/disable', { sid, csrf }, { password: 'wrong-password-1' });
  assert.equal(wrongPw.statusCode, 401, '先卡密码（统一 401 invalid_credentials）');

  const res = await post('/api/v1/auth/2fa/disable', { sid, csrf }, { password: PASSWORD });
  assert.equal(res.statusCode, 204);

  const row = await totpEnvelope(bound.id);
  assert.equal(row.totp_enabled, false);
  assert.equal(row.totp_secret_enc, null, '密文必须清空');

  const { rows: codeRows } = await run(`SELECT * FROM user_recovery_codes WHERE user_id = $1`, [bound.id]);
  assert.equal(codeRows.length, 0, 'D5：解绑必须连恢复码一起作废');

  assert.equal((await me(sid)).statusCode, 200, '当前会话不受影响（已是完整态）');

  const relogin = await login(bound.username);
  assert.equal(relogin.body.totp_required, false, '解绑后重新登录不再要求第二步');

  const audits = await auditRows('user.2fa_disable');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.recovery_codes_deleted, 10);
});

test('disable：密码错误 → 401 + 审计 user.2fa_disable_failed，绑定不变', async () => {
  const bound = await seedBoundTotpUser();
  const { sid, csrf } = await bindTotp(bound);

  const res = await post('/api/v1/auth/2fa/disable', { sid, csrf }, { password: 'totally-wrong-1' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'invalid_credentials');

  const row = await totpEnvelope(bound.id);
  assert.equal(row.totp_enabled, true, '失败不得解绑');

  const audits = await auditRows('user.2fa_disable_failed');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.reason, 'invalid_credentials');
});

test('disable：require_2fa=true 时禁止自助解绑 → 409 conflict（D3），审计 reason=require_2fa_policy', async () => {
  await run(`INSERT INTO settings (key, value) VALUES ('security.require_2fa', 'true'::jsonb)`);
  const bound = await seedBoundTotpUser();

  // 策略开启时绑定账号登录落在 pending → 先过 TOTP 进入 full，再尝试解绑
  const l = await login(bound.username);
  const v = await post('/api/v1/auth/2fa/verify', l, { code: codeFor(bound.secret) });
  assert.equal(v.statusCode, 204);
  const sid = sidFrom(v);

  const res = await post('/api/v1/auth/2fa/disable', { sid, csrf: l.csrf }, { password: PASSWORD });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'conflict');

  const row = await totpEnvelope(bound.id);
  assert.equal(row.totp_enabled, true, '策略禁止时绑定必须原样保留');

  const audits = await auditRows('user.2fa_disable_failed');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.reason, 'require_2fa_policy');
});

test('disable：pending 态 → 403 totp_required（⛔ 不许用密码关掉还没过的 2FA）；未绑定 → 409', async () => {
  const bound = await seedBoundTotpUser();
  const pending = await login(bound.username);
  const resPending = await post('/api/v1/auth/2fa/disable', pending, { password: PASSWORD });
  assert.equal(resPending.statusCode, 403);
  assert.equal(resPending.json().error.code, 'totp_required');

  const plain = await seedUser();
  const l = await login(plain.username);
  const resUnbound = await post('/api/v1/auth/2fa/disable', l, { password: PASSWORD });
  assert.equal(resUnbound.statusCode, 409);
  assert.equal(resUnbound.json().error.code, 'conflict');
});

// -----------------------------------------------------------------------------
// 通用：守卫形态与审计脱敏
// -----------------------------------------------------------------------------

test('⚠️ 新守卫 rejectIfTotpPending 必须 async（Fastify 对同步 hook 按回调式处理会挂起请求）', () => {
  const panel = createPanelAuth({ redis, config: CONFIG });
  assert.equal(panel.rejectIfTotpPending.constructor.name, 'AsyncFunction');
});

test('审计脱敏：2FA 全链路 detail 里没有验证码、恢复码明文与 TOTP secret', async () => {
  const user = await seedUser();
  const l = await login(user.username);

  const s = await post('/api/v1/auth/2fa/setup', l, {});
  const secret = s.json().secret;
  const code = codeFor(secret);
  const e = await post('/api/v1/auth/2fa/enable', l, { code });
  const codes = e.json().recovery_codes;

  await post('/api/v1/auth/2fa/verify', l, { code: wrongCode() }); // 一次失败
  const { sid, csrf } = { sid: sidFrom(e), csrf: l.csrf };
  await post('/api/v1/auth/2fa/recovery/verify', { sid, csrf }, { code: codes[0] }); // 一次成功

  const { rows } = await run(`SELECT detail FROM audit_logs`);
  const dump = JSON.stringify(rows.map((row) => row.detail));
  assert.equal(dump.includes(secret), false, '⛔ secret 不进审计');
  assert.equal(dump.includes(code), false, '⛔ 验证明文不进审计');
  for (const recoveryCode of codes) {
    assert.equal(dump.includes(recoveryCode), false, '⛔ 恢复码明文不进审计');
  }
});
