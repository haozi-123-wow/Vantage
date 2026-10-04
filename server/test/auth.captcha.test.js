/**
 * 滑动验证码（人机验证）集成测试
 *
 * 依据：docs/slider-captcha-selfbuilt.md §10.3（验收用例 AC-1…AC-13）、§2（触发语义）、
 *       §5（接口契约）、§6.4（token 绑定与消费时机）；docs/api.md §4.1
 *
 * 与 `auth.test.js` / `auth.2fa.test.js` 同一取向：**真 PGlite + 真 buildApp + app.inject()**，
 * Redis 用内存替身（会话语义已在 `session.test.js` 钉死，这里不重复）。
 *
 * 🔑 测试如何"拖对"：答案只存在 Redis（`captcha:<id>` 的 `x`），所以测试**直读替身**取出答案再构造
 *    一条类人轨迹（`buildHumanLikeTrack`）——⛔ 生产里没有这条路径，它正是"答案不下发"的证明：
 *    想通过校验，要么真拖对，要么读得到 Redis。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { insertUser } from '../src/repositories/user.repo.js';
import { hashPassword } from '../src/utils/crypto.js';
import { keys } from '../src/utils/redisKeys.js';
import { buildHumanLikeTrack } from '../src/utils/slider.js';
import { createLogger } from '../src/utils/log.js';
import { createFakeRedisHash } from './helpers/fake-redis-hash.js';

// -----------------------------------------------------------------------------
// 真库（PGlite）：与生产同一条迁移代码路径
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

const pool = { query: run, connect: async () => ({ query: run, release: () => {} }) };

const CONFIG = loadConfig(
  {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 11).toString('base64'),
    /**
     * ⛔ 必须显式指定 `selfbuilt`：本文件验证的是**自建滑块**的语义，
     *    而 `CAPTCHA_PROVIDER` 未设置时会自动推断（配了极验密钥 → geetest）。
     *    极验分支的等价用例在 `auth.captcha.geetest.test.js`。
     */
    CAPTCHA_PROVIDER: 'selfbuilt',
  },
  { skipEnvFile: true },
);
const SILENT = createLogger({ level: 'silent' });
const PASSWORD = 'correct-horse-1';

/** 两个不同的来源 IP：AC-11（换 IP）与 AC-12（代理池）都要用 */
const IP_A = '10.0.0.5';
const IP_B = '10.0.0.6';

let app = null;
let redis = null;

beforeEach(async () => {
  if (app) await app.close();
  await run('DELETE FROM audit_logs');
  await run('DELETE FROM settings');
  await run('DELETE FROM users');
  await run('DELETE FROM user_recovery_codes');

  redis = createFakeRedisHash({ now: () => Date.now() });
  app = await buildApp({ config: CONFIG, logger: SILENT, db: { app: pool, migrator: null }, redis });
});

after(async () => {
  if (app) await app.close();
  await db.close();
});

let seq = 0;

async function seedUser({ username = `captcha${(seq += 1)}` } = {}) {
  const row = await insertUser(pool, { username, passwordHash: await hashPassword(PASSWORD), role: 'admin' });
  return { id: row.id, username };
}

/** 登录请求（可指定来源 IP 与 `captcha_token`） */
function injectLogin({ username, password, captchaToken = null, ip = IP_A }) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: ip,
    payload: { username, password, ...(captchaToken ? { captcha_token: captchaToken } : {}) },
  });
}

/** 取题 */
function challenge(ip = IP_A) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/captcha/challenge', remoteAddress: ip });
}

/** 交卷 */
function submit({ captchaId, x, track, ip = IP_A }) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/captcha/verify',
    remoteAddress: ip,
    payload: { captcha_id: captchaId, x, track },
  });
}

/** 从替身里读答案（⛔ 只有测试能这么做） */
async function answerOf(captchaId) {
  const raw = await redis.hgetall(keys.captcha(captchaId));
  return Number(raw.x);
}

/** 出题 → 拖对 → 拿一次性 token */
async function solve({ ip = IP_A, offset = 0 } = {}) {
  const res = await challenge(ip);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  const x = (await answerOf(body.captcha_id)) + offset;
  const verify = await submit({ captchaId: body.captcha_id, x, track: buildHumanLikeTrack({ to: x }), ip });
  return { challenge: body, verify, token: verify.json().captcha_token, x };
}

