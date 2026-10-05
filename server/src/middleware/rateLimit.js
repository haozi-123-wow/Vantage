/**
 * Vantage · 限流中间件（Agent 维度固定窗口）
 *
 * 依据：docs/api.md §1.4（Agent 上报 60 次/分钟，429 + `Retry-After`；响应头建议）、
 *       docs/database.md §7（`ratelimit:agent:<agent_id>`，窗口期 TTL）、决策 #23
 *
 * 🔑 为什么固定窗口的**清零与过期必须写在 Lua 里**（这段代码只有 4 行，但两种朴素写法都错）
 *
 *  写法 A：`INCR` 后**每次**都 `EXPIRE(key, 60)`
 *    → TTL 被不断续期，key 永远不过期。一个稳定按 59 次/分钟上报的 Agent 会
 *      在第 61 次撞上 429，并且**此后永久 429**（计数器再也回不到 0）。这是最坏的一种 bug：
 *      它只在"合法速率"下才出现，压测和短测都看不出来。
 *
 *  写法 B：`INCR`，`n === 1` 时才 `EXPIRE`
 *    → 语义正确，但两步非原子：INCR 成功后进程崩溃/连接断开，key 会留下**没有 TTL 的计数器**，
 *      同样造成永久 429。
 *
 *  Lua 脚本在 Redis 内单线程原子执行，一次往返同时拿到「计数」与「剩余 TTL」，
 *  两个问题都不存在。
 *
 * ⚠️ 窗口是**固定窗口**（非滑动/令牌桶），边界处允许最多 2× 的瞬时突发。
 *    对 15s 周期的上报流完全够用；真要精确到"任意 60s 内 ≤ 60 次"需要滑动窗口（Redis 侧成本更高），
 *    收益与成本不匹配（§1.4 的阈值本身就是 2–3 倍余量的粗粒度保护）。
 */

import { AppError } from '../utils/errors.js';
import { keys } from '../utils/redisKeys.js';
import { FIXED_WINDOW_LUA } from '../utils/redisCounter.js';

/** 窗口长度（秒）：§1.4 的建议阈值以「每分钟」表述，故窗口固定 60s */
export const AGENT_RATE_WINDOW_S = 60;

// ⚠️ 固定窗口的 Lua 已抽到 `utils/redisCounter.js`（唯一来源，登录失败计数共用同一段语义）：
//    ⛔ 不要在本文件里再写一份——那正是"两边 TTL 口径漂移"的来源。用法见下面的 eval 调用。

/**
 * 创建 Agent 限流的 preHandler。
 *
 * ⚠️ 上报与心跳**共用同一个桶**（✅ §2.2：心跳不单独设桶）——
 *    否则心跳可以被用来绕过上报限流，两倍的写入压力会绕过这一层防护。
 *
 * @param {{ redis: import('ioredis').Redis, config: object, logger: object }} deps
 */
export function createAgentRateLimiter({ redis, config, logger }) {
  const limit = config.rateLimit.agentPerMinute;

  return async function agentRateLimit(request, reply) {
    const key = keys.rateLimitAgent(request.agent.id);

    let count;
    let ttl;
    try {
      // ioredis 会把 Lua 的 table 映射成扁平数组 [count, ttl]
      [count, ttl] = await redis.eval(FIXED_WINDOW_LUA, 1, key, AGENT_RATE_WINDOW_S);
    } catch (err) {
      // 限流失效时**拒绝服务**而不是放行：Redis 是限流/nonce/幂等的共同依赖，
      // 它挂了却继续收数据，等于在没有防护的状态下写库（与 §6.1 的取舍一致）。
      logger?.error({ err, agentId: request.agent.id }, '限流检查失败（Redis 不可用）');
      throw new AppError('upstream_unavailable', { cause: err, details: { dependency: 'redis' } });
    }

    const remaining = Math.max(0, limit - count);
    const retryAfterS = Math.max(1, Number(ttl) || AGENT_RATE_WINDOW_S);
    reply.header('X-RateLimit-Limit', String(limit));
    reply.header('X-RateLimit-Remaining', String(remaining));
    // 约定：Reset = 窗口重置的 Unix **epoch 秒**；Retry-After = 还需等待的**秒数**
    reply.header('X-RateLimit-Reset', String(Math.floor(Date.now() / 1000) + retryAfterS));

    if (count > limit) {
      logger?.warn({ agentId: request.agent.id, count, limit }, 'Agent 上报被限流');
      throw new AppError('rate_limited', {
        message: `上报过于频繁（上限 ${limit} 次 / ${AGENT_RATE_WINDOW_S}s）`,
        retryAfterS,
        details: { limit, window_s: AGENT_RATE_WINDOW_S, count },
      });
    }
  };
}

