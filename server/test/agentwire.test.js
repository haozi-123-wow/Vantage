/**
 * Agent 线上报文 × 中心契约（跨语言契约测试）
 *
 * 依据：docs/api.md §2.1/§2.2、docs/agent.md §5、docs/database.md §5.7.2、`docs/design-deltas.md`
 *
 * 被测对象是 **Go Agent 真实产出的字节**：`agent/testdata/wire/*.json` 由
 * `agent/internal/model/wire_test.go` 生成并逐字节比对。这里把它们送进**真实的**链路 ——
 * gzip → HMAC 签名 → 路由 schema 校验 → 摊平成序列 → 落库参数，与真机上报完全同一条路。
 *
 * ⛔ 为什么这个文件是必要的：
 *   1. 中心 schema 的每个 object 都是 `additionalProperties: false`，Agent 侧字段漂移不是
 *      「被忽略」而是当场 400；
 *   2. 此前所有用例的报文都由测试自己手搓（`makeReportBody`）——那**证明不了 Agent 产出的
 *      字节能被中心接受**。这正是「两端各自都对、拼在一起不通」最容易漏掉的一类缺陷；
 *   3. 报文里 `boot_time` 的口径、`metrics.agent` 的键集合、`agent.reload_ok` 的布尔→1/0
 *      这类约定，只有跨语言跑一遍才算真的钉住。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/utils/log.js';
import { pickCalls, createFakeDb } from './helpers/fake-pg.js';
import { createFakeRedis } from './helpers/fake-redis.js';
import {
  TEST_SECRET_KEY,
  buildSignedRequest,
  makeAgentRow,
  makeReportBody,
} from './helpers/agent-client.js';

/** 黄金样本目录：Go 侧生成，放在仓库根的 contracts/（见 contracts/README.md） */
const WIRE_DIR = new URL('../../contracts/wire/', import.meta.url);

/** 样本里写死的 agent_id（生成时固定，否则样本每次都不一样） */
const FIXTURE_AGENT_ID = '11111111-2222-3333-4444-555555555555';

/** 连接来源 IP 与样本里的 reported_ip 保持一致，避免顺带触发 IP 变化事件 */
const REMOTE_ADDR = '203.0.113.7';

function readWire(name) {
  return readFileSync(new URL(name, WIRE_DIR), 'utf8').trim();
}

/**
 * 把样本里写死的 `ts` 换成当前时间。
 *
 * 样本的 ts 是固定值（2025-09-25），直接发会额外产生一条巨大的 clock_drift 信号；
 * 头部 X-Timestamp 由签名助手取当前时间，所以鉴权本身不受影响。
 * 断言「只改了 ts 这一处」，保证其余字节与 Go 产出的黄金样本完全一致。
 */
function restampTs(raw) {
  const matches = raw.match(/"ts":\d+/g) ?? [];
  assert.equal(matches.length, 1, `样本里应恰好有一处 "ts":…，实际 ${matches.length} 处：${raw.slice(0, 120)}`);
  const stamped = raw.replace(/"ts":\d+/, `"ts":${Date.now()}`);
  assert.equal(stamped.replace(/"ts":\d+/, matches[0]), raw, 're-stamp 必须只改动 ts 一处');
  return stamped;
}

async function setUp() {
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
      SECRET_KEY: TEST_SECRET_KEY.toString('base64'),
    },
    { skipEnvFile: true },
  );

  const agent = makeAgentRow({ id: FIXTURE_AGENT_ID });
  const fake = createFakeDb({ agentRow: agent });
  const redis = createFakeRedis();

  const app = await buildApp({
    config,
    logger: createLogger({ level: 'silent' }),
    db: { app: fake.pool, migrator: null },
    redis,
  });

  return { app, agent, calls: fake.calls, state: fake.state };
}

/** 用**样本自己的字节**签名并发出去（⛔ 不重新序列化，否则测的就不是样本了） */
function sendRaw(app, agent, { raw, url = '/api/v1/agent/report' }) {
  const req = buildSignedRequest({
    agent,
    body: JSON.parse(raw),
    rawBodyJson: raw,
    url,
  });
  return app.inject({ ...req, remoteAddress: REMOTE_ADDR });
}

/** 用测试自己构造的报文发（用于反例：改一个字段就必须被拒） */
function sendBody(app, agent, body, url = '/api/v1/agent/report') {
  const req = buildSignedRequest({ agent, body, url });
  return app.inject({ ...req, remoteAddress: REMOTE_ADDR });
}

