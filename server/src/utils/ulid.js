/**
 * Vantage · ULID（Crockford Base32，26 字符）
 *
 * 依据：docs/api.md §2.1（`batch_id` 类型 string(ULID)，✅ 决策 #18 幂等键）
 *
 * 为什么自己实现而不引依赖
 *  - 只需要「生成 + 校验」两件事，一个 40 行的模块比再进一个依赖更划算（本项目依赖越少越稳）；
 *  - 编解码必须与 Agent 侧（Go）**逐字符一致**，自己写才好配共享测试向量。
 *
 * 编码要点（ULID 规范）
 *  - 字符集 `0123456789ABCDEFGHJKMNPQRSTVWXYZ` —— 即 Crockford Base32，**不含 I / L / O / U**；
 *  - 前 10 字符 = 48 位毫秒时间戳（大端），后 16 字符 = 80 位随机量；
 *  - 因此「字典序 == 时间序」，可直接当 keyset 分页/排序键使用。
 */

import crypto from 'node:crypto';

/** Crockford Base32 字符集（顺序不可改：它就是编码表本身） */
export const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ENCODING_LEN = ULID_ENCODING.length; // 32
const TIME_LEN = 10;
const RANDOM_LEN = 16;
/** 48 位时间戳上限对应的毫秒（公元 10889 年），超出即无法用 10 字符表示 */
const MAX_TIME_MS = 2 ** 48 - 1;

/** ⚠️ 与 models/report.js 的 JSON Schema pattern 必须一致（I/L/O/U 被排除） */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 是否是合法的 26 位 ULID */
export function isUlid(value) {
  return typeof value === 'string' && ULID_RE.test(value);
}

/**
 * 生成 ULID。
 * @param {number} [now] 毫秒时间戳（测试注入固定值用）
 */
export function newUlid(now = Date.now()) {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME_MS) {
    throw new Error(`ULID 时间戳超出可表示范围：${now}`);
  }

  let time = '';
  let rest = now;
  for (let i = 0; i < TIME_LEN; i += 1) {
    time = ULID_ENCODING[rest % ENCODING_LEN] + time;
    rest = Math.floor(rest / ENCODING_LEN);
  }

  // 32 整除 256，故取模不产生偏置（无需拒绝采样）
  const bytes = crypto.randomBytes(RANDOM_LEN);
  let random = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) random += ULID_ENCODING[bytes[i] % ENCODING_LEN];

  return time + random;
}

/** 从 ULID 解回毫秒时间戳（排障用：一眼看出某个 batch_id 是何时生成的） */
export function ulidTimeMs(ulid) {
  if (!isUlid(ulid)) throw new Error(`不是合法 ULID：${ulid}`);
  let time = 0;
  for (let i = 0; i < TIME_LEN; i += 1) {
    time = time * ENCODING_LEN + ULID_ENCODING.indexOf(ulid[i]);
  }
  return time;
}
