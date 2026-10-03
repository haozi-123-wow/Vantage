/**
 * TOTP / Base32 / 一次性恢复码 单元测试（**纯离线，不需要 PG / Redis**）
 *
 * 依据：docs/api.md §4.1、§4.1.1 ⑤（✅ 已定：零依赖自研 + RFC 6238 官方向量自测）
 *
 * 为什么把「官方向量」而不是「自己算一遍再断言」当作验收标准：
 *   TOTP 由 RFC 4226（HOTP 截断）与 RFC 6238（时间步）完全钉死，向量是**外部权威事实**。
 *   一旦不符，要修的是实现，⛔ 不是放宽断言（仓库既有约定见 docs/agent-testing.md 的测试红线）。
 *
 * 时钟一律**注入**（`time` 参数），不等待真实时间流逝——与 collector 夹具的注入时钟同一取向。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { hashRecoveryCode, totpSecretAad, verifyRecoveryCode } from '../src/utils/crypto.js';
import {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  TOTP_STEP_S,
  base32Decode,
  base32Encode,
  buildOtpAuthUri,
  formatRecoveryCode,
  generateRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  stepOf,
  totpCode,
  verifyTotp,
} from '../src/utils/totp.js';

/** RFC 6238 Appendix B 的测试密钥：ASCII `12345678901234567890` */
const RFC_SECRET_TEXT = '12345678901234567890';
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/** RFC 6238 Appendix B（HMAC-SHA1，8 位码）逐条向量 —— 外部权威，不得改动 */
const RFC_VECTORS = [
  { t: 59, code: '94287082' },
  { t: 1111111109, code: '07081804' },
  { t: 1111111111, code: '14050471' },
  { t: 1234567890, code: '89005924' },
  { t: 2000000000, code: '69279037' },
  { t: 20000000000, code: '65353130' },
];

// -----------------------------------------------------------------------------
// Base32（RFC 4648）
// -----------------------------------------------------------------------------

test('Base32 编码：匹配 RFC 4648 已知向量（20 字节密钥 → 32 字符，无填充）', () => {
  assert.equal(base32Encode(Buffer.from(RFC_SECRET_TEXT, 'utf8')), RFC_SECRET_BASE32);
});

test('Base32 往返：各长度字节串编码后再解码必须逐位还原', () => {
  for (let len = 1; len <= 40; len += 1) {
    const raw = Buffer.alloc(len);
    for (let i = 0; i < len; i += 1) raw[i] = (i * 37 + len) & 0xff;
    assert.deepEqual(base32Decode(base32Encode(raw)), raw, `长度 ${len} 往返失败`);
  }
});

test('Base32 解码：容忍人工输入（小写、空白、连字符、= 填充）', () => {
  const expected = Buffer.from(RFC_SECRET_TEXT, 'utf8');
  for (const variant of [
    RFC_SECRET_BASE32.toLowerCase(),
    ` ${RFC_SECRET_BASE32.slice(0, 16)} ${RFC_SECRET_BASE32.slice(16)} `,
    `${RFC_SECRET_BASE32.slice(0, 8)}-${RFC_SECRET_BASE32.slice(8)}`,
    `${RFC_SECRET_BASE32}====`,
  ]) {
    assert.deepEqual(base32Decode(variant), expected, `变体解析失败：${variant}`);
  }
});

test('Base32 解码：⛔ 字母表外字符必须抛错（不得静默把 0/O、1/I 猜成同一个值）', () => {
  assert.throws(() => base32Decode('ABC0'), /非法字符/);
  assert.throws(() => base32Decode('ABC1'), /非法字符/);
  assert.throws(() => base32Decode('ABC!'), /非法字符/);
  assert.throws(() => base32Decode(''), /为空/);
  assert.throws(() => base32Decode('   '), /为空/);
});

// -----------------------------------------------------------------------------
// TOTP（RFC 6238）
// -----------------------------------------------------------------------------

test('TOTP：RFC 6238 Appendix B 官方向量全绿（HMAC-SHA1，8 位码）', () => {
  for (const { t, code } of RFC_VECTORS) {
    assert.equal(
      totpCode(RFC_SECRET_BASE32, { time: t * 1000, digits: 8 }),
      code,
      `T=${t} 不符 RFC 6238 向量`,
    );
  }
});

test('TOTP：直接传原始密钥 Buffer 与传 Base32 等价（把 Base32 缺陷与 HMAC 缺陷分开）', () => {
  const raw = Buffer.from(RFC_SECRET_TEXT, 'utf8');
  for (const { t, code } of RFC_VECTORS) {
    assert.equal(totpCode(raw, { time: t * 1000, digits: 8 }), code);
  }
});