/**
 * 创建**登录**限流的 preHandler（`ratelimit:login:<ip>`，✅ 决策 #23、§1.4）。
 *
 * 与 Agent 限流共用同一段「固定窗口」Lua（计数 + 仅首次设 TTL），但有两点不同：
 *  - 维度是 **IP** 而不是 agent_id（⛔ 不能按用户名限：那会把"锁死某个账号"变成攻击手段，
 *    也无法拦住换用户名的爆破；按 IP 才能拦住同一来源的扫描）。
 *  - 窗口来自 `RATELIMIT_LOGIN_WINDOW_S`（默认 300s），比上报窗口长得多。
 *
 * ⚠️ 统一错误口径（docs/api.md §4.1）：**成功与失败都计数**。只数失败的话，
 *    攻击者可以先用正确密码"免费"消耗掉正常流量再混入爆破；统一计数实现也更简单。
 *    （响应 ⛔ 不区分"账号不存在/密码错"—— 限流信息里同样不能出现账号线索。）
 *
 * ⛔ Redis 不可用时拒绝服务（与 Agent 限流同款取舍）：登录正是要被保护的动作，
 *    没有限流的登录等于敞开爆破；而 Redis 挂了会话也建不起来，503 是诚实的结果。
 *
 * @param {{ redis: import('ioredis').Redis, config: object, logger: object }} deps
 */
export function createLoginRateLimiter({ redis, config, logger }) {
  const limit = config.rateLimit.loginPerWindow;
  const windowS = config.rateLimit.loginWindowS;

  return async function loginRateLimit(request, reply) {
    const key = keys.rateLimitLogin(request.ip);

    let count;
    let ttl;
    try {
      [count, ttl] = await redis.eval(FIXED_WINDOW_LUA, 1, key, windowS);
    } catch (err) {
      logger?.error({ err, ip: request.ip }, '登录限流检查失败（Redis 不可用）');
      throw new AppError('upstream_unavailable', { cause: err, details: { dependency: 'redis' } });
    }

    const remaining = Math.max(0, limit - count);
    const retryAfterS = Math.max(1, Number(ttl) || windowS);
    reply.header('X-RateLimit-Limit', String(limit));
    reply.header('X-RateLimit-Remaining', String(remaining));
    reply.header('X-RateLimit-Reset', String(Math.floor(Date.now() / 1000) + retryAfterS));

    if (count > limit) {
      logger?.warn({ ip: request.ip, count, limit }, '登录被限流');
      throw new AppError('rate_limited', {
        message: `尝试过于频繁，请稍后再试（上限 ${limit} 次 / ${windowS}s）`,
        retryAfterS,
        details: { limit, window_s: windowS },
      });
    }
  };
}

/**
 * 创建**滑块验证码**限流的 preHandler（`ratelimit:captcha:<ip>`）。
 *
 * 依据：docs/api.md §1.4（30 次/分钟）、docs/slider-captcha-selfbuilt.md §5.1/§5.2、§6.2。
 *
 * 🔑 为什么**独立成桶**而不复用登录桶：滑块"换一张图"是**正常操作**（图看不懂、手滑拖歪），
 *    若与登录共用，用户换两次图就把登录额度吃掉了，转而在真正的登录上撞 429——典型的自伤。
 *    两桶独立后，取题/验题被限流**不影响**登录请求本身的额度。
 *
 * ⛔ Redis 不可用时拒绝服务（与本文件其它限流器同款取舍）：没有限流的滑块等于
 *    "可以无限取题 + 无限试位"，而容差 5px / 宽 320px 只要约 60 次试位就能命中（自建方案 §6.2）。
 *
 * @param {{ redis: import('ioredis').Redis, config: object, logger: object }} deps
 */
export function createCaptchaRateLimiter({ redis, config, logger }) {
  const limit = config.rateLimit.captchaPerMinute;
  const windowS = 60;

  return async function captchaRateLimit(request, reply) {
    const key = keys.rateLimitCaptcha(request.ip);

    let count;
    let ttl;
    try {
      [count, ttl] = await redis.eval(FIXED_WINDOW_LUA, 1, key, windowS);
    } catch (err) {
      logger?.error({ err, ip: request.ip }, '滑块限流检查失败（Redis 不可用）');
      throw new AppError('upstream_unavailable', { cause: err, details: { dependency: 'redis' } });
    }

    const remaining = Math.max(0, limit - count);
    const retryAfterS = Math.max(1, Number(ttl) || windowS);
    reply.header('X-RateLimit-Limit', String(limit));
    reply.header('X-RateLimit-Remaining', String(remaining));
    reply.header('X-RateLimit-Reset', String(Math.floor(Date.now() / 1000) + retryAfterS));

    if (count > limit) {
      logger?.warn({ ip: request.ip, count, limit }, '滑块取题/验题被限流');
      throw new AppError('rate_limited', {
        message: `操作过于频繁，请稍后再试（上限 ${limit} 次 / ${windowS}s）`,
        retryAfterS,
        details: { limit, window_s: windowS },
      });
    }
  };
}

