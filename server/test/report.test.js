/**
 * Agent 上报链路测试（M1）—— 全部通过 `app.inject()` 走**真实**中间件管线
 *
 * 覆盖 docs/api.md §6.1 的十条验收用例（第 5 条的"漂移 2 分钟"与第 9 条的 IP 变化/Flapping 都在此）：

 *   1 正常 · 2 重复批次 · 3 篡改 body · 4 nonce 重放 · 5 时间越窗 · 6 zip bomb / 超大包
 *   7 schema 越界 · 8 跨机越权（+审计）· 9 IP 变化与 Flapping · 10 响应体纯净
 *
 * 另覆盖：两条凭证的分工、disabled Agent、首次上报必须带 host/capabilities、
 * 批次占位在事务失败后释放、限流（429 + Retry-After）、单向宗旨（不存在下发端点）。
 *
 * ⚠️ 依赖全部是替身（记录型 PG + 内存 Redis），因此**不需要真实数据库**；
 *    真机联调见 test/report.live.test.js（VANTAGE_LIVE_TEST=1）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/utils/log.js';
import { isUlid, newUlid, ulidTimeMs } from '../src/utils/ulid.js';
import { pickCalls, createFakeDb } from './helpers/fake-pg.js';
import { createFakeRedis } from './helpers/fake-redis.js';
import {
  TEST_AGENT_ID,
  TEST_SECRET_KEY,
  buildSignedRequest,
  makeAgentRow,
  makeReportBody,
  newBatchId,
  newNonce,
} from './helpers/agent-client.js';

/** 测试客户端 IP：非回环 → 值得记入 IP 历史（否则会被 §5.5 的过滤规则跳过） */
const REMOTE_ADDR = '203.0.113.9';

async function setUp(options = {}) {
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
      SECRET_KEY: TEST_SECRET_KEY.toString('base64'),
      ...(options.env ?? {}),
    },
    { skipEnvFile: true },
  );

  const agentRow = options.agentRow === undefined ? makeAgentRow() : options.agentRow;
  const fake = createFakeDb({ agentRow, ipChanged: options.ipChanged, recentIpChanges: options.recentIpChanges });
  const redis = createFakeRedis();

  const app = await buildApp({
    config,
    logger: createLogger({ level: 'silent' }),
    db: { app: fake.pool, migrator: null },
    redis,
  });

  return { app, config, calls: fake.calls, state: fake.state, redis, agent: makeAgentRow() };
}

/**
 * 发一份合法上报（可按需覆盖细节）。
 *
 * ⚠️ `body` 是**增量覆盖**（在默认完整报文上改几个字段）；要发一份**完全自定义**的报文
 *    （例如心跳的极简报文、或故意删掉某字段）必须用 `exactBody` ——
 *    否则 `delete body.host` 之后再经过 makeReportBody 合并，字段会被默认值补回来，
 *    用例会静默地测成"合法报文"。
 */
function send(app, agent, overrides = {}) {
  const body = overrides.exactBody !== undefined ? overrides.exactBody : makeReportBody(overrides.body);
  const request = buildSignedRequest({
    agent,
    body,
    rawBodyJson: overrides.rawBodyJson,
    url: overrides.url ?? '/api/v1/agent/report',
    gzip: overrides.gzip,
    timestamp: overrides.timestamp,
    nonce: overrides.nonce,
    wrongSignature: overrides.wrongSignature,
    overrideRawBody: overrides.overrideRawBody,
    signature: overrides.signature,
    agentKey: overrides.agentKey,
    agentId: overrides.agentId,
  });
  return app.inject({ ...request, remoteAddress: overrides.remoteAddress ?? REMOTE_ADDR });
}

// -----------------------------------------------------------------------------
// 1 / 10 —— 正常路径与响应体纯净
// -----------------------------------------------------------------------------

