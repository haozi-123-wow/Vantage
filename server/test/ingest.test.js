/**
 * 批次生命周期（幂等 + 防重放 + 失败释放）与落库语句形状的单元测试
 *
 * 依据：docs/database.md §6.1（Redis SETNX 占位 + 事务边界）、§7（键空间与 TTL）、
 *      决策 #18（幂等 10min）、#36（nonce TTL ≥ 签名窗口）
 *
 * 路由级测试（test/report.test.js）已经从外部覆盖了这些行为，这里补的是**直接**覆盖：
 *  - release() 必须幂等，且**不能**误删别人的占位；
 *  - 空批次（没有指标 / 没有探活）不得产生任何 SQL（省一次往返、也避免空 INSERT 报错）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config/index.js';
import { beginBatch } from '../src/services/ingest.service.js';
import { storeMetrics, storeProcessSnapshot } from '../src/services/metrics.service.js';
import { storeProbes } from '../src/services/probe.service.js';
import { TTL_S, keys } from '../src/utils/redisKeys.js';
import { createFakeRedis } from './helpers/fake-redis.js';
import { createFakeDb } from './helpers/fake-pg.js';
import { TEST_AGENT_ID } from './helpers/agent-client.js';

const CONFIG = loadConfig(
  {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  },
  { skipEnvFile: true },
);

const BATCH = '01M3EK0XDYRKR6TCTWA8ST4A1J';
const NONCE = 'a'.repeat(32);
const AGENT = { id: TEST_AGENT_ID };

test('首次占位成功 → duplicate=false，两个键都带正确 TTL', async () => {
  const redis = createFakeRedis();
  const batch = await beginBatch({ redis, config: CONFIG, agent: AGENT, batchId: BATCH, nonce: NONCE });

  assert.equal(batch.duplicate, false);
  assert.equal(await redis.ttl(keys.batch(BATCH)), TTL_S.batch);
  assert.equal(await redis.ttl(keys.nonce(TEST_AGENT_ID, NONCE)), CONFIG.security.nonceTtlS);
  // nonce TTL 必须 ≥ 签名窗口，否则 120–300s 之间会存在重放窗口（✅ 决策 #36）
  assert.ok(CONFIG.security.nonceTtlS >= CONFIG.security.signatureWindowS);
});

test('同 batch_id 再来一次 → duplicate=true，且不得动 nonce（复用别人的 nonce 不该被误判）', async () => {
  const redis = createFakeRedis();
  await beginBatch({ redis, config: CONFIG, agent: AGENT, batchId: BATCH, nonce: NONCE });
  const second = await beginBatch({
    redis,
    config: CONFIG,
    agent: AGENT,
    batchId: BATCH,
    nonce: 'b'.repeat(32),
  });

  assert.equal(second.duplicate, true);
  // 幂等命中时 release 必须是 no-op：否则会把**第一次**那批的占位删掉，幂等直接失效
  await second.release();
  assert.equal(redis.has(keys.batch(BATCH)), true);
  assert.equal(redis.has(keys.nonce(TEST_AGENT_ID, NONCE)), true);
});

test('同 nonce + 不同 batch → 409 nonce_reused，且刚占的 batch 键被撤掉', async () => {
  const redis = createFakeRedis();
  await beginBatch({ redis, config: CONFIG, agent: AGENT, batchId: BATCH, nonce: NONCE });

  const OTHER_BATCH = '01M3EK0XDYRKR6TCTWA8ST4A1K';
  await assert.rejects(
    beginBatch({ redis, config: CONFIG, agent: AGENT, batchId: OTHER_BATCH, nonce: NONCE }),
    (err) => err.code === 'nonce_reused' && err.statusCode === 409,
  );
  assert.equal(redis.has(keys.batch(OTHER_BATCH)), false, '被拒的批次不能把占位留住');
});

test('nonce 是**按 Agent** 隔离的：不同 Agent 用同一个 nonce 互不影响', async () => {
  const redis = createFakeRedis();
  const other = { id: '99999999-8888-4777-8666-555555555555' };

  await beginBatch({ redis, config: CONFIG, agent: AGENT, batchId: BATCH, nonce: NONCE });
  const second = await beginBatch({ redis, config: CONFIG, agent: other, batchId: BATCH, nonce: NONCE });
  // ⚠️ batch 键是全局的（ULID 全局唯一），所以第二次仍是幂等命中 —— 这是有意的：
  //    batch_id 是 Agent 自己生成的全局唯一值，跨 Agent 撞车说明生成器坏了，宁可漏写也不要重写
  assert.equal(second.duplicate, true);
  assert.equal(redis.has(keys.nonce(other.id, NONCE)), false);
});

test('release() 幂等：连调两次只删一次，且不影响其它键', async () => {
  const redis = createFakeRedis();
  const batch = await beginBatch({ redis, config: CONFIG, agent: AGENT, batchId: BATCH, nonce: NONCE });
  redis.seed('nonce:someone-else:x', '1');

  await batch.release();
  await batch.release();

  assert.equal(redis.has(keys.batch(BATCH)), false);
  assert.equal(redis.has(keys.nonce(TEST_AGENT_ID, NONCE)), false);
  assert.equal(redis.has('nonce:someone-else:x'), true, '不得误删其它键');
});

test('空批次不产生任何 SQL（没有指标 / 没有探活 / 没有进程块）', async () => {
  const fake = createFakeDb();
  const client = await fake.pool.connect();

  assert.equal(await storeMetrics(client, { agentId: TEST_AGENT_ID, serverTs: new Date(), series: [] }), 0);
  assert.equal(await storeProbes(client, { agentId: TEST_AGENT_ID, serverTs: new Date(), probes: [] }), 0);
  assert.equal(
    fake.calls.filter((call) => call.sql && /INSERT/i.test(call.sql)).length,
    0,
    '空批次不得发起 INSERT',
  );
});

test('metrics_raw 落库语句：参数个数恒定（5 个），与批内序列数无关', async () => {
  const fake = createFakeDb();
  const client = await fake.pool.connect();
  const serverTs = new Date('2026-09-26T10:00:00.000Z');

  const one = await storeMetrics(client, {
    agentId: TEST_AGENT_ID,
    serverTs,
    series: [{ metric: 'cpu.usage', value: 1, labels: {} }],
  });
  const many = await storeMetrics(client, {
    agentId: TEST_AGENT_ID,
    serverTs,
    series: Array.from({ length: 500 }, (_, i) => ({ metric: `x.y${i}`, value: i, labels: { i: String(i) } })),
  });

  assert.equal(one, 1);
  assert.equal(many, 500);

  const calls = fake.calls.filter((call) => /INSERT INTO metrics_raw/.test(call.sql));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    // ⛔ 参数个数恒定，否则最坏批次（256 核 + 64 盘 + 64 网卡 + 16 GPU ≈ 1400 序列）
    //    会撞上 PostgreSQL 的 65535 参数上限
    assert.equal(call.params.length, 5);
    assert.equal(call.params[2].length, call.params[3].length);
    assert.equal(call.params[2].length, call.params[4].length);
  }
  // 断言用的是 unnest 而不是拼值
  assert.match(calls[0].sql, /unnest\(\$3::text\[\], \$4::float8\[\], \$5::text\[\]\)/);
});

test('process_snapshots 与 probe_results 的参数形状正确（latency/status/error 允许 NULL）', async () => {
  const fake = createFakeDb();
  const client = await fake.pool.connect();

  const id = await storeProcessSnapshot(client, {
    agentId: TEST_AGENT_ID,
    serverTs: new Date(),
    process: { count: 3, top: [{ pid: 1, name: 'init' }] },
  });
  assert.equal(id, 7);
  const snapshotCall = fake.calls.find((call) => /INSERT INTO process_snapshots/.test(call.sql));
  assert.equal(snapshotCall.params[2], 3);
  assert.equal(snapshotCall.params[3], JSON.stringify([{ pid: 1, name: 'init' }]));

  const rows = await storeProbes(client, {
    agentId: TEST_AGENT_ID,
    serverTs: new Date(),
    probes: [
      { name: 'a', type: 'ping', target: '1.1.1.1', up: true, latency_ms: 3.2 },
      { name: 'b', type: 'tcp', target: '1.1.1.1:80', up: false, error: 'timeout' },
    ],
  });
  assert.equal(rows, 2);
  const probeCall = fake.calls.find((call) => /INSERT INTO probe_results/.test(call.sql));
  // 9 个参数：agent, ts + 7 个数组
  assert.equal(probeCall.params.length, 9);
  assert.deepEqual(probeCall.params[6], [3.2, null], '缺失的 latency_ms 落 NULL');
  assert.deepEqual(probeCall.params[7], [null, null], 'ping 没有 status_code');
  assert.deepEqual(probeCall.params[8], [null, 'timeout']);
  // detail 一律 NULL：§2.1 的 probes[] 里没有该字段，不引入"Agent 自定义结构"
  assert.match(probeCall.sql, /NULL, \$2::timestamptz/);
});

test('插入语句的 ON CONFLICT 语义：metrics 覆盖、IP 区间推进（都不是 DO NOTHING）', async () => {
  const fake = createFakeDb();
  const client = await fake.pool.connect();

  await storeMetrics(client, {
    agentId: TEST_AGENT_ID,
    serverTs: new Date(),
    series: [{ metric: 'cpu.usage', value: 1, labels: {} }],
  });
  const { upsertIpHistory } = await import('../src/repositories/ipTrack.repo.js');
  await upsertIpHistory(client, { agentId: TEST_AGENT_ID, ip: '203.0.113.9', source: 'remote', at: new Date() });

  const metricsSql = fake.calls.find((call) => /INSERT INTO metrics_raw/.test(call.sql)).sql;
  // ⛔ DO NOTHING 会让"同一毫秒的两个批次"静默丢数据；DO UPDATE 让它变成幂等覆盖
  assert.match(metricsSql, /ON CONFLICT \(agent_id, metric, ts\)\s+DO UPDATE/);
  assert.equal(metricsSql.includes('DO NOTHING'), false);

  const ipSql = fake.calls.find((call) => /INSERT INTO agent_ip_history/.test(call.sql)).sql;
  assert.match(ipSql, /ON CONFLICT \(agent_id, ip, source\)/);
  assert.match(ipSql, /GREATEST\(agent_ip_history\.last_seen, EXCLUDED\.last_seen\)/);
  assert.equal(ipSql.includes('DO NOTHING'), false);
});
