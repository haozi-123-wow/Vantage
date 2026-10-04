/**
 * 离线判定（`offline_sweep`）测试
 *
 * 依据：设计 §5.3（L254 阈值 = 3×上报周期）、§5.2（L472「只在 online→offline 时发告警」）、
 *       docs/database.md §8.2（离线判定任务 + 「状态迁移需防抖」）
 *
 * 为什么必须是**真 PostgreSQL（PGlite）**：
 *   本服务的全部价值都建立在两条**数据库语义**上，替身证明不了 ——
 *   ① `now() - last_seen_at > make_interval(secs => $1)` 的时区/类型求值；
 *   ② `UPDATE ... WHERE` 在并发下**重新求值 WHERE** 这一行为（防抖的根据）。
 *   用桩只能证明 SQL"被发出去过"，而这里最容易出错的恰恰是"这条 SQL 在 PG 上到底匹配了哪些行"。
 *
 * ⚠️ 这组用例同时是**回归防线**：`agents` 表的 `agents_disabled_ck` / `agents_status_ck`
 *    与三态状态机（online/offline/disabled）一旦被改坏，这里会立刻红。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { loadConfig } from '../src/config/index.js';
import { createCronService } from '../src/services/cron.service.js';
import { AGENT_REPORT_PERIOD_S, markStaleAgentsOffline, offlineThresholdS } from '../src/services/offline.service.js';
import { CRON_TASKS, CHANNEL, keys } from '../src/utils/redisKeys.js';
import { PUBLIC_SLUG_ALPHABET } from '../src/utils/crypto.js';
import { createFakeRedis } from './helpers/fake-redis.js';

// -----------------------------------------------------------------------------
// 真库（PGlite）准备：与生产同一条迁移代码路径
// -----------------------------------------------------------------------------
const db = await PGlite.create();
await db.exec('CREATE ROLE vantage_migrator LOGIN; CREATE ROLE vantage_app LOGIN; CREATE ROLE vantage_ro LOGIN;');
await db.exec(BOOTSTRAP_SQL);

const migrations = loadMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
const pgClient = {
  query: (sql, params) => (Array.isArray(params) && params.length > 0 ? db.query(sql, params) : db.exec(sql)),
};
for (const migration of migrations) {
  await applyOne(pgClient, migration, false);
}

/** PGlite → node-pg 适配器（差异说明见 cron.test.js，本项目所有真库用例必须抹平同样两处） */
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

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const CONFIG = loadConfig(
  {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  },
  { skipEnvFile: true },
);

/** 默认阈值（来自 config，⛔ 不在用例里写死 45/90 这类字面量：阈值改了两处会漂） */
const THRESHOLD_S = offlineThresholdS(CONFIG);

/** 固定的几台测试主机（UUID 也是固定的，便于逐用例清理） */
const STALE = '11111111-2222-4333-8444-555555555501'; // 超时未上报
const FRESH = '11111111-2222-4333-8444-555555555502'; // 刚刚上报过
const DISABLED = '11111111-2222-4333-8444-555555555503'; // 人工禁用
const NEVER = '11111111-2222-4333-8444-555555555504'; // 从未上报过
const FUTURE = '11111111-2222-4333-8444-555555555505'; // last_seen_at 在未来
const ALL = [STALE, FRESH, DISABLED, NEVER, FUTURE];