test('① 合法上报 → 200 {ok:true, server_ts}，指标/快照/探活全部落库且在同一事务内', async () => {
  const { app, calls, state } = await setUp();
  const agent = makeAgentRow();

  const res = await send(app, agent);
  assert.equal(res.statusCode, 200, res.body);

  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.server_ts, 'number');
  // server_ts 必须是「现在」（毫秒），而不是 agent 的 ts
  assert.ok(Math.abs(body.server_ts - Date.now()) < 5_000);

  // 落库顺序对齐 docs/database.md §6.1
  const order = calls
    .filter((call) => call.sql)
    .map((call) => {
      if (/FOR UPDATE/i.test(call.sql)) return 'lock-agents';
      if (/UPDATE agents[\s\S]*last_seen_at/i.test(call.sql)) return 'upsert-agents';
      if (/INSERT INTO agent_ip_history/i.test(call.sql)) return 'ip-history';
      if (/INSERT INTO metrics_raw/i.test(call.sql)) return 'metrics';
      if (/INSERT INTO process_snapshots/i.test(call.sql)) return 'process';
      if (/INSERT INTO probe_results/i.test(call.sql)) return 'probes';
      return null;
    })
    .filter(Boolean);
  // 两条 ip-history：连接来源 IP（remote）与 Agent 自报出口 IP（agent_reported），§8 双源比对
  assert.deepEqual(order, [
    'lock-agents',
    'upsert-agents',
    'ip-history',
    'ip-history',
    'metrics',
    'process',
    'probes',
  ]);

  // 全部写入必须发生在同一事务内
  const writes = calls.filter((call) => /^(INSERT|UPDATE)/i.test(call.sql ?? ''));
  assert.ok(writes.length >= 5);
  assert.ok(writes.every((call) => call.inTransaction), '所有写入都必须在事务内');
  assert.equal(state.committed, 1);
  assert.equal(state.rolledBack, 0);

  // metrics_raw 的参数：agent/ts 走标量，metric/value/labels 走三个等长数组
  const metricsCall = pickCalls(calls, /INSERT INTO metrics_raw/)[0];
  const [metricsAgentId, metricsTs, metrics, values, labels] = metricsCall.params;
  assert.equal(metricsAgentId, TEST_AGENT_ID);
  assert.equal(metricsTs.getTime(), body.server_ts, 'ts 必须等于响应里的 server_ts（时间权威）');
  assert.equal(metrics.length, values.length);
  assert.equal(metrics.length, labels.length);

  // 维度写进序列全名（✅ 决策 R5）：挂载点/设备/GPU 序号都在名字里
  assert.ok(metrics.includes('disk.used_pct{device=sda1,mount=/}'));
  assert.ok(metrics.includes('net.rx_bps{device=eth0}'));
  assert.ok(metrics.includes('gpu.util{index=0}'));
  assert.ok(metrics.includes('cpu.core.usage{core=0}'));
  assert.ok(metrics.includes('cpu.load15'));
  // 派生百分比：中心用同一批的分子分母就地算出（mem 25%，disk 50%，swap used=0 → 0）
  const valueOf = (name) => values[metrics.indexOf(name)];
  assert.equal(valueOf('mem.used_pct'), 25);
  assert.equal(valueOf('disk.used_pct{device=sda1,mount=/}'), 50);
  assert.equal(valueOf('swap.used_pct'), 0);
  assert.ok(metrics.includes('process.count'));

  // labels 是"由全名反解的便利副本"，⛔ 非权威 —— 必须与全名一致
  const diskIndex = metrics.indexOf('disk.used_pct{device=sda1,mount=/}');
  assert.deepEqual(JSON.parse(labels[diskIndex]), { device: 'sda1', mount: '/' });
  const cpuIndex = metrics.indexOf('cpu.usage');
  assert.deepEqual(JSON.parse(labels[cpuIndex]), {});

  await app.close();
});

test('⑩ 响应体纯净：键集合**恰为** {ok, server_ts}（⛔ 单向宗旨回归用例）', async () => {
  const { app, agent } = await setUp();
  const res = await send(app, agent);

  const keys = Object.keys(res.json()).sort();
  assert.deepEqual(keys, ['ok', 'server_ts']);
  // 全文再兜一层：不得出现任何可解释为"下发"的字段
  for (const banned of ['config', 'command', 'script', 'threshold', 'task', 'url', 'key', 'secret']) {
    assert.equal(res.body.includes(banned), false, `响应体出现了疑似下发字段：${banned}`);
  }
  await app.close();
});

test('⛔ 单向宗旨：公开路由表里不存在任何下发式端点', async () => {
  const { app } = await setUp();
  const routes = app.printRoutes({ commonPrefix: false });
  for (const banned of ['agent/config', 'agent/tasks', 'agent/command', 'agent/exec', 'agent/script', 'agent/upgrade']) {
    assert.equal(routes.includes(banned), false, `出现了禁止的下发式端点：${banned}`);
  }
  // 上行端点确实存在
  assert.ok(routes.includes('report'));
  assert.ok(routes.includes('heartbeat'));
  await app.close();
});

