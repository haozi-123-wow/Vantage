/**
 * Vantage · 一次性口令原语（TOTP / RFC 6238 + 面板一次性恢复码）
 *
 * 依据：docs/api.md §4.1（`2fa/setup` / `enable` / `recovery/*`）、§4.1.1 ⑤
 *       （✅ 已定：零依赖自研，用 RFC 6238 Appendix B 官方向量自测）
 *       docs/frontend.md §4.6（绑定成功展示 10 个一次性恢复码、剩余 ≤2 强提示重生成）
 *
 * 为什么自研而不引 otplib / speakeasy
 *  - 这里只有两件事：HOTP 动态截断（RFC 4226）与 Base32 编解码（RFC 4648）。两者的算法被 RFC
 *    完全钉死，没有需要跟随上游演化的空间；本仓库的取向是依赖越少越好（见 `docs/agent.md` 的依赖口径）。
 *  - 第三方 OTP 库常把「步长 / 容差 / 时间来源」做成隐式默认值——本模块把它们全部显式化，
 *    并让 `time` 可注入，因此测试**不需要等待真实时间流逝**（与 collector 夹具注入时钟同一取向）。
 *
 * ⛔ 本模块**只做纯函数**：不碰 Redis、不碰 PG、不发请求。
 *     「同一步号只能成功一次」需要跨请求状态，那是调用方的职责（`services/auth.service.js` + Redis
 *     键 `totp:used:<user_id>`，见 §4.1.1 ④），所以 `verifyTotp()` **返回命中的步号**，自己不留状态。
 * ⛔ 本模块**不反向依赖** `utils/crypto.js`：`crypto.js` 的 `hashRecoveryCode()` 需要本模块的
 *     `normalizeRecoveryCode()`（归一化是哈希口径的一部分），若这里再 import crypto.js 就成环。
 *     常量时间比较因此就地实现（`node:crypto` 的 `timingSafeEqual`）。
 */

import crypto from 'node:crypto';

// -----------------------------------------------------------------------------
// TOTP 参数
// -----------------------------------------------------------------------------

/**
 * 步长（秒）。⛔ 与 `otpauth_uri` 下发给认证器的 `period` 必须一致，
 * 改动等于让**所有已绑定用户的验证码全部失效**（`docs/api.md` §4.1.1 ⑤）。
 */
export const TOTP_STEP_S = 30;

/** 验证码位数（与 `otpauth_uri` 的 `digits` 一致） */
export const TOTP_DIGITS = 6;

/** 密钥字节数：160 bit —— RFC 4226 §4 对 HMAC-SHA1 的建议值，也是各认证器的事实标准 */
export const TOTP_SECRET_BYTES = 20;

/** 默认容差：±1 步（±30s）——覆盖手机与服务器的常见时钟漂移，又不至于放大重放窗口 */
export const TOTP_DEFAULT_WINDOW = 1;

/** `otpauth_uri` 的发行方标签（认证器里显示的归属） */
export const TOTP_ISSUER = 'Vantage';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 字符 → 5 bit 值（解码用；⛔ 只认标准 Base32 字母表） */
const BASE32_LOOKUP = Object.freeze(
  Object.fromEntries([...BASE32_ALPHABET].map((ch, index) => [ch, index])),
);

// -----------------------------------------------------------------------------
// Base32（RFC 4648，无填充）
// -----------------------------------------------------------------------------

/**
 * Base32 编码（**不加 `=` 填充**：TOTP 密钥在各认证器里都是无填充形态）。
 * @param {Buffer} buffer
 * @returns {string}
 */
