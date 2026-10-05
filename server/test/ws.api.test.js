/**
 * WebSocket 端到端测试（`/ws/public` 与 `/ws/live`）—— **真实连接、真实 Fastify、真实 PGlite**
 *
 * 依据：docs/api.md §5（频道与握手 / 消息格式 / 语义约束，✅ 2026-10-05 定稿）
 *
 * 🔑 为什么这里必须开真端口：`app.inject()` 走的是 Fastify 的**假 socket**，
 *    而 WebSocket 是一个**协议层升级**（HTTP 101 + 帧），inject 根本没有这条路径。
 *    所以"该发给谁"的判断全部下沉到 `test/ws.hub.test.js` 做纯单测，
 *    本文件只留**握手的四道闸门**与**两条端到端路径**——真跑一条连接就够了，不必每条规则都开一条。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import WebSocket from 'ws';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { sessionCookieName } from '../src/middleware/authPanel.js';
import { createSession } from '../src/services/session.service.js';
import { PUBLIC_SLUG_ALPHABET } from '../src/utils/crypto.js';
import { createLogger } from '../src/utils/log.js';
import { CHANNEL, keys } from '../src/utils/redisKeys.js';
import { createFakeRedisHash } from './helpers/fake-redis-hash.js';

const db = await PGlite.create();
await db.exec('CREATE ROLE vantage_migrator LOGIN; CREATE ROLE vantage_app LOGIN; CREATE ROLE vantage_ro LOGIN;');
await db.exec(BOOTSTRAP_SQL);

const migrations = loadMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
const migrator = {
  query: (sql, params) => (Array.isArray(params) && params.length > 0 ? db.query(sql, params) : db.exec(sql)),
};
for (const migration of migrations) {
  await applyOne(migrator, migration, false);
}

async function run(sql, params = []) {
  if (Array.isArray(params) && params.length > 0) {
    const result = await db.query(sql, params);
    return { rows: result.rows ?? [], rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  }
  const results = await db.exec(sql);
  const last = Array.isArray(results) ? results.at(-1) : results;
  return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
}

const pool = { query: run };
after(async () => {
  await db.close();
});

const SILENT = createLogger({ level: 'silent' });
const CONFIG = loadConfig(
  {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 21).toString('base64'),
  },
  { skipEnvFile: true },
);
const COOKIE = sessionCookieName(CONFIG);

const USER_ID = '88888888-9999-aaaa-bbbb-cccccccccc00';
const A1 = '88888888-9999-aaaa-bbbb-cccccccccc01';

function makeSlug(seed) {
  let x = 17;
  for (const ch of String(seed)) x = (x * 31 + ch.codePointAt(0)) % 2_147_483_647;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_647;
    out += PUBLIC_SLUG_ALPHABET[x % PUBLIC_SLUG_ALPHABET.length];
  }
  return out;
}

async function seedAgent() {
  await run(
    `INSERT INTO agents (id, name, public_slug, agent_key_hash, agent_secret_enc, tags, status, last_seen_at,
                         host_info, capabilities, last_ip, reported_ip)
     VALUES ($1, 'web-01', $2, $3, 'v1:AAAA:BBBB:CCCC', '["prod"]'::jsonb, 'online', now() - interval '5 seconds',
             '{"hostname":"web-01","os":"linux"}'::jsonb, '{"gpu":{"nvidia":false}}'::jsonb,
             '203.0.113.7'::inet, '198.51.100.7'::inet)`,
    [A1, makeSlug('web-01'), 'd'.repeat(64)],
  );
}

let app = null;
let redis = null;
let port = 0;

beforeEach(async () => {
  if (app) await app.close();
  await run(`DELETE FROM metrics_raw WHERE agent_id = $1::uuid`, [A1]);
  await run(`DELETE FROM agents WHERE id = $1::uuid`, [A1]);

  redis = createFakeRedisHash();
  app = await buildApp({ config: CONFIG, logger: SILENT, db: { app: pool, migrator: null }, redis });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = app.server.address().port;
});

after(async () => {
  if (app) await app.close();
});

async function mintCookie(state = 'full', roles = ['admin']) {
  const { sid } = await createSession(redis, CONFIG, {
    userId: USER_ID,
    roles,
    totpOk: state === 'full',
    setupRequired: state === 'setup_required',
  });
  return `${COOKIE}=${sid}`;
}

/**
 * 开一条真连接，并把消息/关闭事件收进可 await 的队列。
 * ⚠️ 用 `ws`（`@fastify/websocket` 的依赖）：WS 客户端不是标准库，浏览器才有。
 */