// -----------------------------------------------------------------------------
// 2 / 4 —— 幂等与防重放
// -----------------------------------------------------------------------------

test('② 重复批次：同 batch_id 第二次不入库、仍 200（✅ 决策 #18）', async () => {
  const { app, calls, agent } = await setUp();
  const batchId = newBatchId();

  const first = await send(app, agent, { body: { batch_id: batchId } });
  assert.equal(first.statusCode, 200);
  const metricsAfterFirst = pickCalls(calls, /INSERT INTO metrics_raw/).length;

  const second = await send(app, agent, { body: { batch_id: batchId }, nonce: newNonce() });
  assert.equal(second.statusCode, 200);
  // 响应形态必须恒定（⛔ 不加 duplicate 字段）：键集合一致、ok 一致，只有 server_ts 是新时刻
  assert.deepEqual(Object.keys(second.json()).sort(), Object.keys(first.json()).sort());
  assert.equal(second.json().ok, true);
  assert.ok(second.json().server_ts >= first.json().server_ts);

  assert.equal(
    pickCalls(calls, /INSERT INTO metrics_raw/).length,
    metricsAfterFirst,
    '第二次不得再写指标',
  );
  await app.close();
});

test('④ nonce 重放（不同 batch）：409 nonce_reused，且被占用的 batch 占位会被撤掉', async () => {
  const { app, redis, agent } = await setUp();
  const nonce = newNonce();

  const first = await send(app, agent, { nonce });
  assert.equal(first.statusCode, 200, first.body);

  const replayedBatch = newBatchId();
  const replay = await send(app, agent, { nonce, body: { batch_id: replayedBatch } });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().error.code, 'nonce_reused');
  // ⛔ 关键：被拒绝的请求不能把 batch 占位永久留住，否则同批次永远补不上
  assert.equal(redis.has(`batch:${replayedBatch}`), false);

  // 换一个新 nonce 就能正常上报该批次
  const retry = await send(app, agent, { body: { batch_id: replayedBatch } });
  assert.equal(retry.statusCode, 200, retry.body);
  await app.close();
});

test('幂等键是 ULID（26 位 Crockford）且可解回时间戳', async () => {
  const batchId = newUlid();
  assert.match(batchId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(Math.abs(ulidTimeMs(batchId) - Date.now()) < 1000);
  // 与 JSON Schema 的 pattern 必须同形，否则"自己生成的 id 自己收不了"
  assert.equal(isUlid(newBatchId().toLowerCase().toUpperCase()), true);
});

// -----------------------------------------------------------------------------
// 3 —— 篡改与凭证
// -----------------------------------------------------------------------------

test('③ 篡改 body 1 字节 → 401 signature_invalid（验签先于 JSON.parse）', async () => {
  const { app, calls, agent } = await setUp();
  const body = makeReportBody();
  // 签的是 A，发的是 A 改了一字节的 B
  const tampered = Buffer.from(JSON.stringify(makeReportBody({ batch_id: body.batch_id, seq: 999 })), 'utf8');
  const res = await send(app, agent, { body, overrideRawBody: tampered });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'signature_invalid');
  // 并且**没有**发生任何落库（连 agents 心跳都没写）
  assert.equal(pickCalls(calls, /INSERT INTO|UPDATE agents/).length, 0);
  await app.close();
});

test('X-Agent-Key 与库内哈希不符 → 401 signature_invalid（身份这层先失败）', async () => {
  const { app, agent } = await setUp();
  const res = await send(app, agent, { agentKey: 'vk_WRONG_KEY' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'signature_invalid');
  await app.close();
});

test('签名格式非法（非 64 位十六进制）→ 401 signature_invalid', async () => {
  const { app, agent } = await setUp();
  const res = await send(app, agent, { signature: 'not-a-signature' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'signature_invalid');
  await app.close();
});

test('未知 Agent → 401 agent_unknown_or_disabled', async () => {
  const { app, agent } = await setUp({ agentRow: null });
  const res = await send(app, agent);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'agent_unknown_or_disabled');
  await app.close();
});

test('凭证已禁用 → 401 agent_unknown_or_disabled（⛔ 上报不能把 disabled 救回 online）', async () => {
  const { app, calls } = await setUp({
    agentRow: makeAgentRow({ status: 'disabled', disabled_at: new Date() }),
  });
  const res = await send(app, makeAgentRow());
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'agent_unknown_or_disabled');
  assert.equal(pickCalls(calls, /UPDATE agents/).length, 0);
  await app.close();
});