test('TOTP：6 位码 = 同时刻 8 位码的后 6 位（默认 digits=6）', () => {
  for (const { t } of RFC_VECTORS) {
    const eight = totpCode(RFC_SECRET_BASE32, { time: t * 1000, digits: 8 });
    assert.equal(totpCode(RFC_SECRET_BASE32, { time: t * 1000 }), eight.slice(-6));
  }
});

test('步号：按 UTC epoch 取整，边界处不进位错位', () => {
  assert.equal(TOTP_STEP_S, 30);
  assert.equal(stepOf(0), 0);
  assert.equal(stepOf(29_999), 0);
  assert.equal(stepOf(30_000), 1);
  assert.equal(stepOf(59_999), 1);
  assert.equal(stepOf(60_000), 2);
});

test('verifyTotp：当前步、±1 步容差内通过，±2 步拒绝', () => {
  const base = 1_700_000_000_000; // 固定时钟，避免用例随时间抖动
  const current = totpCode(RFC_SECRET_BASE32, { time: base });
  const prev = totpCode(RFC_SECRET_BASE32, { time: base - TOTP_STEP_S * 1000 });
  const next = totpCode(RFC_SECRET_BASE32, { time: base + TOTP_STEP_S * 1000 });
  const tooOld = totpCode(RFC_SECRET_BASE32, { time: base - TOTP_STEP_S * 2 * 1000 });
  const tooNew = totpCode(RFC_SECRET_BASE32, { time: base + TOTP_STEP_S * 2 * 1000 });

  assert.deepEqual(verifyTotp(RFC_SECRET_BASE32, current, { time: base }), { ok: true, step: stepOf(base) });
  assert.equal(verifyTotp(RFC_SECRET_BASE32, prev, { time: base }).ok, true);
  assert.equal(verifyTotp(RFC_SECRET_BASE32, next, { time: base }).ok, true);
  assert.equal(verifyTotp(RFC_SECRET_BASE32, tooOld, { time: base }).ok, false);
  assert.equal(verifyTotp(RFC_SECRET_BASE32, tooNew, { time: base }).ok, false);
});

test('verifyTotp：回传**命中的步号**（调用方据此写 totp:used 做同一步防重放）', () => {
  const base = 1_700_000_000_000;
  const prev = totpCode(RFC_SECRET_BASE32, { time: base - TOTP_STEP_S * 1000 });
  const result = verifyTotp(RFC_SECRET_BASE32, prev, { time: base });
  assert.equal(result.ok, true);
  assert.equal(result.step, stepOf(base) - 1, '命中上一步时必须回传上一步步号，而不是当前步');
});

test('verifyTotp：容忍输入里的空白（用户从短信/密码管理器粘贴常带空格）', () => {
  const base = 1_700_000_000_000;
  const code = totpCode(RFC_SECRET_BASE32, { time: base });
  assert.equal(verifyTotp(RFC_SECRET_BASE32, ` ${code.slice(0, 3)} ${code.slice(3)} `, { time: base }).ok, true);
});

test('verifyTotp：格式非法（位数不对/含字母/空）一律 reason=format，⛔ 不抛异常', () => {
  const base = 1_700_000_000_000;
  for (const bad of ['12345', '1234567', 'abcdef', '', '   ', '12345a']) {
    assert.deepEqual(verifyTotp(RFC_SECRET_BASE32, bad, { time: base }), { ok: false, reason: 'format' });
  }
  assert.deepEqual(verifyTotp(RFC_SECRET_BASE32, null, { time: base }), { ok: false, reason: 'format' });
});

test('verifyTotp：错码返回 reason=mismatch；window=0 时只有当前步可过', () => {
  const base = 1_700_000_000_000;
  const prev = totpCode(RFC_SECRET_BASE32, { time: base - TOTP_STEP_S * 1000 });
  assert.deepEqual(verifyTotp(RFC_SECRET_BASE32, '000000', { time: base + 7 }), { ok: false, reason: 'mismatch' });
  assert.equal(verifyTotp(RFC_SECRET_BASE32, prev, { time: base, window: 0 }).ok, false);
});

test('generateTotpSecret：32 字符 Base32、可解码回 20 字节、两次生成不重复', () => {
  const a = generateTotpSecret();
  const b = generateTotpSecret();
  assert.equal(a.length, 32);
  assert.match(a, /^[A-Z2-7]+$/);
  assert.equal(base32Decode(a).length, 20);
  assert.notEqual(a, b);
});

test('buildOtpAuthUri：label 保留字面冒号、参数完整（认证器扫码的输入契约）', () => {
  const uri = buildOtpAuthUri({ secret: RFC_SECRET_BASE32, account: 'admin' });
  assert.equal(
    uri,
    `otpauth://totp/Vantage:admin?secret=${RFC_SECRET_BASE32}&issuer=Vantage&algorithm=SHA1&digits=6&period=30`,
  );

  const encoded = buildOtpAuthUri({ secret: RFC_SECRET_BASE32, account: 'a b@c.com' });
  assert.match(encoded, /^otpauth:\/\/totp\/Vantage:a%20b%40c\.com\?/, '账号侧要 URL 编码，冒号要保留为分隔符');

  assert.throws(() => buildOtpAuthUri({ account: 'admin' }), /需要 secret/);
  assert.throws(() => buildOtpAuthUri({ secret: 'ABC' }), /需要 account/);
});

