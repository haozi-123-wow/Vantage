/**
 * Vantage · 面板会话服务（Redis 有状态会话，✅ 决策 #31/#32、设计 §18.1）
 *
 * 依据：docs/api.md §4.1（Cookie / 会话 hash / 生命周期 / 轮换）、§4.1.1 ①（键结构与字段）
 *       docs/database.md §7（Redis 键空间契约：`session:<sid>`、`user_sessions:<uid>`）
 *
 * 三条不可动摇的规则
 *  1. **会话状态只在 Redis**：Cookie 里只有不透明 `sid`（256-bit 随机），⛔ 不放任何用户资料。
 *  2. **双 TTL**：滑动 30min（每次命中续期）+ 绝对 24h（从 `created_at` 起算，**不受续期影响**）。
 *     只有滑动 TTL 的话，一个持续活跃的会话永远不会过期——被盗的 Cookie 可以永久使用。
 *  3. **轮换 sid**（✅ 决策 #32）：过 2FA / 改密 / 用恢复码之后必须换一个 sid，防会话固定攻击。
 *
 * 🔑 为什么轮换时**不换 csrf**（与"sid 必须变"并不矛盾）：
 *   防的是**会话标识被固定**，而 csrf 是"当前会话的写操作令牌"。若轮换时一起换掉，
 *   那些返回 204 无响应体的接口（改密、2FA 验证）就没机会把新 csrf 交给前端 →
 *   客户端手上那个立刻失效，后续所有写请求 403 `csrf_invalid`（自己把自己锁住）。
 *   sid 已经变了，攻击者拿旧 sid 无从下手；csrf 保持稳定是**安全且可用**的取舍。
 *
 * ⛔ 本模块只管会话的**存取**：不判断密码、不发 Cookie、不抛 HTTP 错误码
 *    （HTTP 语义在 `middleware/authPanel.js`，业务判断在 `services/auth.service.js`）。
 */

import { generateCsrfToken, generateSessionId } from '../utils/crypto.js';
import { keys } from '../utils/redisKeys.js';

/** 会话三态（docs/api.md §4.1.1 ②） */
export const SESSION_STATE = Object.freeze({
  full: 'full',
  totpPending: 'totp_pending',
  setupRequired: 'setup_required',
});

/**
 * `last_seen` 的写入节流（秒）。
 * 🔑 不节流的话**每个带会话的请求都要写一次 Redis**（`HSET` + 可能的 `EXPIRE`），
 *    面板轮询/图表刷新会把 Redis 写放大成主要负载，而 `last_seen` 的精度要求只有"分钟级"。
 */
export const LAST_SEEN_WRITE_INTERVAL_S = 60;

/** `ua` 落库上限：UA 头是客户端可控的任意长字符串，⛔ 不能让一个请求决定 Redis 的占用 */
export const UA_MAX_LENGTH = 200;

function sessionConfig(config) {
  const section = config?.security?.session;
  if (!section) throw new Error('缺少 config.security.session（会话配置未加载）');
  return section;
}

function truncateUa(ua) {
  if (!ua) return '';
  return String(ua).slice(0, UA_MAX_LENGTH);
}

function parseRoles(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    // 会话内容损坏 → 当作空角色（后续中间件会因缺少角色而拒绝），⛔ 不让它变成 500
    return [];
  }
}

function parseDate(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? new Date(0) : new Date(ms);
}

/** Redis hash（全字符串）→ 领域对象 */
function toSession(sid, raw) {
  return {
    sid,
    userId: raw.user_id,
    roles: parseRoles(raw.roles),
    totpOk: raw.totp_ok === '1',
    setupRequired: raw.setup_required === '1',
    csrf: raw.csrf ?? '',
    createdAt: parseDate(raw.created_at),
    lastSeen: parseDate(raw.last_seen ?? raw.created_at),
    ip: raw.ip ? raw.ip : null,
    ua: raw.ua ? raw.ua : null,
  };
}