test('SECRET_KEY 换过（密文解不开）→ 500 internal_error，而不是静默 401', async () => {
  // 用另一把主密钥封装的 agent_secret_enc（模拟 SECRET_KEY 被更换）
  const foreign = makeAgentRow();
  const { sealAgentSecret } = await import('../src/utils/crypto.js');
  const otherKeyRow = { ...foreign, agent_secret_enc: sealAgentSecret('vs_other', Buffer.alloc(32, 9), foreign.id) };
  const { app } = await setUp({ agentRow: otherKeyRow });

  const res = await send(app, foreign);
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, 'internal_error');
  await app.close();
});

// -----------------------------------------------------------------------------
// 5 —— 时间窗与漂移
// -----------------------------------------------------------------------------

test('⑤ 时间越窗 6 分钟 → 401 timestamp_skew（>5min 硬上限，任何模式）', async () => {
  const { app, calls, agent } = await setUp();
  const res = await send(app, agent, { timestamp: Date.now() - 6 * 60 * 1000 });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'timestamp_skew');
  assert.equal(res.json().error.details.hard_limit_s, 300);
  assert.equal(pickCalls(calls, /INSERT INTO/).length, 0);
  await app.close();
});

test('⑤ 偏 2 分钟 → 默认模式**接受**（只记录漂移，✅ 决策 #17）', async () => {
  const { app, agent } = await setUp();
  const res = await send(app, agent, { timestamp: Date.now() - 2 * 60 * 1000 });

  assert.equal(res.statusCode, 200, res.body);
  await app.close();
});

test('SIGNATURE_STRICT=true 时窗口收紧到 SIGNATURE_WINDOW_S（opt-in 严格拒收）', async () => {
  const { app, agent } = await setUp({ env: { SIGNATURE_STRICT: 'true', SIGNATURE_WINDOW_S: '60' } });
  const res = await send(app, agent, { timestamp: Date.now() - 120 * 1000 });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'timestamp_skew');
  await app.close();
});

// -----------------------------------------------------------------------------
// 6 —— 体积上限与 zip bomb
// -----------------------------------------------------------------------------

test('⑥ zip bomb：解压输出超 4MB → 413，且**不进入 JSON.parse**', async () => {
  const { app, agent } = await setUp();
  // 5MB 的 "a" 压缩后只有几 KB —— 先在解压阶段就被 zlib 的 maxOutputLength 挡住
  const bomb = Buffer.from(JSON.stringify({ filler: 'a'.repeat(5 * 1024 * 1024) }), 'utf8');
  const res = await send(app, agent, { rawBodyJson: bomb, gzip: true });

  assert.equal(res.statusCode, 413, res.body);
  assert.equal(res.json().error.code, 'payload_too_large');
  await app.close();
});

test('⑥ 压缩后超过 1MB → 413（Content-Length 快路径）', async () => {
  const { app, agent } = await setUp();
  // 2MB 的**不可压缩**内容：base64 随机字节 → gzip 后仍 ~1.5MB
  const { randomBytes } = await import('node:crypto');
  const big = Buffer.from(JSON.stringify({ filler: randomBytes(1_600_000).toString('base64') }), 'utf8');
  const res = await send(app, agent, { rawBodyJson: big, gzip: true });

  assert.equal(res.statusCode, 413);
  assert.equal(res.json().error.code, 'payload_too_large');
  await app.close();
});

test('未压缩（identity）也能上报，但同样受 1MB 上限约束', async () => {
  const { app, agent } = await setUp();

  const ok = await send(app, agent, { gzip: false });
  assert.equal(ok.statusCode, 200, ok.body);

  const tooBig = await send(app, agent, {
    gzip: false,
    rawBodyJson: Buffer.from(JSON.stringify({ filler: 'b'.repeat(1_500_000) }), 'utf8'),
  });
  assert.equal(tooBig.statusCode, 413);
  await app.close();
});