// -----------------------------------------------------------------------------
// 1 —— 完整样本：真链路必须 200，且每个序列都按契约摊平
// -----------------------------------------------------------------------------

test('Go Agent 的完整报文样本 → 200，且全部序列按 §5.7.2 摊平', async () => {
  const { app, agent, calls, state } = await setUp();
  const raw = restampTs(readWire('report-full.json'));

  const res = await sendRaw(app, agent, { raw });
  assert.equal(res.statusCode, 200, `中心拒绝了 Agent 的样本：${res.body}`);

  // 响应体必须极简（✅ 决策 #12：中心零命令面）
  assert.deepEqual(Object.keys(res.json()).sort(), ['ok', 'server_ts']);

  const metricsCall = pickCalls(calls, /INSERT INTO metrics_raw/)[0];
  assert.ok(metricsCall, '样本没有被落成时序数据');
  const [, , names, values, labels] = metricsCall.params;
  assert.equal(names.length, values.length);
  assert.equal(names.length, labels.length);

  const valueOf = (name) => values[names.indexOf(name)];
  const expect = (name) => assert.ok(names.includes(name), `缺少序列 ${name}（实际有：${names.join(', ')}）`);

  // --- CPU（每核是**维度**，不是基名里的点号段）------------------------------
  expect('cpu.usage');
  expect('cpu.core.usage{core=0}');
  expect('cpu.core.usage{core=3}');
  expect('cpu.load1');
  expect('cpu.load5');
  expect('cpu.load15');
  expect('cpu.ctx_switch');
  assert.equal(valueOf('cpu.usage'), 12.5);
  assert.equal(valueOf('cpu.core.usage{core=2}'), 0); // 采到了 0 与「没采到」必须能区分
  assert.equal(valueOf('cpu.load15'), 0.31);

  // --- 内存与 Swap（报文是 mem.swap.*，指标名是顶层 swap.*）-------------------
  expect('mem.total');
  expect('mem.used');
  expect('mem.available');
  expect('mem.cached');
  expect('mem.buffers');
  expect('mem.used_pct'); // 中心派生，⛔ Agent 不报
  expect('swap.total');
  expect('swap.used');
  expect('swap.used_pct');
  assert.equal(valueOf('swap.used_pct'), 0, 'swap.used=0 必须落成 0，而不是缺一个点');
  const memPct = (8123456789 / 16777216000) * 100;
  assert.ok(Math.abs(valueOf('mem.used_pct') - memPct) < 1e-4, `mem.used_pct=${valueOf('mem.used_pct')}`);

  // --- 磁盘（维度写进名字，字母序 device 在前）--------------------------------
  const disk = '{device=nvme0n1p2,mount=/}';
  for (const base of ['disk.total', 'disk.used', 'disk.used_pct', 'disk.inode_used_pct',
    'disk.read_bps', 'disk.write_bps', 'disk.read_iops', 'disk.write_iops', 'disk.latency_ms']) {
    expect(`${base}${disk}`);
  }
  assert.equal(valueOf(`disk.used_pct${disk}`), 50, 'used=total/2 → 50%');
  assert.equal(valueOf(`disk.inode_used_pct${disk}`), 12.5, 'inode_used 是**百分比**，不是数量');
  assert.equal(valueOf(`disk.latency_ms${disk}`), 1.25);

  // --- 网卡 / GPU / 进程 ------------------------------------------------------
  for (const base of ['net.rx_bps', 'net.tx_bps', 'net.rx_total', 'net.tx_total', 'net.conn_count', 'net.err', 'net.drop']) {
    expect(`${base}{device=eth0}`);
  }
  assert.equal(valueOf('net.err{device=eth0}'), 0, 'net.err=0 必须落成 0');
  for (const base of ['gpu.util', 'gpu.mem_used', 'gpu.mem_total', 'gpu.temp', 'gpu.power']) {
    expect(`${base}{index=0}`);
  }
  expect('process.count');
  assert.equal(valueOf('process.count'), 231);

  // --- Agent 自监控（✅ G10）：布尔必须转成 1/0，否则时序层无法承载 -------------
  expect('agent.mem_rss');
  expect('agent.report_failures');
  expect('agent.reload_ok');
  assert.equal(valueOf('agent.reload_ok'), 1);
  assert.equal(valueOf('agent.report_failures'), 0);

  // --- Top-N 走 process_snapshots，⛔ 不进时序 ---------------------------------
  assert.equal(names.some((n) => n.includes('process.top')), false);
  assert.equal(pickCalls(calls, /INSERT INTO process_snapshots/).length, 1);

  // --- 探活 ---------------------------------------------------------------
  assert.equal(pickCalls(calls, /INSERT INTO probe_results/).length, 1);

  // --- labels 是由全名反解的便利副本，必须与全名一致 --------------------------
  // ⚠️ 落库参数里的 labels 是 JSON **字符串**（jsonb 列），不是对象
  const labelsOf = (name) => JSON.parse(labels[names.indexOf(name)]);
  assert.deepEqual(labelsOf(`disk.used_pct${disk}`), { device: 'nvme0n1p2', mount: '/' });

  assert.equal(state.rolledBack, 0);
  assert.equal(state.committed, 1);
});

