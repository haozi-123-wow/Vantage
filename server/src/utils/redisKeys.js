/**
 * Vantage · Redis 键空间契约
 *
 * 依据：docs/database.md §7（Redis 键空间契约）、§7 落地要求（单实例 + 键名前缀 + noeviction）
 *
 * 为什么集中定义：键名是**跨模块契约**（接入层写、cron/告警读，排障还要手工查），
 * 散落的字符串拼接是 TTL 不一致与「键名打错导致防护静默失效」的主要来源。
 *
 * ⚠️ Redis 配置要求：`maxmemory-policy noeviction` —— 若 nonce / 幂等键被驱逐，
 *    重放窗口会重新打开、幂等失效；生产须监控 `evicted_keys` 恒为 0。
 */

import { sha256Hex } from './crypto.js';

/** 键前缀常量（唯一来源） */
export const KEY_PREFIX = Object.freeze({
  rateLimitAgent: 'ratelimit:agent:',
  rateLimitPublic: 'ratelimit:public:',
  rateLimitLogin: 'ratelimit:login:',
  rateLimitWs: 'ratelimit:ws:',
  /** 滑块取题/验题限流（✅ docs/api.md §1.4：与登录桶**独立**，"换一张图"不该消耗登录额度） */
  rateLimitCaptcha: 'ratelimit:captcha:',
  nonce: 'nonce:',
  batch: 'batch:',
  session: 'session:',
  userSessions: 'user_sessions:',
  totpUsed: 'totp:used:',
  /** 滑块题目（答案只存在这里）✅ docs/slider-captcha-selfbuilt.md §4.1 —— ⚠️ 仅 provider=selfbuilt 使用 */
  captcha: 'captcha:',
  /** 滑块通过后的一次性凭证（值 = 解出该题的 IP） */
  captchaOk: 'captcha:ok:',
  /**
   * 外部人机验证服务（极验）的**短时熔断**标记：`captcha:vendor:down:<provider>`。
   * ✅ docs/geetest-captcha.md §9.3 第 3 条（C19）：不可达后置位 30s，期间不再干等超时。
   * 🔑 它是**性能优化而非安全控制**：读不到时按"未熔断"处理，
   *    真正的放行/拒绝决策由 `security.captcha.geetest.failMode` 负责。
   */
  captchaVendorDown: 'captcha:vendor:down:',
  /** 登录失败计数（按 IP）：决定"是否要求人机验证" */
  loginFailIp: 'login:fail:ip:',
  /** 登录失败计数（按账号，用户名哈希后入键）：防代理池"每个 IP 只失败一次"的绕过 */
  loginFailAcct: 'login:fail:acct:',
  alertCooldown: 'alert:cooldown:',
  ipRecent: 'ip:recent:',
  snapshotAgent: 'snapshot:agent:',
  /**
   * 公开接口的**响应级**缓存（✅ docs/server-status-api.md §2.4 / §7.2）。
   * ⚠️ 刻意复用 `snapshot:` 语义族而不是新开 `cache:` 前缀：它缓存的就是「当前快照」，
   *    只是粒度从**每机**（`snapshot:agent:<id>`，至今无写入方）改成了**整个响应**。
   *    ⛔ 键名是跨模块契约（`docs/database.md` §7）：新增子键必须同步登记到该表。
   */
  snapshotPublic: 'snapshot:public:',
  notifyTokenBucket: 'notify:tokenbucket:',
  cronLock: 'cron:lock:',
  settingsCache: 'settings:cache',
});

/** Pub/Sub 频道 */
export const CHANNEL = Object.freeze({
  /** 上报落库后扇出（docs/database.md §6.1 第 5 步） */
  liveMetrics: 'live:metrics',
  /** settings 变更广播（可选，见 §5.4 建议） */
  settingsChanged: 'live:settings',
});