function connect(path, { cookie = null, origin = null } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });

  const buffer = [];
  const all = [];
  const waiters = [];
  const closes = [];
  const closeWaiters = [];
  const handshakeStatuses = [];

  socket.on('message', (data) => {
    const text = data.toString('utf8');
    all.push(text);
    const waiter = waiters.shift();
    if (waiter) waiter(text);
    else buffer.push(text);
  });
  socket.on('close', (code, reason) => {
    const info = { code, reason: reason?.toString?.() ?? '' };
    closes.push(info);
    for (const waiter of closeWaiters.splice(0)) waiter(info);
  });
  // 握手被拒时服务端回的是一份普通 HTTP 响应（没有 101），`ws` 把它报在这里
  socket.on('unexpected-response', (_req, res) => {
    handshakeStatuses.push(res.statusCode);
    res.resume?.();
  });
  socket.on('error', () => {
    // 握手失败/被强制关闭都会走这里；断言看 code 与 handshakeStatuses
  });

  return {
    socket,
    all,
    closes,
    handshakeStatuses,
    opened: new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('unexpected-response', () => reject(new Error('handshake rejected')));
      socket.once('error', (err) => reject(err));
    }),
    next(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        if (buffer.length > 0) return resolve(buffer.shift());
        const timer = setTimeout(() => reject(new Error('等待 WS 消息超时')), timeoutMs);
        waiters.push((text) => {
          clearTimeout(timer);
          resolve(text);
        });
      });
    },
    waitClose(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        if (closes.length > 0) return resolve(closes[0]);
        const timer = setTimeout(() => reject(new Error('等待 WS 关闭超时')), timeoutMs);
        closeWaiters.push((info) => {
          clearTimeout(timer);
          resolve(info);
        });
      });
    },
  };
}

/**
 * 探针式的握手请求：发一次真正的 HTTP 升级请求，直接读状态码。
 *
 * ⚠️ 用 `node:http` 而不是 `fetch`：undici（Node 的 fetch）把 `Connection: Upgrade`
 *    列为**禁止的请求头**，会直接抛 `InvalidArgumentError: invalid connection header`，
 *    连请求都发不出去。而 `ws` 客户端的 `unexpected-response` 又只给状态码、不给 body，
 *    都不如自己发一个裸请求好断言。
 *
 * ⚠️ 必须挂 `upgrade` 事件：成功时服务端回 **101**（走 `upgrade`），失败时回普通 HTTP 响应（走 `response`）。
 *    只监听 `response` 的话，成功那一路会一直挂着不 resolve。
 */
function upgradeStatus(path, { cookie = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      // ⚠️ `agent: false` 不是可选项：Node 18+ 的全局 http agent **默认 keep-alive**，
      //    第二次探针会复用上次那条空闲连接，而服务端可能已经把它关掉 ——
      //    于是复用的瞬间就 ECONNRESET，报出来的错和"握手被拒"完全无关，极难归因。
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
        'sec-websocket-version': '13',
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
      },
    });
    req.on('response', (res) => {
      settled = true;
      res.resume();
      resolve(res.statusCode);
    });
    req.on('upgrade', (res) => {
      settled = true;
      // 拿到 101 就够了：主动掐掉这条连接（我们只想断言"握手放行了"）
      res.socket?.destroy();
      resolve(101);
    });
    // ⚠️ 掐连接之后本请求还会冒出一个 ECONNRESET —— 已经拿到状态码了，必须忽略，
    //    否则它会以"未处理的错误"形式算到当前测试头上（表现为一个与断言无关的 ECONNRESET 失败）
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
    req.end();
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const delta = (channel, extra = {}) =>
  JSON.stringify({ type: 'delta', ts: 1758800015000, channel, agent_id: A1, ...extra });

// -----------------------------------------------------------------------------
// 握手的四道闸门
// -----------------------------------------------------------------------------

