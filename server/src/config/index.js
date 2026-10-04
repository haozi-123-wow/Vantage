/**
 * Vantage · vantage-core 配置加载与校验
 *
 * 依据：docs/api.md §1.2/§1.4、docs/database.md §7/§8、Vantage-DESIGN-v0.7.md §5.2/§6.2/§18.1
 *
 * 设计要点
 *  - 零依赖：优先读取 server/.env，**已存在的真实环境变量优先**（容器/env 覆盖文件）；
 *  - 快速失败：缺少必需项或格式不合法 → 聚合为一条错误消息，一次性列出全部问题；
 *  - 单一入口：`getConfig()` 惰性缓存，避免各模块各读一遍 process.env；
 *  - ⛔ 任何情况下不得把密钥写进日志（见 redactUrl）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

/** server/ 目录绝对路径（src/config/index.js → ../..） */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 默认 .env 路径，可用 VANTAGE_ENV_FILE 覆盖 */
export function envFilePath(env = process.env) {
  const override = env.VANTAGE_ENV_FILE;
  return override && String(override).trim() !== ''
    ? path.resolve(String(override))
    : path.join(SERVER_ROOT, '.env');
}

/**
 * 把 .env 载入给定 env 对象（**不覆盖已存在的键**，保证真实环境变量优先）。
 */
export function loadEnvFile(file = envFilePath(), env = process.env) {
  if (!fs.existsSync(file)) return { loaded: false, file };
  const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return { loaded: true, file, keys: Object.keys(parsed) };
}

// -----------------------------------------------------------------------------
// 取值助手（失败时把问题累积到 errors，最后一次性抛出）
// -----------------------------------------------------------------------------

function makeReaders(env, errors) {
  const raw = (name) => {
    const value = env[name];
    return value === undefined || value === null ? undefined : String(value).trim();
  };

  const str = (name, { required = false, def, pattern, hint } = {}) => {
    const value = raw(name);
    if (value === undefined || value === '') {
      if (required) errors.push(`${name} 未设置（必需）${hint ? `：${hint}` : ''}`);
      return def;
    }
    if (pattern && !pattern.test(value)) {
      errors.push(`${name} 格式不合法${hint ? `（要求：${hint}）` : ''}`);
      return def;
    }
    return value;
  };

  const int = (name, { def, min, max, required = false } = {}) => {
    const value = raw(name);
    if (value === undefined || value === '') {
      if (required) errors.push(`${name} 未设置（必需，整数）`);
      return def;
    }
    if (!/^-?\d+$/.test(value)) {
      errors.push(`${name} 必须是整数，当前为「${value}」`);
      return def;
    }
    const num = Number(value);
    if (min !== undefined && num < min) {
      errors.push(`${name} 不得小于 ${min}（当前 ${num}）`);
      return def;
    }
    if (max !== undefined && num > max) {
      errors.push(`${name} 不得大于 ${max}（当前 ${num}）`);
      return def;
    }
    return num;
  };

  const bool = (name, { def } = {}) => {
    const value = raw(name);
    if (value === undefined || value === '') return def;
    if (/^(1|true|yes|on)$/i.test(value)) return true;
    if (/^(0|false|no|off)$/i.test(value)) return false;
    errors.push(`${name} 必须是布尔值（true/false/1/0/yes/no/on/off），当前为「${value}」`);
    return def;
  };

  const oneOf = (name, allowed, { def } = {}) => {
    const value = raw(name);
    if (value === undefined || value === '') return def;
    if (!allowed.includes(value)) {
      errors.push(`${name} 只能是 ${allowed.join(' / ')} 之一，当前为「${value}」`);
      return def;
    }
    return value;
  };

  return { str, int, bool, oneOf };
}

// -----------------------------------------------------------------------------
// 连接串助手
// -----------------------------------------------------------------------------

const PG_URL_RE = /^postgres(ql)?:\/\//i;