/**
 * 由名字派生一个**必然合法**的 `public_slug`（8–12 位）。
 *
 * 字符集直接取自 `src/utils/crypto.js` 的 `PUBLIC_SLUG_ALPHABET`：它是「公开标识」的
 * **唯一生产者**，与迁移 0003 的 CHECK `^[2-9A-HJ-NP-Za-km-z]{8,12}$` 同源。
 *
 * ⚠️ 两点必须记住（都真踩过）：
 *  1. ⛔ 不要手写 slug。本用例最初的 `slug5502` 就带着一个 `l`——而 `l`/`I`/`O`/`0`/`1`
 *     正是这个字符集**刻意排除**的易混字符，插入会直接撞 `23514 agents_public_slug_format_ck`。
 *  2. ⚠️ **PGlite 0.5.8（PG 18.3 / wasm32）与真实 PG 16 在这个正则上不一致**：
 *     真实 PG 按 POSIX 排序规则会把 `a-km-z` 解释成「a–k 与 m–z，中间的 `l` 也落在范围内」，
 *     故 `l` **合法**；PGlite 则把这两段相邻区间塌缩成一个空集，于是 `l` **不合法**。
 *     结论：**测试里绝不能出现 `l`**，否则会出现「PGlite 红、生产绿」这种最难查的不一致。
 *     本函数只从官方 alphabet 取字符，天然回避了该问题。
 */
function makeSlug(seed) {
  let x = 7;
  for (const ch of seed) x = (x * 31 + ch.codePointAt(0)) % 2_147_483_647;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_647;
    out += PUBLIC_SLUG_ALPHABET[x % PUBLIC_SLUG_ALPHABET.length];
  }
  return out;
}

/**
 * 故意挑一个**数据库与进程时钟都能一致解释**的时刻：本用例用 `now() - interval` 造数据，
 * 于是"多久没上报"这件事在 SQL 侧是精确的，不依赖 Node 与 PG 的时钟差。
 */
async function seedAgent({ id, name, status = 'online', ageSeconds = null, disabled = false }) {
  await run(
    `INSERT INTO agents
       (id, name, public_slug, agent_key_hash, agent_secret_enc, status, last_seen_at, disabled_at)
     VALUES ($1, $2, $3, $4, $5, $6,
             CASE WHEN $7::int IS NULL THEN NULL ELSE now() - make_interval(secs => $7::double precision) END,
             CASE WHEN $8::boolean THEN now() ELSE NULL END)`,
    [
      id,
      name,
      makeSlug(name),
      'a'.repeat(64), // agent_key_hash 必须是 64 位小写十六进制
      'v1:AAAA:BBBB:CCCC', // agent_secret_enc 信封形状
      status,
      ageSeconds,
      disabled,
    ],
  );
}

beforeEach(async () => {
  // ⚠️ agents 被 metrics_raw / alert_events 等引用（ON DELETE RESTRICT），
  //    故只清理本文件自己造的行，且按固定 UUID 精确删。
  await run(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [ALL]);
});

// -----------------------------------------------------------------------------
// 阈值：与 config 同源
// -----------------------------------------------------------------------------

test('offlineThresholdS：= 上报周期 × offlineMultiplier（默认 30 × 3 = 90s）', () => {
  // ⚠️ 30s 不是随手写的：它必须等于 Agent 侧 `report.interval` 的默认值
  //    （agent/internal/config/config.go，修订 G3：15s → 30s）。
  //    取小了会**误报离线**（正常上报的机器在两次上报之间被判死），取大了只是判定变宽松。
  assert.equal(AGENT_REPORT_PERIOD_S, 30, '必须与 Agent 的 report.interval 默认值一致');
  assert.equal(CONFIG.heartbeat.offlineMultiplier, 3);
  assert.equal(offlineThresholdS(CONFIG), 90);
  assert.ok(
    offlineThresholdS(CONFIG) > AGENT_REPORT_PERIOD_S,
    '⛔ 阈值必须**大于**上报周期，否则正常上报的机器也会被判离线',
  );

  // 倍数可配（OFFLINE_CYCLES_MULTIPLIER），阈值必须跟着走而不是写死
  const loose = loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/vantage',
      SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
      OFFLINE_CYCLES_MULTIPLIER: '5',
    },
    { skipEnvFile: true },
  );
  assert.equal(offlineThresholdS(loose), 150);
});

