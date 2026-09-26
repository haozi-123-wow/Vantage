/**
 * Vantage · Agent 上报签名（HMAC-SHA256）
 *
 * 依据：Vantage-DESIGN-v0.7.md §6.2/§6.6；docs/api.md §2.1（逐字节规范）；docs/agent.md §6.2
 *
 *   canonical = method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(raw_body)
 *   signature = hex( HMAC_SHA256(agent_secret, canonical) )
 *
 * 落地要点（违反即产生难查的 401）
 *  - 分隔符**固定 `\n`（LF，0x0A）**，4 处，末尾**不加**换行（✅ 决策 #46）；
 *  - `sha256_hex(raw_body)` 针对 **gzip 之前的原始 JSON 字节**：⛔ 绝不能用 `JSON.parse` 后
 *    重新序列化的结果来算（字段顺序/空格会变，见决策 #35）；
 *  - `path` **仅路径**：⛔ 不含 host、⛔ 不含 query（如 `/api/v1/agent/report?...` 只取前段）；
 *  - `timestamp` 为十进制 ASCII unix **毫秒**，无前导零、无引号；`nonce` 原样；
 *  - 因此本模块的顺序是：**先验签、后 JSON.parse**（§6.6），调用方必须在 preParsing 阶段拿到原始 buffer。
 *
 * 两份凭证的分工（✅ 本轮修订，见 docs/database.md §5.1）
 *  - `agent_key`（`vk_`）→ `X-Agent-Key` 头，中心以 `agents.agent_key_hash` 校验，证明**身份**；
 *  - `agent_secret`（`vs_`）→ 只用于算 HMAC，**不上行**；中心从 `agents.agent_secret_enc` 解密后重算。
 */

import crypto from 'node:crypto';

import { sha256Hex, timingSafeEqualStr } from './crypto.js';
import { AppError } from './errors.js';

/** 上报请求头名（唯一来源，供中间件与测试共用） */
export const AGENT_HEADERS = Object.freeze({
  agentId: 'x-agent-id',
  agentKey: 'x-agent-key',
  timestamp: 'x-timestamp',
  nonce: 'x-nonce',
  signature: 'x-signature',
});

/** 签名窗口硬上限（秒）。✅ 决策 #17：任何模式都不得放宽 */
export const TIMESTAMP_HARD_LIMIT_S = 300;

/** 时钟漂移告警阈值（毫秒）。✅ §6.5 默认 60s */
export const CLOCK_DRIFT_ALERT_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/; // 无前导零
const NONCE_RE = /^[\x21-\x7E]{16,128}$/; // 可打印 ASCII（无空格），至少 16 字节
const SIGNATURE_RE = /^[0-9a-f]{64}$/; // 十六进制小写 32 字节

/**
 * 取 canonical 用的 path：只保留 '?' 之前的部分，且**不做任何解码/规范化**。
 * ⛔ 不要用 URL 构造函数（它会把 `/a/../b` 规范化），两端必须对「原始路径」达成一致。
 */
