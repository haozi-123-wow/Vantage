/**
 * Vantage · 结构化日志
 *
 * 依据：Vantage-DESIGN-v0.7.md §13 安全清单（日志不得含 key/secret）、docs/database.md §11
 *
 * 约定
 *  - 全量 JSON 结构化日志（pino），字段名稳定，便于后续接 Loki/ELK；
 *  - ⛔ 凭证与个人敏感字段一律脱敏：Authorization / Cookie / X-Signature / 各类 secret；
 *  - 时间戳统一 ISO8601 UTC（服务端一律 UTC，本地化在前端，见 docs/api.md §1.2）。
 */

import pino from 'pino';

/**
 * 脱敏路径。pino 的 redact 支持 `*` 通配与数组下标，
 * 这里覆盖三类来源：HTTP 头、请求/响应体字段、以及对象里常见的密钥命名。
 */
export const REDACT_PATHS = Object.freeze([
  // HTTP 头
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-signature"]',
  'req.headers["x-agent-key"]',
  'req.headers["x-csrf-token"]',
  'request.headers.authorization',
  'request.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  // Agent 凭证（明文只在创建/轮换响应中出现一次，绝不可入日志）
  'agent_key',
  'agent_secret',
  'agentKey',
  'agentSecret',
  '*.agent_key',
  '*.agent_secret',
  'body.agent_key',
  'body.agent_secret',
  // 面板认证与 2FA
  'password',
  'password_hash',
  '*.password',
  '*.password_hash',
  'body.password',
  'totp_secret',
  'totp_secret_enc',
  '*.totp_secret',
  '*.totp_secret_enc',
  'recovery_code',
  '*.recovery_code',
  'sid',
  'csrf',
  '*.csrf',
  // 通知通道密钥（channels.config 内的敏感项）
  'config.password',
  'config.secret',
  'config.webhook_url',
  'config.token',
  'config.access_token',
  '*.config.password',
  '*.config.secret',
  '*.config.token',
  // 环境与配置
  'SECRET_KEY',
  'config.security.secretKey',
  'config.redis.password',
  'config.db.url',
  'config.db.migratorUrl',
  'redis.password',
  '*.redis.password',
  'DATABASE_URL',
  'MIGRATOR_DATABASE_URL',
  'REDIS_URL',
  'REDIS_PASSWORD',
]);

/**
 * 创建根 logger。
 * @param {{ level?: string, name?: string, base?: object, pretty?: boolean }} [options]
 */
export function createLogger(options = {}) {
  const { level = 'info', name = 'vantage-core', base = {}, ...rest } = options;

  const logger = pino({
    name,
    level,
    base: { service: name, ...base },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    ...rest,
  });

  return logger;
}

/**
 * 由 Fastify 实例的 logger 派生子 logger（携带 requestId）。
 * 便于服务层在无 request 上下文时也能带 trace 标识。
 */
export function childLogger(logger, bindings = {}) {
  return logger.child(bindings);
}
