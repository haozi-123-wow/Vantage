/**
 * 面板会话服务 + 鉴权中间件测试（**离线可跑：注入时钟 + 内存 Redis 替身**）
 *
 * 依据：docs/api.md §4.1（Cookie / 会话 / CSRF）、§4.1.1 ①②③④（键结构、三态矩阵、错误码、防重放键）
 *
 * 为什么时钟必须注入：本套件的核心断言全是**时间语义**——滑动 30min 续期、绝对 24h 封顶、
 *   `last_seen` 写节流。用真实时间就意味着每条用例要么等半小时，要么只敢测"刚创建就读取"这种空断言。
 *   注入后，"连续活跃 24 小时"可以在毫秒内跑完（见"持续活跃也逃不过绝对 TTL"那条）。
 *
 * 中间件用**真的 Fastify 实例**（`buildApp` + `@fastify/cookie` + 真实错误处理器）：
 *   Cookie 属性、CSRF 头、状态码映射都只在真实 HTTP 栈里才成立，
 *   自己拼一个假 request 对象等于把要验的东西全部假设成对的。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import {
  createPanelAuth,
  sessionCookieName,
  sessionCookieOptions,
} from '../src/middleware/authPanel.js';
import {
  LAST_SEEN_WRITE_INTERVAL_S,
  SESSION_STATE,
  countSessions,
  createSession,
  destroyAllSessions,
  destroyOtherSessions,
  destroySession,
  loadSession,
  rotateSession,
  sessionState,
} from '../src/services/session.service.js';
import { keys } from '../src/utils/redisKeys.js';
import { createLogger } from '../src/utils/log.js';
import { createFakeRedisHash } from './helpers/fake-redis-hash.js';

const CONFIG = loadConfig(
  {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 3).toString('base64'),
  },
  { skipEnvFile: true },
);

const SILENT = createLogger({ level: 'silent' });
const USER_A = '11111111-2222-4333-8444-555555555555';
const USER_B = '99999999-8888-4777-8666-555555555555';
const START_MS = Date.parse('2026-10-02T12:00:00.000Z');

/** 每个用例一套独立状态：注入时钟 + 内存 Redis + 绑定好 now/config 的调用壳 */
function setup() {
  let current = START_MS;
  const clock = {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
  const redis = createFakeRedisHash({ now: clock.now });
  const s = {
    create: (input) => createSession(redis, CONFIG, { ...input, now: clock.now(), logger: SILENT }),
    load: (sid) => loadSession(redis, CONFIG, sid, { now: clock.now(), logger: SILENT }),
    rotate: (sid, patch) => rotateSession(redis, CONFIG, sid, { now: clock.now(), patch, logger: SILENT }),
    destroy: (sid) => destroySession(redis, CONFIG, sid),
    destroyAll: (userId) => destroyAllSessions(redis, CONFIG, userId),
    destroyOther: (userId, keepSid) => destroyOtherSessions(redis, CONFIG, userId, keepSid),
    count: (userId) => countSessions(redis, userId),
  };
  return { redis, clock, s };
}

// -----------------------------------------------------------------------------
// 创建与读取
// -----------------------------------------------------------------------------

test('createSession：写入会话 hash + 滑动 TTL + user_sessions 集合成员', async () => {
  const { redis, s } = setup();
  const { sid, session } = await s.create({
    userId: USER_A,
    roles: ['admin'],
    totpOk: true,
    ip: '203.0.113.7',
    ua: 'Mozilla/5.0 (test)',
  });

  assert.equal(sid.length > 20, true, 'sid 必须是高强度随机值（base64url 32 字节 → 43 字符）');
  assert.equal(session.userId, USER_A);
  assert.deepEqual(session.roles, ['admin']);
  assert.equal(session.totpOk, true);
  assert.equal(session.setupRequired, false);
  assert.equal(session.csrf.length > 20, true);

  const raw = await redis.hgetall(keys.session(sid));
  assert.deepEqual(Object.keys(raw).sort(), [
    'created_at',
    'csrf',
    'ip',
    'last_seen',
    'roles',
    'setup_required',
    'totp_ok',
    'ua',
    'user_id',
  ]);
  assert.equal(raw.roles, '["admin"]', 'roles 以 JSON 数组串存储（为将来多角色留形）');
  assert.equal(await redis.ttl(keys.session(sid)), CONFIG.security.session.slidingTtlS);
  assert.deepEqual(await redis.smembers(keys.userSessions(USER_A)), [sid]);
});

test('createSession：未过第二步 / 强制绑定态都如实落库（totp_ok、setup_required）', async () => {
  const { redis, s } = setup();
  const pending = await s.create({ userId: USER_A, roles: ['admin'], totpOk: false });
  const setupRequired = await s.create({ userId: USER_B, roles: ['user'], totpOk: false, setupRequired: true });

  assert.equal((await redis.hgetall(keys.session(pending.sid))).totp_ok, '0');
  assert.equal((await redis.hgetall(keys.session(setupRequired.sid))).setup_required, '1');
});

test('loadSession：字段归一（空 IP → null、roles 解析、UA 截断到 200 字符）', async () => {
  const { s } = setup();
  const longUa = 'x'.repeat(500);
  const { sid } = await s.create({ userId: USER_A, roles: ['user'], totpOk: true, ip: null, ua: longUa });

  const session = await s.load(sid);
  assert.equal(session.ip, null, '空串 IP 必须归一为 null，否则前端会显示一个空 IP');
  assert.deepEqual(session.roles, ['user']);
  assert.equal(session.ua.length, 200, 'UA 是客户端可控的任意长字符串，必须截断');
  assert.ok(session.createdAt instanceof Date);
  assert.equal(session.createdAt.getTime(), START_MS);
});

test('loadSession：未知 sid / 空 sid / 结构损坏的会话一律返回 null（不抛）', async () => {
  const { redis, s } = setup();
  assert.equal(await s.load('not-a-real-sid'), null);
  assert.equal(await s.load(''), null);
  assert.equal(await s.load(null), null);

  // 结构损坏：缺 created_at（如手工写入/半截写入）→ 视为无效并销毁，⛔ 不能带着 undefined 往下走
  redis.seedHash(keys.session('broken-sid'), { user_id: USER_A });
  assert.equal(await s.load('broken-sid'), null);
  assert.equal(redis.has(keys.session('broken-sid')), false);
});

test('roles 损坏时退化为空数组，而不是把异常抛给请求（角色判定留待中间件拒绝）', async () => {
  const { redis, s } = setup();
  redis.seedHash(keys.session('bad-roles'), {
    user_id: USER_A,
    roles: '{不是 JSON',
    created_at: new Date(START_MS).toISOString(),
    last_seen: new Date(START_MS).toISOString(),
  });
  const session = await s.load('bad-roles');
  assert.deepEqual(session.roles, []);
});

test('sessionState：三态判定（full / totp_pending / setup_required）', () => {
  assert.equal(sessionState(null), null);
  assert.equal(sessionState({ totpOk: true, setupRequired: false }), SESSION_STATE.full);
  assert.equal(sessionState({ totpOk: false, setupRequired: false }), SESSION_STATE.totpPending);
  assert.equal(sessionState({ totpOk: false, setupRequired: true }), SESSION_STATE.setupRequired);
  // setupRequired 与 totpOk 同时为真只可能出现在代码缺陷里；此判定保证"已过第二步"优先
  assert.equal(sessionState({ totpOk: true, setupRequired: true }), SESSION_STATE.full);
});

// -----------------------------------------------------------------------------
// 生命周期：滑动 / 绝对 TTL / last_seen 节流
// -----------------------------------------------------------------------------

test('滑动 TTL：每次命中都续期（闲置 20 分钟后再访问，剩余 TTL 回到满格）', async () => {
  const { redis, clock, s } = setup();
  const { sid } = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });

  clock.advance(20 * 60_000);
  assert.equal(await redis.ttl(keys.session(sid)), 600, '未访问的 20 分钟已经从 TTL 里扣掉');

  assert.ok(await s.load(sid));
  assert.equal(await redis.ttl(keys.session(sid)), CONFIG.security.session.slidingTtlS, '命中后 TTL 续满');
});