export function base32Encode(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('base32Encode 只接受 Buffer');

  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buffer) {
    // 累积到 ≥5 bit 就吐一个字符；剩余位留给下一个字节
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Base32 解码。宽松处理**人工输入**：忽略空白与 `-`、`=` 填充、大小写不敏感。
 * ⛔ 但字母表外字符一律抛错——把 `0/O`、`1/I` 这类抄写歧义静默"猜"出来，会让一个错密钥
 *    变成"验证码永远不对"的幽灵故障（用户只会以为是自己手机时间不准）。
 * @param {string} text
 * @returns {Buffer}
 */
export function base32Decode(text) {
  if (typeof text !== 'string') throw new TypeError('base32Decode 只接受字符串');

  const cleaned = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (cleaned.length === 0) throw new Error('Base32 字符串为空');

  const out = Buffer.alloc(Math.floor((cleaned.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of cleaned) {
    const digit = BASE32_LOOKUP[ch];
    if (digit === undefined) throw new Error(`Base32 含非法字符：${ch}`);
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      out[index] = (value >>> (bits - 8)) & 0xff;
      index += 1;
      bits -= 8;
    }
  }
  // 末尾不足 8 bit 的余位按 RFC 4648 丢弃
  return out;
}

// -----------------------------------------------------------------------------
// TOTP
// -----------------------------------------------------------------------------

/** 时间 → 步号（自 Unix epoch 起的第几个步长） */
export function stepOf(timeMs = Date.now(), stepS = TOTP_STEP_S) {
  return Math.floor(timeMs / 1000 / stepS);
}

/** 接受 Base32 字符串或原始密钥 Buffer */
function toKey(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  return base32Decode(secret);
}

/** 定长常量时间比较（⛔ 不引 crypto.js，理由见文件头） */
function timingSafeEqualCode(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * HOTP（RFC 4226）：HMAC-SHA1 → 动态截断 → 取模。
 * @param {Buffer} key
 * @param {number} counter 步号
 * @param {number} digits
 */
function hotpCode(key, counter, digits) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const mac = crypto.createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  // 动态截断：取 4 字节并抹掉最高位，得到 31 bit 无符号整数（RFC 4226 §5.3）
  const truncated =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];

  return String(truncated % 10 ** digits).padStart(digits, '0');
}

/**
 * 计算某一时刻的 TOTP 验证码。
 * ⚠️ 只用于**测试与排障**：服务端校验走 `verifyTotp()`，绝不在响应里回显期望验证码。
 * @param {string|Buffer} secret Base32 字符串（或原始 Buffer）
 * @param {{ time?: number, stepS?: number, digits?: number }} [options] `time` 支持注入，便于测试
 */
export function totpCode(secret, options = {}) {
  const { time = Date.now(), stepS = TOTP_STEP_S, digits = TOTP_DIGITS } = options;
  return hotpCode(toKey(secret), stepOf(time, stepS), digits);
}

/**
 * 校验用户输入的 TOTP 验证码。
 *
 * @param {string|Buffer} secret
 * @param {string} code 用户输入（内部忽略空白）
 * @param {{ time?: number, window?: number, stepS?: number, digits?: number }} [options]
 * @returns {{ ok: true, step: number } | { ok: false, reason: 'format'|'mismatch' }}
 *   `step` 是**命中的步号**——调用方必须把它写进 Redis（`totp:used:<uid>`，TTL 90s）做同一步防重放，
 *   否则同一个验证码在它自己的 30s 窗口内可以被无限次重放（见 docs/api.md §4.1.1 ④）。
 */
export function verifyTotp(secret, code, options = {}) {
  const {
    time = Date.now(),
    window = TOTP_DEFAULT_WINDOW,
    stepS = TOTP_STEP_S,
    digits = TOTP_DIGITS,
  } = options;

  const normalized = typeof code === 'string' ? code.replace(/\s/g, '') : '';
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return { ok: false, reason: 'format' };

  const key = toKey(secret);
  const current = stepOf(time, stepS);

  // 比对顺序：当前步 → -1 → +1 → -2 → +2 …（按 |offset| 递增）。
  // 为什么要定序：两个不同步号的 6 位码偶然相同的概率约 2/1e6，定序后"命中哪一步"是确定的
  //   （优先当前步，而不是受循环方向影响的随机结果）——调用方要拿这个步号做防重放记账。
  // ⛔ 仍然**扫完全部候选**才返回（不 early-return），避免计时差异泄露命中步号。
  const offsets = [0];
  for (let i = 1; i <= window; i += 1) offsets.push(-i, i);

  let matched = null;
  for (const offset of offsets) {
    const step = current + offset;
    if (step < 0) continue;
    if (matched === null && timingSafeEqualCode(hotpCode(key, step, digits), normalized)) matched = step;
  }
  return matched === null ? { ok: false, reason: 'mismatch' } : { ok: true, step: matched };
}

/** 生成新的 TOTP 密钥（Base32，无填充） */
export function generateTotpSecret(bytes = TOTP_SECRET_BYTES) {
  return base32Encode(crypto.randomBytes(bytes));
}

/**
 * 构造 `otpauth_uri`（Key Uri Format），供认证器扫码。
 * label 形如 `Vantage:<username>`：⛔ 冒号是「发行方:账号」的分隔符，必须保留为字面量，
 *  只对两侧各自做 URL 编码（否则部分认证器会把整串当成账号名显示）。
 */
export function buildOtpAuthUri(options) {
  const { secret, account, issuer = TOTP_ISSUER, digits = TOTP_DIGITS, stepS = TOTP_STEP_S } = options;
  if (!secret) throw new Error('buildOtpAuthUri 需要 secret');
  if (!account) throw new Error('buildOtpAuthUri 需要 account（登录名）');

  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(stepS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// -----------------------------------------------------------------------------
// 一次性恢复码（✅ docs/api.md §4.1 渠道一；库里只存哈希，见 crypto.js）
// -----------------------------------------------------------------------------

/** 固定 10 个/次（✅ docs/database.md §5.4） */
export const RECOVERY_CODE_COUNT = 10;

/** 每个码 10 个字符 = 50 bit 熵（32^10 ≈ 1.1e15），足够抗在线爆破，又不至于抄写困难 */
export const RECOVERY_CODE_LENGTH = 10;

/**
 * Crockford Base32 字母表：`0-9` + 去掉 `I` `L` `O` `U` 的字母。
 * 为什么不用标准 Base32：恢复码是**人要抄在纸上**的，`0/O`、`1/I/L` 抄错会让一次性的救命码直接作废；
 * 排除这四个字符后，剩下的每一个都字形唯一。
 */
export const RECOVERY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 展示形态：`XXXXX-XXXXX`（5+5，便于念读与核对） */
export function formatRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code);
  return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}

/**
 * 归一化用户输入的恢复码：去分隔符/空白 → 大写 → 按 Crockford 规则把易混字符映射回字母表。
 * ⛔ 这是**哈希口径的一部分**：`crypto.js` 的 `hashRecoveryCode()` 必须用它，
 * 否则用户少打一个连字符就会得到另一个哈希，码就"莫名其妙失效"了。
 * @param {string} input
 * @returns {string} 归一化结果（非法输入返回空串，由调用方决定如何处理）
 */
export function normalizeRecoveryCode(input) {
  if (typeof input !== 'string') return '';
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

/** 生成一个恢复码（已格式化）。随机性来自 node:crypto（均匀，非 Math.random） */
export function generateRecoveryCode() {
  let raw = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
    raw += RECOVERY_CODE_ALPHABET[crypto.randomInt(RECOVERY_CODE_ALPHABET.length)];
  }
  return formatRecoveryCode(raw);
}

/**
 * 生成一批（默认 10 个）互不相同的恢复码。
 * 50 bit 空间下同批碰撞的概率可忽略，但仍用 Set 兜底——重复的码会让"一次性"变成"两次性"。
 * @param {number} [count]
 * @returns {string[]}
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = new Set();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}
