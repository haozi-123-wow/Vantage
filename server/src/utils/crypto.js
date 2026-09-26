/**
 * Vantage · 密码学工具
 *
 * 依据：Vantage-DESIGN-v0.7.md §6.1（凭证模型）、§13 安全清单；
 *       docs/database.md §5.1（凭证只存哈希）、§5.3（密码 Argon2id）、§11（敏感项应用层加密）
 *
 * 三类用途，**刻意使用不同算法**（安全性/性能的取舍，勿混用）：
 *
 *  1. 面板密码（`users.password_hash`）→ **Argon2id**：低熵人工口令，必须慢哈希抗爆破。
 *  2. Agent 凭证（`agents.agent_key_hash` / `agent_secret_hash`）→ **HMAC-SHA256(pepper=SECRET_KEY)**：
 *     凭证是 256 位随机值本无需慢哈希；且**每次上报都要校验签名**，Argon2 的数十毫秒
 *     会直接吃掉上报吞吐。加 pepper 后即使数据库泄露也无法离线爆破。
 *  3. 落地加密（`channels.config` 敏感项、`users.totp_secret_enc`）→ **AES-256-GCM**，
 *     主密钥来自 env（SECRET_KEY），⛔ 永不入库；密文带 `v1:` 版本前缀以便日后轮换密钥。
 */

import crypto from 'node:crypto';
import { Algorithm, hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

// -----------------------------------------------------------------------------
// 通用随机与摘要
// -----------------------------------------------------------------------------

/** 生成 n 字节随机 Buffer */
export function randomBytes(n = 32) {
  return crypto.randomBytes(n);
}

/** 生成 n 字节随机值的 base64url 字符串（无填充，适合放 URL/文件名） */
export function randomToken(n = 32) {
  return crypto.randomBytes(n).toString('base64url');
}

/** SHA-256 十六进制小写（用于签名 canonical 里的 body 摘要） */
export function sha256Hex(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 定长常量时间字符串比较（避免签名/凭据比较被计时侧信道探测） */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// -----------------------------------------------------------------------------
// 公开标识（agents.public_slug）
// -----------------------------------------------------------------------------

/**
 * public_slug 字符集：数字与字母，但**排除易混字符 0 O 1 l I**。
 * 与迁移脚本 0003 的 CHECK 约束 `^[2-9A-HJ-NP-Za-km-z]{8,12}$` 严格一致。
 * 附带收益：内部 UUID（36 位含连字符）必然不满足该字符集，从库层面杜绝「公开 URL 泄露内部 ID」。
 */
export const PUBLIC_SLUG_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** 生成 public_slug（默认 10 位，落在 8–12 的约束区间内；用 randomInt 避免取模偏差） */
export function generatePublicSlug(length = 10) {
  if (!Number.isInteger(length) || length < 8 || length > 12) {
    throw new Error('public_slug 长度必须在 8–12 之间（与库表 CHECK 约束一致）');
  }
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PUBLIC_SLUG_ALPHABET[crypto.randomInt(0, PUBLIC_SLUG_ALPHABET.length)];
  }
  return out;
}

// -----------------------------------------------------------------------------
// Agent 凭证
// -----------------------------------------------------------------------------

/** 凭证前缀便于泄露检测（secret scanning）与人工辨识 */
export const AGENT_KEY_PREFIX = 'vk_';
export const AGENT_SECRET_PREFIX = 'vs_';

/** 生成 agent_key（32 字节随机 → `vk_` + base64url） */
export function generateAgentKey() {
  return AGENT_KEY_PREFIX + randomToken(32);
}

/** 生成 agent_secret（32 字节随机 → `vs_` + base64url；独立于 key） */
export function generateAgentSecret() {
  return AGENT_SECRET_PREFIX + randomToken(32);
}

/**
 * `agents.agent_secret_enc` 的 AAD —— **把密文绑定到 agent_id**。
 *
 * 为什么必须绑定：AES-GCM 的密文在「密钥相同 + AAD 相同」时是可搬运的。
 * 若不绑定 agent_id，任何能写 `agents` 表的路径（SQL 注入、误操作、
 * 备份恢复串库）都可以把 A 机的 `agent_secret_enc` 抄给 B 机，
 * 于是 B 机就自动获得了 A 机的签名能力——而 `agent_key_hash` 仍然各归各的，
 * 从表面完全看不出来。绑定后这种搬运会在解密时直接 GCM 认证失败。
 *
 * ⛔ 这个字符串是**落库格式的一部分**：改动它等于让所有既有密文失效。
 */
export function agentSecretAad(agentId) {
  if (!agentId) throw new Error('agentSecretAad 需要 agent_id');
  return `agent-secret:${agentId}`;
}

/** 封装 agent_secret（唯一允许的写入路径，保证 AAD 口径一致） */
export function sealAgentSecret(secret, key, agentId) {
  return encryptSecret(secret, key, agentSecretAad(agentId));
}

/** 解出 agent_secret 明文（仅中心验签时使用；⛔ 明文不得入日志/响应） */
export function openAgentSecret(envelope, key, agentId) {
  return decryptSecret(envelope, key, agentSecretAad(agentId));
}

/**
 * Agent 凭证哈希：HMAC-SHA256(pepper = SECRET_KEY, domain || 明文)。
 * @param {'key'|'secret'} kind 域分隔，避免 key 与 secret 哈希互相等价
 * @param {string} plaintext 明文凭证
 * @param {Buffer} pepper SECRET_KEY（32 字节）
 */
export function hashAgentCredential(kind, plaintext, pepper) {
  if (kind !== 'key' && kind !== 'secret') throw new Error(`未知凭证类型：${kind}`);
  if (!Buffer.isBuffer(pepper) || pepper.length !== 32) {
    throw new Error('SECRET_KEY 必须是 32 字节 Buffer');
  }
  return crypto.createHmac('sha256', pepper).update(`vantage:agent:${kind}:${plaintext}`, 'utf8').digest('hex');
}

/** 校验 Agent 凭证（常量时间比较） */
export function verifyAgentCredential(kind, plaintext, storedHash, pepper) {
  if (!storedHash) return false;
  return timingSafeEqualStr(hashAgentCredential(kind, plaintext, pepper), storedHash);
}

// -----------------------------------------------------------------------------
// 面板密码（Argon2id）
// -----------------------------------------------------------------------------

/**
 * Argon2id 参数（OWASP 推荐档：19 MiB / 2 次迭代 / 并行度 1）。
 * ⚠️ 调整参数会让既有哈希仍可校验（参数编码在哈希串内），但新哈希才用新参数。
 */
export const ARGON2_OPTIONS = Object.freeze({
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});

/** 生成密码哈希（返回 PHC 字符串，可直接入库） */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('密码至少 8 个字符');
  }
  return argon2Hash(password, ARGON2_OPTIONS);
}