/**
 * 会话状态判定（docs/api.md §4.1.1 ②）。
 * @param {{ totpOk: boolean, setupRequired: boolean } | null} session
 * @returns {'full'|'totp_pending'|'setup_required'|null}
 */
export function sessionState(session) {
  if (!session) return null;
  if (session.setupRequired && !session.totpOk) return SESSION_STATE.setupRequired;
  return session.totpOk ? SESSION_STATE.full : SESSION_STATE.totpPending;
}

/**
 * 创建会话（登录成功后调用）。
 *
 * @param {import('ioredis').Redis} redis
 * @param {object} config `loadConfig()` 结果
 * @param {object} input
 * @param {string} input.userId
 * @param {string[]} input.roles 恒为单元素数组（`["admin"]`/`["user"]`）
 * @param {boolean} [input.totpOk] 未过第二步时为 false
 * @param {boolean} [input.setupRequired] `security.require_2fa=true` 且未绑定 TOTP
 * @param {string|null} [input.ip]
 * @param {string|null} [input.ua]
 * @param {number} [input.now] 注入时钟（测试用）
 * @param {{ debug?: Function, warn?: Function }} [input.logger]
 * @returns {Promise<{ sid: string, session: object, evicted: string[] }>}
 *   `evicted` 是被"并发上限"踢下线的**存活**会话 sid（不含顺带清理掉的僵尸成员）——
 *   调用方（登录路径）建议写审计，便于解释"我怎么被下线了"。
 */
export async function createSession(redis, config, input) {
  const { slidingTtlS, maxPerUser } = sessionConfig(config);
  const nowMs = input.now ?? Date.now();
  const createdAt = new Date(nowMs).toISOString();

  const sid = generateSessionId();
  const fields = {
    user_id: input.userId,
    roles: JSON.stringify(input.roles ?? []),
    totp_ok: input.totpOk ? '1' : '0',
    setup_required: input.setupRequired ? '1' : '0',
    created_at: createdAt,
    last_seen: createdAt,
    ip: input.ip ?? '',
    ua: truncateUa(input.ua),
    csrf: generateCsrfToken(),
  };

  const multi = redis.multi();
  multi.hset(keys.session(sid), fields);
  multi.expire(keys.session(sid), slidingTtlS);
  multi.sadd(keys.userSessions(input.userId), sid);
  await multi.exec();

  const evicted = await pruneSessions(redis, {
    userId: input.userId,
    maxPerUser,
    protectSid: sid,
    logger: input.logger,
  });

  return { sid, session: toSession(sid, fields), evicted };
}

/**
 * 会话集合整理（**每次登录都跑一次**，不只是超限时）。
 *
 * 干两件事：
 *  1. **清理僵尸成员**：sid 的 hash 过期后，没有任何人会去 `SREM` 那个成员
 *     （过期是 Redis 自己删键，不是我们的代码）。不清理的话，`user_sessions:<uid>`
 *     会随"登录→闲置过期→再登录"无限增长——而它只在限并发与"全部下线"时被读，
 *     属于典型的"平时没人看、发现时已经很大"的泄漏。
 *  2. **并发上限**：存活会话超过 `maxPerUser` 时踢**最旧**的（✅ 决策 #32）。
 *
 * 🔑 `protectSid` 不是可选项：新建会话与既有会话的 `created_at` 可能落在**同一毫秒**
 *    （脚本化连续登录），只按时间排序时"最旧"可能就是刚建的那一个 ——
 *    现象是"登录成功但立刻 401"，极难排查。因此新建的 sid 永远不参与淘汰。
 *
 * ⚠️ 每轮多一次 pipeline（成员数 ≤ 并发上限附近），换掉一条无界增长的路径，值得。
 *
 * @returns {Promise<string[]>} 被踢下线的**存活**会话 sid（僵尸成员不计入——它们不是会话）
 */
