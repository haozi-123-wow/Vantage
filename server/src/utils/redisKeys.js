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

/** 键前缀常量（唯一来源） */
export const KEY_PREFIX = Object.freeze({
  rateLimitAgent: 'ratelimit:agent:',
  rateLimitPublic: 'ratelimit:public:',
  rateLimitLogin: 'ratelimit:login:',
  rateLimitWs: 'ratelimit:ws:',
  nonce: 'nonce:',
  batch: 'batch:',
  session: 'session:',
  userSessions: 'user_sessions:',
  totpUsed: 'totp:used:',
  alertCooldown: 'alert:cooldown:',
  ipRecent: 'ip:recent:',
  snapshotAgent: 'snapshot:agent:',
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
  /** 公开「当前快照」缓存（§5.4「带缓存」） */
  snapshotAgent: 15,
  /**
   * ✅ docs/api.md §4.1.1 ④：TOTP 步号防重放。
   * 90s = 当前步（30s）+ 两侧容差各一步 —— 覆盖 verifyTotp 的 ±1 步窗口，
   * 使"某步号已被接受"这一事实在它仍可能被重放的时间内始终有效。
   */
  totpUsed: 90,
});

export const keys = Object.freeze({
  /** 限流：Agent 维度（上报/心跳共用一桶，§2.2） */
  rateLimitAgent: (agentId) => `${KEY_PREFIX.rateLimitAgent}${agentId}`,
  /** 限流：公开接口按 IP（✅ §5.4 严格限流） */
  rateLimitPublic: (ip) => `${KEY_PREFIX.rateLimitPublic}${ip}`,
  /** 限流：登录按 IP（不泄露账号是否存在） */
  rateLimitLogin: (ip) => `${KEY_PREFIX.rateLimitLogin}${ip}`,
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

  /** 告警静默期 + 同类合并（规则 × 主机） */
  alertCooldown: (ruleId, agentId) => `${KEY_PREFIX.alertCooldown}${ruleId}:${agentId}`,
  /** Flapping 判定：窗口内 IP 变化次数 */
  ipRecent: (agentId) => `${KEY_PREFIX.ipRecent}${agentId}`,
  /** 公开快照缓存 */
  snapshotAgent: (agentId) => `${KEY_PREFIX.snapshotAgent}${agentId}`,
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