async function auditRows(action) {
  const { rows } = await run(`SELECT action, actor, actor_type, detail FROM audit_logs WHERE action = $1 ORDER BY id`, [action]);
  return rows;
}

/** 制造一次登录失败（把两个失败计数器推到阈值） */
async function failOnce(user, ip = IP_A) {
  const res = await injectLogin({ username: user.username, password: 'wrong-password-1', ip });
  assert.equal(res.statusCode, 401, res.body);
  return res;
}

// -----------------------------------------------------------------------------
// AC-1…AC-3：出场时机（"首次不要求、密码错后引入"）
// -----------------------------------------------------------------------------

test('AC-1 首次登录：无失败计数时**不带** token 也能成功，⛔ 全程不出现人机验证', async () => {
  const user = await seedUser();

  const res = await injectLogin({ username: user.username, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.totp_required, false);
  assert.equal(body.user.username, user.username);

  // 首次登录不该写任何失败计数（否则"第一次就要滑块"）
  assert.equal(await redis.get(keys.loginFailIp(IP_A)), null);
  assert.equal(await redis.get(keys.loginFailAcct(user.username)), null);
});

test('AC-2/AC-3 密码错一次 → 401 + details.captcha_required；两个计数器各 +1；再提交缺 token → 400 captcha_required', async () => {
  const user = await seedUser();

  const bad = await failOnce(user);
  assert.equal(bad.json().error.code, 'invalid_credentials');
  assert.deepEqual(bad.json().error.details, { captcha_required: true }, '失败响应要当场告诉前端"该弹滑块了"');

  assert.equal(Number(await redis.get(keys.loginFailIp(IP_A))), 1);
  assert.equal(Number(await redis.get(keys.loginFailAcct(user.username))), 1);
  // 计数窗口必须与登录限流同窗口，否则能被"卡在窗口边界"绕过
  assert.equal(await redis.ttl(keys.loginFailIp(IP_A)), CONFIG.rateLimit.loginWindowS);

  // 即使这次密码是**对的**，也先被闸门拦下：⛔ 滑块校验在验密码之前（防 Argon2 DoS）
  const again = await injectLogin({ username: user.username, password: PASSWORD });
  assert.equal(again.statusCode, 400);
  assert.equal(again.json().error.code, 'captcha_required');
});

// -----------------------------------------------------------------------------
// AC-4…AC-6：一次性、绑定与复用口径
// -----------------------------------------------------------------------------

test('AC-4 取题 → 拖对 → verify → 带 token 登录成功；token 绑定 IP 并在成功后被消费', async () => {
  const user = await seedUser();
  await failOnce(user);

  const { verify, token } = await solve();
  assert.equal(verify.statusCode, 200, verify.body);
  assert.deepEqual(Object.keys(verify.json()).sort(), ['captcha_token', 'expires_in']);
  assert.equal(verify.json().expires_in, CONFIG.security.captcha.ttlS);
  assert.equal(await redis.get(keys.captchaOk(token)), IP_A, 'token 的值必须是解出它的 IP');

  const ok = await injectLogin({ username: user.username, password: PASSWORD, captchaToken: token });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(await redis.get(keys.captchaOk(token)), null, '登录成功即消费（一次性）');
});

test('AC-5 同一 token 再次使用 → 400 captcha_invalid（已消费）', async () => {
  const user = await seedUser();
  await failOnce(user);
  const { token } = await solve();

  assert.equal((await injectLogin({ username: user.username, password: PASSWORD, captchaToken: token })).statusCode, 200);

  // ⚠️ 决策 A（成功登录清零失败计数）落地后，"刚成功过"的账号**不再处于要求验证的状态** ——
  //    要复现"复用已消费的 token"，必须先把闸门重新立起来（再错一次密码）；
  //    否则旧 token 根本不会被读取，登录会以 200 通过（那是正常行为，不是 token 被接受）。
  await failOnce(user);

  const reuse = await injectLogin({ username: user.username, password: PASSWORD, captchaToken: token });
  assert.equal(reuse.statusCode, 400);
  assert.equal(reuse.json().error.code, 'captcha_invalid');
  assert.equal(reuse.json().error.details.reason, 'expired');
});

test('AC-6 有效期内 token 复用于"密码仍错"的提交 → 401（⛔ 不要求重滑），且 token 不被消费', async () => {
  const user = await seedUser();
  await failOnce(user);
  const { token } = await solve();

  const badWithToken = await injectLogin({ username: user.username, password: 'wrong-password-1', captchaToken: token });
  assert.equal(badWithToken.statusCode, 401, '有有效 token 时应当进入验密码环节，而不是再要一次滑块');
  assert.equal(badWithToken.json().error.details.captcha_required, true);
  assert.equal(await redis.get(keys.captchaOk(token)), IP_A, '⛔ 失败不得消费 token（否则用户要反复重滑）');

  const ok = await injectLogin({ username: user.username, password: PASSWORD, captchaToken: token });
  assert.equal(ok.statusCode, 200);
});

// -----------------------------------------------------------------------------
// AC-7…AC-10：校验规则与失败上限
// -----------------------------------------------------------------------------

test('AC-7 偏差超容差 → 400 captcha_invalid(mismatch) + attempts+1 + 审计（⛔ 不含答案原值）', async () => {
  const res = await challenge();
  const captchaId = res.json().captcha_id;
  const x = await answerOf(captchaId);
  const off = x + CONFIG.security.captcha.tolerancePx + 5; // 恰好超出容差

  const verify = await submit({ captchaId, x: off, track: buildHumanLikeTrack({ to: off }) });
  assert.equal(verify.statusCode, 400);
  assert.equal(verify.json().error.code, 'captcha_invalid');
  assert.equal(verify.json().error.details.reason, 'mismatch');

  assert.equal(Number((await redis.hgetall(keys.captcha(captchaId))).attempts), 1);

  const audits = await auditRows('auth.captcha_failed');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.reason, 'mismatch');
  assert.equal(audits[0].detail.delta_px, CONFIG.security.captcha.tolerancePx + 5);
  assert.equal(audits[0].actor, 'system');
  assert.equal(JSON.stringify(audits[0].detail).includes(String(x)), false, '⛔ 审计里不得出现答案');
});