test('gzip 数据损坏 → 400 invalid_request（而不是 500）', async () => {
  const { app, agent } = await setUp();
  const good = buildSignedRequest({ agent, body: makeReportBody() });
  // 把 gzip 魔数改坏
  const broken = Buffer.from(good.payload);
  broken[0] = 0x00;
  const res = await app.inject({ ...good, payload: broken, remoteAddress: REMOTE_ADDR });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'invalid_request');
  await app.close();
});

test('⛔ 不支持的 Content-Encoding（br）→ 415 unsupported_content_encoding', async () => {
  const { app, agent } = await setUp();
  const request = buildSignedRequest({ agent, body: makeReportBody() });
  const res = await app.inject({
    ...request,
    headers: { ...request.headers, 'content-encoding': 'br' },
    remoteAddress: REMOTE_ADDR,
  });

  assert.equal(res.statusCode, 415);
  assert.equal(res.json().error.code, 'unsupported_content_encoding');
  await app.close();
});

test('Content-Type 不是 application/json → 400 invalid_request', async () => {
  const { app, agent } = await setUp();
  const request = buildSignedRequest({ agent, body: makeReportBody(), gzip: false });
  const res = await app.inject({
    ...request,
    headers: { ...request.headers, 'content-type': 'text/plain' },
    remoteAddress: REMOTE_ADDR,
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'invalid_request');
  await app.close();
});

// -----------------------------------------------------------------------------
// 7 —— schema 白名单
// -----------------------------------------------------------------------------

test('⑦ 白名单外字段 → 400 schema_invalid（⛔ 不静默忽略）', async () => {
  const { app, agent } = await setUp();
  const res = await send(app, agent, { body: { evil_field: 'rm -rf /' } });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  await app.close();
});

test('⑦ metrics 里出现白名单外的键 → 400 schema_invalid', async () => {
  const { app, agent } = await setUp();
  const body = makeReportBody();
  body.metrics.cpu = { ...body.metrics.cpu, secret_metric: 1 };
  const res = await send(app, agent, { body });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  await app.close();
});

test('⑦ 数值越界（cpu.usage > 100）→ 400 schema_invalid', async () => {
  const { app, agent } = await setUp();
  const body = makeReportBody();
  body.metrics.cpu = { ...body.metrics.cpu, usage: 100.5 };
  const res = await send(app, agent, { body });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  await app.close();
});

test('⑦ 数组超长（disk 65 条 > 上限 64）→ 400 schema_invalid', async () => {
  const { app, agent } = await setUp();
  const body = makeReportBody();
  body.metrics.disk = Array.from({ length: 65 }, (_, i) => ({ mount: `/mnt/${i}`, total: 1, used: 0 }));
  const res = await send(app, agent, { body });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  await app.close();
});

test('⑦ batch_id 不是 ULID → 400 schema_invalid', async () => {
  const { app, agent } = await setUp();
  const res = await send(app, agent, { body: { batch_id: 'not-a-ulid' } });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  await app.close();
});

test('⑦ docker 非 null（本期固定 null）→ 400 schema_invalid', async () => {
  const { app, agent } = await setUp();
  const body = makeReportBody();
  body.metrics.docker = { containers: [] };
  const res = await send(app, agent, { body });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  await app.close();
});

test('⑦ 批内重复序列名（同 device+mount 两条 disk）→ 400 schema_invalid', async () => {
  const { app, agent } = await setUp();
  const body = makeReportBody();
  body.metrics.disk = [
    { device: 'sda1', mount: '/', total: 100, used: 50 },
    { device: 'sda1', mount: '/', total: 100, used: 60 },
  ];
  const res = await send(app, agent, { body });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  assert.match(res.json().error.message, /重复的序列名/);
  await app.close();
});

test('NaN / Infinity 无法出现在 JSON 里，但中心仍拒绝非有限值（走 schema 层）', async () => {
  const { app, agent } = await setUp();
  // 用 1e308 * 10 会被 JSON.stringify 变成 null → schema 直接判类型错误
  const body = makeReportBody();
  body.metrics.mem = { total: Infinity, used: 1 };
  const res = await send(app, agent, { body });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  await app.close();
});

// -----------------------------------------------------------------------------
// 8 —— 跨机越权（+审计）
// -----------------------------------------------------------------------------

test('⑧ 跨机越权：body.agent_id 与 X-Agent-Id 不一致 → 400 + 写审计', async () => {
  const OTHER_ID = '99999999-8888-4777-8666-555555555555';
  const { app, calls, agent } = await setUp();
  const res = await send(app, agent, { body: { agent_id: OTHER_ID } });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'invalid_request');
  assert.equal(res.json().error.details.field, 'agent_id');

  const audits = pickCalls(calls, /INSERT INTO audit_logs/);
  assert.equal(audits.length, 1, '跨机越权必须留审计');
  const params = audits[0].params;
  assert.equal(params[0], `agent:${TEST_AGENT_ID}`);
  assert.equal(params[1], 'agent');
  assert.equal(params[2], 'agent.report.identity_mismatch');
  assert.equal(params[3], OTHER_ID);
  assert.equal(JSON.parse(params[5]).body_agent_id, OTHER_ID);

  // ⛔ 未通过一致性的请求不得落任何业务数据
  assert.equal(pickCalls(calls, /INSERT INTO metrics_raw/).length, 0);
  await app.close();
});

