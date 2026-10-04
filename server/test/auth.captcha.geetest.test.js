/**
 * 极验 GeeTest v4 集成测试（`CAPTCHA_PROVIDER=geetest`）
 *
 * 依据：docs/geetest-captcha.md §10.2（AC-G1…AC-G12）、§9（失败模式：fail-open/closed + 熔断 + 审计）
 *
 * 与 `auth.captcha.test.js` 同一取向：**真 PGlite + 真 buildApp + app.inject()**，Redis 用内存替身。
 * 唯一的额外注入是 `fetchImpl`：⛔ **测试绝不真连 gcaptcha4.geetest.com**，
 * 所有"极验怎么说"都由 `scriptVendor()` 脚本化（成功 / fail / 500 / 断网）。
 *
 * 🔑 本文件真正要钉死的是"**不可用 ≠ 没通过**"这条分界线：前者走 failMode（放行或 503），
 *    后者才是 400 `captcha_invalid`。混掉它会把「极验挂了」记成「用户作弊」，且失败模式整体失准。
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
import { signToken } from '../src/utils/geetest.js';
import { keys, TTL_S } from '../src/utils/redisKeys.js';
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

// -----------------------------------------------------------------------------
// 配置 / 常驻量
// -----------------------------------------------------------------------------

/** 文档里的公开示例值，纯属占位（⛔ 不是真密钥） */
const GEETEST_ID = '647f5ed2ed8acb4be36784e01556bb71';
const GEETEST_KEY = 'b09a7aafbfd83f73b35a9b530d0337bf';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
  SECRET_KEY: Buffer.alloc(32, 11).toString('base64'),
  CAPTCHA_PROVIDER: 'geetest',
  GEETEST_CAPTCHA_ID: GEETEST_ID,
  GEETEST_CAPTCHA_KEY: GEETEST_KEY,
};

const makeConfig = (overrides = {}) => loadConfig({ ...BASE_ENV, ...overrides }, { skipEnvFile: true });

const CONFIG = makeConfig();
const SILENT = createLogger({ level: 'silent' });
const PASSWORD = 'correct-horse-1';

const IP_A = '10.0.0.5';
const IP_B = '10.0.0.6';

/** 极验 `getValidate()` 的 4 个参数（值本身对服务端是不透明的，只用于转发与签名） */
const LOT_NUMBER = '4dc3cfc2cdff448cad8d13107198d473';
const CAPTCHA_OUTPUT = 'captcha-output-opaque-blob';
const PASS_TOKEN = 'pass-token-opaque-blob';
const GEN_TIME = '1700000000';

// -----------------------------------------------------------------------------
// 极验侧替身（⛔ 唯一允许"扮演极验"的地方）
// -----------------------------------------------------------------------------

let vendor = null;
let fetchCalls = [];

function scriptVendor(next = {}) {
  vendor = { status: 200, body: '{"result":"success","reason":""}', throwError: null, ...next };
}

function fakeFetch(url, options) {
  fetchCalls.push({ url, options });
  if (vendor.throwError) return Promise.reject(vendor.throwError);
  return Promise.resolve({ status: vendor.status, text: async () => vendor.body });
}

// -----------------------------------------------------------------------------
// 夹具
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
  fetchCalls = [];
  scriptVendor();

  app = await buildApp({
    config: CONFIG,
    logger: SILENT,
    db: { app: pool, migrator: null },
    redis,
    fetchImpl: fakeFetch,
  });
});

after(async () => {
  if (app) await app.close();
  await db.close();
});

let seq = 0;

async function seedUser({ username = `geetest${(seq += 1)}` } = {}) {
  const row = await insertUser(pool, { username, passwordHash: await hashPassword(PASSWORD), role: 'admin' });
  return { id: row.id, username };
}

function injectLogin({ username, password, captchaToken = null, ip = IP_A, target = null }) {
  return (target ?? app).inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: ip,
    payload: { username, password, ...(captchaToken ? { captcha_token: captchaToken } : {}) },
  });
}

