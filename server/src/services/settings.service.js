/**
 * Vantage · 系统设置读取（`settings` 表 + Redis 缓存）—— **最小只读版**
 *
 * 依据：docs/database.md §5.4（白名单 key + 缺行取代码默认值 + `settings:cache` TTL 30s + 变更主动失效）、
 *       docs/api.md §4.1.1 ②（`security.require_2fa` 的读取）、§4.10（M3 的 GET/PATCH /settings）
 *
 * 为什么 B4 就需要它：登录时要判定「该账号是否进入强制绑定受限态」，而 `security.require_2fa`
 * 是**面板可改**的运行时开关（⛔ 不能做成 env 重启才生效）。 settings 表迁移 0002 已建好。
 *
 * ⚠️ 本文件刻意只做**读**：M3 的 `PATCH /api/v1/settings`（§4.10）落地时在此扩展写路径，
 *    白名单与默认值以这里的 `SETTING_DEFAULTS` 为唯一来源（⛔ 两处维护必然漂移）。
 */

import { keys } from '../utils/redisKeys.js';

/**
 * 白名单与默认值（⛔ 与 docs/database.md §5.4 的表逐行对应；新 key 必须先加这里）。
 * 缺行 = 用默认值，因此新部署**不需要**预置任何数据。
 */
export const SETTING_DEFAULTS = Object.freeze({
  'public_view.enabled': true,
  'security.require_2fa': false,
  'credential_rotate.reminder_days': 90,
  'credential_rotate.notify': true,
});

/** key 是否在白名单内（M3 的 PATCH 用它拒绝未知 key → 400 unknown_setting） */
export function isKnownSettingKey(key) {
  return Object.hasOwn(SETTING_DEFAULTS, key);
}

/** 读库里的**覆盖值**（只认白名单内的 key；脏数据行静默忽略并留 warn） */
async function loadOverrides(runner, logger) {
  const { rows } = await runner.query(`SELECT key, value FROM settings`);
  const overrides = {};
  for (const row of rows) {
    if (!isKnownSettingKey(row.key)) {
      logger?.warn?.({ key: row.key }, 'settings 表存在白名单外的 key（已忽略）——⛔ 新 key 必须先加入 SETTING_DEFAULTS');
      continue;
    }
    overrides[row.key] = row.value;
  }
  return overrides;
}

/**
 * 读取全部生效设置（默认值 ⊕ 库内覆盖值），带 Redis 缓存。
 *
 * 🔑 缓存的是**覆盖值**而不是合并结果：默认值改代码即生效，缓存永远只可能"过期"不会"过期成错值"。
 * ⚠️ 缓存解析失败按未命中处理（下一读重建），⛔ 不让一条坏缓存把登录路径打成 500。
 *
 * @param {import('ioredis').Redis} redis
 * @param {import('pg').Pool | import('pg').PoolClient} runner
 * @param {{ ttlS: number, logger?: object }} options ttlS = config.security.settingsCacheTtlS
 * @returns {Promise<object>} 全部白名单 key 的生效值
 */
export async function readSettings(redis, runner, { ttlS, logger } = {}) {
  const cached = await redis.get(keys.settingsCache).catch((err) => {
    logger?.warn?.({ err }, 'settings 缓存读取失败（按未命中处理，直接查库）');
    return null;
  });

  if (typeof cached === 'string' && cached.length > 0) {
    try {
      return { ...SETTING_DEFAULTS, ...JSON.parse(cached) };
    } catch (err) {
      logger?.warn?.({ err }, 'settings 缓存内容损坏（按未命中处理）');
    }
  }

  const overrides = await loadOverrides(runner, logger);
  await redis
    .set(keys.settingsCache, JSON.stringify(overrides), 'EX', Math.max(1, Math.floor(ttlS || 30)))
    .catch((err) => logger?.warn?.({ err }, 'settings 缓存写入失败（下次再试）'));
  return { ...SETTING_DEFAULTS, ...overrides };
}

/**
 * 读一个布尔开关（当前唯一调用方：登录时的 `security.require_2fa`）。
 * ⛔ 库内类型不对（比如存成了字符串）按**默认值**处理并告警——开关读出错值比读到旧值危险得多，
 *    而"类型不对"意味着有人绕过了白名单校验直接写库。
 */
export async function getSettingBool(redis, runner, key, { ttlS, logger } = {}) {
  if (!isKnownSettingKey(key) || typeof SETTING_DEFAULTS[key] !== 'boolean') {
    throw new Error(`getSettingBool 只接受布尔型白名单 key：${key}`);
  }
  const all = await readSettings(redis, runner, { ttlS, logger });
  const value = all[key];
  if (typeof value !== 'boolean') {
    logger?.warn?.({ key, value }, '布尔设置项的类型不正确，已回退默认值');
    return SETTING_DEFAULTS[key];
  }
  return value;
}

/** 使缓存失效（M3 的 PATCH /settings 落地时**必须**调用，✅ R16：变更立即生效、不必重启） */
export async function invalidateSettingsCache(redis) {
  await redis.del(keys.settingsCache);
}