export function toCanonicalPath(rawUrlOrPath) {
  if (typeof rawUrlOrPath !== 'string' || rawUrlOrPath === '') {
    throw new AppError('invalid_request', { message: '请求路径为空，无法验签' });
  }
  const path = rawUrlOrPath.split(/[?#]/, 1)[0];
  return path === '' ? '/' : path;
}

/**
 * 拼装 canonical 字符串。
 * @param {{ method: string, path: string, timestamp: number|string, nonce: string, rawBody: Buffer|string }} input
 * @returns {string}
 */
export function buildCanonical({ method, path, timestamp, nonce, rawBody }) {
  const m = String(method || '').toUpperCase();
  if (m === '') throw new AppError('invalid_request', { message: '缺少 HTTP method，无法验签' });

  const ts = String(timestamp ?? '');
  if (!DECIMAL_RE.test(ts)) {
    throw new AppError('invalid_request', { message: 'X-Timestamp 必须是无前导零的十进制 unix 毫秒' });
  }

  const n = String(nonce ?? '');
  if (!NONCE_RE.test(n)) {
    throw new AppError('invalid_request', { message: 'X-Nonce 必须是 16–128 位可打印 ASCII 字符' });
  }

  if (rawBody === undefined || rawBody === null) {
    throw new AppError('invalid_request', { message: '缺少请求体原始字节，无法验签' });
  }

  return `${m}\n${toCanonicalPath(path)}\n${ts}\n${n}\n${sha256Hex(rawBody)}`;
}

/**
 * 计算签名（十六进制小写）。
 * @param {string} secret agent_secret 明文
 * @param {string} canonical buildCanonical 的输出
 */
export function computeSignature(secret, canonical) {
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('computeSignature 需要非空的 agent_secret');
  }
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/**
 * 校验签名（常量时间比较）。
 * @param {{ secret: string, signature: string, method: string, path: string, timestamp: number|string, nonce: string, rawBody: Buffer|string }} input
 * @returns {boolean}
 */
export function verifySignature({ secret, signature, method, path, timestamp, nonce, rawBody }) {
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return false;
  const canonical = buildCanonical({ method, path, timestamp, nonce, rawBody });
  const expected = computeSignature(secret, canonical);
  return timingSafeEqualStr(expected, signature);
}

/**
 * 时钟漂移判定。
 * @param {number} agentTsMs Agent 侧 ts（unix 毫秒）
 * @param {number} serverTsMs 中心接收时间
 * @param {{ maxSkewS?: number, strict?: boolean }} [options]
 * @returns {{ skewMs: number, accept: boolean, driftAlert: boolean, reason?: string }}
 *   默认策略（✅ 决策 #17）：**接受 + 修正 + 告警**——只要不越过 5min 硬上限就收下；
 *   `strict=true` 时窗口收紧到 `maxSkewS`（opt-in），越窗即拒。
 */
export function evaluateTimestampSkew(agentTsMs, serverTsMs, options = {}) {
  const maxSkewS = options.maxSkewS ?? TIMESTAMP_HARD_LIMIT_S;
  const skewMs = agentTsMs - serverTsMs;
  const absSkewMs = Math.abs(skewMs);

  if (absSkewMs > TIMESTAMP_HARD_LIMIT_S * 1000) {
    return { skewMs, accept: false, driftAlert: true, reason: 'hard_limit' };
  }
  if (options.strict && absSkewMs > maxSkewS * 1000) {
    return { skewMs, accept: false, driftAlert: true, reason: 'strict_window' };
  }
  return { skewMs, accept: true, driftAlert: absSkewMs > CLOCK_DRIFT_ALERT_MS };
}

/**
 * 从请求头解析并校验鉴权头（格式层，暂不验签）。
 * @param {Record<string, string|string[]|undefined>} headers 已小写化的头
 * @returns {{ agentId: string, agentKey: string, timestamp: number, nonce: string, signature: string }}
 * @throws {AppError} 缺头或格式非法 → 401 signature_invalid（⛔ 不回显具体缺哪个字段之外的信息）
 */
export function parseAgentAuthHeaders(headers = {}) {
  const pick = (name) => {
    const raw = headers[AGENT_HEADERS[name]];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  const agentId = String(pick('agentId') ?? '').trim();
  const agentKey = String(pick('agentKey') ?? '').trim();
  const timestamp = String(pick('timestamp') ?? '').trim();
  const nonce = String(pick('nonce') ?? '').trim();
  const signature = String(pick('signature') ?? '').trim();

  const missing = [];
  if (agentId === '') missing.push('X-Agent-Id');
  if (agentKey === '') missing.push('X-Agent-Key');
  if (timestamp === '') missing.push('X-Timestamp');
  if (nonce === '') missing.push('X-Nonce');
  if (signature === '') missing.push('X-Signature');
  if (missing.length > 0) {
    throw new AppError('signature_invalid', {
      message: `缺少必需的鉴权头：${missing.join('、')}`,
      details: { missing },
    });
  }

  if (!UUID_RE.test(agentId)) {
    throw new AppError('signature_invalid', { message: 'X-Agent-Id 不是合法 UUID' });
  }
  if (!DECIMAL_RE.test(timestamp)) {
    throw new AppError('signature_invalid', { message: 'X-Timestamp 必须是无前导零的十进制 unix 毫秒' });
  }
  if (!NONCE_RE.test(nonce)) {
    throw new AppError('signature_invalid', { message: 'X-Nonce 必须是 16–128 位可打印 ASCII 字符' });
  }
  if (!SIGNATURE_RE.test(signature)) {
    throw new AppError('signature_invalid', { message: 'X-Signature 必须是 64 位十六进制小写' });
  }

  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs)) {
    throw new AppError('signature_invalid', { message: 'X-Timestamp 超出可表示范围' });
  }

  return { agentId, agentKey, timestamp: timestampMs, nonce, signature };
}