test('滑动 TTL：闲置超过 30 分钟即失效（无需任何清理任务）', async () => {
  const { s, clock } = setup();
  const { sid } = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });
  clock.advance(CONFIG.security.session.slidingTtlS * 1000 + 1000);
  assert.equal(await s.load(sid), null);
});

test('绝对 TTL：持续活跃也逃不过 24h（滑动续期不能给会话续命）', async () => {
  const { redis, clock, s } = setup();
  const { sid } = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });

  // 每 20 分钟访问一次（远小于滑动 TTL）：会话始终"活跃"，绝不会因闲置而失效
  let aliveRounds = 0;
  let expiredAt = null;
  for (let round = 1; round <= 72; round += 1) {
    clock.advance(20 * 60_000);
    if (await s.load(sid)) {
      aliveRounds += 1;
      continue;
    }
    expiredAt = round;
    break;
  }

  assert.equal(aliveRounds, 71, '前 71 轮（23h40m）都必须有效');
  assert.equal(expiredAt, 72, '第 72 轮（累计 24h）必须失效 —— 上限是绝对 TTL，不是滑动 TTL');
  assert.equal(redis.has(keys.session(sid)), false, '会话键应被销毁');
  assert.deepEqual(await redis.smembers(keys.userSessions(USER_A)), [], '集合成员也应被移除');
});