// -----------------------------------------------------------------------------
// 9 —— IP 变化与 Flapping
// -----------------------------------------------------------------------------

test('⑨ IP 变化 → ip_change_events 新增 1 条（kind=change）', async () => {
  const { app, calls, agent } = await setUp({ ipChanged: true });
  const res = await send(app, agent);
  assert.equal(res.statusCode, 200, res.body);

  const events = pickCalls(calls, /INSERT INTO ip_change_events/);
  assert.equal(events.length, 1);
  const params = events[0].params;
  assert.equal(params[2], REMOTE_ADDR, 'new_ip 应为本次连接来源 IP');
  assert.equal(params[5], 'remote');
  assert.equal(params[6], 'change');
  assert.equal(params[7], 1, 'change_count 含本次变化');
  // 前端用的"是否同网段"在没有前缀长度策略前留 NULL（开放项 M-7）
  assert.equal(params[3], null);
  await app.close();
});

test('⑨ 10 分钟内变化 > 3 次 → 置 Flapping 且只记 1 条 flapping 事件', async () => {
  // 窗口内已有 3 次变化，本次是第 4 次 → 触发（默认阈值 3）
  const { app, calls, agent } = await setUp({ ipChanged: true, recentIpChanges: 3 });
  const res = await send(app, agent);
  assert.equal(res.statusCode, 200, res.body);

  const kinds = pickCalls(calls, /INSERT INTO ip_change_events/).map((call) => call.params[6]);
  assert.deepEqual(kinds, ['change', 'flapping'], '应记 1 条 change + 1 条 flapping');
  assert.equal(pickCalls(calls, /UPDATE agents[\s\S]*SET ip_flapping/).length, 1);
  await app.close();
});

test('⑨ 已在 Flapping 态 → 不再累加 change 事件（防刷爆表）', async () => {
  const row = makeAgentRow({ ip_flapping: true });
  const { app, calls } = await setUp({ agentRow: row, ipChanged: true });
  const res = await send(app, row);

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(pickCalls(calls, /INSERT INTO ip_change_events/).length, 0);
  // 但区间表仍然推进（IP 历史不能因为 Flapping 就断档）
  const history = pickCalls(calls, /INSERT INTO agent_ip_history/);
  assert.equal(history.filter((call) => call.params[2] === 'remote').length, 1);
  await app.close();
});

test('回环来源 IP 不写 IP 历史（§5.5 过滤回环）', async () => {
  const { app, calls, agent } = await setUp({ ipChanged: true });
  const exactBody = makeReportBody();
  delete exactBody.reported_ip; // 隔离变量：本用例只看连接来源 IP 的处理
  const res = await send(app, agent, { exactBody, remoteAddress: '127.0.0.1' });

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(pickCalls(calls, /INSERT INTO agent_ip_history/).length, 0);
  assert.equal(pickCalls(calls, /INSERT INTO ip_change_events/).length, 0);
  await app.close();
});

test('IPv4-mapped IPv6（::ffff:）与私网地址都会被规范化并记入历史', async () => {
  const { app, calls, agent } = await setUp();
  const res = await send(app, agent, { remoteAddress: '::ffff:10.0.0.5' });

  assert.equal(res.statusCode, 200, res.body);
  const history = pickCalls(calls, /INSERT INTO agent_ip_history/);
  // 归一成 IPv4 文本（否则同一条链路会在"映射写法/裸写法"之间反复判成 IP 变化）
  assert.equal(history[0].params[1], '10.0.0.5');
  await app.close();
});