/**
 * 校验并返回 PG 连接串。
 *
 * ⚠️ 为什么这里要真的解析一遍：`pg-connection-string`（node-pg 的解析器）内部用的就是 WHATWG `new URL()`，
 *    因此口令里的裸 `/` 或 `#` 会让驱动直接抛 `Invalid URL`——那时的报错看不出是口令的问题。
 *    这里提前用**同一个解析器**校验，把崩溃换成带编码指引的可操作错误（口径与 Redis 完全一致）。
 */
function pgUrl(name, value, errors, { required = false } = {}) {
  if (!value) {
    if (required) errors.push(`${name} 未设置（必需）：形如 postgres://user:pass@127.0.0.1:5432/vantage`);
    return undefined;
  }
  if (!PG_URL_RE.test(value)) {
    errors.push(`${name} 必须以 postgres:// 或 postgresql:// 开头`);
    return undefined;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch {
    errors.push(
      `${name} 不是合法 URL：${redactUrl(value)}。` +
        '常见原因：口令含 @ : / # ? 空格等字符但未做百分号编码（@→%40、:→%3A、/→%2F、#→%23、?→%3F、%→%25）',
    );
    return undefined;
  }
  return value;
}

/**
 * 日志/报错时使用的脱敏连接串（隐藏口令）。
 *
 * ⚠️ 为什么不能只写一条正则：口令里出现**未编码的 `/` `?` `#`** 时，"authority 到哪里结束"是歧义的
 *    （例如 `redis://:p/ss@h:6379/0`：朴素正则会在第一个 `/` 处停下，于是**脱敏失败、口令原样进日志**）。
 *    这里分两步：先按规范边界找 authority；若其中没有 `@` 但整串仍有 `@`，说明是畸形 URL，
 *    则退化为"把 `://` 到最后一个 `@` 之间全部抹掉"——⛔ 宁可多抹，不可漏抹。
 */
export function redactUrl(url) {
  if (!url) return url;
  const s = String(url);

  const schemeEnd = s.indexOf('://');
  if (schemeEnd === -1) return s;
  const authorityStart = schemeEnd + 3;

  // authority 结束于第一个 / ? # （取三者最靠前者）
  let authorityEnd = s.length;
  for (const marker of ['/', '?', '#']) {
    const index = s.indexOf(marker, authorityStart);
    if (index !== -1 && index < authorityEnd) authorityEnd = index;
  }

  const authority = s.slice(authorityStart, authorityEnd);
  const tail = s.slice(authorityEnd);

  const at = authority.lastIndexOf('@');
  if (at === -1) {
    // 畸形 URL 兜底：口令里含未编码的 / ? #，导致 authority 被提前截断
    const lastAtInString = s.lastIndexOf('@');
    if (lastAtInString > authorityStart) {
      return `${s.slice(0, authorityStart)}***${s.slice(lastAtInString)}`;
    }
    return s;
  }

  const userinfo = authority.slice(0, at);
  const host = authority.slice(at + 1);
  const colon = userinfo.indexOf(':');
  // 保留用户名（便于排障辨认连接身份），口令一律替换为 ***
  const redacted = colon === -1 ? '***' : `${userinfo.slice(0, colon)}:***`;
  return `${s.slice(0, authorityStart)}${redacted}@${host}${tail}`;
}

// -----------------------------------------------------------------------------
// 主加载函数
// -----------------------------------------------------------------------------

/**
 * 构建配置对象（全部校验通过才返回）。
 * @param {NodeJS.ProcessEnv} [env] 环境变量来源（测试可注入）
 * @param {{ skipEnvFile?: boolean }} [options]
 */
export function loadConfig(env = process.env, options = {}) {
  const errors = [];
  const { str, int, bool, oneOf } = makeReaders(env, errors);

  if (!options.skipEnvFile) {
    try {
      loadEnvFile(envFilePath(env), env);
    } catch (err) {
      errors.push(`读取 .env 失败（${envFilePath(env)}）：${err.message}`);
    }
  }

  // --- 运行环境 --------------------------------------------------------------
  const nodeEnv = oneOf('NODE_ENV', ['development', 'test', 'production'], { def: 'development' });
  const isProd = nodeEnv === 'production';

  // --- HTTP 接入层 -----------------------------------------------------------
  const http = {
    host: str('HOST', { def: '127.0.0.1' }),
    port: int('PORT', { def: 8787, min: 1, max: 65535 }),
    trustProxy: str('TRUST_PROXY', {
      def: 'loopback',
      hint: '反代后填 1 / loopback / CIDR 列表（决定 client IP 与 X-Forwarded-For 可信度，见 §13）',
    }),
    publicOrigin: str('PUBLIC_ORIGIN', {
      def: '',
      hint: '面板对外地址，如 https://vantage.example.com（用于 WS Origin 白名单）',
    }),
  };

  // --- 日志 ------------------------------------------------------------------
  const log = {
    level: oneOf('LOG_LEVEL', ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
      def: isProd ? 'info' : 'debug',
    }),
  };

  // --- Agent 安装引导（`POST /api/v1/agents` 的 `install_hint` 用）-------------
  /**
   * `vantage.sh` 的下载地址（GitHub Release 或内网镜像，见 `docs/agent.md` §12.1）。
   *
   * ⚠️ **未配置时面板不给安装命令**（`install_hint.one_liner` 等返回 `null` + 一条 warning），
   *    ⛔ 绝不返回带 `<mirror>` 占位符的假命令 —— 一条会 `curl` 到错误地址、
   *    还被 `sudo sh` 执行的命令，比"没有命令"危险得多（后者用户会来问，前者不会）。
   * ⚠️ 只接受 `https://`：这段命令是 `curl … | sudo sh` 的形态，
   *    http 镜像等于把「以 root 执行远端脚本」暴露在链路上（与 center.url 强制 https 同一条理由）。
   */
  const agentInstallScriptUrl = str('AGENT_INSTALL_SCRIPT_URL', { def: '' });
  if (agentInstallScriptUrl !== '' && !/^https:\/\/[^\s]+$/.test(agentInstallScriptUrl)) {
    errors.push(
      `AGENT_INSTALL_SCRIPT_URL 必须是 https:// 开头的完整地址（当前 ${JSON.stringify(agentInstallScriptUrl)}）：` +
        '该地址会被拼进 `curl … | sudo sh` 的一键安装命令，http 或相对路径都不安全',
    );
  }
  const agentInstall = { scriptUrl: agentInstallScriptUrl };

  // --- PostgreSQL ------------------------------------------------------------
  const databaseUrl = pgUrl('DATABASE_URL', str('DATABASE_URL', { def: '' }), errors, { required: true });
  const migratorDatabaseUrl =
    pgUrl('MIGRATOR_DATABASE_URL', str('MIGRATOR_DATABASE_URL', { def: '' }), errors) || databaseUrl;

  const db = {
    url: databaseUrl,
    migratorUrl: migratorDatabaseUrl,
    poolMax: int('PG_POOL_MAX', { def: 10, min: 1, max: 200 }),
    idleTimeoutMs: int('PG_IDLE_TIMEOUT_MS', { def: 30000, min: 1000 }),
    connectionTimeoutMs: int('PG_CONNECTION_TIMEOUT_MS', { def: 5000, min: 500 }),
    statementTimeoutMs: int('PG_STATEMENT_TIMEOUT_MS', { def: 15000, min: 1000 }),
    maxUses: int('PG_MAX_USES', { def: 7500, min: 100 }),
  };

  // --- Redis -----------------------------------------------------------------
  // 🔑 凭据两种给法，**只能选一种**（另一种留空）：
  //    ① REDIS_URL 内联：redis://[:密码@]主机:端口/库号，密码含 @ : / # ? % 等字符时必须百分号编码；
  //    ② REDIS_USERNAME / REDIS_PASSWORD 分立变量：**无需编码**，适合密码随机的场景。
  //    ⛔ 两边都写不算"双保险"而是歧义：ioredis 会优先采用 URL 里的凭据（见 db/redis.js 的说明），
  //       因此代码在检测到两者同时存在时会**摘掉 URL 里的凭据**并告警。
  const redisPassword = str('REDIS_PASSWORD', { def: undefined });
  const redisUsername = str('REDIS_USERNAME', { def: undefined });
  if (redisUsername !== undefined && redisPassword === undefined) {
    errors.push('REDIS_USERNAME 已设置但 REDIS_PASSWORD 为空：ACL 用户必须配套口令（或改用 REDIS_URL 内联形式）');
  }

  const redis = {
    url: str('REDIS_URL', { def: 'redis://127.0.0.1:6379/0' }),
    username: redisUsername,
    password: redisPassword,
    connectTimeoutMs: int('REDIS_CONNECT_TIMEOUT_MS', { def: 5000, min: 500 }),
    maxRetriesPerRequest: int('REDIS_MAX_RETRIES_PER_REQUEST', { def: 3, min: 1, max: 20 }),
  };

  // --- 加密与签名 ------------------------------------------------------------
  const secretKeyRaw = str('SECRET_KEY', {
    required: true,
    hint:
      '用于加密 channels.config 敏感项与 users.totp_secret_enc（AES-256-GCM）；' +
      '生成：node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"',
  });
  const secretKey = secretKeyRaw ? Buffer.from(secretKeyRaw, 'base64') : Buffer.alloc(0);
  if (secretKeyRaw && secretKey.length !== 32) {
    errors.push(
      `SECRET_KEY 必须是 base64 编码的 32 字节密钥（当前解出 ${secretKey.length} 字节）` +
        '：node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  // --- 上报通道限制（✅ 决策 #47）--------------------------------------------
  const maxCompressedBytes = int('MAX_COMPRESSED_BYTES', { def: 1024 * 1024, min: 1024 });
  const maxDecompressedBytes = int('MAX_DECOMPRESSED_BYTES', { def: 4 * 1024 * 1024, min: 1024 });
  if (maxDecompressedBytes < maxCompressedBytes) {
    errors.push('MAX_DECOMPRESSED_BYTES 不得小于 MAX_COMPRESSED_BYTES（否则正常的压缩请求会被误拒）');
  }

  // --- Agent 鉴权（✅ §6.2、决策 #36）---------------------------------------
  const signatureWindowS = int('SIGNATURE_WINDOW_S', { def: 300, min: 30, max: 3600 });
  const nonceTtlS = int('NONCE_TTL_S', { def: 600, min: 60, max: 86400 });
  if (nonceTtlS < signatureWindowS) {
    errors.push('NONCE_TTL_S 必须 ≥ SIGNATURE_WINDOW_S（否则重放窗口未覆盖，见 docs/database.md §7）');
  }

  // --- 面板会话（✅ §18.1、决策 #31/#32）------------------------------------
  const sessionSlidingS = int('SESSION_SLIDING_TTL_S', { def: 1800, min: 60 });
  const sessionAbsoluteS = int('SESSION_ABSOLUTE_TTL_S', { def: 86400, min: 300 });
  if (sessionAbsoluteS < sessionSlidingS) {
    errors.push('SESSION_ABSOLUTE_TTL_S 不得小于 SESSION_SLIDING_TTL_S');
  }
  const cookieName = str('COOKIE_NAME', { def: 'vantage_sid', pattern: /^[A-Za-z0-9_-]+$/, hint: '只允许字母数字与 - _' });

  // --- 人机验证提供方（✅ C12 已定 = G1-a；docs/geetest-captcha.md §8.1）--------------
  // ⛔ captchaId 是**公开**值（会下发给前端）；captchaKey 是**机密**（只用来算 sign_token）。
  const geetestCaptchaId = str('GEETEST_CAPTCHA_ID', {
    pattern: /^[A-Za-z0-9_-]{16,64}$/,
    hint: '极验后台的 captcha_id（当前形如 32 位十六进制）',
  });
  const geetestCaptchaKey = str('GEETEST_CAPTCHA_KEY', {
    pattern: /^[A-Za-z0-9_-]{16,64}$/,
    hint: '极验后台的 captcha_key（当前形如 32 位十六进制；⛔ 机密，勿提交仓库）',
  });
  const geetestConfigured = Boolean(geetestCaptchaId && geetestCaptchaKey);

  /**
   * 提供方解析（⚠️ 这是对 C12「极验为默认」的一处**受控细化**，理由必须写在代码里）：
   *
   *  · **未设置 → 自动推断**：配了极验密钥就用极验，否则用自建滑块。
   *    为什么不直接写死默认 `geetest`：那会让**所有既有部署升级后因缺密钥启动失败**，
   *    而"没有极验可用"时回退到自建滑块**严格优于**整个服务起不来 —— 回退后依然有人机验证。
   *    ✅ 一旦填了密钥（用极验的必要前提），默认就是极验，与 C12 的意图一致。
   *  · **显式声明 `geetest` 却缺密钥 → 启动即失败**。
   *    ⛔ 绝不允许"声明用极验但没给密钥"变成一个跑得起来、运行时静默放行的进程
   *    （前车之鉴见 docs/geetest-captcha.md §9.4 教训一）。
   *  · 取值与 `services/captcha/providers/*` 的 provider 名**逐字一致**（改一处必须改两处）。
   */
  const captchaProviderExplicit = oneOf('CAPTCHA_PROVIDER', ['geetest', 'selfbuilt', 'none'], { def: undefined });
  if (captchaProviderExplicit === 'geetest' && !geetestConfigured) {
    errors.push(
      'CAPTCHA_PROVIDER=geetest 时必须同时配置 GEETEST_CAPTCHA_ID 与 GEETEST_CAPTCHA_KEY' +
        '（缺密钥时无法校验，故此处拒绝启动；不打算用极验请显式改为 selfbuilt 或 none）',
    );
  }
  const captchaProvider = captchaProviderExplicit ?? (geetestConfigured ? 'geetest' : 'selfbuilt');

  const geetest = {
    captchaId: geetestCaptchaId ?? null,
    captchaKey: geetestCaptchaKey ?? null,
    /** ⛔ 只写域名：协议固定为 https、路径由 `utils/geetest.js` 拼（备用域名见变更方案 §8.5） */
    apiServer: str('GEETEST_API_SERVER', {
      def: 'gcaptcha4.geetest.com',
      pattern: /^[A-Za-z0-9.-]+$/,
      hint: '只写域名，不含协议与路径',
    }),
    /**
     * 二次校验超时（毫秒）。
     * ⚠️ 官方 demo 用 5000；这里默认 3000 —— 闸门在验密**之前**，超时直接体现为"点登录卡住"，
     *    宁可更早放弃（放弃后的行为由 failMode 决定）。
     */
    timeoutMs: int('GEETEST_TIMEOUT_MS', { def: 3000, min: 500, max: 10000 }),
    /**
     * 极验不可达时：`open` = **放行**（✅ C13 已定，与极验官方容灾口径一致）；
     * `closed` = 拒绝（503 `captcha_unavailable`）。
     * ⚠️ 选 `open` 的连带义务见 docs/geetest-captcha.md §9.3：审计 + error 日志 + 超时不重试，
     *    否则这一层会在没人察觉的情况下静默消失。
     */
    failMode: oneOf('GEETEST_FAIL_MODE', ['open', 'closed'], { def: 'open' }),
    /**
     * 官方按钮的展现形式（✅ C16 已定 = 用极验的**官方按钮**）：
     * `popup` = 按钮 + 带遮罩的验证弹窗；`float` = 按钮 + 浮动验证层。
     * ⛔ 不接受 `bind`（它根本不渲染按钮，与已定需求相反）。
     */
    product: oneOf('GEETEST_PRODUCT', ['popup', 'float'], { def: 'popup' }),
    /** 验证窗内文案的语言（由极验自己渲染，⛔ 不受本站 i18n 控制；图片文字不随语言变） */
    language: oneOf(
      'GEETEST_LANGUAGE',
      ['zho', 'eng', 'zho-tw', 'zho-hk', 'udm', 'jpn', 'ind', 'kor', 'rus', 'ara', 'spa', 'pon', 'por', 'fra', 'deu'],
      { def: 'zho' },
    ),
  };

  const security = {
    secretKey,
    settingsCacheTtlS: int('SETTINGS_CACHE_TTL_S', { def: 30, min: 0, max: 3600 }),
    maxCompressedBytes,
    maxDecompressedBytes,
    signatureWindowS,
    // ✅ 决策 #17：默认「接受 + 修正 + 告警」，只有超过 5min 硬上限才拒。
    //    SIGNATURE_STRICT=true 时收紧到 signatureWindowS（超窗即拒）——**opt-in**，默认关。
    signatureStrict: bool('SIGNATURE_STRICT', { def: false }),
    nonceTtlS,
    staleReportHours: int('STALE_REPORT_HOURS', { def: 6, min: 1, max: 168 }),
    session: {
      slidingTtlS: sessionSlidingS,
      absoluteTtlS: sessionAbsoluteS,
      maxPerUser: int('SESSION_MAX_PER_USER', { def: 3, min: 1, max: 50 }),
      cookieName: cookieName || 'vantage_sid',
      cookieSecure: bool('COOKIE_SECURE', { def: isProd }),
      cookieSameSite: 'lax',
    },
    /**
     * 人机验证（✅ docs/geetest-captcha.md §8.1；自建方案 docs/slider-captcha-selfbuilt.md §8.1）。
     * ⛔ 出场阈值（是否启用 / 失败几次后要求）**不在这里**：它们是面板可改的运行时设置（settings 表），
     *    只有"用哪个提供方、题目怎么出、判多宽、给几次机会、超时多久"这类工程常量才走 env（改了要重启）。
     */
    captcha: {
      /** `geetest` / `selfbuilt` / `none`（未设置时自动推断，见上方 captchaProvider 的注释） */
      provider: captchaProvider,
      ttlS: int('CAPTCHA_TTL_S', { def: 120, min: 30, max: 600 }),
      tolerancePx: int('CAPTCHA_TOLERANCE_PX', { def: 5, min: 2, max: 20 }),
      maxAttempts: int('CAPTCHA_MAX_ATTEMPTS', { def: 3, min: 1, max: 10 }),
      /** 极验参数（仅在 provider=geetest 时被读取；凭据缺失时字段为 null） */
      geetest,
    },
  };

  // --- 限流（✅ 决策 #23；数值为 docs/api.md §1.4 建议值）--------------------
  const rateLimit = {
    agentPerMinute: int('RATELIMIT_AGENT_PER_MINUTE', { def: 60, min: 1 }),
    publicPerMinute: int('RATELIMIT_PUBLIC_PER_MINUTE', { def: 60, min: 1 }),
    /**
     * 公开接口的**响应级**缓存 TTL（秒）；`0` = 关闭缓存。
     * ✅ docs/server-status-api.md §2.4（决策 D4）：缓存的是**已脱敏的整个响应体**
     *    （键 `snapshot:public:hosts` / `snapshot:public:summary`），⛔ 不是每机快照 ——
     *    列表端点按机缓存会退化成 N 次读取，而 `snapshot:agent:<id>` 至今没有写入方。
     * ⚠️ 默认 10s 的取舍：落在 docs/api.md §3.2 要求的 5–15s 区间内，且与 Agent 30s 上报周期同量级
     *    ——缓存比上报周期还长就只是在显示更旧的数据，比这更短则等于没有缓存（每个访客各打一次库）。
     */
    publicCacheTtlS: int('PUBLIC_CACHE_TTL_S', { def: 10, min: 0, max: 60 }),
    loginPerWindow: int('RATELIMIT_LOGIN_PER_WINDOW', { def: 10, min: 1 }),
    loginWindowS: int('RATELIMIT_LOGIN_WINDOW_S', { def: 300, min: 30 }),
    /** 滑块取题/验题按 IP（✅ docs/api.md §1.4：独立桶，比登录桶宽松——"换一张图"是正常操作） */
    captchaPerMinute: int('RATELIMIT_CAPTCHA_PER_MINUTE', { def: 30, min: 1 }),
    wsConcurrentPerIp: int('RATELIMIT_WS_CONCURRENT_PER_IP', { def: 3, min: 1 }),
  };

  // --- 数据保留与分区（✅ 决策 #11/#38、docs/database.md §8.1）--------------
  const retention = {
    metricsRawDays: int('RETENTION_METRICS_RAW_DAYS', { def: 15, min: 2 }),
    metrics1mDays: int('RETENTION_METRICS_1M_DAYS', { def: 90, min: 7 }),
    metrics5mDays: int('RETENTION_METRICS_5M_DAYS', { def: 365, min: 30 }),
    probeResultsDays: int('RETENTION_PROBE_RESULTS_DAYS', { def: 90, min: 7 }),
    processSnapshotsDays: int('RETENTION_PROCESS_SNAPSHOTS_DAYS', { def: 30, min: 7 }),
    agentIpHistoryDays: int('RETENTION_AGENT_IP_HISTORY_DAYS', { def: 180, min: 7 }),
    notificationLogDays: int('RETENTION_NOTIFICATION_LOG_DAYS', { def: 180, min: 7 }),
    auditLogsDays: int('RETENTION_AUDIT_LOGS_DAYS', { def: 365, min: 30 }),
    silenceKeepAfterEndDays: int('RETENTION_SILENCE_KEEP_DAYS', { def: 7, min: 0 }),
    deleteBatchSize: int('RETENTION_DELETE_BATCH_SIZE', { def: 10000, min: 100, max: 1000000 }),
    /** 分区维护：预建未来几天（✅ §5.7.3 建议 7 天） */
    partitionPreCreateDays: int('PARTITION_PRE_CREATE_DAYS', { def: 7, min: 1, max: 90 }),
  };

  if (retention.metricsRawDays >= retention.metrics1mDays) {
    errors.push('RETENTION_METRICS_RAW_DAYS 应小于 RETENTION_METRICS_1M_DAYS（原始层比降采样层先过期）');
  }

  // --- 心跳与离线判定（✅ §5.3）---------------------------------------------
  // ⚠️ sweepIntervalS 默认 **60s**（原 30s）：与 Agent 的上报周期 30s / 心跳周期 60s 同量级即可
  //    —— 扫描比上报还勤并不带来任何精度（判定读的是 last_seen_at，不依赖扫描次数），
  //    只是白烧 CPU 与 PG 往返。60s 扫描 + 90s 阈值 ⇒ 最坏检出延迟 150s（离线告警可接受）。
  //    ⛔ 别把它调到「大于阈值」：那会让判定精度被扫描周期主导（阈值 90s、扫描 180s ⇒ 最坏 270s）。
  const heartbeat = {
    offlineMultiplier: int('OFFLINE_CYCLES_MULTIPLIER', { def: 3, min: 2, max: 20 }),
    sweepIntervalS: int('HEARTBEAT_SWEEP_INTERVAL_S', { def: 60, min: 5, max: 300 }),
  };

  // --- IP 变化防抖 / Flapping（✅ 决策 #39、§8）-----------------------------
  // 判据：同一 Agent 在 windowS 内 IP 变化**超过** changes 次 → 进入 Flapping 态
  //       （只记一条 flapping 事件、暂停 IP 变化类告警，直到稳定期后由 cron 解除）。
  // 默认 600s / 3 次，与 alert_rules.params（ip_change.mode='frequent' 的 window_s/changes）同口径。
  const flapping = {
    windowS: int('FLAPPING_WINDOW_S', { def: 600, min: 60, max: 86400 }),
    changes: int('FLAPPING_CHANGES', { def: 3, min: 1, max: 100 }),
  };

  // --- 定时任务（✅ 决策 #50：core 内置 + 分布式锁）--------------------------
  // ⚠️ DDL 走 MIGRATOR_DATABASE_URL、DML 走 DATABASE_URL；单账号部署下 migrator 池为 null 时
  //    代码统一回退 `db.migrator ?? db.app`（见 services/cron.service.js）。
  const cron = {
    enabled: bool('CRON_ENABLED', { def: true }),
    /** 每日类任务（建/删分区、两项清理）的执行时刻（UTC 小时，避开业务高峰） */
    dailyUtcHour: int('CRON_DAILY_UTC_HOUR', { def: 3, min: 0, max: 23 }),
    /** 分布式锁 TTL：略大于单个任务的最长预期耗时即可（任务幂等，过期重跑无害） */
    lockTtlS: int('CRON_LOCK_TTL_S', { def: 900, min: 30, max: 86400 }),
    aggregate1mIntervalS: int('AGGREGATE_1M_INTERVAL_S', { def: 60, min: 30, max: 3600 }),
    aggregate5mIntervalS: int('AGGREGATE_5M_INTERVAL_S', { def: 300, min: 60, max: 7200 }),
    /** 每次聚合重算最近 N+1 个完整桶：迟到数据（重试/时钟修正）靠它自愈 */
    lookbackBuckets: int('DOWNSAMPLE_LOOKBACK_BUCKETS', { def: 3, min: 1, max: 60 }),
    /** 单次清理最多删几批（每批 RETENTION_DELETE_BATCH_SIZE 行）；积压时下一轮继续 */
    maxPurgeBatches: int('RETENTION_MAX_BATCHES_PER_RUN', { def: 50, min: 1, max: 10000 }),
    /** 分区提前量告警线：剩余不足该天数即 error 日志 */
    partitionMinRemainingDays: int('PARTITION_MIN_REMAINING_DAYS', { def: 7, min: 1, max: 365 }),
  };

  if (retention.partitionPreCreateDays < cron.partitionMinRemainingDays) {
    errors.push(
      'PARTITION_PRE_CREATE_DAYS 应 ≥ PARTITION_MIN_REMAINING_DAYS' +
        '（否则每次预建完都会立刻触发"提前量不足"告警）',
    );
  }
  if (cron.aggregate5mIntervalS < cron.aggregate1mIntervalS) {
    errors.push('AGGREGATE_5M_INTERVAL_S 不应小于 AGGREGATE_1M_INTERVAL_S（5m 档比 1m 档还勤没有意义）');
  }

  // --- 聚合报错 --------------------------------------------------------------
  if (errors.length > 0) {
    const err = new Error(
      `vantage-core 配置校验失败（共 ${errors.length} 项）：\n` +
        errors.map((e) => `  · ${e}`).join('\n') +
        '\n请参考 server/.env.example 补全后重试。',
    );
    err.code = 'CONFIG_INVALID';
    err.details = errors;
    throw err;
  }

  return Object.freeze({
    nodeEnv,
    isProd,
    isTest: nodeEnv === 'test',
    http: Object.freeze(http),
    log: Object.freeze(log),
    db: Object.freeze(db),
    redis: Object.freeze(redis),
    security: Object.freeze({
      ...security,
      session: Object.freeze(security.session),
      captcha: Object.freeze({ ...security.captcha, geetest: Object.freeze(security.captcha.geetest) }),
    }),
    rateLimit: Object.freeze(rateLimit),
    agentInstall: Object.freeze(agentInstall),
    retention: Object.freeze(retention),
    heartbeat: Object.freeze(heartbeat),
    flapping: Object.freeze(flapping),
    cron: Object.freeze(cron),
  });
}

let cached = null;

/** 惰性缓存的配置单例（进程内首次调用时加载并校验） */
export function getConfig() {
  if (cached === null) cached = loadConfig();
  return cached;
}

/** 仅供测试：清空缓存 */
export function resetConfigCache() {
  cached = null;
}