function challenge(ip = IP_A, target = null) {
  return (target ?? app).inject({ method: 'POST', url: '/api/v1/auth/captcha/challenge', remoteAddress: ip });
}

/** 交卷：极验分支的请求体就是 `getValidate()` 的 4 个字段 */
function submit({ ip = IP_A, overrides = {}, target = null } = {}) {
  return (target ?? app).inject({
    method: 'POST',
    url: '/api/v1/auth/captcha/verify',
    remoteAddress: ip,
    payload: {
      lot_number: LOT_NUMBER,
      captcha_output: CAPTCHA_OUTPUT,
      pass_token: PASS_TOKEN,
      gen_time: GEN_TIME,
      ...overrides,
    },
  });
}

async function auditRows(action) {
  const { rows } = await run(
    `SELECT action, actor, actor_type, detail FROM audit_logs WHERE action = $1 ORDER BY id`,
    [action],
  );
  return rows;
}

/** 制造一次登录失败（把两个失败计数器推到阈值，从而"下一次登录必须过人机验证"） */
async function failOnce(user, ip = IP_A) {
  const res = await injectLogin({ username: user.username, password: 'wrong-password-1', ip });
  assert.equal(res.statusCode, 401, res.body);
  return res;
}

// -----------------------------------------------------------------------------
// AC-G1…AC-G3：出场时机（跨提供方不变的语义）
// -----------------------------------------------------------------------------

test('AC-G1 首次登录：无失败计数时**不带**任何验证参数也能成功，⛔ 不出现 captcha_required、不打极验', async () => {
  const user = await seedUser();

  const res = await injectLogin({ username: user.username, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().totp_required, false);

  assert.equal(await redis.get(keys.loginFailIp(IP_A)), null);
  assert.equal(await redis.get(keys.loginFailAcct(user.username)), null);
  assert.equal(fetchCalls.length, 0, '首次登录不该触发任何对极验的出站调用');
});

test('AC-G2 密码错一次 → 401 + details.captcha_required；两个计数器各 +1 且与登录窗口同 TTL', async () => {
  const user = await seedUser();

  const bad = await failOnce(user);
  assert.equal(bad.json().error.code, 'invalid_credentials');
  assert.deepEqual(bad.json().error.details, { captcha_required: true });

  assert.equal(Number(await redis.get(keys.loginFailIp(IP_A))), 1);
  assert.equal(Number(await redis.get(keys.loginFailAcct(user.username))), 1);
  assert.equal(await redis.ttl(keys.loginFailIp(IP_A)), CONFIG.rateLimit.loginWindowS);
});

test('AC-G3 失败后缺凭证提交 → 400 captcha_required（⛔ 不是 401），且**不会**调极验', async () => {
  const user = await seedUser();
  await failOnce(user);

  // 即使这次密码是**对的**，也先被闸门拦下：⛔ 人机验证闸门在验密码之前（防 Argon2 DoS）
  const again = await injectLogin({ username: user.username, password: PASSWORD });
  assert.equal(again.statusCode, 400);
  assert.equal(again.json().error.code, 'captcha_required');
  assert.equal(fetchCalls.length, 0, '缺凭证时连极验都不该调用（更不该先跑 Argon2）');
});

// -----------------------------------------------------------------------------
// AC-G4…AC-G6：契约形状与二次校验
// -----------------------------------------------------------------------------

test('AC-G4 取题（geetest）只下发公开配置：⛔ 无 SVG、无 expires_in、无密钥', async () => {
  const res = await challenge();
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();

  assert.deepEqual(Object.keys(body).sort(), ['captcha_id', 'language', 'product', 'provider']);
  assert.equal(body.provider, 'geetest');
  assert.equal(body.captcha_id, GEETEST_ID, 'captcha_id 是公开值，本来就要下发给前端');
  assert.equal(body.product, 'popup', '✅ C16 已定 = 官方按钮（popup）');
  assert.equal(body.language, 'zho');
  assert.equal('bg_svg' in body, false, '出题是极验的事，服务端没有 SVG');
  assert.equal('expires_in' in body, false, '题目有效期由极验掌握，服务端承诺不了');
  assert.equal(JSON.stringify(body).includes(GEETEST_KEY), false, '⛔ captcha_key 绝不得出现在响应里');
});

test('AC-G5 验题：⛔ 只发一次请求（不重试）、URL/body/签名正确、通过后发一次性凭证并绑定 IP', async () => {
  const user = await seedUser();
  await failOnce(user);

  const verify = await submit();
  assert.equal(verify.statusCode, 200, verify.body);
  assert.deepEqual(Object.keys(verify.json()).sort(), ['captcha_token', 'expires_in']);
  assert.equal(verify.json().expires_in, CONFIG.security.captcha.ttlS);

  const token = verify.json().captcha_token;
  assert.equal(await redis.get(keys.captchaOk(token)), IP_A, 'token 的值必须是解出它的 IP');

  assert.equal(fetchCalls.length, 1, '⛔ 不重试：一次校验只发一次请求');
  const call = fetchCalls[0];
  assert.equal(call.url, `https://gcaptcha4.geetest.com/validate?captcha_id=${GEETEST_ID}`);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['content-type'], 'application/x-www-form-urlencoded');

  const params = new URLSearchParams(call.options.body);
  assert.equal(params.get('lot_number'), LOT_NUMBER);
  assert.equal(params.get('captcha_output'), CAPTCHA_OUTPUT);
  assert.equal(params.get('pass_token'), PASS_TOKEN);
  assert.equal(params.get('gen_time'), GEN_TIME);
  assert.equal(params.get('sign_token'), signToken(LOT_NUMBER, GEETEST_KEY), 'key=captcha_key、message=lot_number');
  assert.equal(params.has('captcha_id'), false, 'captcha_id 走 URL query，不进 body');
  assert.equal(params.has('user_info'), false, '⛔ C17：不把用户名通过 userInfo 交给第三方');

  // 带 token 登录 → 成功即消费
  const ok = await injectLogin({ username: user.username, password: PASSWORD, captchaToken: token });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(await redis.get(keys.captchaOk(token)), null, '登录成功即消费（一次性）');
});