/**
 * 创建**公开接口**限流的 preHandler（`ratelimit:public:<ip>`，✅ docs/api.md §1.4/§3.2、方案 §7.1）。
 *
 * 🔑 为什么公开视图（默认开启）**必须**配套严格限流：它是全站唯一「匿名可打」的读端点，
 *    内容虽然脱敏，但"主机数与在线状态"本身就是情报（可推断业务规模与故障窗口）。
 *    ⛔ 本限流器与上面三个桶**完全独立**：公开页被刷爆不得影响 Agent 上报，反之亦然。
 *
 * ⚠️ 与滑块桶的差异只有两处：桶名、阈值（`RATELIMIT_PUBLIC_PER_MINUTE`，默认 60/min）。
 *    ⛔ 不要为了"省一段代码"把它和 `ratelimit:login` 合并 —— 匿名访客刷公开页会把
 *    同一 IP 后面**所有运维**的登录额度一起吃掉（这正是 `docs/api.md` §1.4 的现有取舍）。
 *
 * ⛔ Redis 不可用时拒绝服务（与本文件其它限流器同款取舍）：没有限流的公开端点，
 *    配上"默认开启"，等于把一个可被无限抓取的拓扑快照放到公网上。
 *
 * @param {{ redis: import('ioredis').Redis, config: object, logger: object }} deps
 */
export function createPublicRateLimiter({ redis, config, logger }) {
  const limit = config.rateLimit.publicPerMinute;
  const windowS = 60;

  return async function publicRateLimit(request, reply) {
    const key = keys.rateLimitPublic(request.ip);

    let count;
    let ttl;
    try {
      [count, ttl] = await redis.eval(FIXED_WINDOW_LUA, 1, key, windowS);
    } catch (err) {
      logger?.error({ err, ip: request.ip }, '公开接口限流检查失败（Redis 不可用）');
      throw new AppError('upstream_unavailable', { cause: err, details: { dependency: 'redis' } });
    }

    const remaining = Math.max(0, limit - count);
    const retryAfterS = Math.max(1, Number(ttl) || windowS);
    reply.header('X-RateLimit-Limit', String(limit));
    reply.header('X-RateLimit-Remaining', String(remaining));
    reply.header('X-RateLimit-Reset', String(Math.floor(Date.now() / 1000) + retryAfterS));

    if (count > limit) {
      logger?.warn({ ip: request.ip, count, limit }, '公开接口被限流');
      throw new AppError('rate_limited', {
        message: `请求过于频繁，请稍后再试（上限 ${limit} 次 / ${windowS}s）`,
        retryAfterS,
        details: { limit, window_s: windowS },
      });
    }
  };
}

/**
 * WebSocket **握手**限流（`/ws/public` 与 `/ws/live` 共用，桶 `ratelimit:ws:<ip>`）。
 *
 * 🔑 这里限的是"每分钟发起多少次**握手**"（= 升级请求），**不是**"同时保持几条连接"。
 *    两者是两件事，必须分开（✅ docs/api.md §5.1）：
 *      · **握手速率**（本函数）：防的是"反复连-断"刷服务端握手与鉴权开销；
 *      · **并发连接数**（`config.rateLimit.wsConcurrentPerIp`，在 `routes/ws.js` 里按 IP 计）：
 *        防的是"一个 IP 挂一堆连接把内存吃光"。
 *    ⛔ 只做其中一个都会留下明显缺口：只限速率挡不住"慢慢连 1000 条"，只限并发挡不住连断风暴。
 */
export function createWsRateLimiter({ redis, config, logger }) {
  const limit = config.rateLimit.wsHandshakePerMinute;
  const windowS = 60;

  return async function wsRateLimit(request, reply) {
    const key = keys.rateLimitWs(request.ip);

    let count;
    let ttl;
    try {
      [count, ttl] = await redis.eval(FIXED_WINDOW_LUA, 1, key, windowS);
    } catch (err) {
      logger?.error({ err, ip: request.ip }, 'WS 握手限流检查失败（Redis 不可用）');
      throw new AppError('upstream_unavailable', { cause: err, details: { dependency: 'redis' } });
    }

    const retryAfterS = Math.max(1, Number(ttl) || windowS);
    reply?.header?.('X-RateLimit-Limit', String(limit));
    reply?.header?.('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
    reply?.header?.('X-RateLimit-Reset', String(Math.floor(Date.now() / 1000) + retryAfterS));

    if (count > limit) {
      logger?.warn({ ip: request.ip, count, limit }, 'WS 握手被限流');
      throw new AppError('rate_limited', {
        message: `连接过于频繁，请稍后再试（上限 ${limit} 次 / ${windowS}s）`,
        retryAfterS,
        details: { limit, window_s: windowS, scope: 'ws_handshake' },
      });
    }
  };
}