test('offlineThresholdS 为非法值时拒绝执行（⛔ 宁可报错也不静默按 0 判定）', async () => {
  await assert.rejects(() => markStaleAgentsOffline(pool, { thresholdS: 0, logger: silentLogger }), /thresholdS/);
  await assert.rejects(() => markStaleAgentsOffline(pool, { thresholdS: NaN, logger: silentLogger }), /thresholdS/);
});

test('⛔ 回归防线：扫描周期必须**小于**离线阈值（否则判定精度被扫描周期主导）', () => {
  // 本用例防的是一次"看起来很合理"的独立调参：把 HEARTBEAT_SWEEP_INTERVAL_S 调到大于阈值。
  // 后果不是报错，而是**离线的检出时刻被扫描周期决定**：
  //   阈值 90s、扫描 180s ⇒ 机器可能在离线后最多 270s 才被判离线（面板与告警都跟着迟钝）。
  // 根因：扫描间隔与阈值是**两个独立的旋钮**，但它们的语义是耦合的。
  const thresholdS = offlineThresholdS(CONFIG);
  assert.ok(
    CONFIG.heartbeat.sweepIntervalS < thresholdS,
    `扫描周期 ${CONFIG.heartbeat.sweepIntervalS}s 必须小于离线阈值 ${thresholdS}s`,
  );
  // 且检查精度不应退化太多：最坏检出延迟 = 阈值 + 扫描周期（默认 90 + 60 = 150s）
  assert.ok(
    thresholdS + CONFIG.heartbeat.sweepIntervalS <= 300,
    '阈值 + 扫描周期不应超过 5 分钟（否则离线告警会太迟钝）',
  );
});

// -----------------------------------------------------------------------------
// 核心：谁能被置为 offline
// -----------------------------------------------------------------------------

test('超时未上报的 online 主机被置为 offline，返回它最后一次上报时间', async () => {
  await seedAgent({ id: STALE, name: 'stale01', ageSeconds: 600 });

  const result = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });

  assert.equal(result.count, 1);
  assert.equal(result.changed[0].agentId, STALE);
  assert.equal(result.changed[0].name, 'stale01');
  assert.ok(result.changed[0].lastSeenAt instanceof Date, '必须回传最后一次上报时间（供前端显示"最后在线于"）');
  const ageS = (Date.now() - result.changed[0].lastSeenAt.getTime()) / 1000;
  assert.ok(ageS > 590 && ageS < 610, `last_seen_at 应约为 600s 前，实际 ${ageS.toFixed(1)}s`);

  const { rows } = await run(`SELECT status FROM agents WHERE id = $1`, [STALE]);
  assert.equal(rows[0].status, 'offline');
});

test('刚好在阈值内的主机**不动**（防网络抖动误判）', async () => {
  // 比阈值少 15s：还在容忍窗口内
  await seedAgent({ id: FRESH, name: 'fresh01', ageSeconds: THRESHOLD_S - 15 });

  const result = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });

  assert.equal(result.count, 0);
  const { rows } = await run(`SELECT status FROM agents WHERE id = $1`, [FRESH]);
  assert.equal(rows[0].status, 'online', '阈值内的机器绝不能被判离线');
});

test('阈值边界：阈值-1s 不动、阈值+1s 判离（阈值是「超过」而不是「达到」）', async () => {
  await seedAgent({ id: FRESH, name: 'edge_in', ageSeconds: THRESHOLD_S - 1 });
  await seedAgent({ id: STALE, name: 'edge_out', ageSeconds: THRESHOLD_S + 1 });

  const result = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });

  assert.deepEqual(result.changed.map((c) => c.agentId), [STALE]);
  const { rows } = await run(`SELECT id, status FROM agents WHERE id = ANY($1::uuid[]) ORDER BY id`, [ALL]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
  assert.equal(byId[FRESH], 'online');
  assert.equal(byId[STALE], 'offline');
});

