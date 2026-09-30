/**
 * 签名规范测试 —— 逐字节对齐 docs/api.md §2.1 / docs/agent.md §6.2
 *
 * ⚠️ 测试向量来自 `contracts/agent-signature.json`（**Go Agent 侧消费同一文件**）：
 *    文档明确要求「两端各跑一遍共享向量」，否则会出现「实现都对但拼法不同」的 401。
 *    ⛔ 向量固定放在仓库根目录的 `contracts/`：它是**接口定义**而不是测试代码，
 *    放两侧任何一边的测试目录里，都会让另一边产生跨目录的怪依赖（见 `contracts/README.md`）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '../src/utils/crypto.js';
import { AppError } from '../src/utils/errors.js';
import {
  AGENT_HEADERS,
  TIMESTAMP_HARD_LIMIT_S,
  buildCanonical,
  computeSignature,
  evaluateTimestampSkew,
  parseAgentAuthHeaders,
  toCanonicalPath,
  verifySignature,
} from '../src/utils/sign.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(
  fs.readFileSync(path.join(here, '..', '..', 'contracts', 'agent-signature.json'), 'utf8'),
);
const SECRET = VECTORS.secret;

/** 把向量文件的一条记录转成 buildCanonical/verifySignature 需要的字段形状 */
function fieldsOf(vector, overrides = {}) {
  return {
    method: vector.method,
    path: vector.path,
    timestamp: vector.timestamp,
    nonce: vector.nonce,
    rawBody: vector.raw_body,
    ...overrides,
  };
}

test('共享测试向量：canonical 与签名逐字节一致', () => {
  for (const vector of VECTORS.vectors) {
    const canonical = buildCanonical(fieldsOf(vector));
    assert.equal(sha256Hex(vector.raw_body), vector.body_sha256, `${vector.name}: body sha256`);
    assert.equal(
      Buffer.byteLength(vector.raw_body, 'utf8'),
      vector.body_bytes,
      `${vector.name}: body 字节数`,
    );
    assert.equal(canonical, vector.canonical, `${vector.name}: canonical`);
    assert.equal(computeSignature(SECRET, canonical), vector.signature, `${vector.name}: signature`);
    assert.equal(
      verifySignature({ ...fieldsOf(vector), secret: SECRET, signature: vector.signature }),
      true,
      `${vector.name}: verify`,
    );
  }
});

test('canonical 结构：4 处 LF 分隔、末尾无换行、method 强制大写', () => {
  const canonical = buildCanonical({
    method: 'post',
    path: '/api/v1/agent/report',
    timestamp: 1758800000123,
    nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    rawBody: '{}',
  });
  assert.equal(canonical.split('\n').length, 5);
  assert.equal(canonical.endsWith('\n'), false);
  assert.ok(canonical.startsWith('POST\n'));
  assert.equal(canonical.split('\n')[4], sha256Hex('{}'));
});

test('path 只取路径：query / fragment 必须被剥离，且不做任何规范化', () => {
  assert.equal(toCanonicalPath('/api/v1/agent/report?x=1&y=2#z'), '/api/v1/agent/report');
  // ⛔ 不解析 `..`：两端必须对「原始路径」达成一致
  assert.equal(toCanonicalPath('/a/../b'), '/a/../b');
  assert.throws(() => toCanonicalPath(''), AppError);
});

test('决策 #35 的核心动机：签名的字节 ≠ 重新序列化后的字节', () => {
  const vector = VECTORS.vectors[0];

  // 服务端只多收到一个空格：签名立刻对不上（说明签名绑定的是**字节**而非语义）
  const spaced = vector.raw_body.replace(',"seq"', ', "seq"');
  assert.notEqual(spaced, vector.raw_body);
  assert.equal(
    verifySignature({ ...fieldsOf(vector, { rawBody: spaced }), secret: SECRET, signature: vector.signature }),
    false,
  );

  // 而「解析后再序列化」会把这个空格吃掉 → 又变回原字节、签名又能对上。
  // 这正是 ⛔ 绝不能用 JSON.parse 后重序列化结果来验签的原因（决策 #35）：
  // 若 Agent 签名的是 spaced 字节、发送的也是 spaced 字节，服务端重序列化后反而"验签通过"，
  // 于是一个被中间件改写过的 body 会被静默接受。
  assert.equal(JSON.stringify(JSON.parse(spaced)), vector.raw_body);
  assert.equal(
    verifySignature({
      ...fieldsOf(vector, { rawBody: JSON.stringify(JSON.parse(spaced)) }),
      secret: SECRET,
      signature: vector.signature,
    }),
    true,
  );

  // 真正的篡改（改内容而不是空白）无论如何都过不去
  assert.equal(
    verifySignature({
      ...fieldsOf(vector, { rawBody: vector.raw_body.replace('12.5', '99.5') }),
      secret: SECRET,
      signature: vector.signature,
    }),
    false,
  );

  // 凭证不对（换 secret）同样失败
  assert.equal(
    verifySignature({ ...fieldsOf(vector), secret: `${SECRET}x`, signature: vector.signature }),
    false,
  );
});

