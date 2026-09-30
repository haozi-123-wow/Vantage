/**
 * 测试替身 · 已签名 Agent 客户端
 *
 * 用**真实的** HMAC 与真实的密文信封构造请求，这样路由测试覆盖的是真实链路
 * （X-Agent-Key 校验、AES-GCM 解密、canonical 拼装、gzip 解压），而不是被替身绕过的假链路。
 *
 * ⚠️ 签名算法本身（canonical 的分隔符/顺序）由 test/sign.test.js 用**固定测试向量**验证；
 *    这里只负责把它接到 HTTP 层，因此调用 computeSignature 而不是再手写一遍 —— 
 *    否则测试会跟着实现一起错。
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { hashAgentCredential, sealAgentSecret } from '../../src/utils/crypto.js';
import { computeSignature } from '../../src/utils/sign.js';

/** 测试用主密钥（32 字节；与生产 SECRET_KEY 无关） */
export const TEST_SECRET_KEY = Buffer.alloc(32, 7);

export const TEST_AGENT_ID = '11111111-2222-4333-8444-555555555555';
export const TEST_AGENT_KEY = 'vk_TEST_KEY_DO_NOT_USE';
export const TEST_AGENT_SECRET = 'vs_TEST_SECRET_DO_NOT_USE_0123456789abcdef';

/** 生成能通过鉴权的 agents 行（哈希与密文都用真实算法产出） */
export function makeAgentRow(overrides = {}) {
  const id = overrides.id ?? TEST_AGENT_ID;
  const key = overrides.key ?? TEST_AGENT_KEY;
  const secret = overrides.secret ?? TEST_AGENT_SECRET;
  return {
    id,
    name: overrides.name ?? 'test-host',
    status: overrides.status ?? 'online',
    agent_key_hash: hashAgentCredential('key', key, TEST_SECRET_KEY),
    agent_secret_enc: sealAgentSecret(secret, TEST_SECRET_KEY, id),
    last_ip: overrides.last_ip ?? '203.0.113.7',
    reported_ip: overrides.reported_ip ?? null,
    ip_flapping: overrides.ip_flapping ?? false,
    flapping_since: null,
    capabilities: overrides.capabilities === undefined ? { 'disk.io': true } : overrides.capabilities,
    host_info:
      overrides.host_info === undefined
        ? { hostname: 'test-host', os: 'linux', kernel: '6.8.0', boot_time: 1710000000 }
        : overrides.host_info,
    disabled_at: overrides.disabled_at ?? null,
    // 非库列，仅供调用方取用（便于签名时不必再传一遍）
    plainKey: key,
    plainSecret: secret,
  };
}

/** 随机 nonce（≥16 位可打印 ASCII） */
export function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/** batch_id（ULID 形状；测试直接固定字符集即可，不必真解析） */
export function newBatchId() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}

/**
 * 构造一份可直接 `app.inject()` 的已签名请求。
 *
 * @param {object} input
 * @param {object} input.agent makeAgentRow() 的结果
 * @param {object} input.body 报文体（对象）
 * @param {string} [input.url]
 * @param {string} [input.method]
 * @param {boolean} [input.gzip] 是否真做 gzip 压缩（签名永远针对**压缩前**字节）
 * @param {number} [input.timestamp]
 * @param {string} [input.nonce]
 * @param {boolean} [input.wrongSignature] 故意签错（篡改体用例）
 * @param {Buffer|string} [input.overrideRawBody] 用另一份字节签名（模拟"改 1 字节"）
 * @returns {{ payload: Buffer, headers: Record<string,string>, rawBody: Buffer, canonical: string }}
 */
export function buildSignedRequest(input) {
  const url = input.url ?? '/api/v1/agent/report';
  const method = input.method ?? 'POST';
  const agent = input.agent;

  const json = input.rawBodyJson ?? JSON.stringify(input.body);
  const rawBody = Buffer.isBuffer(json) ? json : Buffer.from(json, 'utf8');
  // 用于签名的字节：默认就是发送的字节；overrideRawBody 用来构造"签名与实体不一致"
  const signedBody = input.overrideRawBody ?? rawBody;

  const timestamp = String(input.timestamp ?? Date.now());
  const nonce = input.nonce ?? newNonce();
  const canonical = [
    method,
    url.split(/[?#]/, 1)[0],
    timestamp,
    nonce,
    crypto.createHash('sha256').update(signedBody).digest('hex'),
  ].join('\n');

  let signature = computeSignature(agent.plainSecret, canonical);
  if (input.wrongSignature) {
    signature = `${signature.slice(0, 63)}${signature.endsWith('0') ? '1' : '0'}`;
  }

  const headers = {
    'content-type': 'application/json',
    'x-agent-id': input.agentId ?? agent.id,
    'x-agent-key': input.agentKey ?? agent.plainKey,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': input.signature ?? signature,
  };
  if (input.gzip !== false) headers['content-encoding'] = 'gzip';

  return {
    method,
    url,
    headers,
    payload: input.gzip === false ? rawBody : zlib.gzipSync(rawBody),
    rawBody,
    canonical,
  };
}

/** 一份内容齐全的合法报文体 */
export function makeReportBody(overrides = {}) {
  return {
    agent_id: TEST_AGENT_ID,
    batch_id: newBatchId(),
    ts: Date.now(),
    seq: 1,
    host: {
      hostname: 'test-host',
      os: 'linux',
      kernel: '6.8.0-45-generic',
      arch: 'x86_64',
      boot_time: 1710000000,
      capabilities: { 'disk.io': true, 'process.top': true, 'probe.http': true },
    },
    reported_ip: '203.0.113.7',
    metrics: {
      cpu: { usage: 12.5, cores: [10, 15], load: [0.1, 0.2, 0.3], ctx_switch: 1234 },
      mem: {
        total: 8589934592,
        used: 2147483648,
        available: 6442450944,
        cached: 1073741824,
        buffers: 104857600,
        swap: { total: 2147483648, used: 0 },
      },
      disk: [
        { device: 'sda1', mount: '/', total: 107374182400, used: 53687091200, inode_used: 12.5, read_bps: 1024, write_bps: 2048, read_iops: 3, write_iops: 5, latency_ms: 0.8 },
      ],
      net: [{ device: 'eth0', rx_bps: 1000, tx_bps: 2000, rx_total: 1e12, tx_total: 2e12, conn_count: 42, err: 0, drop: 0 }],
      gpu: [{ index: 0, util: 30, mem_used: 1024, mem_total: 8192, temp: 55, power: 120 }],
      process: { count: 210, top: [{ pid: 1, name: 'systemd', cpu: 0.1, mem: 10485760 }] },
      docker: null,
    },
    probes: [
      { name: 'site-health', type: 'https', target: 'https://example.com/', up: true, latency_ms: 123.4, status_code: 200, error: null },
    ],
    ...overrides,
  };
}
