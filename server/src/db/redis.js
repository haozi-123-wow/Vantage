/**
 * Vantage · Redis 连接
 *
 * 依据：docs/database.md §2（Redis 可丢：会话丢失=重新登录；nonce 丢失仅削弱重放防护）、§7（键空间契约）
 *
 * 强制约束（✅ R15）
 *  - **单实例、不拆 DB index、不拆实例**：各用途靠键名前缀区分（见 utils/redisKeys.js）；
 *  - `maxmemory-policy` 必须为 **`noeviction`** —— 否则 nonce/幂等键被驱逐会**重新打开重放窗口**、
 *    使批量幂等失效（数据重复入库）。内存吃紧时先清 `ratelimit:*` / `snapshot:*`（可重建），
 *    ⛔ 不要靠开淘汰策略解决；
 *  - 运维指标：`used_memory` 与 `evicted_keys`（**须恒为 0**）。
 */

import Redis from 'ioredis';

import { redactUrl } from '../config/index.js';

/** ioredis 默认会「无限快速重连」，这里给出有上限的退避，避免 Redis 挂掉时打满日志与 CPU */
export function retryStrategy(times) {
  return Math.min(times * 200, 3_000);
}

/**
 * 解析 Redis 连接凭据，保证**始终只有一处凭据来源**。
 *
 * ⚠️ 为什么不能"URL 与分立变量都给"（实测结论，改代码前务必先读）：
 *    ioredis 的 `parseOptions()` 用 `lodash.defaults(options, arg)` **按参数出现顺序**填充，
 *    而 `defaults` 不会覆盖已定义的键 → 先解析的 URL 里的 userinfo 会**压过**
 *    后面传入的 `{ password }` 选项。即 `new Redis('redis://:urlpw@h', { password: 'optpw' })`
 *    最终用的是 **urlpw**，与直觉相反，是最典型的"改了 .env 却毫无效果"来源。
 *    因此当 `REDIS_PASSWORD`/`REDIS_USERNAME` 存在时，这里**主动摘掉 URL 里的 userinfo**。
 *
 * ⚠️ 另一个坑：ioredis 用 WHATWG `new URL()` 解析连接串，密码里的裸 `/` 会直接抛
 *    `TypeError: Invalid URL`（启动即崩），裸 `#` 会被当成 fragment 而**静默解析错**。
 *    所以内联形态必须百分号编码；分立变量形态则完全不需要编码。
 *
 * @param {{ url: string, username?: string, password?: string }} input
 * @returns {{ url: string, username?: string, password?: string, source: 'discrete'|'url'|'none', warnings: string[] }}
 */
export function resolveRedisTarget({ url, username, password } = {}) {
  if (!url) throw new Error('resolveRedisTarget 需要 url');

  const warnings = [];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // 把 ioredis 那句难懂的 Invalid URL 换成可操作的提示（⛔ 不回显原串里的口令）
    throw new Error(
      `REDIS_URL 不是合法 URL：${redactUrl(url)}。` +
        '常见原因：密码含 @ : / # ? % 等字符但未做百分号编码（@→%40、:→%3A、/→%2F、#→%23、?→%3F、%→%25）；' +
        '或改用 REDIS_USERNAME / REDIS_PASSWORD 分立变量（无需编码）。',
    );
  }

  const urlHasCredential = parsed.username !== '' || parsed.password !== '';
  const hasDiscrete = Boolean(username || password);

  if (!hasDiscrete) {
    return {
      url,
      source: urlHasCredential ? 'url' : 'none',
      warnings,
    };
  }

  if (urlHasCredential) {
    warnings.push(
      'REDIS_URL 与 REDIS_PASSWORD/REDIS_USERNAME 同时提供了凭据：已采用分立变量的值并**丢弃 URL 中的凭据**。' +
        '为避免歧义，请只保留一种（建议用分立变量，密码不必编码）。',
    );
  }

  // 摘掉 userinfo：URL 只保留地址与库号，凭据一律走选项
  parsed.username = '';
  parsed.password = '';

  return {
    url: parsed.toString(),
    username,
    password,
    source: 'discrete',
    warnings,
  };
}

/**
 * 创建 Redis 客户端。
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.maxRetriesPerRequest]
 * @param {boolean} [options.lazyConnect] 仅测试/CLI 使用（避免构造即连接）
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} [options.logger]
 */