// -----------------------------------------------------------------------------
// 一次性恢复码
// -----------------------------------------------------------------------------

test('恢复码形态：XXXXX-XXXXX，字符集不含 I/L/O/U（抄写歧义）', () => {
  for (let i = 0; i < 50; i += 1) {
    const code = generateRecoveryCode();
    assert.match(code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const raw = normalizeRecoveryCode(code);
    assert.equal(raw.length, 10);
    for (const ch of raw) {
      assert.ok(RECOVERY_CODE_ALPHABET.includes(ch), `出现字母表外字符：${ch}`);
    }
  }
});

test('恢复码归一化：小写/无连字符/带空格/易混字符映射后必须等价', () => {
  const canonical = '4C2N7-8HKM3';
  const expected = '4C2N78HKM3';
  assert.equal(normalizeRecoveryCode(canonical), expected);
  assert.equal(normalizeRecoveryCode('4c2n7-8hkm3'), expected);
  assert.equal(normalizeRecoveryCode(' 4C2N7 8HKM3 '), expected);
  assert.equal(normalizeRecoveryCode('4C2N7_8HKM3'), expected);
  // Crockford 规则：I/L → 1，O → 0
  assert.equal(normalizeRecoveryCode('OI'), '01');
  assert.equal(normalizeRecoveryCode('oi'), '01');
  assert.equal(normalizeRecoveryCode(null), '');
  assert.equal(normalizeRecoveryCode(''), '');
  assert.equal(formatRecoveryCode(expected), canonical);
});

test('恢复码批量生成：固定 10 个且互不相同（同批重复会把"一次性"变成"两次性"）', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT);
  for (const code of codes) assert.match(code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
});

// -----------------------------------------------------------------------------
// 哈希口径（crypto.js）
// -----------------------------------------------------------------------------

const PEPPER = Buffer.alloc(32, 7);

test('hashRecoveryCode：归一化在哈希口径内 —— 带连字符/小写与标准形态同哈希', () => {
  const canonical = '4C2N7-8HKM3';
  const hash = hashRecoveryCode(canonical, PEPPER);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashRecoveryCode('4c2n78hkm3', PEPPER), hash);
  assert.equal(hashRecoveryCode(' 4C2N7 8HKM3 ', PEPPER), hash);
  assert.notEqual(hashRecoveryCode('4C2N7-8HKM4', PEPPER), hash);
});

test('hashRecoveryCode：换 pepper 或换域即换哈希（域分隔防跨用途等价）', () => {
  const code = '4C2N7-8HKM3';
  assert.notEqual(hashRecoveryCode(code, Buffer.alloc(32, 7)), hashRecoveryCode(code, Buffer.alloc(32, 8)));
  assert.equal(hashRecoveryCode(code, PEPPER).length, 64);
  assert.throws(() => hashRecoveryCode(code, Buffer.alloc(16, 1)), /32 字节/);
  assert.throws(() => hashRecoveryCode('', PEPPER), /为空|非法/);
  assert.throws(() => hashRecoveryCode('---', PEPPER), /为空|非法/);
});

test('verifyRecoveryCode：正例通过，错码/空码/损坏哈希一律 false（⛔ 不抛）', () => {
  const code = '4C2N7-8HKM3';
  const stored = hashRecoveryCode(code, PEPPER);
  assert.equal(verifyRecoveryCode(code, stored, PEPPER), true);
  assert.equal(verifyRecoveryCode('4c2n78hkm3', stored, PEPPER), true);
  assert.equal(verifyRecoveryCode('4C2N7-8HKM4', stored, PEPPER), false);
  assert.equal(verifyRecoveryCode('', stored, PEPPER), false);
  assert.equal(verifyRecoveryCode(null, stored, PEPPER), false);
  assert.equal(verifyRecoveryCode(code, null, PEPPER), false);
  assert.equal(verifyRecoveryCode(code, 'not-a-hash', PEPPER), false);
});

test('totpSecretAad：绑定行身份（与 agentSecretAad 同理），空 user_id 必须拒绝', () => {
  assert.equal(totpSecretAad('11111111-2222-3333-4444-555555555555'), 'totp-secret:11111111-2222-3333-4444-555555555555');
  assert.notEqual(totpSecretAad('user-a'), totpSecretAad('user-b'));
  assert.throws(() => totpSecretAad(''), /需要 user_id/);
  assert.throws(() => totpSecretAad(undefined), /需要 user_id/);
});