test(`last_seen：写入节流（${LAST_SEEN_WRITE_INTERVAL_S}s 内不重复写），但滑动续期照做`, async () => {
  const { redis, s, clock } = setup();
  const { sid } = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });
  const firstSeen = (await redis.hgetall(keys.session(sid))).last_seen;

  clock.advance(10_000);
  await s.load(sid);
  assert.equal((await redis.hgetall(keys.session(sid))).last_seen, firstSeen, '10s 内不得写 last_seen');
  assert.equal(await redis.ttl(keys.session(sid)), CONFIG.security.session.slidingTtlS, '但 TTL 必须续期');

  clock.advance(LAST_SEEN_WRITE_INTERVAL_S * 1000);
  await s.load(sid);
  const updated = (await redis.hgetall(keys.session(sid))).last_seen;
  assert.notEqual(updated, firstSeen, '超过节流窗口后必须更新 last_seen');
  assert.equal(Date.parse(updated) - Date.parse(firstSeen), (10 + LAST_SEEN_WRITE_INTERVAL_S) * 1000);
});

// -----------------------------------------------------------------------------
// 并发上限（✅ 决策 #32：超限踢最旧）
// -----------------------------------------------------------------------------

test('并发上限：第 4 次登录踢掉最旧的那个（并回传被踢 sid 供审计）', async () => {
  const { redis, clock, s } = setup();
  const sids = [];
  for (let i = 0; i < 4; i += 1) {
    clock.advance(1000); // 拉开创建时间，保证"最旧"是确定的
    const created = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });
    sids.push(created.sid);
    if (i === 3) assert.deepEqual(created.evicted, [sids[0]], '第 4 次必须踢掉第 1 个');
  }

  assert.equal(await s.load(sids[0]), null, '最旧的会话已失效');
  assert.ok(await s.load(sids[3]), '最新的会话必须仍然有效');
  assert.equal(await s.count(USER_A), CONFIG.security.session.maxPerUser);
  assert.deepEqual(await redis.smembers(keys.userSessions(USER_A)).then((all) => all.sort()), [sids[1], sids[2], sids[3]].sort());
  assert.equal(redis.has(keys.session(sids[0])), false, '被踢会话的键必须删除');
});