test('签名格式非法（非 64 位小写十六进制）直接判否，不抛异常', () => {
  const vector = VECTORS.vectors[0];
  for (const bad of ['', 'ZZZ', vector.signature.toUpperCase(), vector.signature.slice(0, 63)]) {
    assert.equal(
      verifySignature({ ...fieldsOf(vector), secret: SECRET, signature: bad }),
      false,
      `should reject signature: ${bad}`,
    );
  }
});

test('buildCanonical 拒绝畸形输入（避免产生"看似成功"的错误签名）', () => {
  const base = {
    method: 'POST',
    path: '/api/v1/agent/report',
    timestamp: 1758800000123,
    nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    rawBody: '{}',
  };
  for (const patch of [
    { timestamp: '01758800000123' }, // 前导零
    { timestamp: '1758800000123.5' },
    { nonce: 'short' },
    { nonce: 'has space in it 1234567' },
    { rawBody: undefined },
    { method: '' },
  ]) {
    assert.throws(() => buildCanonical({ ...base, ...patch }), AppError, JSON.stringify(patch));
  }
});

test('parseAgentAuthHeaders：缺头/格式错 → 401 signature_invalid 且列出缺失项', () => {
  const headers = {
    [AGENT_HEADERS.agentId]: '11111111-2222-3333-4444-555555555555',
    [AGENT_HEADERS.agentKey]: 'vk_test',
    [AGENT_HEADERS.timestamp]: '1758800000123',
    [AGENT_HEADERS.nonce]: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    [AGENT_HEADERS.signature]: 'b'.repeat(64),
  };

  assert.deepEqual(parseAgentAuthHeaders(headers), {
    agentId: '11111111-2222-3333-4444-555555555555',
    agentKey: 'vk_test',
    timestamp: 1758800000123,
    nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    signature: 'b'.repeat(64),
  });

  const withoutSignature = { ...headers };
  delete withoutSignature[AGENT_HEADERS.signature];
  assert.throws(
    () => parseAgentAuthHeaders(withoutSignature),
    (err) =>
      err instanceof AppError &&
      err.code === 'signature_invalid' &&
      err.statusCode === 401 &&
      err.details.missing.includes('X-Signature'),
  );

  assert.throws(() => parseAgentAuthHeaders({ ...headers, [AGENT_HEADERS.agentId]: 'not-a-uuid' }), AppError);
  assert.throws(() => parseAgentAuthHeaders({ ...headers, [AGENT_HEADERS.signature]: 'ABC' }), AppError);
  // 数组形式的头（重复投递同一头）取第一个值，不崩
  assert.equal(
    parseAgentAuthHeaders({ ...headers, [AGENT_HEADERS.nonce]: [headers[AGENT_HEADERS.nonce]] }).nonce,
    headers[AGENT_HEADERS.nonce],
  );
});

test('时钟漂移：默认接受+修正+告警；越 5min 硬上限任何模式都拒（决策 #17）', () => {
  const now = 1_758_800_000_123;

  assert.deepEqual(evaluateTimestampSkew(now, now), { skewMs: 0, accept: true, driftAlert: false });

  // 漂 2 分钟：默认模式接受并触发 clock_drift 告警
  const drift = evaluateTimestampSkew(now - 120_000, now);
  assert.equal(drift.accept, true);
  assert.equal(drift.driftAlert, true);
  assert.equal(drift.skewMs, -120_000);

  // 漂 6 分钟：超过硬上限 300s → 拒收
  const tooLate = evaluateTimestampSkew(now - 360_000, now);
  assert.equal(tooLate.accept, false);
  assert.equal(tooLate.reason, 'hard_limit');

  // 未来时间同样按绝对值判定
  assert.equal(evaluateTimestampSkew(now + 360_000, now).accept, false);

  // 严格模式（opt-in）：窗口收紧到 60s
  const strict = evaluateTimestampSkew(now - 120_000, now, { strict: true, maxSkewS: 60 });
  assert.equal(strict.accept, false);
  assert.equal(strict.reason, 'strict_window');

  assert.equal(TIMESTAMP_HARD_LIMIT_S, 300);
});