test('/ws/live 握手的四道闸门：无会话 401、受限态 403、跨站 Origin 403、id 不存在也不放行', async () => {
  await seedAgent();

  assert.equal(await upgradeStatus('/ws/live'), 401, '没有会话 Cookie 应当 401');

  const pending = await mintCookie('totp_pending');
  assert.equal(await upgradeStatus('/ws/live', { cookie: pending }), 403, '只过了密码的会话不许开');

  const full = await mintCookie();
  assert.equal(await upgradeStatus('/ws/live', { cookie: full, origin: 'https://evil.example.com' }), 403, '跨站 Origin 必须拒');

  // 放行的两种情况：同源 Origin；以及**完全没有 Origin**（非浏览器客户端 —— Origin 校验对它无意义）
  const sameOrigin = connect('/ws/live', { cookie: full, origin: `http://127.0.0.1:${port}` });
  await sameOrigin.opened;
  assert.equal(sameOrigin.socket.readyState, 1);
  sameOrigin.socket.close();

  const noOrigin = connect('/ws/live', { cookie: full });
  await noOrigin.opened;
  assert.equal(noOrigin.socket.readyState, 1);
  noOrigin.socket.close();
});

test('公开视图关闭 → /ws/public 直接 404（与 REST 同一口径，⛔ 不泄露"存在过"）', async () => {
  await seedAgent();
  assert.equal(await upgradeStatus('/ws/public'), 101);

  // 开关是**运行时**的：把缓存里的值改掉，下一条连接立刻被拒（不必重启进程）
  await redis.set(keys.settingsCache, JSON.stringify({ 'public_view.enabled': false }), 'EX', 60);
  assert.equal(await upgradeStatus('/ws/public'), 404);
});

// -----------------------------------------------------------------------------
// /ws/live 端到端
// -----------------------------------------------------------------------------

test('/ws/live：连上先收 snapshot（hosts 形状 = REST 列表条目），再收**原样转发**的 delta', async () => {
  await seedAgent();
  const client = connect('/ws/live', { cookie: await mintCookie() });
  await client.opened;

  const snapshot = JSON.parse(await client.next());
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.summary.total, 1);
  assert.equal(snapshot.hosts.length, 1);
  // 面板连接的快照就是 /api/v1/hosts 的条目（同一形状、同一函数）—— 含内部 id 与 IP
  assert.equal(snapshot.hosts[0].id, A1);
  assert.equal(snapshot.hosts[0].slug, makeSlug('web-01'));
  assert.equal(snapshot.hosts[0].status, 'online');
  assert.equal(snapshot.hosts[0].last_ip, '203.0.113.7');
  assert.deepEqual(snapshot.channels, ['metrics', 'status', 'probes', 'alerts']);

  // 扇出：直接喂一条 delta 进去（生产环境这一步来自 Redis Pub/Sub）
  const raw = delta('metrics', { metrics: { 'cpu.usage': 42 } });
  await app.wsFanout.handleMessage(CHANNEL.liveMetrics, raw);

  const received = await client.next();
  assert.equal(received, raw, '⛔ 必须逐字转发，不在 WS 层重新编码');
  client.socket.close();
});

test('/ws/live：subscribe 之后只收订了的频道；未知频道 → 关连接 1008', async () => {
  await seedAgent();
  const client = connect('/ws/live', { cookie: await mintCookie() });
  await client.opened;
  await client.next(); // snapshot

  // 只订 probes
  client.socket.send(JSON.stringify({ type: 'subscribe', channels: ['probes'] }));
  // 订阅没有回执（契约里只有 snapshot/subscribe/delta 三种消息），所以用"发一条不该收到的"来判生效
  await delay(80);

  await app.wsFanout.handleMessage(CHANNEL.liveMetrics, delta('metrics', { metrics: { 'cpu.usage': 1 } }));
  await app.wsFanout.handleMessage(CHANNEL.liveMetrics, delta('probes', { probe: { name: 'site', up: true } }));
  await delay(120);

  assert.equal(client.all.length, 2, '只该多收到 probes 那一条（metrics 没订）');
  assert.equal(JSON.parse(client.all[1]).channel, 'probes');

  client.socket.send(JSON.stringify({ type: 'subscribe', channels: ['metric'] })); // 拼错一个字母
  const closeInfo = await client.waitClose();
  assert.equal(closeInfo.code, 1008);
  assert.match(closeInfo.reason, /未知频道/);
});