test('并发上限：同一毫秒创建的会话也必须保住新的那个（protectSid 的由来）', async () => {
  const { s } = setup();
  // 刻意不推进时钟：4 个会话的 created_at 完全相同
  const created = [];
  for (let i = 0; i < 4; i += 1) created.push(await s.create({ userId: USER_A, roles: ['admin'], totpOk: true }));

  assert.ok(await s.load(created[3].sid), '刚建好的会话绝不能被自己触发的淘汰踢掉');
  assert.equal(await s.count(USER_A), CONFIG.security.session.maxPerUser);
});

test('并发上限：集合里的僵尸 sid（hash 已过期）被清理，且不计入"被踢会话"', async () => {
  const { redis, s, clock } = setup();
  await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });
  clock.advance(1000);
  await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });
  clock.advance(1000);
  await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });

  // 模拟"hash 已过期但没人 SREM"的残留成员
  await redis.sadd(keys.userSessions(USER_A), 'ghost-sid');
  assert.equal(await s.count(USER_A), 4);

  clock.advance(1000);
  const created = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });

  assert.equal(created.evicted.length, 1, '超限踢掉 1 个存活会话（僵尸不算会话）');
  assert.equal(created.evicted.includes('ghost-sid'), false, '僵尸不是会话，不该出现在"被踢下线"名单里');
  const members = await redis.smembers(keys.userSessions(USER_A));
  assert.equal(members.includes('ghost-sid'), false, '僵尸成员必须从集合移除');
  assert.equal(members.length, CONFIG.security.session.maxPerUser);
});

test('每次登录都整理集合：未超限时也会清掉僵尸成员（防 user_sessions 无界增长）', async () => {
  const { redis, s, clock } = setup();
  const first = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });

  // 让它自然过期：Redis 自己删 hash，但集合成员没有任何人负责 SREM
  clock.advance(CONFIG.security.session.slidingTtlS * 1000 + 1000);
  assert.equal(redis.has(keys.session(first.sid)), false, '会话键已过期');
  assert.deepEqual(await redis.smembers(keys.userSessions(USER_A)), [first.sid], '成员成了僵尸');

  const second = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });
  assert.deepEqual(second.evicted, [], '没超限，没有会话被踢下线');
  assert.deepEqual(
    await redis.smembers(keys.userSessions(USER_A)),
    [second.sid],
    '僵尸成员必须在下一次登录时被顺带清掉',
  );
});

test('并发上限：不同账号互不影响', async () => {
  const { s, clock } = setup();
  for (let i = 0; i < 3; i += 1) {
    clock.advance(1000);
    await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });
  }
  clock.advance(1000);
  await s.create({ userId: USER_B, roles: ['user'], totpOk: true });
  assert.equal(await s.count(USER_A), 3);
  assert.equal(await s.count(USER_B), 1);
});

// -----------------------------------------------------------------------------
// 轮换（✅ 决策 #32）
// -----------------------------------------------------------------------------

test('rotateSession：换 sid、保 csrf/created_at/ip/ua、按补丁置 totp_ok（防会话固定）', async () => {
  const { redis, s } = setup();
  const { sid: oldSid, session: before } = await s.create({
    userId: USER_A,
    roles: ['admin'],
    totpOk: false,
    ip: '198.51.100.9',
    ua: 'Mozilla/5.0 (rotate)',
  });

  const rotated = await s.rotate(oldSid, { totpOk: true, setupRequired: false });
  assert.notEqual(rotated.sid, oldSid, 'sid 必须变化');
  assert.equal(rotated.session.totpOk, true);
  assert.equal(rotated.session.setupRequired, false);
  assert.equal(rotated.session.csrf, before.csrf, 'csrf 保持稳定（理由见 session.service.js 文件头）');
  assert.equal(rotated.session.createdAt.getTime(), before.createdAt.getTime(), 'created_at 不变 ⇒ 绝对 TTL 不被重置');
  assert.equal(rotated.session.ip, '198.51.100.9');
  assert.equal(rotated.session.ua, 'Mozilla/5.0 (rotate)');

  assert.equal(await s.load(oldSid), null, '旧 sid 必须立即失效');
  assert.ok(await s.load(rotated.sid));
  const members = await redis.smembers(keys.userSessions(USER_A));
  assert.deepEqual(members, [rotated.sid], '集合内成员被原子替换，会话数不变');
  assert.equal(await redis.ttl(keys.session(rotated.sid)), CONFIG.security.session.slidingTtlS);
});