test('AC-8 同一题连错到上限 → 第 4 次判 too_many_attempts 且题目作废', async () => {
  const res = await challenge();
  const captchaId = res.json().captcha_id;
  const off = (await answerOf(captchaId)) + 50;

  for (let i = 1; i <= CONFIG.security.captcha.maxAttempts; i += 1) {
    const attempt = await submit({ captchaId, x: off, track: buildHumanLikeTrack({ to: off }) });
    assert.equal(attempt.statusCode, 400);
    assert.equal(attempt.json().error.details.reason, 'mismatch', `第 ${i} 次应仍是 mismatch`);
  }

  const over = await submit({ captchaId, x: off, track: buildHumanLikeTrack({ to: off }) });
  assert.equal(over.statusCode, 400);
  assert.equal(over.json().error.details.reason, 'too_many_attempts');
  assert.equal(redis.has(keys.captcha(captchaId)), false, '到达上限即作废该题（必须重新取题）');
});

test('AC-9 题目不存在（TTL 到期 / 已被作废）→ 400 captcha_invalid(not_found)', async () => {
  const res = await challenge();
  const captchaId = res.json().captcha_id;
  await redis.del(keys.captcha(captchaId)); // 模拟 TTL 到期

  const verify = await submit({ captchaId, x: 150, track: buildHumanLikeTrack({ to: 150 }) });
  assert.equal(verify.statusCode, 400);
  assert.equal(verify.json().error.details.reason, 'not_found');
});

test('AC-10 轨迹点数不足（瞬移式提交）→ 400 track_suspicious + 审计', async () => {
  const res = await challenge();
  const captchaId = res.json().captcha_id;
  const x = await answerOf(captchaId);

  const verify = await submit({ captchaId, x, track: [[0, 0], [100, 10], [200, x]] });
  assert.equal(verify.statusCode, 400);
  assert.equal(verify.json().error.details.reason, 'track_suspicious');
  assert.equal((await auditRows('auth.captcha_failed')).length, 1);
});