test('AC-G6 极验明确判定 fail → 400 captcha_invalid(validate_failed) + 审计（⛔ 不含 pass_token）', async () => {
  const user = await seedUser();
  await failOnce(user);
  scriptVendor({ status: 200, body: JSON.stringify({ result: 'fail', reason: 'pass_token expire' }) });

  const verify = await submit();
  assert.equal(verify.statusCode, 400, verify.body);
  assert.equal(verify.json().error.code, 'captcha_invalid');
  assert.equal(verify.json().error.details.reason, 'validate_failed');

  const audits = await auditRows('auth.captcha_failed');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'system');
  assert.equal(audits[0].detail.provider, 'geetest');
  assert.equal(audits[0].detail.reason, 'validate_failed');
  assert.equal(audits[0].detail.vendor_reason, 'pass_token expire');

  const serialized = JSON.stringify(audits[0].detail);
  assert.equal(serialized.includes(PASS_TOKEN), false, '⛔ 审计不得出现 pass_token');
  assert.equal(serialized.includes(CAPTCHA_OUTPUT), false, '⛔ 审计不得出现 captcha_output');
  assert.equal(serialized.includes(LOT_NUMBER), false, '⛔ 审计不得出现 lot_number');
});

// -----------------------------------------------------------------------------
// AC-G7…AC-G9：失败模式（✅ C13 已定 = fail-open）
// -----------------------------------------------------------------------------