test('rotateSession：旧会话不存在/结构损坏 → null（并顺手清理）', async () => {
  const { redis, s } = setup();
  assert.equal(await s.rotate('missing-sid'), null);

  redis.seedHash(keys.session('broken'), { user_id: USER_A });
  assert.equal(await s.rotate('broken'), null);
  assert.equal(redis.has(keys.session('broken')), false);
});

// -----------------------------------------------------------------------------
// 销毁
// -----------------------------------------------------------------------------

test('destroySession：删键 + 移集合成员；重复登出返回 false', async () => {
  const { redis, s } = setup();
  const { sid } = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });

  assert.equal(await s.destroy(sid), true);
  assert.equal(redis.has(keys.session(sid)), false);
  assert.deepEqual(await redis.smembers(keys.userSessions(USER_A)), []);
  assert.equal(await s.destroy(sid), false);
  assert.equal(await s.destroy(null), false);
});

test('destroyAllSessions：全部下线（含集合本身）', async () => {
  const { redis, s, clock } = setup();
  const sids = [];
  for (let i = 0; i < 3; i += 1) {
    clock.advance(1000);
    sids.push((await s.create({ userId: USER_A, roles: ['admin'], totpOk: true })).sid);
  }
  assert.equal(await s.destroyAll(USER_A), 3);
  for (const sid of sids) assert.equal(redis.has(keys.session(sid)), false);
  assert.equal(redis.has(keys.userSessions(USER_A)), false);
  assert.equal(await s.destroyAll(USER_A), 0);
});

test('destroyOtherSessions：改密后保留当前会话、踢掉其余（含集合成员）', async () => {
  const { redis, s, clock } = setup();
  const sids = [];
  for (let i = 0; i < 3; i += 1) {
    clock.advance(1000);
    sids.push((await s.create({ userId: USER_A, roles: ['admin'], totpOk: true })).sid);
  }
  const keep = sids[1];
  assert.equal(await s.destroyOther(USER_A, keep), 2);
  assert.ok(await s.load(keep), '当前会话必须留下（否则用户改完密码自己就被踢了）');
  assert.equal(await s.load(sids[0]), null);
  assert.equal(await s.load(sids[2]), null);
  assert.deepEqual(await redis.smembers(keys.userSessions(USER_A)), [keep]);
});

// -----------------------------------------------------------------------------
// 中间件：真实 Fastify 栈
// -----------------------------------------------------------------------------

const stubPool = { query: async () => ({ rows: [], rowCount: 0 }) };