async function pruneSessions(redis, { userId, maxPerUser, protectSid, logger }) {
  const setKey = keys.userSessions(userId);
  const sids = await redis.smembers(setKey);
  if (sids.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const sid of sids) pipeline.hget(keys.session(sid), 'created_at');
  const results = await pipeline.exec();

  // ⚠️ 必须**按原始下标取结果**：results 与 sids 同序，先 filter 会把下标错位，
  //    于是"最旧的那个"变成随机一个（我第一版就踩了）。
  const rows = sids.map((sid, index) => {
    const raw = results?.[index]?.[1];
    const parsed = raw ? Date.parse(raw) : 0;
    return { sid, alive: typeof raw === 'string', createdAt: Number.isNaN(parsed) ? 0 : parsed };
  });

  const others = rows
    .filter((row) => row.sid !== protectSid && row.alive)
    .sort((a, b) => a.createdAt - b.createdAt);
  const keepOthers = others.slice(Math.max(0, others.length - (maxPerUser - 1)));
  const keep = new Set([protectSid, ...keepOthers.map((row) => row.sid)]);

  const dropped = rows.filter((row) => !keep.has(row.sid));
  if (dropped.length === 0) return [];

  const cleanup = redis.multi();
  for (const row of dropped) {
    cleanup.del(keys.session(row.sid)); // 僵尸的键本就不存在，DEL 幂等
    cleanup.srem(setKey, row.sid);
  }
  await cleanup.exec();

  const evicted = dropped.filter((row) => row.alive).map((row) => row.sid);
  const zombies = dropped.length - evicted.length;
  if (zombies > 0) logger?.debug?.({ userId, zombies }, '已清理会话集合里的僵尸成员（对应 hash 已过期）');
  if (evicted.length > 0) {
    logger?.debug?.({ userId, evicted: evicted.length, maxPerUser }, '会话数超限：已踢掉最旧的会话');
  }
  return evicted;
}

/**
 * 载入会话（每个带 Cookie 的请求调用一次）。
 *
 * 行为：不存在/已过期 → `null`；存在 → 返回会话对象，并**顺带**做滑动续期与（节流的）`last_seen` 更新。
 * ⛔ 不抛错：判断"要不要 401"是中间件的事，这里只回答"这个 sid 现在还有效吗"。
 *
 * @param {import('ioredis').Redis} redis
 * @param {object} config
 * @param {string|null|undefined} sid
 * @param {{ now?: number, logger?: object }} [options]
 * @returns {Promise<object|null>}
 */
export async function loadSession(redis, config, sid, options = {}) {
  if (!sid) return null;
  const { slidingTtlS, absoluteTtlS } = sessionConfig(config);
  const nowMs = options.now ?? Date.now();
  const key = keys.session(sid);

  const raw = await redis.hgetall(key);
  if (!raw || Object.keys(raw).length === 0) return null;

  // 结构损坏（缺关键字段）→ 视为无效并清掉，避免后续用 undefined 的 userId 去查库
  if (!raw.user_id || !raw.created_at) {
    await destroySession(redis, config, sid);
    options.logger?.warn?.({ sid }, '会话数据不完整，已销毁（请重新登录）');
    return null;
  }

  const session = toSession(sid, raw);

  // 绝对 TTL：从 created_at 起算，滑动续期改变不了它
  if (nowMs - session.createdAt.getTime() >= absoluteTtlS * 1000) {
    await destroySession(redis, config, sid);
    options.logger?.debug?.({ sid, userId: session.userId }, '会话已达绝对 TTL，已销毁（需重新登录）');
    return null;
  }

  const multi = redis.multi();
  multi.expire(key, slidingTtlS);
  if (nowMs - session.lastSeen.getTime() >= LAST_SEEN_WRITE_INTERVAL_S * 1000) {
    multi.hset(key, 'last_seen', new Date(nowMs).toISOString());
    session.lastSeen = new Date(nowMs);
  }
  await multi.exec();
  return session;
}