/** TTL（秒）：与 docs/database.md §7 表逐行对应 */
export const TTL_S = Object.freeze({
  /** ✅ §7：nonce TTL ≥ 签名窗口（默认 600 ≥ 300），消除 120–300s 重放窗口 */
  nonce: 600,
  /** ✅ 决策 #18：幂等去重 10min */
  batch: 600,
  /** ➕ 建议：占位失败时删键；把占位 TTL 设短可容忍「占位后事务失败」的丢批风险 */
  batchShort: 60,
  /** Flapping 判定窗口（决策 #39：10 分钟窗口内变化次数） */
  ipRecent: 600,
  /**
   * 公开「当前快照」缓存（§5.4「带缓存」）。
   * ⏳ **暂无写入方**：`/api/public/*` 落地时改用**响应级**缓存
   *    （`snapshot:public:hosts|summary`，TTL 由 `config.rateLimit.publicCacheTtlS` 决定），
   *    本键当前的语义与列表端点不匹配，保留给将来的 `/ws/*` 实时扇出复用。
   */
  snapshotAgent: 15,
  /**
   * ✅ docs/api.md §4.1.1 ④：TOTP 步号防重放。
   * 90s = 当前步（30s）+ 两侧容差各一步 —— 覆盖 verifyTotp 的 ±1 步窗口，
   * 使"某步号已被接受"这一事实在它仍可能被重放的时间内始终有效。
   */
  totpUsed: 90,
  /**
   * ✅ 滑动验证码（docs/slider-captcha-selfbuilt.md §4.1）：题目与一次性凭证共用同一 TTL。
   * 120s 的取舍：够"看清题 → 拖动 → 提交"，又不至于让一次人机判定被长期复用。
   */
  captcha: 120,
  /**
   * ✅ 外部验证服务熔断窗口（docs/geetest-captcha.md §9.3 第 3 条）。
   * 30s 的取舍：短到"极验恢复后最多 30s 内自动恢复"，又长到足以挡住"每次登录都干等一次超时"。
   * 熔断期间的行为由 `failMode` 决定（open = 视为该层不存在；closed = 拒绝）。
   */
  captchaVendorDown: 30,
});

