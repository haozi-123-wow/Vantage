/**
 * Vantage · Redis 固定窗口计数器（原子：`INCR` + 仅首次设 TTL）
 *
 * 依据：`docs/api.md` §1.4（限流）、`docs/slider-captcha-selfbuilt.md` §2.1/§4（登录失败计数）
 *
 * 🔑 为什么单独抽出来
 *  - 这段 Lua 的两种朴素写法**都是错的**（详见 `middleware/rateLimit.js` 文件头）：
 *    ① `INCR` 后每次都 `EXPIRE` → TTL 被不断续期，计数器永不清零；
 *    ② `INCR` 后只在 `n===1` 时 `EXPIRE`（两步非原子）→ 崩在中间会留下**没有 TTL 的计数器**。
 *  - 限流（`middleware/rateLimit.js`）与登录失败计数（`services/captcha.service.js`）需要**同一套语义**；
 *    ⛔ 各抄一份 Lua 等于埋一个"两边 TTL 口径悄悄漂移"的坑，所以这里是唯一来源。
 *
 * ⚠️ 固定窗口的固有性质：边界处允许最多 2× 瞬时突发。对本用途（限流、失败计数）完全够用，
 *    真要"任意 N 秒内 ≤ M 次"得换滑动窗口/令牌桶，成本与收益不匹配。
 */

/** 原子「计数 + 首次设 TTL」，返回 [当前计数, 剩余秒数] */
export const FIXED_WINDOW_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return { n, redis.call('TTL', KEYS[1]) }
`;

/**
 * 计数 +1 并返回窗口剩余时间。
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} key
 * @param {number} windowS 窗口长度（秒）
 * @returns {Promise<{ count: number, ttlS: number }>}
 * @throws 透传 Redis 异常 —— ⛔ 调用方**不得**把异常吞掉当"计数成功"：
 *         本仓库的取向是 fail-closed（`docs/api.md` §1.4：Redis 挂了宁可拒绝服务，也不放开）
 */
export async function bumpFixedWindow(redis, key, windowS) {
  // ioredis 会把 Lua 的 table 映射成扁平数组 [count, ttl]
  const [count, ttl] = await redis.eval(FIXED_WINDOW_LUA, 1, key, windowS);
  return { count: Number(count) || 0, ttlS: Number(ttl) || 0 };
}

/**
 * 读当前计数（不 +1）。键不存在或值非法一律返回 0 ——
 * ⛔ 不抛错：它跑在登录路径上，"读不到计数"只应表现为"这一次不要求人机验证"，
 * 而**不能**把登录打成 500（真正的依赖故障会由限流器先一步 fail-closed 拦下）。
 */
export async function readCounter(redis, key) {
  const raw = await redis.get(key);
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}