// -----------------------------------------------------------------------------
// 2 —— 最小样本：只有中心要求的必填项也必须能被接受
// -----------------------------------------------------------------------------

test('Go Agent 的最小报文样本 → 200，且只产出两个序列', async () => {
  const { app, agent, calls } = await setUp();
  const res = await sendRaw(app, agent, { raw: restampTs(readWire('report-minimal.json')) });

  assert.equal(res.statusCode, 200, `最小样本被拒：${res.body}`);

  const [, , names] = pickCalls(calls, /INSERT INTO metrics_raw/)[0].params;
  assert.deepEqual(
    [...names].sort(),
    ['cpu.usage', 'mem.total'],
    '最小样本只应有 cpu.usage 与 mem.total；mem.used 缺失时不得凭空派生 mem.used_pct',
  );
});

// -----------------------------------------------------------------------------
// 3 —— 心跳样本
// -----------------------------------------------------------------------------

test('Go Agent 的心跳样本 → 200，且不写任何时序数据', async () => {
  const { app, agent, calls } = await setUp();
  const res = await sendRaw(app, agent, {
    raw: restampTs(readWire('heartbeat.json')),
    url: '/api/v1/agent/heartbeat',
  });

  assert.equal(res.statusCode, 200, `心跳样本被拒：${res.body}`);
  assert.deepEqual(Object.keys(res.json()).sort(), ['ok', 'server_ts']);
  assert.equal(pickCalls(calls, /INSERT INTO metrics_raw/).length, 0);
  assert.equal(pickCalls(calls, /INSERT INTO probe_results/).length, 0);
  assert.equal(pickCalls(calls, /INSERT INTO process_snapshots/).length, 0);
});

// -----------------------------------------------------------------------------
// 4/5/6 —— 反例：契约收窄的地方，必须真的会 400
// -----------------------------------------------------------------------------

test('✅ M-5 已收窄：boot_time 传字符串 → 400（口径锁定为整数 unix 秒）', async () => {
  const { app, agent } = await setUp();
  const body = makeReportBody({
    agent_id: FIXTURE_AGENT_ID,
    host: { hostname: 'h', os: 'linux', kernel: '6.8.0', boot_time: '2025-09-25T00:00:00Z' },
  });

  const res = await sendBody(app, agent, body);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
});

test('metrics.agent 里出现白名单外的键 → 400（⛔ 不静默忽略）', async () => {
  const { app, agent } = await setUp();
  const body = makeReportBody({
    agent_id: FIXTURE_AGENT_ID,
    metrics: {
      cpu: { usage: 1 },
      mem: { total: 1024 },
      agent: { mem_rss: 1024, unknown_self_metric: 1 },
    },
  });

  const res = await sendBody(app, agent, body);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'schema_invalid');
});

test('metrics.agent 的自监控三项合法取值 → 200（含 reload_ok=false 转 0）', async () => {
  const { app, agent, calls } = await setUp();
  const body = makeReportBody({
    agent_id: FIXTURE_AGENT_ID,
    metrics: {
      cpu: { usage: 1 },
      mem: { total: 1024 },
      agent: { mem_rss: 18874368, report_failures: 3, reload_ok: false },
    },
  });

  const res = await sendBody(app, agent, body);
  assert.equal(res.statusCode, 200, res.body);

  const [, , names, values] = pickCalls(calls, /INSERT INTO metrics_raw/)[0].params;
  const valueOf = (name) => values[names.indexOf(name)];
  assert.equal(valueOf('agent.reload_ok'), 0, 'reload_ok=false 必须落成 0，不是省略');
  assert.equal(valueOf('agent.report_failures'), 3);
  assert.equal(valueOf('agent.mem_rss'), 18874368);
});