// -----------------------------------------------------------------------------
// 首次上报的有状态约束（schema 表达不了）
// -----------------------------------------------------------------------------

test('首次上报（库内无 host_info）未带 host → 400 invalid_request', async () => {
  const row = makeAgentRow({ host_info: null, capabilities: null });
  const { app } = await setUp({ agentRow: row });
  const exactBody = makeReportBody();
  delete exactBody.host;
  const res = await send(app, row, { exactBody });

  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'invalid_request');
  assert.equal(res.json().error.details.field, 'host');
  await app.close();
});

test('首次上报带了 host 但没带 capabilities → 400 invalid_request（✅ 决策 #55）', async () => {
  const row = makeAgentRow({ host_info: null, capabilities: null });
  const { app } = await setUp({ agentRow: row });
  const exactBody = makeReportBody();
  delete exactBody.host.capabilities;
  const res = await send(app, row, { exactBody });

  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, 'invalid_request');
  assert.equal(res.json().error.details.field, 'host.capabilities');
  await app.close();
});

test('非首次上报（库内已有 host_info）可以省略 host（§2.1：其余可省）', async () => {
  const { app, agent } = await setUp();
  const exactBody = makeReportBody();
  delete exactBody.host;
  const res = await send(app, agent, { exactBody });

  assert.equal(res.statusCode, 200, res.body);
  await app.close();
});

test('能力声明出现白名单外的键 → 400 schema_invalid', async () => {
  const { app, agent } = await setUp();
  const body = makeReportBody();
  body.host.capabilities = { docker: true, 'rootkit.mode': true };
  const res = await send(app, agent, { body });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  await app.close();
});

// -----------------------------------------------------------------------------
// 心跳（§2.2）
// -----------------------------------------------------------------------------

test('心跳：只更新心跳字段，⛔ 不写任何时序数据（与 report 共用限流桶与幂等语义）', async () => {
  const { app, calls, agent } = await setUp();
  const exactBody = { agent_id: TEST_AGENT_ID, batch_id: newBatchId(), ts: Date.now(), seq: 7 };
  const res = await send(app, agent, { exactBody, url: '/api/v1/agent/heartbeat' });

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(Object.keys(res.json()).sort(), ['ok', 'server_ts']);
  assert.equal(pickCalls(calls, /UPDATE agents[\s\S]*last_seen_at/).length, 1);
  assert.equal(pickCalls(calls, /INSERT INTO metrics_raw/).length, 0);
  assert.equal(pickCalls(calls, /INSERT INTO probe_results/).length, 0);
  assert.equal(pickCalls(calls, /INSERT INTO process_snapshots/).length, 0);
  await app.close();
});

test('心跳：不带 host 也不算"缺字段"（§2.2 报文里本来就没有 host）', async () => {
  const row = makeAgentRow({ host_info: null, capabilities: null });
  const { app } = await setUp({ agentRow: row });
  const exactBody = { agent_id: TEST_AGENT_ID, batch_id: newBatchId(), ts: Date.now() };
  const res = await send(app, row, { exactBody, url: '/api/v1/agent/heartbeat' });

  assert.equal(res.statusCode, 200, res.body);
  await app.close();
});

test('心跳：多带 metrics 字段 → 400 schema_invalid（两套报文不混用）', async () => {
  const { app, agent } = await setUp();
  const exactBody = { agent_id: TEST_AGENT_ID, batch_id: newBatchId(), ts: Date.now(), metrics: {} };
  const res = await send(app, agent, { exactBody, url: '/api/v1/agent/heartbeat' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
  await app.close();
});

// -----------------------------------------------------------------------------
// 限流
// -----------------------------------------------------------------------------

test('限流：超过阈值 → 429 + Retry-After + X-RateLimit-* 响应头（上报与心跳共用桶）', async () => {
  const { app, agent } = await setUp({ env: { RATELIMIT_AGENT_PER_MINUTE: '2' } });

  const first = await send(app, agent);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-ratelimit-limit'], '2');
  assert.equal(first.headers['x-ratelimit-remaining'], '1');

  const second = await send(app, agent);
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers['x-ratelimit-remaining'], '0');

  const third = await send(app, agent);
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().error.code, 'rate_limited');
  assert.equal(third.headers['retry-after'], '60');
  assert.ok(Number(third.headers['x-ratelimit-reset']) > Math.floor(Date.now() / 1000));

  // 桶共用：心跳也吃这个额度（⚠️ 心跳报文是极简的，不能借用 report 的默认体）
  const heartbeat = await send(app, agent, {
    exactBody: { agent_id: TEST_AGENT_ID, batch_id: newBatchId(), ts: Date.now() },
    url: '/api/v1/agent/heartbeat',
  });
  assert.equal(heartbeat.statusCode, 429);
  await app.close();
});

