/**
 * 极验 GeeTest v4 纯函数单测（零网络）
 *
 * 依据：docs/geetest-captcha.md §10.1（单测清单）
 *
 * 🔑 为什么这个文件能（也必须能）不联网：`utils/geetest.js` 只做字符串与 JSON 变换。
 *    而它承载的恰恰是**两个最容易写错、且错了最难查**的点：
 *      ① `sign_token` 的 key/message 顺序（写反 → 100% 校验失败，极验的 reason 还很含糊）
 *      ② 响应有**两种形状**，"校验没通过"与"极验不可用"必须被分开（混了失败模式与审计全错）
 *    ⛔ 测试里绝不能真连 gcaptcha4.geetest.com。
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  GEETEST_DEFAULT_API_SERVER,
  GEETEST_REASON,
  VENDOR_REASON_MAX,
  buildValidateBody,
  buildValidateUrl,
  parseValidateResponse,
  sanitizeReason,
  signToken,
} from '../src/utils/geetest.js';

const KEY = 'b09a7aafbfd83f73b35a9b530d0337bf';

// -----------------------------------------------------------------------------
// sign_token
// -----------------------------------------------------------------------------

test('sign_token 对齐 RFC 4231 的 HMAC-SHA256 官方向量（key=captcha_key, message=lot_number）', () => {
  // RFC 4231 Test Case 1：key = 20 字节 0x0b，data = "Hi There"
  assert.equal(
    signToken('Hi There', '\u000b'.repeat(20)),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  );
  // RFC 4231 Test Case 2：key = "Jefe"，data = "what do ya want for nothing?"
  assert.equal(
    signToken('what do ya want for nothing?', 'Jefe'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
});

test('sign_token ⛔ key 与 message 写反会得到完全不同的值（这就是为什么要用官方向量钉死顺序）', () => {
  assert.notEqual(
    signToken('Jefe', 'what do ya want for nothing?'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
  // 与"直接用 node:crypto 算一遍"也必须一致（防将来有人改动实现细节）
  assert.equal(
    signToken('lot-123', KEY),
    createHmac('sha256', KEY).update('lot-123', 'utf8').digest('hex'),
  );
});

test('sign_token 拒绝空输入（空 lot_number 会算出"合法"签名，从而把错误推迟到极验侧，更难查）', () => {
  assert.throws(() => signToken('', KEY), /lot_number/);
  assert.throws(() => signToken('lot-1', ''), /captcha_key/);
  assert.throws(() => signToken(undefined, KEY), /lot_number/);
});

// -----------------------------------------------------------------------------
// 参数拼装
// -----------------------------------------------------------------------------

test('buildValidateUrl：⛔ 一律 https；captcha_id 进 query 且被编码', () => {
  assert.equal(
    buildValidateUrl({ captchaId: 'abc123' }),
    `https://${GEETEST_DEFAULT_API_SERVER}/validate?captcha_id=abc123`,
  );
  // 备用域名可切（docs/geetest-captcha.md §8.5）
  assert.equal(
    buildValidateUrl({ apiServer: 'gcaptcha4.geevisit.com', captchaId: 'abc123' }),
    'https://gcaptcha4.geevisit.com/validate?captcha_id=abc123',
  );
  // 编码：不能让 captcha_id 里的特殊字符改变 URL 结构
  assert.equal(
    buildValidateUrl({ captchaId: 'a&b=c' }),
    `https://${GEETEST_DEFAULT_API_SERVER}/validate?captcha_id=a%26b%3Dc`,
  );
  assert.throws(() => buildValidateUrl({ captchaId: '' }), /captcha_id/);
});

test('buildValidateBody：5 个参数齐全、签名与 signToken 一致、⛔ captcha_id 不在 body 里', () => {
  const body = buildValidateBody({
    lotNumber: 'lot-1',
    captchaOutput: 'out-1',
    passToken: 'pass-1',
    genTime: '1700000000',
    captchaKey: KEY,
  });
  const params = new URLSearchParams(body);

  assert.deepEqual([...params.keys()].sort(), [
    'captcha_output',
    'gen_time',
    'lot_number',
    'pass_token',
    'sign_token',
  ]);
  assert.equal(params.get('sign_token'), signToken('lot-1', KEY));
  assert.equal(params.get('gen_time'), '1700000000');
  // ⛔ captcha_id 走 URL（buildValidateUrl），不进 body —— 少一个可被替换的输入
  assert.equal(params.has('captcha_id'), false);
});

// -----------------------------------------------------------------------------
// 响应解析：这是本模块最重要的一处
// -----------------------------------------------------------------------------

test('parseValidateResponse：result=success → ok', () => {
  const raw = JSON.stringify({ result: 'success', reason: '', captcha_args: { used_type: 'slide' } });
  assert.deepEqual(parseValidateResponse({ httpStatus: 200, body: raw }), { ok: true });
});

test('parseValidateResponse：result=fail → **校验未通过**（不是"不可用"），并带上极验原文', () => {
  const raw = JSON.stringify({ result: 'fail', reason: 'pass_token expire', captcha_args: {} });
  assert.deepEqual(parseValidateResponse({ httpStatus: 200, body: raw }), {
    ok: false,
    reason: GEETEST_REASON.validateFailed,
    vendorReason: 'pass_token expire',
  });
});

test('parseValidateResponse：⛔ error 形状必须判为"不可用"，绝不能当成"用户没通过"', () => {
  const raw = JSON.stringify({ status: 'error', code: '-50005', msg: 'illegal gen_time', desc: {} });
  const result = parseValidateResponse({ httpStatus: 200, body: raw });

  assert.equal(result.ok, false);
  assert.equal(result.reason, GEETEST_REASON.unavailable);
  assert.equal(result.unavailable, true, '不可用必须显式标记：编排层据此走 failMode（放行/503）');
  assert.equal(result.vendorCode, '-50005');
  // 反过来：合法的 fail 响应**不得**被标成 unavailable（否则会被误放行）
  assert.equal(parseValidateResponse({ httpStatus: 200, body: '{"result":"fail"}' }).unavailable, undefined);
});

test('parseValidateResponse：HTTP 非 200 / 非 JSON / 空 body / 数组 / result 缺失 → 一律"不可用"', () => {
  const cases = [
    { httpStatus: 500, body: '{"result":"success"}' },
    { httpStatus: 502, body: '<html>bad gateway</html>' },
    { httpStatus: 200, body: 'not json at all' },
    { httpStatus: 200, body: '' },
    { httpStatus: 200, body: null },
    { httpStatus: 200, body: '[]' },
    { httpStatus: 200, body: '{}' },
    { httpStatus: 200, body: '{"result":"unknown-value"}' },
  ];

  for (const input of cases) {
    const result = parseValidateResponse(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(result.reason, GEETEST_REASON.unavailable, JSON.stringify(input));
    assert.equal(result.unavailable, true, JSON.stringify(input));
  }
});

test('parseValidateResponse：也接受已解析好的对象（编排层/测试用起来更方便）', () => {
  assert.deepEqual(parseValidateResponse({ httpStatus: 200, body: { result: 'success' } }), { ok: true });
  // ⚠️ 对象形态下 typeof null === 'object'，必须仍然判不可用
  assert.equal(parseValidateResponse({ httpStatus: 200, body: null }).unavailable, true);
});

// -----------------------------------------------------------------------------
// vendor_reason 清洗
// -----------------------------------------------------------------------------

test('sanitizeReason：去掉控制字符、限长、空值归 null（防日志/审计注入）', () => {
  assert.equal(sanitizeReason('pass_token expire'), 'pass_token expire');
  // 换行/制表/回车会污染日志行（伪造成"另一条日志"）
  assert.equal(sanitizeReason('bad\nreason\twith\rcontrol'), 'bad reason with control');
  assert.equal(sanitizeReason('   '), null);
  assert.equal(sanitizeReason(''), null);
  assert.equal(sanitizeReason(undefined), null);
  assert.equal(sanitizeReason(12345), null);

  const long = 'x'.repeat(VENDOR_REASON_MAX + 50);
  const cleaned = sanitizeReason(long);
  assert.equal(cleaned.length, VENDOR_REASON_MAX + 1); // 截断后追加一个省略号
  assert.ok(cleaned.endsWith('…'));
});
