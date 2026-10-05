/**
 * WebSocket 订阅中心 + 扇出的**纯单测**（不碰 PG、不碰 socket、不碰真 Redis）
 *
 * 依据：docs/api.md §5（✅ 2026-10-05 定稿）的频道/订阅/消息类型表
 *
 * 这一层存在的意义就是"能这样测"：`app.inject()` 测不了 WebSocket，
 * 于是把"该发给谁"从路由里抽出来，让渠道白名单、agent 过滤、坏连接不拖垮广播
 * 这些判断全部落在纯函数级的断言上（`server/test/ws.api.test.js` 只留握手与端到端）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError } from '../src/utils/errors.js';
import { createLogger } from '../src/utils/log.js';
import { CHANNEL } from '../src/utils/redisKeys.js';
import { createWsFanout } from '../src/ws/fanout.js';
import {
  WS_CHANNELS,
  WS_PUBLIC_CHANNELS,
  WsProtocolError,
  createWsHub,
  defaultChannelsFor,
} from '../src/ws/hub.js';

const SILENT = createLogger({ level: 'silent' });

/** 造一个假连接（`send` 只收集文本，`close` 只记录参数） */
function fakeConnection(kind = 'live', ip = '10.0.0.1') {
  const sent = [];
  const closes = [];
  return {
    sent,
    closes,
    input: {
      kind,
      ip,
      send: (text) => sent.push(text),
      close: (code, reason) => closes.push({ code, reason }),
    },
  };
}

function addFake(hub, kind = 'live', ip = '10.0.0.1') {
  const connection = fakeConnection(kind, ip);
  const client = hub.add(connection.input);
  // 生产里由 `sendSnapshot()` 在快照发出**之后**调用；这里默认就绪，好让广播类断言直击过滤逻辑
  hub.activate(client);
  return { client, sent: connection.sent, closes: connection.closes };
}

const delta = (channel, agentId = null, extra = {}) =>
  JSON.stringify({ type: 'delta', ts: 1758800015000, channel, agent_id: agentId, ...extra });

// -----------------------------------------------------------------------------
// 频道白名单
// -----------------------------------------------------------------------------

test('频道白名单：面板 4 个、公开连接只有 status（⛔ 公开侧拿不到带维度全名的 delta）', () => {
  assert.deepEqual([...WS_CHANNELS], ['metrics', 'status', 'probes', 'alerts']);
  assert.deepEqual([...WS_PUBLIC_CHANNELS], ['status']);
  assert.deepEqual(defaultChannelsFor('live'), ['metrics', 'status', 'probes', 'alerts']);
  assert.deepEqual(defaultChannelsFor('public'), ['status']);
  // ⛔ `hosts` 不是增量频道（主机是管理员建的，不会因上报而"冒出来"）—— 它属于快照
  assert.ok(!WS_CHANNELS.includes('hosts'), 'hosts 不该出现在增量频道里');
});

// -----------------------------------------------------------------------------
// 订阅
// -----------------------------------------------------------------------------

test('subscribe：缺省 / 空数组都按"全部"处理（沿用本项目 `?q=` 空值=未提供 的口径）', () => {
  const hub = createWsHub({ logger: SILENT });
  const { client } = addFake(hub);

  assert.deepEqual(hub.subscribe(client, {}).channels.sort(), ['alerts', 'metrics', 'probes', 'status']);
  assert.deepEqual(hub.subscribe(client, { channels: [] }).channels.sort(), ['alerts', 'metrics', 'probes', 'status']);
  assert.deepEqual(hub.subscribe(client, { channels: ['metrics'] }).channels, ['metrics']);
  // 订阅是**整体替换**，不是叠加
  assert.deepEqual(hub.subscribe(client, { channels: ['probes'] }).channels, ['probes']);
});

test('subscribe：未知频道 → WsProtocolError（含白名单），让调用方去关连接 1008', () => {
  const hub = createWsHub({ logger: SILENT });
  const { client } = addFake(hub);

  assert.throws(
    () => hub.subscribe(client, { channels: ['metric'] }), // 少一个 s
    (err) => {
      assert.ok(err instanceof WsProtocolError);
      assert.deepEqual(err.details.allowed, ['metrics', 'status', 'probes', 'alerts']);
      return true;
    },
  );
  assert.throws(() => hub.subscribe(client, { channels: 'metrics' }), WsProtocolError);
  assert.throws(() => hub.subscribe(client, { channels: ['hosts'] }), WsProtocolError);
});