/**
 * 校验密码。
 * ⛔ SSO-only 账号 password_hash 为 NULL：调用方必须先判断为空并直接拒绝
 *    （docs/database.md §5.3「不允许空密码本地登录」），本函数对空哈希返回 false。
 */
export async function verifyPassword(password, passwordHash) {
  if (!passwordHash || typeof password !== 'string' || password.length === 0) return false;
  try {
    return await argon2Verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    // 哈希格式损坏/参数不支持 → 视为校验失败，不向外抛异常
    return false;
  }
}

// -----------------------------------------------------------------------------
// 应用层加密（AES-256-GCM，v1 信封）
// -----------------------------------------------------------------------------

const ENC_VERSION = 'v1';
const GCM_IV_BYTES = 12; // 96 bit，GCM 推荐长度
const GCM_TAG_BYTES = 16;

/**
 * 加密敏感字符串（channels.config 里的密码/加签 secret、users.totp_secret_enc）。
 * 输出格式：`v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`（标准 base64，可安全放 JSONB 文本）
 * @param {string} plaintext
 * @param {Buffer} key 32 字节主密钥（config.security.secretKey）
 * @param {string} [aad] 附加认证数据（建议传用途标识，如 'totp' / 'channel:wecom'，防止密文跨用途搬运）
 */
export function encryptSecret(plaintext, key, aad = '') {
  if (typeof plaintext !== 'string') throw new Error('encryptSecret 只接受字符串');
  assertKey(key);
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * 解密（失败即抛错：密文被篡改、密钥不匹配或 AAD 不符都会导致 GCM 认证失败）。
 * @returns {string} 明文
 */
export function decryptSecret(envelope, key, aad = '') {
  assertKey(key);
  if (typeof envelope !== 'string') throw new Error('密文必须是字符串');
  const parts = envelope.split(':');
  if (parts.length !== 4) throw new Error('密文格式非法（应为 v1:<iv>:<tag>:<ct>）');
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== ENC_VERSION) throw new Error(`不支持的密文版本：${version}`);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'), {
    authTagLength: GCM_TAG_BYTES,
  });
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** 是否为本模块产出的密文信封 */
export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(`${ENC_VERSION}:`) && value.split(':').length === 4;
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('加密主密钥必须是 32 字节 Buffer（来自 SECRET_KEY）');
  }
}

// -----------------------------------------------------------------------------
// 面板会话
// -----------------------------------------------------------------------------

/** 会话 ID：256-bit 随机（✅ §18.1「Cookie 仅存不透明 sid」） */
export function generateSessionId() {
  return randomToken(32);
}

/** CSRF token（配合 SameSite=Lax 的双保险） */
export function generateCsrfToken() {
  return randomToken(24);
}