test('⛔ 人工禁用（disabled）的主机永不参与超时判定（即使它已离线 3 天）', async () => {
  await seedAgent({ id: DISABLED, name: 'disabled01', status: 'disabled', ageSeconds: 3 * 86_400, disabled: true });

  const result = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });

  assert.equal(result.count, 0, 'disabled 是人工状态，不会因为机器没在跑而改变');
  const { rows } = await run(`SELECT status, disabled_at FROM agents WHERE id = $1`, [DISABLED]);
  assert.equal(rows[0].status, 'disabled');
  assert.ok(rows[0].disabled_at, 'agents_disabled_ck 要求 disabled 必有 disabled_at');
});

test('从未上报过（last_seen_at IS NULL）的 online 主机也会被点名', async () => {
  await seedAgent({ id: NEVER, name: 'never01', ageSeconds: null });

  const result = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });

  assert.equal(result.changed[0].lastSeenAt, null, '从未上报 → last_seen_at 就应该是 null（⛔ 不伪造时间）');
  const { rows } = await run(`SELECT status FROM agents WHERE id = $1`, [NEVER]);
  assert.equal(rows[0].status, 'offline');
});

test('last_seen_at 在未来（进程时钟回跳）时**不**判离线（负的 now()-last_seen_at 不是超时）', async () => {
  await run(
    `INSERT INTO agents (id, name, public_slug, agent_key_hash, agent_secret_enc, status, last_seen_at)
     VALUES ($1, 'future01', $2, $3, 'v1:AAAA:BBBB:CCCC', 'online', now() + interval '5 minutes')`,
    [FUTURE, makeSlug('future01'), 'a'.repeat(64)],
  );

  const result = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });
  assert.equal(result.count, 0);
});

// -----------------------------------------------------------------------------
// 防抖：本服务只做一次单向迁移（这是「只发一次离线告警」的根据）
// -----------------------------------------------------------------------------

test('⛔ 假离线回归防线：按**正常上报节奏**（每 30s 一次）上报的机器，绝不能在任何时刻被判离线', async () => {
  // 本用例专门防一类真实踩过的 bug：阈值基准取错。
  // 曾把上报周期写成 15s（旧文档值），阈值算成 45s —— 而 Agent 实际每 30s 才报一次，
  // 于是"刚上报完 30s"的机器已经超过 45s？不，是 45s < 60s（两次上报之间），
  // 机器在两次上报的间隙里被判死，随后下一次上报又救活它 → 面板上随机闪离线。
  //
  // 判据：把 last_seen_at 依次设在「上报周期 30s 的各个相位」上，任何相位都不得判离线。
  for (const phase of [0, 5, 10, 15, 20, 25, 30]) {
    await run(`DELETE FROM agents WHERE id = $1`, [STALE]);
    await seedAgent({ id: STALE, name: `phase${phase}`, ageSeconds: phase });

    const result = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });
    assert.equal(
      result.count,
      0,
      `距上次上报 ${phase}s（< 上报周期 30s）时绝不能被判离线 —— 这正是阈值基准取错 15s 时的症状`,
    );
  }

  // 顺带钉死：阈值必须留足「两个上报周期」的余量，否则网络抖动一次就误报
  assert.ok(
    THRESHOLD_S >= 2 * AGENT_REPORT_PERIOD_S,
    `阈值 ${THRESHOLD_S}s 必须 ≥ 2 倍上报周期（${2 * AGENT_REPORT_PERIOD_S}s），否则丢一批就误判离线`,
  );
});

test('幂等/防抖：连跑两次，第二次返回 0 行（⛔ 不会再触发一次告警/广播）', async () => {
  await seedAgent({ id: STALE, name: 'once01', ageSeconds: 600 });

  const first = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });
  assert.equal(first.count, 1, '第一次：online → offline');

  const second = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });
  assert.equal(second.count, 0, '第二次：它已经是 offline，不应再被"重新发现"一次');

  const third = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });
  assert.equal(third.count, 0, '跑多少次都稳定为 0（幂等）');
});