test('subscribe：公开连接⛔ 不能订 metrics/probes/alerts（泄露设备名的那条路必须堵死）', () => {
  const hub = createWsHub({ logger: SILENT });
  const { client } = addFake(hub, 'public');

  assert.deepEqual(hub.subscribe(client, { channels: ['status'] }).channels, ['status']);
  for (const channel of ['metrics', 'probes', 'alerts']) {
    assert.throws(
      () => hub.subscribe(client, { channels: [channel] }),
      (err) => err instanceof WsProtocolError && err.details.allowed === undefined
        ? false
        : err instanceof WsProtocolError,
      `公开连接不该能订 ${channel}`,
    );
  }
  // `allowed` 里必须只有 status —— 前端据此知道公开侧只有这一个频道
  try {
    hub.subscribe(client, { channels: ['metrics'] });
  } catch (err) {
    assert.deepEqual(err.details.allowed, ['status']);
  }
});

test('subscribe：agents 过滤 —— `["*"]` 与空数组都等于"不过滤"（null），具体 id 必须是 UUID', () => {
  const hub = createWsHub({ logger: SILENT });
  const { client } = addFake(hub);
  const uuid = '11111111-2222-3333-4444-555555555555';

  assert.equal(hub.subscribe(client, { agents: ['*'] }).agents, null);
  assert.equal(hub.subscribe(client, { agents: [] }).agents, null);
  assert.deepEqual(hub.subscribe(client, { agents: [uuid] }).agents, [uuid]);
  assert.throws(() => hub.subscribe(client, { agents: ['not-a-uuid'] }), WsProtocolError);
  assert.throws(() => hub.subscribe(client, { agents: 'x' }), WsProtocolError);
  assert.throws(
    () => hub.subscribe(client, { agents: Array.from({ length: 201 }, () => uuid) }),
    (err) => err instanceof WsProtocolError && err.details.max_items === 200,
  );
});

// -----------------------------------------------------------------------------
// 广播
// -----------------------------------------------------------------------------

test('broadcast：按频道过滤 —— 只订了 metrics 的连接收不到 status', () => {
  const hub = createWsHub({ logger: SILENT });
  const a = addFake(hub);
  const b = addFake(hub);
  hub.subscribe(a.client, { channels: ['metrics'] });
  hub.subscribe(b.client, { channels: ['status'] });

  const metrics = delta('metrics', '11111111-2222-3333-4444-555555555555');
  const result = hub.broadcast({ channel: 'metrics', agentId: '11111111-2222-3333-4444-555555555555', json: metrics });

  assert.equal(result.delivered, 1);
  assert.deepEqual(a.sent, [metrics]);
  assert.deepEqual(b.sent, []);
  assert.equal(result.skipped, 1);
});

test('broadcast：agents 过滤生效 —— 只订了某台的连接收不到别台的增量', () => {
  const hub = createWsHub({ logger: SILENT });
  const only = addFake(hub);
  const all = addFake(hub);
  const mine = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const other = '99999999-8888-7777-6666-555555555555';
  hub.subscribe(only.client, { agents: [mine] });
  hub.subscribe(all.client, { agents: ['*'] });

  hub.broadcast({ channel: 'metrics', agentId: other, json: delta('metrics', other) });
  assert.deepEqual(only.sent, []);
  assert.equal(all.sent.length, 1);

  hub.broadcast({ channel: 'metrics', agentId: mine, json: delta('metrics', mine) });
  assert.equal(only.sent.length, 1);
  assert.equal(all.sent.length, 2);
});