export function createRedis(options) {
  const { connectTimeoutMs = 5_000, maxRetriesPerRequest = 3, lazyConnect = false, logger } = options;
  const target = resolveRedisTarget(options);

  for (const warning of target.warnings) logger?.warn(warning);

  const redis = new Redis(target.url, {
    // ⛔ 顺序很重要：ioredis 先解析 URL，再 defaults 选项；这里 URL 已被摘掉凭据，故不会互相压盖。
    // ⛔⛔ 新增任何**与 URL 同名的选项**（username / password / db / host / port / family）都要小心：
    //      `new Redis('redis://host:6379/0', { db: 3 })` 最终是 **db=0** —— URL 的值会赢。
    //      库号（/0、/1…）因此**只能写在 REDIS_URL 的路径里**，不要试图用选项覆盖（本文件曾自己踩过）。
    ...(target.username !== undefined ? { username: target.username } : {}),
    ...(target.password !== undefined ? { password: target.password } : {}),
    connectTimeout: connectTimeoutMs,
    maxRetriesPerRequest,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    retryStrategy,
    lazyConnect,
    // 键名已自带前缀（ratelimit: / nonce: / session: …），⛔ 不再用 keyPrefix 叠加
  });

  redis.on('connect', () => logger?.debug('Redis 已建立连接'));
  redis.on('ready', () => logger?.info('Redis 就绪'));
  redis.on('reconnecting', (delay) => logger?.warn({ delayMs: delay }, 'Redis 重连中'));
  redis.on('end', () => logger?.warn('Redis 连接已关闭'));
  // ⛔ 必须监听：未处理的 'error' 事件在 Node 中会抛未捕获异常
  redis.on('error', (err) => logger?.error({ err }, 'Redis 错误'));

  // 只记录"凭据来自哪里"，⛔ 永不记录凭据本身
  logger?.debug(
    { target: redactUrl(target.url), credentialSource: target.source },
    'Redis 连接参数已解析',
  );

  return redis;
}

/** PING 健康检查 */
export async function ping(redis) {
  const pong = await redis.ping();
  return pong === 'PONG';
}

/**
 * 检查 `maxmemory-policy` 是否为 noeviction（✅ R15）。
 * @returns {Promise<{ ok: boolean, policy?: string, reason?: string }>}
 */
export async function checkEvictionPolicy(redis) {
  try {
    const reply = await redis.config('GET', 'maxmemory-policy');
    // ioredis 返回扁平的 [key, value]
    const policy = Array.isArray(reply) ? reply[1] : undefined;
    if (!policy) return { ok: false, reason: 'CONFIG GET 未返回 maxmemory-policy' };
    if (policy !== 'noeviction') {
      return {
        ok: false,
        policy,
        reason:
          `maxmemory-policy=${policy} 不符合要求（必须 noeviction）：` +
          'nonce/幂等键一旦被驱逐，重放窗口会重新打开且批量幂等失效',
      };
    }
    return { ok: true, policy };
  } catch (err) {
    // 托管 Redis 常禁用 CONFIG：此时无法自检，退化为告警而非阻断启动
    return { ok: false, reason: `无法读取 maxmemory-policy（${err.message}）——请在运维侧确认等于 noeviction` };
  }
}

/**
 * 采集内存与淘汰统计（供 /readyz 与运维监控）。
 * @returns {Promise<{ usedMemoryBytes: number|null, maxmemoryPolicy: string|null, evictedKeys: number|null, connectedClients: number|null }>}
 */
export async function stats(redis) {
  const info = await redis.info(); // 默认返回全部 section（含 memory / stats / clients）
  const pick = (key) => {
    const match = new RegExp(`^${key}:(.*)$`, 'm').exec(info);
    return match ? match[1].trim() : null;
  };
  const num = (key) => {
    const value = pick(key);
    return value === null || value === '' ? null : Number(value);
  };

  return {
    usedMemoryBytes: num('used_memory'),
    maxmemoryPolicy: pick('maxmemory_policy'),
    evictedKeys: num('evicted_keys'),
    connectedClients: num('connected_clients'),
  };
}

/**
 * 批量 PUBLISH（一次 pipeline，等价于一次网络往返）。
 *
 * 用途：上报落库后的扇出（`live:metrics`）。一个批次可能同时产生
 * 「1 条 metrics + 1 条 status + N 条 probes」，逐条 await 会变成 N+2 次往返 ——
 * 在 15s 周期、多机并发的场景下这笔开销完全没必要。
 *
 * @param {import('ioredis').Redis} redis
 * @param {Array<[string, string]>} messages [channel, payload]
 * @returns {Promise<number>} 成功投递的消息条数
 */
export async function publish(redis, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const [channel, payload] of messages) pipeline.publish(channel, payload);

  // ⚠️ pipeline.exec() 在**单条命令**出错时并不会 reject，必须自己检查每个 [err, reply]
  const results = await pipeline.exec();
  const firstError = results.find(([err]) => err)?.[0];
  if (firstError) throw firstError;
  return results.length;
}

/**
 * 优雅关闭（`quit` 会等命令队列清空；失败则强制 `disconnect`）。
 */
export async function closeRedis(redis, logger) {
  try {
    await redis.quit();
  } catch (err) {
    logger?.warn({ err }, 'Redis quit 失败，强制断开');
    redis.disconnect();
  }
}