test('AC-G7 极验断网 + failMode=open（默认）→ **放行**并审计；熔断期间整条链路视为不存在', async () => {
  const user = await seedUser();
  await failOnce(user);
  scriptVendor({ throwError: new Error('fetch failed') });

  const verify = await submit();
  assert.equal(verify.statusCode, 200, verify.body);
  const token = verify.json().captcha_token;
  assert.equal(await redis.get(keys.captchaOk(token)), IP_A);

  const audits = await auditRows('auth.captcha_unavailable');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'system');
  assert.equal(audits[0].detail.provider, 'geetest');
  assert.equal(audits[0].detail.fail_mode, 'open');
  assert.equal(audits[0].detail.breaker, false, '这一次是真发出去失败了，不是命中熔断');
  assert.equal(typeof audits[0].detail.elapsed_ms, 'number');

  // 熔断已置位（TTL 30s）→ 熔断期间整条链路按"不存在"处理，⛔ 不让每次登录都干等一次超时
  assert.equal(await redis.exists(keys.captchaVendorDown('geetest')), 1);
  assert.equal(await redis.ttl(keys.captchaVendorDown('geetest')), TTL_S.captchaVendorDown);
  assert.equal((await challenge()).statusCode, 404, '熔断期间出题端点视为不存在');

  // 这才是 fail-open 的**完整**含义：前端的官方按钮根本拉不起来（gt4.js 也拿不到），
  // 用户不带 token 直接提交也必须能进 —— 否则"放行"只是服务端的一厢情愿。
  const ok = await injectLogin({ username: user.username, password: PASSWORD });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('AC-G8 同样的断网但 failMode=closed → 503 captcha_unavailable（⛔ 不是 400）', async () => {
  const user = await seedUser();
  await failOnce(user);
  scriptVendor({ throwError: new Error('fetch failed') });

  const closedApp = await buildApp({
    config: makeConfig({ GEETEST_FAIL_MODE: 'closed' }),
    logger: SILENT,
    db: { app: pool, migrator: null },
    redis,
    fetchImpl: fakeFetch,
  });
  try {
    const verify = await submit({ target: closedApp });
    assert.equal(verify.statusCode, 503, verify.body);
    assert.equal(verify.json().error.code, 'captcha_unavailable');

    // 审计与 open 模式一样要写（审计是"发生过不可用"的事实，与放不放行无关）
    const audits = await auditRows('auth.captcha_unavailable');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].detail.fail_mode, 'closed');

    // ⛔ closed 模式下熔断**不**让链路消失：登录仍然必须带凭证（没人能借故障绕过）
    assert.equal((await challenge(IP_A, closedApp)).statusCode, 200);
    const blocked = await injectLogin({ username: user.username, password: PASSWORD, target: closedApp });
    assert.equal(blocked.statusCode, 400);
    assert.equal(blocked.json().error.code, 'captcha_required');
  } finally {
    await closedApp.close();
  }
});

test('AC-G9 极验返回 HTTP 500 / 非 JSON → **不可用**（按 failMode 处理），⛔ 不得记成"用户没通过"', async () => {
  const user = await seedUser();
  await failOnce(user);
  scriptVendor({ status: 500, body: '<html>bad gateway</html>' });

  const verify = await submit();
  assert.equal(verify.statusCode, 200, verify.body, 'open 模式下放行');

  const unavailable = await auditRows('auth.captcha_unavailable');
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].detail.http_status, 500);
  const failed = await auditRows('auth.captcha_failed');
  assert.equal(failed.length, 0, '⛔ 一次都不能记成 captcha_failed（那是"用户作弊"，与事实不符）');
});

// -----------------------------------------------------------------------------
// AC-G10…AC-G11：一次性与绑定（与提供方无关，换极验后必须继续成立）
// -----------------------------------------------------------------------------