test('broadcast：onlyKind 生效（公开与面板两条路互不串台）', () => {
  const hub = createWsHub({ logger: SILENT });
  const live = addFake(hub, 'live');
  const pub = addFake(hub, 'public');
  hub.subscribe(pub.client, { channels: ['status'] });

  const json = delta('status', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const result = hub.broadcast({ channel: 'status', agentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', onlyKind: 'live', json });

  assert.equal(result.delivered, 1);
  assert.deepEqual(live.sent, [json]);
  assert.deepEqual(pub.sent, []);
});

test('⛔ 广播的健壮性：一条连接的 send 抛异常，不许影响其它连接（否则表现为"部分人收不到增量"）', () => {
  const hub = createWsHub({ logger: SILENT });
  const good = addFake(hub);
  const bad = hub.add({
    kind: 'live',
    ip: '10.0.0.9',
    send: () => {
      throw new Error('socket already closed');
    },
    close: () => {},
  });
  hub.activate(bad); // 未就绪的连接会在 ready 闸门处被跳过，测不到"抛异常不拖垮别人"

  const result = hub.broadcast({ channel: 'metrics', agentId: null, json: delta('metrics') });
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 1);
  assert.equal(good.sent.length, 1);
});

test('⛔ 快照还没发出去时不许收广播（"先 snapshot 后 delta"靠构造保证，不靠时序运气）', () => {
  const hub = createWsHub({ logger: SILENT });
  const connection = fakeConnection();
  const client = hub.add(connection.input); // 刻意**不** activate

  const before = hub.broadcast({ channel: 'metrics', agentId: null, json: delta('metrics') });
  assert.equal(before.delivered, 0);
  assert.equal(before.skipped, 1);
  assert.deepEqual(connection.sent, []);

  hub.activate(client);
  const after = hub.broadcast({ channel: 'metrics', agentId: null, json: delta('metrics') });
  assert.equal(after.delivered, 1);
  assert.equal(connection.sent.length, 1);
});

test('连接总数上限：到顶抛 AppError(rate_limited)，摘掉一条后能再进来', () => {
  const hub = createWsHub({ logger: SILENT, maxClients: 2 });
  const a = addFake(hub);
  addFake(hub);

  assert.throws(
    () => addFake(hub),
    (err) => err instanceof AppError && err.code === 'rate_limited' && err.details.scope === 'ws_total',
  );

  hub.remove(a.client);
  assert.equal(hub.count(), 1);
  const c = addFake(hub);
  assert.equal(hub.count(), 2);
  assert.equal(hub.stats().max_clients, 2);
  // 幂等：重复摘除不报错
  hub.remove(a.client);
  assert.equal(hub.remove('不存在的 id'), false);
  void c;
});

test('closeAll：关掉全部并清空（进程退出/测试收尾用）', () => {
  const hub = createWsHub({ logger: SILENT });
  const connection = fakeConnection();
  hub.add(connection.input);

  assert.equal(hub.closeAll(), 1);
  assert.equal(hub.count(), 0);
  assert.deepEqual(connection.closes, [{ code: 1001, reason: 'server shutting down' }]);
});

// -----------------------------------------------------------------------------
// 扇出（注入假订阅者，验证"订阅了什么"与"怎么转发"）
// -----------------------------------------------------------------------------

test('扇出：start() 只订阅 live:metrics，且把 delta **原样**转发给面板连接（⛔ 不重新编码）', async () => {
  const hub = createWsHub({ logger: SILENT });
  const { sent } = addFake(hub, 'live');

  const subscribed = [];
  const handlers = {};
  const fakeSubscriber = {
    subscribe: async (channel) => subscribed.push(channel),
    on: (event, handler) => {
      handlers[event] = handler;
    },
    unsubscribe: async () => {},
    quit: async () => {},
  };

  const fanout = createWsFanout({
    redis: {},
    hub,
    config: { security: { settingsCacheTtlS: 30 } },
    pool: {},
    logger: SILENT,
    createSubscriber: () => fakeSubscriber,
  });

  assert.equal((await fanout.start()).started, true);
  assert.deepEqual(subscribed, [CHANNEL.liveMetrics]);
  assert.equal(fanout.isStarted(), true);

  const raw = delta('metrics', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', { metrics: { 'cpu.usage': 12.4 } });
  await fanout.handleMessage(CHANNEL.liveMetrics, raw);

  // ⚠️ 逐字相等：生产者的形状已被 ingest/offline 的测试钉住，这一层再拼一遍就等于第二份实现
  assert.deepEqual(sent, [raw]);
  await fanout.stop();
  assert.equal(fanout.isStarted(), false);
});

test('扇出：非 JSON / 非 delta / 未知频道一律丢弃（⛔ 不把协议外的消息推给前端）', async () => {
  const hub = createWsHub({ logger: SILENT });
  const { sent } = addFake(hub, 'live');

  const fanout = createWsFanout({
    redis: {},
    hub,
    config: { security: { settingsCacheTtlS: 30 } },
    pool: {},
    logger: SILENT,
    createSubscriber: () => ({ subscribe: async () => {}, on: () => {}, unsubscribe: async () => {}, quit: async () => {} }),
  });

  await fanout.handleMessage(CHANNEL.liveMetrics, '这不是 JSON');
  await fanout.handleMessage(CHANNEL.liveMetrics, JSON.stringify({ type: 'snapshot', ts: 1 }));
  await fanout.handleMessage(CHANNEL.liveMetrics, JSON.stringify({ type: 'delta', channel: 'metrics2' }));
  await fanout.handleMessage('live:别的频道', delta('metrics'));

  assert.deepEqual(sent, [], '四种情况都不该有任何推送');
});

test('扇出：Redis 门面不支持 subscribe/duplicate → 只告警、不抛错（实时增量是锦上添花，REST 不受影响）', async () => {
  const hub = createWsHub({ logger: SILENT });
  const fanout = createWsFanout({
    redis: {}, // 既没有 duplicate，也没有 subscribe
    hub,
    config: { security: { settingsCacheTtlS: 30 } },
    pool: {},
    logger: SILENT,
  });

  const result = await fanout.start();
  assert.equal(result.started, false);
  assert.equal(result.reason, 'subscriber_unavailable');
  assert.equal(fanout.isStarted(), false);
  await fanout.stop(); // 没启动过也必须能安全停止
});
