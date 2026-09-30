/**
 * 密码学工具测试 —— 对齐 Vantage-DESIGN-v0.7.md §6.1 / §13、docs/database.md §5.1/§5.3/§11
 *
 * 重点验证三类用途**没有互相混用**：
 *  - 面板密码 = Argon2id（慢哈希、不可逆）
 *  - Agent 凭证 = HMAC-SHA256(pepper)（快、不可逆、防库泄露后离线爆破）
 *  - 落地加密 = AES-256-GCM（**可逆**，因为 HMAC 验签必须解出 secret）
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  AGENT_KEY_PREFIX,
  AGENT_SECRET_PREFIX,
  PUBLIC_SLUG_ALPHABET,
  decryptSecret,
  encryptSecret,
  generateAgentKey,
  generateAgentSecret,
  generateCsrfToken,
  generatePublicSlug,
  generateSessionId,
  hashAgentCredential,
  hashPassword,
  isEncryptedSecret,
  randomToken,
  sha256Hex,
  timingSafeEqualStr,
  verifyAgentCredential,
  verifyPassword,
} from '../src/utils/crypto.js';

const PEPPER = crypto.randomBytes(32);

test('randomToken / sha256Hex 基本性质', () => {
  assert.equal(randomToken(32).length, 43); // base64url(32B) 无填充
  assert.notEqual(randomToken(32), randomToken(32));
  assert.equal(sha256Hex('abc').length, 64);
  assert.equal(sha256Hex('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
  // 同一份字节（Buffer 与 string）摘要一致
  assert.equal(sha256Hex(Buffer.from('abc', 'utf8')), sha256Hex('abc'));
});

test('timingSafeEqualStr：长度不同直接 false，内容相同才 true', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStr(undefined, 'abc'), false);
});

test('public_slug：字符集排除易混字符 0 O 1 l I，长度受限于库表 CHECK', () => {
  for (let i = 0; i < 200; i += 1) {
    const slug = generatePublicSlug();
    assert.equal(slug.length, 10);
    assert.match(slug, /^[2-9A-HJ-NP-Za-km-z]{8,12}$/);
    for (const ch of '0O1lI') assert.ok(!slug.includes(ch), `slug 含易混字符 ${ch}: ${slug}`);
  }
  // 字符集本身无重复，且与库表 CHECK 的字符类逐字一致
  assert.equal(new Set(PUBLIC_SLUG_ALPHABET).size, PUBLIC_SLUG_ALPHABET.length, '字符集不得有重复字符');
  assert.ok(PUBLIC_SLUG_ALPHABET.length >= 56, `字符集过小：${PUBLIC_SLUG_ALPHABET.length}`);
  assert.throws(() => generatePublicSlug(7));
  assert.throws(() => generatePublicSlug(13));
  // ⛔ 内部 UUID 必然不符合该字符集（含连字符、长度 36）——库层 CHECK 也依赖这一点
  assert.doesNotMatch(crypto.randomUUID(), /^[2-9A-HJ-NP-Za-km-z]{8,12}$/);
});

test('Agent 凭证：格式、哈希不可逆、常量时间校验、key/secret 域分离', () => {
  const key = generateAgentKey();
  const secret = generateAgentSecret();
  assert.ok(key.startsWith(AGENT_KEY_PREFIX));
  assert.ok(secret.startsWith(AGENT_SECRET_PREFIX));
  assert.notEqual(key, secret);

  const keyHash = hashAgentCredential('key', key, PEPPER);
  const secretHash = hashAgentCredential('secret', secret, PEPPER);
  assert.match(keyHash, /^[0-9a-f]{64}$/); // 与迁移 0003 的 CHECK 约束一致

  assert.equal(verifyAgentCredential('key', key, keyHash, PEPPER), true);
  assert.equal(verifyAgentCredential('key', `${key}x`, keyHash, PEPPER), false);
  assert.equal(verifyAgentCredential('key', key, undefined, PEPPER), false);

  // 域分离：把 secret 明文当 key 校验必须失败（否则两份凭证可互相冒充）
  assert.equal(verifyAgentCredential('key', secret, secretHash, PEPPER), false);

  // 换 pepper（= 换 SECRET_KEY）→ 全部校验失败：库泄露但无 SECRET_KEY 时无法爆破
  const otherPepper = crypto.randomBytes(32);
  assert.equal(verifyAgentCredential('key', key, keyHash, otherPepper), false);

  // pepper 长度错误必须显式报错，而不是静默使用弱密钥
  assert.throws(() => hashAgentCredential('key', key, Buffer.alloc(16)));
  assert.throws(() => hashAgentCredential('nope', key, PEPPER));
});

test('面板密码：Argon2id 哈希可校验、错误密码失败、空哈希拒绝（SSO-only 账号）', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.ok(hash.startsWith('$argon2id$'), `应为 Argon2id PHC 串：${hash}`);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
  // ⛔ SSO-only 用户 password_hash 为 NULL：不得被当成"空密码可登录"
  assert.equal(await verifyPassword('', null), false);
  assert.equal(await verifyPassword('anything', ''), false);
  // 损坏的哈希串 → 返回 false 而不是抛异常
  assert.equal(await verifyPassword('x', '$argon2id$broken'), false);
  await assert.rejects(() => hashPassword('short'));
});

test('AES-256-GCM 信封：往返、随机 IV、篡改检测、AAD 域分离、版本前缀', () => {
  const key = crypto.randomBytes(32);
  const plaintext = 'smtp-p@ssw0rd 与中文';
  const aad = 'channel:wecom';

  const envelope = encryptSecret(plaintext, key, aad);
  assert.ok(isEncryptedSecret(envelope));
  assert.match(envelope, /^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]*={0,2}$/);
  assert.equal(decryptSecret(envelope, key, aad), plaintext);

  // 同一明文两次加密结果不同（随机 IV）
  assert.notEqual(encryptSecret(plaintext, key, aad), envelope);

  // 篡改密文 / 认证标签 → 抛错（GCM 认证失败），而不是返回垃圾明文
  const [v, iv, tag, ct] = envelope.split(':');
  const flipped = Buffer.from(ct, 'base64');
  flipped[0] ^= 0xff;
  assert.throws(() => decryptSecret([v, iv, tag, flipped.toString('base64')].join(':'), key, aad));
  assert.throws(() => decryptSecret([v, iv, tag, ct].join(':'), crypto.randomBytes(32), aad));

  // AAD 不符（把通道密钥密文搬到别处）→ 必须失败
  assert.throws(() => decryptSecret(envelope, key, 'channel:dingtalk'));
  assert.throws(() => decryptSecret(envelope, key, ''));

  // 密钥长度与信封格式校验
  assert.throws(() => encryptSecret(plaintext, Buffer.alloc(31)));
  assert.throws(() => decryptSecret('v2:a:b:c', key));
  assert.throws(() => decryptSecret('garbage', key));
  assert.equal(isEncryptedSecret('smtp-p@ssw0rd'), false); // 明文不被误判为密文

  // 空明文也可加密（config 中允许空字符串字段）
  assert.equal(decryptSecret(encryptSecret('', key, aad), key, aad), '');
});

test('会话与 CSRF token 长度足够（✅ §18.1：sid 为 256-bit 随机）', () => {
  const sid = generateSessionId();
  assert.equal(sid.length, 43);
  assert.equal(Buffer.from(sid, 'base64url').length, 32);
  assert.equal(generateCsrfToken().length, 32);
  assert.notEqual(generateCsrfToken(), generateCsrfToken());
});