/** 装一个带面板中间件的真实 app（复用 buildApp 的错误处理器与 cookie 插件） */
async function makeApp(redis) {
  const app = await buildApp({
    config: CONFIG,
    logger: SILENT,
    db: { app: stubPool, migrator: null },
    redis,
  });
  app.decorateRequest('session', null);
  const auth = createPanelAuth({ redis, config: CONFIG, logger: SILENT });
  const load = auth.loadPanelSession;

  app.get('/test/session', { preHandler: [load, auth.requireSession] }, async (req) => ({
    userId: req.session.userId,
    roles: req.session.roles,
    state: sessionState(req.session),
  }));
  app.get('/test/me', { preHandler: [load, auth.requireSession, auth.rejectIfSetupRequired] }, async () => ({
    ok: true,
  }));
  app.get('/test/full', { preHandler: [load, auth.requireFullSession] }, async () => ({ ok: true }));
  app.post('/test/write', { preHandler: [load, auth.requireSession, auth.requireCsrf] }, async () => ({ ok: true }));
  app.post('/test/login-like', { preHandler: [load, auth.requireCsrf] }, async () => ({ ok: true }));
  app.get('/test/admin', { preHandler: [load, auth.requireRole('admin')] }, async () => ({ ok: true }));
  app.get('/test/set-cookie', async (req, reply) => {
    reply.setCookie(sessionCookieName(CONFIG), 'sid-value', sessionCookieOptions(CONFIG));
    return { ok: true };
  });
  app.get('/test/clear-cookie', async (req, reply) => {
    reply.clearCookie(sessionCookieName(CONFIG), sessionCookieOptions(CONFIG, { maxAge: 0 }));
    return { ok: true };
  });

  await app.ready();
  return { app, auth };
}

const withSid = (sid) => ({ cookies: { [sessionCookieName(CONFIG)]: sid } });

test('中间件自检：所有 preHandler 必须是 async 函数', async () => {
  // 🔑 这条用例防的是一类**会让请求永久挂起**的缺陷：Fastify 对"既非 async、也不接收 done"的 hook
  //    按回调式处理，永远等不到 done()，于是请求既不返回也不报错。
  //    真实 HTTP 栈（下面的 inject 用例）确实能抓到它，但表现是**整条用例挂死**——
  //    下面的断言让它在 1 毫秒内以一句人话失败。
  const { redis } = setup();
  const auth = createPanelAuth({ redis, config: CONFIG, logger: SILENT });
  const guards = {
    loadPanelSession: auth.loadPanelSession,
    requireSession: auth.requireSession,
    requireFullSession: auth.requireFullSession,
    rejectIfSetupRequired: auth.rejectIfSetupRequired,
    requireCsrf: auth.requireCsrf,
    'requireRole("admin")': auth.requireRole('admin'),
  };
  for (const [name, fn] of Object.entries(guards)) {
    assert.equal(fn.constructor.name, 'AsyncFunction', `${name} 必须是 async 函数`);
  }
});

test('中间件：无 Cookie → 401 session_expired；有效 Cookie → request.session 可用', async () => {
  const { redis, s } = setup();
  const { app } = await makeApp(redis);

  const anonymous = await app.inject({ method: 'GET', url: '/test/session' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'session_expired');

  const { sid } = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });
  const authorized = await app.inject({ method: 'GET', url: '/test/session', ...withSid(sid) });
  assert.equal(authorized.statusCode, 200);
  assert.deepEqual(authorized.json(), { userId: USER_A, roles: ['admin'], state: 'full' });

  await app.close();
});

test('中间件：陈旧/伪造 Cookie 被清掉（响应里带 Max-Age=0），不是留着一个死 sid', async () => {
  const { redis } = setup();
  const { app } = await makeApp(redis);

  const res = await app.inject({ method: 'GET', url: '/test/session', ...withSid('forged-sid') });
  assert.equal(res.statusCode, 401);
  const setCookie = res.headers['set-cookie'];
  assert.ok(String(setCookie).includes(`${sessionCookieName(CONFIG)}=`), '应下发清除用的 Set-Cookie');
  assert.ok(/Max-Age=0/i.test(String(setCookie)), '清 Cookie 必须是 Max-Age=0');

  await app.close();
});