test('已处于 offline 的主机不会因为"再次超时"被重复上报（防止告警风暴）', async () => {
  await seedAgent({ id: STALE, name: 'already01', status: 'offline', ageSeconds: 9999 });

  const result = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });
  assert.equal(result.count, 0);
});

test('恢复路径：机器重新上报后变回 online，下一次超时会**再次**被判离线（状态对是完整的）', async () => {
  await seedAgent({ id: STALE, name: 'recover01', ageSeconds: 600 });
  await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });

  // 模拟上报路径把自己"救活"（repositories/agent.repo.js 的 updateAgentAfterReport）
  await run(
    `UPDATE agents SET status = CASE WHEN status = 'disabled' THEN status ELSE 'online' END,
                       last_seen_at = now()
      WHERE id = $1`,
    [STALE],
  );
  const back = await run(`SELECT status FROM agents WHERE id = $1`, [STALE]);
  assert.equal(back.rows[0].status, 'online');

  // 再超时 → 必须能再次被判离线（否则这台机器此后再也不会告警）
  await run(`UPDATE agents SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`, [STALE]);
  const again = await markStaleAgentsOffline(pool, { thresholdS: THRESHOLD_S, logger: silentLogger });
  assert.equal(again.count, 1, 'offline → online → 超时 → 必须能再次转 offline');
});

// -----------------------------------------------------------------------------
// 调度层：任务已注册，且扫描后会把「刚刚掉线」扇出给实时层
// -----------------------------------------------------------------------------

test('cron：offline_sweep 已注册（不再属于 M3 待办），且调度间隔取自 HEARTBEAT_SWEEP_INTERVAL_S', async () => {
  const cron = createCronService({ db: { app: pool, migrator: null }, redis: createFakeRedis(), config: CONFIG, logger: silentLogger });

  assert.ok(cron.taskNames.includes(CRON_TASKS.offlineSweep), 'offline_sweep 必须已注册');

  // ⚠️ `next_at` 只有 `start()` 排程后才有值（构造时为 undefined → status() 显示 1970），
  //    所以这里必须真的 start 一次，否则断言的是"调度器没跑过"而不是"任务没排上"。
  await cron.start();
  const entry = cron.status().find((s) => s.name === CRON_TASKS.offlineSweep);
  cron.stop(); // 立刻停：调度循环的定时器虽已 unref，但留着会污染后续用例

  assert.ok(entry?.next_at, '每个任务都必须有下次执行时间');
  assert.notEqual(entry.next_at, '1970-01-01T00:00:00.000Z');

  // 间隔必须来自 config.heartbeat.sweepIntervalS（默认 30s）——这个配置项本来就是为离线判定存在的，
  // ⛔ 不要另加一个 env，否则会出现「改了 HEARTBEAT_SWEEP_INTERVAL_S 却毫无效果」。
  const expectedNext = Date.now() + CONFIG.heartbeat.sweepIntervalS * 1000;
  const drift = Math.abs(Date.parse(entry.next_at) - expectedNext);
  assert.ok(drift < 5000, `下次执行时间应约为 now + ${CONFIG.heartbeat.sweepIntervalS}s，实际偏差 ${drift}ms`);
});