// -----------------------------------------------------------------------------
// AC-11…AC-12：绑定与"代理池"兜底
// -----------------------------------------------------------------------------

test('AC-11 换 IP 使用同一 token → 400 captcha_invalid(ip_mismatch)', async () => {
  const user = await seedUser();
  await failOnce(user, IP_A);
  const { token } = await solve({ ip: IP_A });

  const other = await injectLogin({ username: user.username, password: PASSWORD, captchaToken: token, ip: IP_B });
  assert.equal(other.statusCode, 400);
  assert.equal(other.json().error.details.reason, 'ip_mismatch');
});

test('AC-12 代理池兜底：另一个 IP（自己零失败记录）也照样被要求人机验证', async () => {
  const user = await seedUser();
  await failOnce(user, IP_A);

  // 换全新 IP、且这次密码是对的：仍被拦——拦住它的是**按账号**的失败计数
  const second = await injectLogin({ username: user.username, password: PASSWORD, ip: IP_B });
  assert.equal(second.statusCode, 400);
  assert.equal(second.json().error.code, 'captcha_required');
  assert.equal(await redis.get(keys.loginFailIp(IP_B)), null, 'IP_B 自己没有失败记录');
  assert.equal(Number(await redis.get(keys.loginFailAcct(user.username))), 1, '真正起作用的是账号维度计数');
});

// -----------------------------------------------------------------------------
// AC-13：总开关 + 响应形状与"不泄露答案"
// -----------------------------------------------------------------------------

test('AC-13 关闭开关：取题 404；密码错也**不带** captcha_required；再提交仍 401（不要求滑块）', async () => {
  await run(`INSERT INTO settings (key, value) VALUES ('security.login_captcha.enabled', 'false'::jsonb)`);
  const user = await seedUser();

  const ch = await challenge();
  assert.equal(ch.statusCode, 404, '关闭时端点应当"不存在"（⛔ 不用 403 暴露它被关了）');
  assert.equal(ch.json().error.code, 'not_found');

  const bad = await injectLogin({ username: user.username, password: 'wrong-password-1' });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error.details, undefined, '关闭时响应应与引入人机验证前**逐字节一致**');

  const ok = await injectLogin({ username: user.username, password: PASSWORD });
  assert.equal(ok.statusCode, 200, '关闭时不要求滑块');
});

test('取题响应：形状与画布尺寸固定，且⛔ 不含答案（无 x/y 字段、答案不是独立属性）', async () => {
  const res = await challenge();
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(Object.keys(body).sort(), [
    'bg_svg',
    'captcha_id',
    'expires_in',
    'height',
    'piece_svg',
    'provider',
    'width',
  ]);
  assert.equal(body.provider, 'selfbuilt', '两个提供方都会带 provider，前端据此选组件');
  assert.equal(body.width, 320);
  assert.equal(body.height, 160);
  assert.equal(body.expires_in, CONFIG.security.captcha.ttlS);
  assert.ok(body.bg_svg.startsWith('<svg') && body.piece_svg.startsWith('<svg'));
  assert.equal('x' in body, false, '⛔ 响应里不得有答案字段');
  assert.equal('y' in body, false, '⛔ 纵坐标也不需要下发（块画在 piece_svg 里）');

  const x = await answerOf(body.captcha_id);
  assert.equal(body.bg_svg.includes(`x="${x}"`), false, '⛔ 答案不得作为可 grep 的独立属性出现');
});

test('取题限流是**独立桶**：取题被限流不影响登录额度（§1.4）', async () => {
  const limit = CONFIG.rateLimit.captchaPerMinute;
  for (let i = 0; i < limit; i += 1) {
    const res = await challenge();
    assert.equal(res.statusCode, 200, `第 ${i + 1} 次取题应成功`);
  }

  const blocked = await challenge();
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'rate_limited');
  assert.ok(Number(blocked.headers['retry-after']) > 0);

  // 同一 IP 的登录额度不受取题限流影响（两桶独立）
  const user = await seedUser();
  const loginRes = await injectLogin({ username: user.username, password: PASSWORD });
  assert.equal(loginRes.statusCode, 200, '取题被限流不得吃掉登录额度');
});