test('中间件 三态矩阵：setup_required → me 也是 403 totp_setup_required；totp_pending → 403 totp_required', async () => {
  const { redis, s } = setup();
  const { app } = await makeApp(redis);

  const setupRequired = await s.create({ userId: USER_A, roles: ['admin'], totpOk: false, setupRequired: true });
  const me = await app.inject({ method: 'GET', url: '/test/me', ...withSid(setupRequired.sid) });
  assert.equal(me.statusCode, 403, '前端正是靠这个 403 才跳到绑定页（docs/api.md §4.1.1 ⑧ D2）');
  assert.equal(me.json().error.code, 'totp_setup_required');

  const full = await app.inject({ method: 'GET', url: '/test/full', ...withSid(setupRequired.sid) });
  assert.equal(full.statusCode, 403);
  assert.equal(full.json().error.code, 'totp_setup_required');

  const pending = await s.create({ userId: USER_B, roles: ['user'], totpOk: false });
  const pendingMe = await app.inject({ method: 'GET', url: '/test/me', ...withSid(pending.sid) });
  assert.equal(pendingMe.statusCode, 200, 'totp_pending 下 me 按 §4.1 放行');
  const pendingFull = await app.inject({ method: 'GET', url: '/test/full', ...withSid(pending.sid) });
  assert.equal(pendingFull.statusCode, 403);
  assert.equal(pendingFull.json().error.code, 'totp_required');

  await app.close();
});

test('中间件 CSRF：GET 不校验；写请求缺/错 token → 403 csrf_invalid；正确 token 放行', async () => {
  const { redis, s } = setup();
  const { app } = await makeApp(redis);
  const { sid, session } = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });

  const missing = await app.inject({ method: 'POST', url: '/test/write', ...withSid(sid) });
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.json().error.code, 'csrf_invalid');

  const wrong = await app.inject({
    method: 'POST',
    url: '/test/write',
    ...withSid(sid),
    headers: { 'x-csrf-token': 'not-the-token' },
  });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().error.code, 'csrf_invalid');

  const ok = await app.inject({
    method: 'POST',
    url: '/test/write',
    ...withSid(sid),
    headers: { 'x-csrf-token': session.csrf },
  });
  assert.equal(ok.statusCode, 200);

  await app.close();
});

test('中间件 CSRF：无会话的写请求放行（/auth/login 正是这种情形，⛔ 否则第一步就挂）', async () => {
  const { redis } = setup();
  const { app } = await makeApp(redis);
  const res = await app.inject({ method: 'POST', url: '/test/login-like', payload: {} });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('中间件 RBAC：user 访问 admin 端点 → 403 role_denied；无会话 → 401（401 优先于 403）', async () => {
  const { redis, s } = setup();
  const { app } = await makeApp(redis);

  const anonymous = await app.inject({ method: 'GET', url: '/test/admin' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'session_expired');

  const user = await s.create({ userId: USER_B, roles: ['user'], totpOk: true });
  const denied = await app.inject({ method: 'GET', url: '/test/admin', ...withSid(user.sid) });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'role_denied');

  const admin = await s.create({ userId: USER_A, roles: ['admin'], totpOk: true });
  const allowed = await app.inject({ method: 'GET', url: '/test/admin', ...withSid(admin.sid) });
  assert.equal(allowed.statusCode, 200);

  await app.close();
});

test('Cookie 属性：HttpOnly + SameSite=Lax + Path=/ + Max-Age=绝对 TTL；清除时 Max-Age=0', async () => {
  const { redis } = setup();
  const { app } = await makeApp(redis);

  const setRes = await app.inject({ method: 'GET', url: '/test/set-cookie' });
  const setCookie = String(setRes.headers['set-cookie']);
  assert.match(setCookie, new RegExp(`^${sessionCookieName(CONFIG)}=sid-value`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);
  assert.match(setCookie, new RegExp(`Max-Age=${CONFIG.security.session.absoluteTtlS}`, 'i'));
  assert.equal(/Secure/i.test(setCookie), false, '测试环境 COOKIE_SECURE 应为 false（生产必须 true）');
  assert.equal(/Domain=/i.test(setCookie), false, '⛔ 不设 Domain，避免子域共享会话 Cookie');

  const clearRes = await app.inject({ method: 'GET', url: '/test/clear-cookie' });
  assert.match(String(clearRes.headers['set-cookie']), /Max-Age=0/i);

  await app.close();
});