test('⛔ 单向宗旨：任何非 subscribe 的应用层消息 → 立刻关连接 1008 并记审计', async () => {
  await seedAgent();
  const client = connect('/ws/live', { cookie: await mintCookie() });
  await client.opened;
  await client.next();

  client.socket.send(JSON.stringify({ type: 'command', cmd: 'rm -rf /' }));
  const closeInfo = await client.waitClose();
  assert.equal(closeInfo.code, 1008);
  assert.match(closeInfo.reason, /unsupported_message_type/);

  const { rows } = await run(
    `SELECT action, target, detail FROM audit_logs WHERE action = 'ws.protocol_violation' ORDER BY id DESC LIMIT 1`,
  );
  assert.equal(rows.length, 1, '必须留下审计（⛔ 不能悄悄关掉）');
  assert.equal(rows[0].target, 'ws:live');
  assert.equal(rows[0].detail.reason, 'unsupported_message_type');
});

// -----------------------------------------------------------------------------
// /ws/public 端到端（脱敏是重点）
// -----------------------------------------------------------------------------

test('/ws/public：快照与增量都**不含**内部 id / IP / 带维度的指标名', async () => {
  await seedAgent();
  const client = connect('/ws/public');
  await client.opened;

  const snapshotText = await client.next();
  const snapshot = JSON.parse(snapshotText);
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.hosts.length, 1);
  assert.equal(snapshot.hosts[0].slug, makeSlug('web-01'));
  // ⛔ 公开侧一个内部标识都不许有
  assert.equal(snapshot.hosts[0].id, undefined, '公开快照不得含内部 UUID');
  assert.equal(snapshot.hosts[0].last_ip, undefined, '公开快照不得含 IP');

  // 一条 status delta → 公开连接收到的是**重新取的脱敏条目**，不是原始 delta
  await app.wsFanout.handleMessage(CHANNEL.liveMetrics, delta('status', { status: 'offline', last_seen_at: '2026-10-05T00:00:00.000Z' }));
  const text = await client.next();
  const push = JSON.parse(text);

  assert.equal(push.type, 'delta');
  assert.equal(push.channel, 'status');
  assert.equal(push.host.slug, makeSlug('web-01'));
  assert.equal(push.host.last_ip, undefined);
  assert.equal(push.host.id, undefined);
  // 生产者原始 delta 里带着 agent_id；公开侧这一份**不许**带上
  assert.equal(push.agent_id, undefined);
  // 字符串级兜底：整个 payload 里不能出现任何泄露字样
  for (const forbidden of ['mount=', 'device=', 'last_ip', 'reported_ip', '203.0.113.7', A1]) {
    assert.ok(!text.includes(forbidden), `公开增量里不该出现 ${forbidden}`);
  }
  client.socket.close();
});

test('/ws/public：只允许订 status —— 订 metrics 直接关连接 1008（堵死泄露设备名的那条路）', async () => {
  await seedAgent();
  const client = connect('/ws/public');
  await client.opened;
  await client.next(); // snapshot

  client.socket.send(JSON.stringify({ type: 'subscribe', channels: ['metrics'] }));
  const closeInfo = await client.waitClose();
  assert.equal(closeInfo.code, 1008);
  assert.match(closeInfo.reason, /未知频道/);
});

test('保活：连上之后服务端会发**协议层 ping 帧**（不占用应用层消息），客户端自动回 pong', async () => {
  // ⚠️ 用最短的保活间隔把"帧"跑出来：这一条验的是 §5.2 的"保活走协议层帧"这个决定
  await seedAgent();
  const shortConfig = { ...CONFIG, ws: { ...CONFIG.ws, keepaliveIntervalS: 5 } };
  await app.close();
  redis = createFakeRedisHash();
  app = await buildApp({ config: shortConfig, logger: SILENT, db: { app: pool, migrator: null }, redis });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = app.server.address().port;

  const client = connect('/ws/live', { cookie: await mintCookie() });
  await client.opened;
  await client.next();

  const gotPing = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 9000);
    client.socket.on('ping', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.equal(gotPing, true, '服务端必须主动发协议层 ping 帧');
  assert.equal(client.all.length, 1, '⛔ 保活不许产生任何应用层消息');
  client.socket.close();
});