test('AC-G10 同一 captcha_token 登录成功后再用 → 400 captcha_invalid（已消费）', async () => {
  const user = await seedUser();
  await failOnce(user);
  const token = (await submit()).json().captcha_token;

  assert.equal((await injectLogin({ username: user.username, password: PASSWORD, captchaToken: token })).statusCode, 200);

  const reuse = await injectLogin({ username: user.username, password: PASSWORD, captchaToken: token });
  assert.equal(reuse.statusCode, 400);
  assert.equal(reuse.json().error.code, 'captcha_invalid');
  assert.equal(reuse.json().error.details.reason, 'expired');
});

test('AC-G11 换 IP 使用同一 token → 400 captcha_invalid(ip_mismatch)', async () => {
  const user = await seedUser();
  await failOnce(user, IP_A);
  const token = (await submit({ ip: IP_A })).json().captcha_token;

  const other = await injectLogin({ username: user.username, password: PASSWORD, captchaToken: token, ip: IP_B });
  assert.equal(other.statusCode, 400);
  assert.equal(other.json().error.details.reason, 'ip_mismatch');
});

test('密码又错时不消费 token（⛔ 用户不必重新点一次验证）——这是"两步契约"换来的直接收益', async () => {
  const user = await seedUser();
  await failOnce(user);
  const token = (await submit()).json().captcha_token;

  const badWithToken = await injectLogin({
    username: user.username,
    password: 'wrong-password-1',
    captchaToken: token,
  });
  assert.equal(badWithToken.statusCode, 401, '有有效 token 时应当进入验密码环节，而不是再要一次验证');
  assert.equal(await redis.get(keys.captchaOk(token)), IP_A, '⛔ 失败不得消费 token');

  // 且这一次**不需要**再打一次极验（极验的 pass_token 是一次性的，正好只在 /captcha/verify 用掉一次）
  const callsBefore = fetchCalls.length;
  assert.equal((await injectLogin({ username: user.username, password: PASSWORD, captchaToken: token })).statusCode, 200);
  assert.equal(fetchCalls.length, callsBefore, '重试登录不该再调用极验');
});

// -----------------------------------------------------------------------------
// AC-G12：配置守卫（⛔ 本文档最看重的一条防呆）
// -----------------------------------------------------------------------------

test('AC-G12 显式声明 provider=geetest 却缺密钥 → 启动即 CONFIG_INVALID（⛔ 不是跑起来后静默放行）', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, GEETEST_CAPTCHA_ID: '', GEETEST_CAPTCHA_KEY: '' }, { skipEnvFile: true }),
    (err) => {
      assert.equal(err.code, 'CONFIG_INVALID');
      assert.match(err.details.join('\n'), /CAPTCHA_PROVIDER=geetest 时必须同时配置/);
      return true;
    },
  );
});

test('AC-G12b 未设置 CAPTCHA_PROVIDER 时自动推断：有密钥→geetest；无密钥→selfbuilt（既有部署升级不炸）', () => {
  const env = { ...BASE_ENV };
  delete env.CAPTCHA_PROVIDER;

  assert.equal(loadConfig(env, { skipEnvFile: true }).security.captcha.provider, 'geetest');

  const noKeys = { ...env };
  delete noKeys.GEETEST_CAPTCHA_ID;
  delete noKeys.GEETEST_CAPTCHA_KEY;
  const inferred = loadConfig(noKeys, { skipEnvFile: true });
  assert.equal(inferred.security.captcha.provider, 'selfbuilt', '没有极验可用时应回退到自建滑块，而不是拒绝启动');
  assert.equal(inferred.security.captcha.geetest.captchaId, null);

  // 显式 none：整条链路关闭（由 services/captcha/providers/index.js 返回 null provider 实现）
  assert.equal(
    loadConfig({ ...noKeys, CAPTCHA_PROVIDER: 'none' }, { skipEnvFile: true }).security.captcha.provider,
    'none',
  );
  // 取值非法必须在配置层就被拦下
  assert.throws(
    () => loadConfig({ ...env, CAPTCHA_PROVIDER: 'geetest4' }, { skipEnvFile: true }),
    /CAPTCHA_PROVIDER 只能是/,
  );
});