test('限流窗口**不会**被每次请求续期（Ttl 只在计数为 1 时设置）', async () => {
  const { app, redis, agent } = await setUp({ env: { RATELIMIT_AGENT_PER_MINUTE: '10' } });
  const key = `ratelimit:agent:${TEST_AGENT_ID}`;

  await send(app, agent);
  const ttlAfterFirst = await redis.ttl(key);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await send(app, agent);
  const ttlAfterSecond = await redis.ttl(key);

  assert.ok(ttlAfterSecond < ttlAfterFirst, `TTL 不应被续期（${ttlAfterFirst} → ${ttlAfterSecond}）`);
  await app.close();
});

// -----------------------------------------------------------------------------
// 事务失败 → 占位释放（可重试性）
// -----------------------------------------------------------------------------

test('写库失败 → 批次与 nonce 占位都被撤掉，Agent 用**同一份签名**可原样重试成功', async () => {
  const { app, state, redis, agent } = await setUp();
  const request = buildSignedRequest({ agent, body: makeReportBody() });

  state.failMetricsInsert = true;
  const failed = await app.inject({ ...request, remoteAddress: REMOTE_ADDR });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().error.code, 'upstream_unavailable');
  assert.equal(state.rolledBack, 1);

  const batchId = JSON.parse(request.rawBody.toString('utf8')).batch_id;
  assert.equal(redis.has(`batch:${batchId}`), false, 'batch 占位必须被释放');
  assert.equal(redis.keys().some((key) => key.startsWith('nonce:')), false, 'nonce 占位必须被释放');

  state.failMetricsInsert = false;
  const retried = await app.inject({ ...request, remoteAddress: REMOTE_ADDR });
  assert.equal(retried.statusCode, 200, retried.body);
  await app.close();
});

// -----------------------------------------------------------------------------
// 扇出
// -----------------------------------------------------------------------------

test('落库后 PUBLISH live:metrics（形状与 docs/api.md §5.2 的 delta 一致）', async () => {
  // 用一台"从未上报过"的 Agent：只有 offline/首次 → online 才值得广播 status，避免每批都发
  const { app, redis, agent } = await setUp({ agentRow: makeAgentRow({ status: 'offline' }) });
  const res = await send(app, agent);
  assert.equal(res.statusCode, 200);

  const metricsDeltas = redis.published.filter((item) => JSON.parse(item.payload).channel === 'metrics');
  assert.equal(metricsDeltas.length, 1);
  const delta = JSON.parse(metricsDeltas[0].payload);
  assert.equal(metricsDeltas[0].channel, 'live:metrics');
  assert.equal(delta.type, 'delta');
  assert.equal(delta.agent_id, TEST_AGENT_ID);
  assert.equal(delta.ts, res.json().server_ts);
  assert.equal(delta.metrics['cpu.usage'], 12.5);
  assert.equal(delta.metrics['disk.used_pct{device=sda1,mount=/}'], 50);

  // 探活与状态各一条
  assert.equal(redis.published.filter((item) => JSON.parse(item.payload).channel === 'probes').length, 1);
  assert.equal(redis.published.filter((item) => JSON.parse(item.payload).channel === 'status').length, 1);
  await app.close();
});

test('已在线的 Agent 不再重复广播 status delta（避免纯噪声）', async () => {
  const { app, redis, agent } = await setUp(); // 默认 agentRow.status = 'online'
  await send(app, agent);

  assert.equal(redis.published.filter((item) => JSON.parse(item.payload).channel === 'status').length, 0);
  await app.close();
});

test('幂等命中时不再扇出（避免面板收到重复增量）', async () => {
  const { app, redis, agent } = await setUp();
  const batchId = newBatchId();

  await send(app, agent, { body: { batch_id: batchId } });
  const afterFirst = redis.published.length;
  await send(app, agent, { body: { batch_id: batchId } });

  assert.equal(redis.published.length, afterFirst);
  await app.close();
});