test('cron：跑一次 offline_sweep → 状态入库 + 扇出 status:offline delta（形状与上报路径一致）', async () => {
  await seedAgent({ id: STALE, name: 'broadcast01', ageSeconds: 600 });
  await seedAgent({ id: FRESH, name: 'broadcast02', ageSeconds: 5 });

  const redis = createFakeRedis();
  const cron = createCronService({ db: { app: pool, migrator: null }, redis, config: CONFIG, logger: silentLogger });

  const result = await cron.runTask(CRON_TASKS.offlineSweep);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.offline, 1, '只有超时那一台应被点名');
  assert.equal(result.result.thresholdS, THRESHOLD_S);
  assert.deepEqual(result.result.agents, ['broadcast01']);

  // 数据面：库里真的变了
  const { rows } = await run(`SELECT id, status FROM agents WHERE id = ANY($1::uuid[])`, [[STALE, FRESH]]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
  assert.equal(byId[STALE], 'offline');
  assert.equal(byId[FRESH], 'online');

  // 实时面：一条 status 增量，形状与 docs/api.md §5.2 一致
  assert.equal(redis.published.length, 1, '在线主机不应产生任何广播');
  const published = redis.published[0];
  assert.equal(published.channel, CHANNEL.liveMetrics);
  const delta = JSON.parse(published.payload);
  assert.equal(delta.type, 'delta');
  assert.equal(delta.channel, 'status');
  assert.equal(delta.agent_id, STALE);
  assert.equal(delta.status, 'offline');
  assert.equal(typeof delta.ts, 'number');
  assert.ok(delta.last_seen_at, '应带上"最后在线于何时"，供前端展示');
  assert.ok(delta.ts > Date.parse(delta.last_seen_at), 'ts 是判定时刻，必须晚于最后上报时刻（⛔ 两者语义不同）');
});

test('cron：没有主机掉线时**不产生任何 Redis 发布**（避免每个扫描周期一条空广播）', async () => {
  await seedAgent({ id: FRESH, name: 'quiet01', ageSeconds: 5 });

  const redis = createFakeRedis();
  const cron = createCronService({ db: { app: pool, migrator: null }, redis, config: CONFIG, logger: silentLogger });
  const result = await cron.runTask(CRON_TASKS.offlineSweep);

  assert.equal(result.result.offline, 0);
  assert.equal(redis.published.length, 0);
});

test('cron：Redis 扇出失败**不影响**离线判定结果（状态已入库，重跑幂等）', async () => {
  await seedAgent({ id: STALE, name: 'redisfail01', ageSeconds: 600 });

  // 只让「扇出」这条路断掉：`db/redis.js` 的 publish() 走 pipeline，
  // 故 pipeline() 抛错就等价于"实时层此刻不可用"。
  const redis = Object.assign(createFakeRedis(), {
    pipeline() {
      throw Object.assign(new Error('Connection is closed.'), { name: 'MaxRetriesPerRequestError' });
    },
  });

  const cron = createCronService({ db: { app: pool, migrator: null }, redis, config: CONFIG, logger: silentLogger });
  const result = await cron.runTask(CRON_TASKS.offlineSweep);

  assert.equal(result.ok, true, '扇出失败不能把任务算失败（否则日志里会出现假的任务故障）');
  assert.equal(result.result.offline, 1);
  const { rows } = await run(`SELECT status FROM agents WHERE id = $1`, [STALE]);
  assert.equal(rows[0].status, 'offline', '数据面必须已经落库');
});

test('cron：任务名必须在 CRON_TASKS 契约内（键名不得分叉）', () => {
  const cron = createCronService({ db: { app: pool, migrator: null }, redis: createFakeRedis(), config: CONFIG, logger: silentLogger });
  const registered = new Set(Object.values(CRON_TASKS));
  for (const name of cron.taskNames) {
    assert.ok(registered.has(name), `${name} 不在 redisKeys.js 的 CRON_TASKS 里`);
  }
});

test('cron：offline_sweep 的锁与其它任务相互独立（不会互相顶掉）', async () => {
  const redis = createFakeRedis();
  // 只占住聚合任务的锁，offline_sweep 必须照常可跑
  redis.seed(keys.cronLock(CRON_TASKS.aggregate1m), 'other-instance');

  const cron = createCronService({ db: { app: pool, migrator: null }, redis, config: CONFIG, logger: silentLogger });
  const result = await cron.runTask(CRON_TASKS.offlineSweep);

  assert.equal(result.skipped, undefined);
  assert.equal(result.ok, true);
  assert.equal(redis.has(keys.cronLock(CRON_TASKS.offlineSweep)), false, '任务结束后自己的锁必须释放');
});