/**
 * 轮换 sid（✅ 决策 #32：过 2FA / 改密 / 恢复码验证成功后必须换）。
 *
 * 保留：`user_id` / `roles` / `csrf` / `created_at` / `ip` / `ua`（理由见文件头）
 * 更新：`totp_ok`、`setup_required`（补丁）与 `last_seen`
 *
 * ⚠️ 轮换**不增加**会话数（同一个逻辑会话换了个标识），因此不走并发上限淘汰。
 * @param {import('ioredis').Redis} redis
 * @param {object} config
 * @param {string} sid 旧 sid
 * @param {{ patch?: { totpOk?: boolean, setupRequired?: boolean }, now?: number, logger?: object }} [options]
 * @returns {Promise<{ sid: string, session: object } | null>} 旧会话不存在/已过绝对 TTL → null
 */
export async function rotateSession(redis, config, sid, options = {}) {
  if (!sid) return null;
  const { slidingTtlS, absoluteTtlS } = sessionConfig(config);
  const nowMs = options.now ?? Date.now();
  const oldKey = keys.session(sid);

  const raw = await redis.hgetall(oldKey);
  if (!raw || Object.keys(raw).length === 0) return null;
  if (!raw.user_id || !raw.created_at) {
    await destroySession(redis, config, sid);
    return null;
  }

  const current = toSession(sid, raw);
  if (nowMs - current.createdAt.getTime() >= absoluteTtlS * 1000) {
    await destroySession(redis, config, sid);
    return null;
  }

  const nextSid = generateSessionId();
  const fields = {
    ...raw,
    totp_ok: (options.patch?.totpOk ?? current.totpOk) ? '1' : '0',
    setup_required: (options.patch?.setupRequired ?? current.setupRequired) ? '1' : '0',
    last_seen: new Date(nowMs).toISOString(),
  };

  const multi = redis.multi();
  multi.hset(keys.session(nextSid), fields);
  multi.expire(keys.session(nextSid), slidingTtlS);
  multi.del(oldKey);
  multi.srem(keys.userSessions(current.userId), sid);
  multi.sadd(keys.userSessions(current.userId), nextSid);
  await multi.exec();

  return { sid: nextSid, session: toSession(nextSid, fields) };
}

/**
 * 销毁单个会话（登出）。
 * @returns {Promise<boolean>} 该会话此前是否存在
 */
export async function destroySession(redis, config, sid) {
  if (!sid) return false;
  const key = keys.session(sid);
  const userId = await redis.hget(key, 'user_id');
  const multi = redis.multi();
  multi.del(key);
  if (userId) multi.srem(keys.userSessions(userId), sid);
  await multi.exec();
  return Boolean(userId);
}

/**
 * 全部下线（`POST /auth/logout-all`，以及改密后的"踢其它会话"）。
 * @returns {Promise<number>} 被销毁的会话数
 */
export async function destroyAllSessions(redis, config, userId) {
  const setKey = keys.userSessions(userId);
  const sids = await redis.smembers(setKey);
  const multi = redis.multi();
  for (const sid of sids) multi.del(keys.session(sid));
  multi.del(setKey);
  await multi.exec();
  return sids.length;
}

/**
 * 踢掉某用户**除 keepSid 之外**的全部会话（改密后保留当前这一个）。
 * @returns {Promise<number>}
 */
export async function destroyOtherSessions(redis, config, userId, keepSid) {
  const setKey = keys.userSessions(userId);
  const sids = (await redis.smembers(setKey)).filter((sid) => sid !== keepSid);
  const multi = redis.multi();
  for (const sid of sids) {
    multi.del(keys.session(sid));
    multi.srem(setKey, sid);
  }
  await multi.exec();
  return sids.length;
}

/** 当前会话数（排障/测试用；⛔ 不清理僵尸成员，只反映集合大小） */
export async function countSessions(redis, userId) {
  return (await redis.smembers(keys.userSessions(userId))).length;
}