export const keys = Object.freeze({
  /** 限流：Agent 维度（上报/心跳共用一桶，§2.2） */
  rateLimitAgent: (agentId) => `${KEY_PREFIX.rateLimitAgent}${agentId}`,
  /** 限流：公开接口按 IP（✅ §5.4 严格限流） */
  rateLimitPublic: (ip) => `${KEY_PREFIX.rateLimitPublic}${ip}`,
  /** 限流：登录按 IP（不泄露账号是否存在） */
  rateLimitLogin: (ip) => `${KEY_PREFIX.rateLimitLogin}${ip}`,
  /** 限流：滑块取题/验题按 IP（⛔ 独立桶，见 KEY_PREFIX.rateLimitCaptcha） */
  rateLimitCaptcha: (ip) => `${KEY_PREFIX.rateLimitCaptcha}${ip}`,
  /** 限流：公开 WS 连接 */
  rateLimitWs: (ip) => `${KEY_PREFIX.rateLimitWs}${ip}`,

  /** 防重放：同一 agent 同一 nonce 只能出现一次 */
  nonce: (agentId, nonce) => `${KEY_PREFIX.nonce}${agentId}:${nonce}`,
  /** 幂等：批次去重（决策 #18） */
  batch: (batchId) => `${KEY_PREFIX.batch}${batchId}`,

  /** 面板会话（hash：user_id/roles/totp_ok/created_at/last_seen/ip/ua/csrf） */
  session: (sid) => `${KEY_PREFIX.session}${sid}`,
  /** 某用户全部会话 sid 集合（限并发、踢最旧、全部下线） */
  userSessions: (userId) => `${KEY_PREFIX.userSessions}${userId}`,
  /** 2FA：已接受过的 TOTP 步号（同一步只允许成功一次，防止 30s 窗口内重放同一验证码） */
  totpUsed: (userId) => `${KEY_PREFIX.totpUsed}${userId}`,

  /** 滑块题目（hash：x/y/created_at/attempts）——答案只在这里，⛔ 不进 PG / 日志 / 响应 */
  captcha: (captchaId) => `${KEY_PREFIX.captcha}${captchaId}`,
  /** 滑块通过后的一次性凭证，值 = 解出该题的 IP（绑定来源，挡"打码平台批量出 token 转卖"） */
  captchaOk: (token) => `${KEY_PREFIX.captchaOk}${token}`,
  /** 外部人机验证服务的熔断标记（按 provider 分键，便于将来并存多个提供方） */
  captchaVendorDown: (provider) => `${KEY_PREFIX.captchaVendorDown}${provider}`,
  /** 登录失败计数（按 IP） */
  loginFailIp: (ip) => `${KEY_PREFIX.loginFailIp}${ip}`,
  /**
   * 登录失败计数（按账号）。
   * 🔑 用户名**先 sha256 再截断 16 字符**：Redis 键会进 MONITOR / 慢日志 / 运维截图，
   *    明文用户名等于把"谁正在被攻击"摊开给任何能看到 Redis 的人；哈希后仍能稳定定位同一账号。
   */
  loginFailAcct: (username) =>
    `${KEY_PREFIX.loginFailAcct}${sha256Hex(String(username).toLowerCase()).slice(0, 16)}`,

  /** 告警静默期 + 同类合并（规则 × 主机） */
  alertCooldown: (ruleId, agentId) => `${KEY_PREFIX.alertCooldown}${ruleId}:${agentId}`,
  /** Flapping 判定：窗口内 IP 变化次数 */
  ipRecent: (agentId) => `${KEY_PREFIX.ipRecent}${agentId}`,
  /** 公开快照缓存 */
  snapshotAgent: (agentId) => `${KEY_PREFIX.snapshotAgent}${agentId}`,
  /**
   * 公开列表 / 汇总的**响应体**缓存（TTL 来自 `config.rateLimit.publicCacheTtlS`，
   * ⛔ 不在这里写死：0 = 关缓存的语义必须由调用方一处决定）。
   * 值 = 已脱敏的完整响应 JSON（含 `updated_at`），⛔ 绝不缓存含 IP / 内部 UUID 的私有响应。
   */
  snapshotPublicHosts: `${KEY_PREFIX.snapshotPublic}hosts`,
  snapshotPublicSummary: `${KEY_PREFIX.snapshotPublic}summary`,
  /**
   * 公开**单机**快照缓存（`/api/public/hosts/{slug}/now`）。
   * ⚠️ 键里带 slug（公开标识，非机密）⇒ 键数量 ≈ 主机数，**不会**被枚举撑爆：
   *    ① slug 是 8–12 位、字符集 58 ⇒ 猜中一个的成本 ≈ 58^8；② 只有**存在**的主机才会写缓存
   *    （404 不缓存）。故无需担心 noeviction 下的键膨胀。
   */
  snapshotPublicHostNow: (slug) => `${KEY_PREFIX.snapshotPublic}now:${slug}`,
  /** 公开探活概览缓存（`/api/public/probes`） */
  snapshotPublicProbes: `${KEY_PREFIX.snapshotPublic}probes`,
  /** 通道令牌桶（✅ 决策 #23：排队等待、不丢弃） */
  notifyTokenBucket: (channelId) => `${KEY_PREFIX.notifyTokenBucket}${channelId}`,

  /** 定时任务分布式锁（✅ R13：多实例下只跑一次） */
  cronLock: (task) => `${KEY_PREFIX.cronLock}${task}`,

  /** settings 表缓存（✅ R16：面板 PATCH 后主动失效，TTL 30s 兜底；缺行取代码默认值） */
  settingsCache: KEY_PREFIX.settingsCache,
});

/** 定时任务名（与 docs/database.md §8.2 表格一一对应，用作 cronLock 的 task 名） */
export const CRON_TASKS = Object.freeze({
  createPartitions: 'create_partitions',
  dropPartitions: 'drop_partitions',
  aggregate1m: 'aggregate_1m',
  aggregate5m: 'aggregate_5m',
  purgeDownsampled: 'purge_downsampled',
  purgeNonTimeSeries: 'purge_non_timeseries',
  offlineSweep: 'offline_sweep',
  flappingRecover: 'flapping_recover',
  credentialRotateReminder: 'credential_rotate_reminder',
});
