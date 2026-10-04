/**
 * 状态推导服务测试（`services/status.service.js`）
 *
 * 依据：docs/server-status-api.md §2（D1–D8 全部决策）、§3（两个接口的字段口径）、
 *       §4（取数策略）、§6（写代码时必须遵守的硬约束）；docs/api.md §3.1/§3.2/§4.2
 *
 * 为什么必须是**真 PostgreSQL（PGlite）**：
 *   本模块的每个结论都"长在 SQL 上"——在线判定用的是 `now() - last_seen_at <= make_interval(...)`、
 *   「每序列最新值」用的是 `DISTINCT ON` + 分区裁剪、探活「最近一轮」用的是 `max(checked_at)` 的 CTE。
 *   桩只能证明"发过一条 SQL"，而这里最容易错的恰恰是"这条 SQL 到底匹配了哪些行"。
 *
 * ⚠️ 三条回归防线（都在本文件里，改坏了会立刻红）：
 *   1. **读路径的在线判定必须与 `offline_sweep` 同源**（阈值与判定式）；
 *   2. **公开响应零内部标识**（用"字段全填满"的 agent 做字符串包含断言）；
 *   3. **没有数据就是 `null`**（⛔ 不补 0 —— 那是把"失联"显示成"空闲"）。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { loadConfig } from '../src/config/index.js';
import { offlineThresholdS } from '../src/services/offline.service.js';
import {
  OBSERVATION_WINDOW_S,
  PANEL_LIMIT_MAX,
  buildPublicDetail,
  buildSnapshot,
  desensitizeTarget,
  getPublicSummary,
  lastSeenAgo,
  listPanelHosts,
  listPublicHosts,
} from '../src/services/status.service.js';
import { PUBLIC_SLUG_ALPHABET } from '../src/utils/crypto.js';
import { keys } from '../src/utils/redisKeys.js';
import { createFakeRedisHash } from './helpers/fake-redis-hash.js';

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

async function run(sql, params = []) {
  if (Array.isArray(params) && params.length > 0) {
    const result = await db.query(sql, params);
    return { rows: result.rows ?? [], rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  }
  const results = await db.exec(sql);
  const last = Array.isArray(results) ? results.at(-1) : results;
  return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
}

/** 统计 SQL 条数：用来钉死「未命中缓存 ≤ 3 条」「命中缓存 0 条」（方案 §4.4/§7.3） */
let sqlCount = 0;
const pool = {
  query(sql, params) {
    sqlCount += 1;
    return run(sql, params);
  },
};

after(async () => {
  await db.close();
});

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const CONFIG = loadConfig(
  {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 11).toString('base64'),
  },
  { skipEnvFile: true },
);
const THRESHOLD_S = offlineThresholdS(CONFIG);

// -----------------------------------------------------------------------------
// 夹具
// -----------------------------------------------------------------------------

/** 固定 UUID：便于逐用例精确清理（agents 被 metrics/probe/alert 引用，⛔ 不能 TRUNCATE） */
const A1 = '33333333-4444-5555-8666-777777777701'; // 在线 + 数据全填满（脱敏断言的主角）
const A2 = '33333333-4444-5555-8666-777777777702'; // status=offline，400s 未上报
const A3 = '33333333-4444-5555-8666-777777777703'; // disabled（公开侧⛔ 不可见）
const A4 = '33333333-4444-5555-8666-777777777704'; // **库说 online、其实已失联**（读路径推导的主角）
const A5 = '33333333-4444-5555-8666-777777777705'; // 从未上报（last_seen_at IS NULL）
const A6 = '33333333-4444-5555-8666-777777777706'; // 在线、无告警（排序对照组）
const A7 = '33333333-4444-5555-8666-777777777707'; // 模糊搜索：名称含 `_`
const A8 = '33333333-4444-5555-8666-777777777708'; // 模糊搜索：`_` 在 LIKE 里被当作通配符的诱饵
const ALL = [A1, A2, A3, A4, A5, A6, A7, A8];

const RULE_NAME = 'rule-status-test';

/** 从官方 alphabet 派生合法 slug（⛔ 见 offline.service.test.js 里关于 PGlite 正则差异的说明） */
function makeSlug(seed) {
  let x = 7;
  for (const ch of String(seed)) x = (x * 31 + ch.codePointAt(0)) % 2_147_483_647;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_647;
    out += PUBLIC_SLUG_ALPHABET[x % PUBLIC_SLUG_ALPHABET.length];
  }
  return out;
}

/** 故意可辨识的凭证哈希（脱敏断言里按字符串包含检查它**不得出现**） */
const AGENT_KEY_HASH = '0123456789abcdef'.repeat(4);

async function seedAgent(input) {
  const {
    id,
    name,
    status = 'online',
    ageSeconds = null,
    displayName = null,
    tags = [],
    hostInfo = null,
    lastIp = null,
    reportedIp = null,
    clockDrift = null,
    flapping = false,
  } = input;
  await run(
    `INSERT INTO agents
       (id, name, public_slug, display_name, agent_key_hash, agent_secret_enc, tags, status,
        last_seen_at, disabled_at, host_info, last_ip, reported_ip, clock_drift_ms, ip_flapping, flapping_since)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8,
             CASE WHEN $9::int IS NULL THEN NULL ELSE now() - make_interval(secs => $9::double precision) END,
             CASE WHEN $10::boolean THEN now() ELSE NULL END,
             $11::jsonb, $12::inet, $13::inet, $14, $15::boolean,
             CASE WHEN $15::boolean THEN now() - interval '5 minutes' ELSE NULL END)`,
    [
      id,
      name,
      makeSlug(input.slugSeed ?? name),
      displayName,
      AGENT_KEY_HASH,
      'v1:AAAA:BBBB:CCCC',
      JSON.stringify(tags),
      status,
      ageSeconds,
      status === 'disabled',
      hostInfo ? JSON.stringify(hostInfo) : null,
      lastIp,
      reportedIp,
      clockDrift,
      flapping,
    ],
  );
}

async function seedMetric(agentId, metric, value, ageSeconds = 10) {
  await run(
    `INSERT INTO metrics_raw (agent_id, metric, value, ts)
     VALUES ($1::uuid, $2, $3, now() - make_interval(secs => $4::double precision))`,
    [agentId, metric, value, ageSeconds],
  );
}

/**
 * 造**一轮**探活（同一条 SQL 写入 ⇒ 该轮所有目标的 `checked_at` 完全相同）。
 *
 * ⚠️ 这是本文件最容易写错的一处夹具：把一轮拆成多条 INSERT 时，每条语句的 `now()` 是各自事务的
 *    开始时间（相差微秒），于是「最近一轮」只剩最后一条 —— 断言会看到 `{up:0,down:1}` 这种结果，
 *    看起来像"探活计数实现错了"，其实是夹具没有复现 `insertProbeResults()` 的单语句批量语义。
 */
async function seedProbeRound(agentId, ageSeconds, results) {
  await run(
    `INSERT INTO probe_results (agent_id, probe_name, probe_type, target, up, checked_at)
     SELECT $1::uuid, s.name, 'ping', '203.0.113.1', s.up,
            now() - make_interval(secs => $2::double precision)
       FROM unnest($3::text[], $4::boolean[]) AS s(name, up)`,
    [agentId, ageSeconds, results.map(([name]) => name), results.map(([, up]) => up)],
  );
}

/** 造一条 firing 告警（只为验证计数 SQL 能跨表 JOIN 出正确数字，⛔ 不代表告警引擎已实现） */
async function seedFiringAlert(agentId, severity = 'critical') {
  await run(`DELETE FROM alert_events WHERE agent_id = ANY($1::uuid[])`, [[agentId]]);
  const { rows } = await run(
    `INSERT INTO alert_rules (name, target, kind, duration, severity, params)
     VALUES ($1, '{"all":true}'::jsonb, 'offline', 180, $2, '{"cycles":3}'::jsonb)
     ON CONFLICT (name) DO UPDATE SET severity = EXCLUDED.severity
     RETURNING id`,
    [RULE_NAME, severity],
  );
  await run(
    `INSERT INTO alert_events (rule_id, agent_id, started_at, status)
     VALUES ($1, $2, now(), 'firing')`,
    [rows[0].id, agentId],
  );
}

/** 「数据全填满」的 agent：脱敏断言要求其中每一个值都不出现在公开响应里 */
function fullHostInfo() {
  return {
    hostname: 'real-host-internal-1',
    os: 'Ubuntu 24.04.1 LTS',
    kernel: '6.8.0-45-generic',
    arch: 'x86_64',
    boot_time: Math.floor(Date.now() / 1000) - 3_723_840, // 43.1 天
    device: 'nvme-SAMSUNG-990-PRO',
    mount: '/data',
    capabilities: { gpu: { nvidia: true }, 'probe.http': true },
  };
}

let redis = null;
let now = Date.parse('2026-10-04T12:00:00.000Z');

beforeEach(async () => {
  sqlCount = 0;
  now = Date.parse('2026-10-04T12:00:00.000Z');
  redis = createFakeRedisHash({ now: () => now });

  // 清理顺序由外键决定：probe_results / alert_events → agents → alert_rules
  await run(`DELETE FROM probe_results WHERE agent_id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM alert_events WHERE agent_id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM metrics_raw WHERE agent_id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [ALL]);
  await run(`DELETE FROM alert_rules WHERE name = $1`, [RULE_NAME]);
});

/** 造一整套标准数据集（每个用例按需调用，避免用例间隐式耦合） */
async function seedStandardWorld({ withAlert = true } = {}) {
  await seedAgent({
    id: A1,
    name: 'web%01',
    status: 'online',
    ageSeconds: 10,
    displayName: '主机甲',
    tags: ['prod', 'web'],
    hostInfo: fullHostInfo(),
    lastIp: '203.0.113.77',
    reportedIp: '198.51.100.9',
    clockDrift: -1234,
    flapping: true,
  });
  await seedAgent({ id: A2, name: 'db-02', status: 'offline', ageSeconds: 400, tags: ['prod'] });
  await seedAgent({ id: A3, name: 'old-03', status: 'disabled', ageSeconds: 30 });
  await seedAgent({ id: A4, name: 'ghost-04', status: 'online', ageSeconds: 200 });
  await seedAgent({ id: A5, name: 'never-05', status: 'online' });
  await seedAgent({ id: A6, name: 'cache-06', status: 'online', ageSeconds: 5, displayName: '缓存机', tags: ['dev'] });
  if (withAlert) await seedFiringAlert(A1, 'critical');

  // A1：五槽位 + 两个磁盘挂载点（取 MAX）+ 两块网卡（取 SUM）+ 两张 GPU（取 MAX）
  await seedMetric(A1, 'cpu.usage', 23.84);
  await seedMetric(A1, 'mem.used_pct', 38.1);
  await seedMetric(A1, 'disk.used_pct{device=sda1,mount=/}', 61.4);
  await seedMetric(A1, 'disk.used_pct{device=sdb1,mount=/data}', 80.04);
  await seedMetric(A1, 'net.rx_bps{device=eth0}', 1_000_000.4);
  await seedMetric(A1, 'net.rx_bps{device=eth1}', 468_006);
  await seedMetric(A1, 'net.tx_bps{device=eth0}', 4_089_446.4);
  await seedMetric(A1, 'gpu.util{index=0}', 12.36);
  await seedMetric(A1, 'gpu.util{index=1}', 44.44);

  // A2：只有 mem.used / mem.total（验证 mem_pct 的兜底口径）
  await seedMetric(A2, 'mem.used', 250);
  await seedMetric(A2, 'mem.total', 1000);

  // A4：数据在观测窗口**之外**（400s > 300s）→ snapshot 必须全 null（⛔ 不返回旧值）
  await seedMetric(A4, 'cpu.usage', 99.9, 400);

  // A1 的探活：最近一轮 2 up / 1 down（更早那一轮 3 up 必须被忽略）
  await seedProbeRound(A1, 200, [['gw', true], ['dns', true], ['api', true]]);
  await seedProbeRound(A1, 10, [['gw', true], ['dns', true], ['api', false]]);
}

const publicBySlug = (body) => Object.fromEntries(body.items.map((item) => [item.slug, item]));

/**
 * 固定 UUID → 主机名（`public_slug` 是从**名字**派生的，见 `seedAgent`）。
 * ⚠️ 不写这张表就只能拿 UUID 当种子算 slug，那样断言会全部对不上（而且看起来像"推导错了"）。
 */
const NAME = {
  [A1]: 'web%01',
  [A2]: 'db-02',
  [A3]: 'old-03',
  [A4]: 'ghost-04',
  [A5]: 'never-05',
  [A6]: 'cache-06',
  [A7]: 'a_b',
  [A8]: 'axb',
};
const slugOf = (id) => makeSlug(NAME[id]);

// -----------------------------------------------------------------------------
// 纯函数：snapshot 与相对时间
// -----------------------------------------------------------------------------

test('buildSnapshot：五槽位口径（disk 取 MAX、net 取 SUM）、无数据一律 null（⛔ 不补 0）', () => {
  const snapshot = buildSnapshot([
    { slot: 'cpu_pct', value: 23.84 },
    { slot: 'mem_pct', value: 38.14 },
    { slot: 'disk_pct', value: 61.4 },
    { slot: 'disk_pct', value: 80.04 },
    { slot: 'net_rx_bps', value: 1_000_000.4 },
    { slot: 'net_rx_bps', value: 468_006 },
    { slot: 'net_tx_bps', value: 4_089_446.4 },
  ]);

  assert.deepEqual(snapshot, {
    cpu_pct: 23.8,
    mem_pct: 38.1,
    disk_pct: 80.0, // MAX（不是平均、不是求和）
    net_rx_bps: 1_468_006.4, // SUM（两块网卡）
    net_tx_bps: 4_089_446.4,
  });
  // ⚠️ GPU 无序列 ⇒ **字段缺省**（不是 null）：设计稿要求 GPU 图整块隐藏
  assert.equal('gpu_pct' in snapshot, false);

  // 完全没有数据：五个键都在、值都是 null（前端据此显示 `—`）
  assert.deepEqual(buildSnapshot([]), {
    cpu_pct: null,
    mem_pct: null,
    disk_pct: null,
    net_rx_bps: null,
    net_tx_bps: null,
  });
});

test('buildSnapshot：mem_pct 优先 mem.used_pct，缺失时用 mem.used / mem.total 兜底', () => {
  const withPct = buildSnapshot([
    { slot: 'mem_pct', value: 38.1 },
    { slot: 'mem_used', value: 999 },
    { slot: 'mem_total', value: 1000 },
  ]);
  assert.equal(withPct.mem_pct, 38.1, '有派生序列时⛔ 不要再用 used/total 重算');

  const fallback = buildSnapshot([
    { slot: 'mem_used', value: 250 },
    { slot: 'mem_total', value: 1000 },
  ]);
  assert.equal(fallback.mem_pct, 25);

  // total=0 / 缺失 → 无法计算 ⇒ null（⛔ 不是 0、不是 100）
  assert.equal(buildSnapshot([{ slot: 'mem_used', value: 250 }, { slot: 'mem_total', value: 0 }]).mem_pct, null);
  assert.equal(buildSnapshot([{ slot: 'mem_used', value: 250 }]).mem_pct, null);

  // GPU 有序列（哪怕只有一张）⇒ 字段出现，取 MAX
  const gpu = buildSnapshot([{ slot: 'gpu_pct', value: 12.36 }, { slot: 'gpu_pct', value: 44.44 }]);
  assert.equal(gpu.gpu_pct, 44.4);
});

test('lastSeenAgo：分级取整（刚刚 / N 分钟前 / N 小时前 / N 天前 / 超过 30 天）', () => {
  assert.equal(lastSeenAgo(0), '刚刚');
  assert.equal(lastSeenAgo(59), '刚刚');
  assert.equal(lastSeenAgo(60), '1 分钟前');
  assert.equal(lastSeenAgo(3599), '59 分钟前');
  assert.equal(lastSeenAgo(3600), '1 小时前');
  assert.equal(lastSeenAgo(86_399), '23 小时前');
  assert.equal(lastSeenAgo(86_400), '1 天前');
  assert.equal(lastSeenAgo(2_592_000), '超过 30 天');
  // 负数（last_seen_at 在未来，即时钟漂移）按 0 处理，⛔ 不得出现「-3 分钟前」
  assert.equal(lastSeenAgo(-30), '刚刚');
  assert.equal(lastSeenAgo(null), null);
});

// -----------------------------------------------------------------------------
// 公开单机展开块：维度取值泛化（⛔ 这是公开侧最要紧的一条脱敏）
// -----------------------------------------------------------------------------

test('buildPublicDetail：把设备/挂载点泛化成「磁盘 N / 网卡 N」，⛔ 一个指标名都不出现', () => {
  const detail = buildPublicDetail([
    { metric: 'cpu.usage', value: 23.84 },
    { metric: 'cpu.load1', value: 0.52 },
    { metric: 'mem.total', value: 16_000_000_000 },
    { metric: 'mem.used_pct', value: 38.1 },
    { metric: 'disk.used_pct{device=sda1,mount=/}', value: 80.04 },
    { metric: 'disk.total{device=sda1,mount=/}', value: 1_000_000 },
    { metric: 'disk.used_pct{device=nvme0n1p2,mount=/data}', value: 61.4 },
    { metric: 'net.rx_bps{device=eth0}', value: 1000.44 },
    { metric: 'net.tx_bps{device=enp3s0}', value: 2000.44 },
    { metric: 'gpu.util{index=0}', value: 44.44 },
    { metric: 'gpu.mem_used{index=0}', value: 1234 },
  ]);

  // 编号按**字典序**稳定：`/` < `/data`
  assert.deepEqual(detail.disks.map((d) => d.label), ['磁盘 1', '磁盘 2']);
  assert.equal(detail.disks[0].used_pct, 80, '磁盘 1 = mount=/');
  assert.equal(detail.disks[0].total_bytes, 1_000_000);
  assert.equal(detail.disks[1].used_pct, 61.4, '磁盘 2 = mount=/data');
  assert.equal(detail.disks[1].total_bytes, null, '该挂载点没报 total ⇒ null（⛔ 不补 0）');

  // ⚠️ 编号按**字典序**：'enp3s0' < 'eth0'（比较到第二个字符 n < t）—— 与"按出现顺序"无关
  assert.deepEqual(detail.networks.map((n) => n.label), ['网卡 1', '网卡 2']);
  assert.equal(detail.networks[0].tx_bps, 2000.4, '网卡 1 = enp3s0');
  assert.equal(detail.networks[0].rx_bps, null);
  assert.equal(detail.networks[1].rx_bps, 1000.4, '网卡 2 = eth0');
  assert.equal(detail.networks[1].tx_bps, null, '该网卡没报 tx ⇒ null（⛔ 不补 0）');

  assert.deepEqual(detail.gpus.map((g) => g.label), ['GPU 1']);
  assert.equal(detail.gpus[0].util_pct, 44.4);
  assert.equal(detail.gpus[0].mem_used_bytes, 1234);

  assert.equal(detail.cpu.usage_pct, 23.8);
  assert.equal(detail.cpu.load5, null);
  assert.equal(detail.memory.total_bytes, 16_000_000_000);
  assert.equal(detail.memory.used_pct, 38.1);

  // ⛔ 泄露检查：设备名、挂载点、指标名、基名前缀一个都不能出现
  const text = JSON.stringify(detail);
  for (const leak of ['sda1', 'nvme0n1p2', '/data', 'eth0', 'enp3s0', 'disk.', 'net.', 'cpu.', 'mem.', 'gpu.', 'index=']) {
    assert.equal(text.includes(leak), false, `公开展开块泄露了 ${leak}`);
  }
  // 字段集合是白名单（将来给 metrics_raw 加维度，也不可能顺带漏出去）
  assert.deepEqual(Object.keys(detail.disks[0]).sort(), [
    'inode_used_pct', 'label', 'latency_ms', 'read_bps', 'read_iops', 'total_bytes', 'used_bytes', 'used_pct', 'write_bps', 'write_iops',
  ]);
});

test('buildPublicDetail：无数据时全是 null、数组为空（⛔ 不补 0、不编造一行）', () => {
  const detail = buildPublicDetail([]);
  assert.deepEqual(detail.disks, []);
  assert.deepEqual(detail.networks, []);
  assert.deepEqual(detail.gpus, []);
  assert.equal(detail.cpu.usage_pct, null);
  assert.equal(detail.memory.total_bytes, null);
  // 未知/不合规的序列名直接跳过（⛔ 不回显可疑字符串）
  const junk = buildPublicDetail([
    { metric: 'not a metric name', value: 1 },
    { metric: 'cpu.core.usage{core=0}', value: 12 }, // 维度不在白名单内 ⇒ 不进任何数组
  ]);
  assert.deepEqual(junk.disks, []);
  assert.equal(junk.cpu.usage_pct, null);
});

test('desensitizeTarget：域名保留、路径/端口剥离、私网泛化、公网保留、无法解析 → null', () => {
  // 域名：只留主机名（⛔ 路径与查询串会暴露内网服务结构）
  assert.equal(desensitizeTarget('https://status.example.com/health?deep=1'), 'status.example.com');
  assert.equal(desensitizeTarget('http://gw.internal:8080/admin'), 'gw.internal');
  assert.equal(desensitizeTarget('gw.internal'), 'gw.internal');
  assert.equal(desensitizeTarget('DNS.EXAMPLE.COM'), 'dns.example.com', '统一小写便于比对');

  // 私网/保留地址：一律泛化（`10.0.0.5` 直接暴露网段划分）
  assert.equal(desensitizeTarget('10.0.0.5'), '内网地址');
  assert.equal(desensitizeTarget('10.0.0.5:5432'), '内网地址');
  assert.equal(desensitizeTarget('192.168.1.1'), '内网地址');
  assert.equal(desensitizeTarget('172.16.0.9'), '内网地址');
  assert.equal(desensitizeTarget('100.64.0.1'), '内网地址', 'CGNAT');
  assert.equal(desensitizeTarget('127.0.0.1'), '内网地址');
  assert.equal(desensitizeTarget('::ffff:10.0.0.5'), '内网地址', 'IPv4-mapped 写法也要能识别');
  assert.equal(desensitizeTarget('fd00::1'), '内网地址', 'ULA');
  assert.equal(desensitizeTarget('[fe80::1]:443'), '内网地址', '链路本地 + 方括号 + 端口');

  // 公网地址：保留（解析域名同样能得到，隐藏只会让公开页变成一排「—」）
  assert.equal(desensitizeTarget('223.5.5.5'), '223.5.5.5');
  assert.equal(desensitizeTarget('223.5.5.5:53'), '223.5.5.5');
  assert.equal(desensitizeTarget('1.1.1.1'), '1.1.1.1');

  // 解析不出来 → null（默认不展示，⛔ 不返回原串）
  assert.equal(desensitizeTarget(''), null);
  assert.equal(desensitizeTarget(null), null);
  assert.equal(desensitizeTarget('not a target'), null);
  assert.equal(desensitizeTarget('http://'), null);
  assert.equal(desensitizeTarget('目标 1'), null);
});

// -----------------------------------------------------------------------------
// 公开列表
// -----------------------------------------------------------------------------

test('公开列表：status 由**读取时推导**（库说 online 但已失联的机器必须显示 offline）', async () => {
  await seedStandardWorld();
  const body = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  const bySlug = publicBySlug(body);

  // A4：agents.status = 'online'，但 200s > 阈值 90s ⇒ 公开侧必须显示 offline
  assert.equal(bySlug[slugOf(A4)].status, 'offline');
  assert.equal(bySlug[slugOf(A1)].status, 'online');
  // A5：从未上报过（last_seen_at IS NULL）同样判 offline
  assert.equal(bySlug[slugOf(A5)].status, 'offline');

  const { rows } = await run(`SELECT status FROM agents WHERE id = $1`, [A4]);
  assert.equal(rows[0].status, 'online', '前提：库里那一行仍是 online（推导只发生在读路径）');
});

test('公开列表：⛔ 不出现 disabled（人工禁用是内部运营信息）', async () => {
  await seedStandardWorld();
  const body = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  assert.equal(body.items.some((item) => item.status === 'disabled'), false);
  assert.equal(body.items.some((item) => item.slug === slugOf(A3)), false, 'disabled 主机的 slug 本身也不该出现');
  assert.equal(body.items.length, 5, '其余 5 台（含 offline）都应出现');
});

test('公开列表：⛔ 零内部标识（字段全填满的 agent 逐个值做字符串包含断言）', async () => {
  await seedStandardWorld();
  const res = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  const text = JSON.stringify(res);

  for (const leak of [A1, AGENT_KEY_HASH, '203.0.113.77', '198.51.100.9', 'real-host-internal-1', 'nvme-SAMSUNG-990-PRO', '/data']) {
    assert.equal(text.includes(leak), false, `公开响应泄露了内部值：${leak}`);
  }
  // 关键名本身也不得出现（防止"字段名在、值为 null"这种半吊子脱敏被当成通过）
  const host = res.items.find((item) => item.slug === slugOf(A1));
  for (const key of ['id', 'last_ip', 'reported_ip', 'tags', 'clock_drift_ms', 'ip_flapping', 'active_alerts', 'display_name']) {
    assert.equal(key in host, false, `公开条目不得含字段 ${key}`);
  }
  // 白名单字段一个都不少
  assert.deepEqual(Object.keys(host).sort(), ['last_seen_ago', 'last_seen_at', 'name', 'os', 'probes', 'slug', 'snapshot', 'status', 'uptime']);
});

test('公开列表：snapshot 逐槽位推导（含窗口外数据不得当"旧值"返回）', async () => {
  await seedStandardWorld();
  const body = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  const bySlug = publicBySlug(body);

  const a1 = bySlug[slugOf(A1)];
  assert.deepEqual(a1.snapshot, {
    cpu_pct: 23.8,
    mem_pct: 38.1,
    disk_pct: 80, // 两个挂载点取 MAX（80.04 → 80.0）
    net_rx_bps: 1_468_006.4,
    net_tx_bps: 4_089_446.4,
    gpu_pct: 44.4,
  });

  // A2 只有 mem.used / mem.total ⇒ mem_pct 兜底为 25，其余为 null
  assert.deepEqual(bySlug[slugOf(A2)].snapshot, {
    cpu_pct: null,
    mem_pct: 25,
    disk_pct: null,
    net_rx_bps: null,
    net_tx_bps: null,
  });

  // A4 的数据在观测窗口（300s）之外 ⇒ 一律 null，⛔ **不是** 99.9
  assert.deepEqual(bySlug[slugOf(A4)].snapshot, {
    cpu_pct: null,
    mem_pct: null,
    disk_pct: null,
    net_rx_bps: null,
    net_tx_bps: null,
  });
  assert.ok(OBSERVATION_WINDOW_S === 300, '观测窗口是 5 分钟（20 × 上报周期）');
});

test('公开列表：probes 取**最近一轮**（不是最近 N 条、也不是全部历史）', async () => {
  await seedStandardWorld();
  const body = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  const bySlug = publicBySlug(body);

  assert.deepEqual(bySlug[slugOf(A1)].probes, { up: 2, down: 1 });
  // 从未探活 → 0/0（⛔ 不是 null，也不是"上一轮"的值）
  assert.deepEqual(bySlug[slugOf(A2)].probes, { up: 0, down: 0 });
});

test('公开列表：时间字段（last_seen_ago 分级文案 + last_seen_at 分钟级取整，⛔ 不暴露秒）', async () => {
  await seedStandardWorld();
  const body = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  const bySlug = publicBySlug(body);

  const a1 = bySlug[slugOf(A1)];
  assert.equal(a1.last_seen_ago, '刚刚'); // 10s
  assert.match(a1.last_seen_at, /:00\.000Z$/, '分钟级取整后秒必须恒为 00（防上下线行为指纹）');
  assert.equal(a1.uptime >= 3_723_838 && a1.uptime <= 3_723_845, true, `uptime 应约 43.1 天，实际 ${a1.uptime}`);
  assert.equal(a1.os, 'Ubuntu 24.04.1 LTS');
  assert.equal(a1.name, '主机甲', '显示名优先 display_name');

  assert.equal(bySlug[slugOf(A2)].last_seen_ago, '6 分钟前'); // 400s
  assert.equal(bySlug[slugOf(A2)].name, 'db-02', 'display_name 为空时回退 name');
  // ⚠️ 从未上报（last_seen_at IS NULL）：`last_seen_ago` 必须是 **null**，⛔ 不是「超过 30 天」——
  //    那句话等于声称"我们 30 天前见过它"，而事实是**一次都没见过**（与 snapshot 的
  //    「没有数据就是 null」同一条原则：⛔ 不用编造的值填满字段）。
  assert.equal(bySlug[slugOf(A5)].last_seen_ago, null);
  assert.equal(bySlug[slugOf(A5)].last_seen_at, null);
});

test('公开列表：排序「有问题优先」（非在线 → 有活动告警 → 在线 → last_seen_at DESC）', async () => {
  await seedStandardWorld();
  const body = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  const order = body.items.map((item) => item.slug);

  assert.deepEqual(order, [
    slugOf(A4), // offline（200s 前）
    slugOf(A2), // offline（400s 前）
    slugOf(A5), // offline（从未上报，last_seen_at NULL → NULLS LAST）
    slugOf(A1), // online 且有 firing 告警
    slugOf(A6), // online 且无告警
  ]);
});

// -----------------------------------------------------------------------------
// 响应级缓存（决策 D4）
// -----------------------------------------------------------------------------

test('公开列表：未命中缓存 = 3 条 SQL；命中缓存 = 0 条 SQL（✅ 方案 §4.4 的成本基准）', async () => {
  await seedStandardWorld();

  const before = sqlCount;
  const first = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  assert.equal(sqlCount - before, 3, 'agents+告警计数 / metrics 最新值 / 探活计数 各一条');
  assert.equal(redis.has(keys.snapshotPublicHosts), true, '未命中后必须写缓存');

  const afterFirst = sqlCount;
  const second = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  assert.equal(sqlCount, afterFirst, '命中缓存不得再打库');
  assert.deepEqual(second, first, '缓存命中的响应必须与首次逐字一致（含 updated_at）');
});

test('公开列表：缓存过期（TTL 由 PUBLIC_CACHE_TTL_S 决定）后重新查库', async () => {
  await seedStandardWorld();
  await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  const afterFirst = sqlCount;

  now += (CONFIG.rateLimit.publicCacheTtlS + 1) * 1000; // 让 fake redis 的 TTL 过期
  await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  assert.ok(sqlCount > afterFirst, 'TTL 过期后必须重新查库');
});

test('公开列表：PUBLIC_CACHE_TTL_S=0 关闭缓存（一条 Redis 命令都不发）', async () => {
  await seedStandardWorld();
  const noCache = loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/vantage',
      SECRET_KEY: Buffer.alloc(32, 11).toString('base64'),
      PUBLIC_CACHE_TTL_S: '0',
    },
    { skipEnvFile: true },
  );
  assert.equal(noCache.rateLimit.publicCacheTtlS, 0);
  redis.commands.length = 0;

  await listPublicHosts({ pool, redis, config: noCache, logger: silentLogger });
  assert.equal(redis.commands.length, 0, '关缓存时不得发 get/set');
});

test('公开列表：缓存**读失败/写失败/内容损坏**都不得影响响应（缓存是优化，不是依赖）', async () => {
  await seedStandardWorld();

  const brokenGet = { ...redis, get: async () => { throw new Error('redis down'); } };
  const readFailed = await listPublicHosts({ pool, redis: brokenGet, config: CONFIG, logger: silentLogger });
  assert.ok(readFailed.items.length > 0, '缓存读失败 → 按未命中处理，直接查库');

  const brokenSet = { ...redis, set: async () => { throw new Error('redis down'); } };
  const writeFailed = await listPublicHosts({ pool, redis: brokenSet, config: CONFIG, logger: silentLogger });
  assert.ok(writeFailed.items.length > 0, '缓存写失败 → 只 warn，响应照常');

  await redis.set(keys.snapshotPublicHosts, '{这不是 JSON');
  const corrupted = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  assert.ok(corrupted.items.length > 0, '缓存损坏 → 按未命中处理');
});

// -----------------------------------------------------------------------------
// 汇总计数
// -----------------------------------------------------------------------------

test('公开汇总：total = online + offline + disabled（disabled 不计入另两个）', async () => {
  await seedStandardWorld();
  const summary = await getPublicSummary({ pool, redis, config: CONFIG, logger: silentLogger });

  assert.deepEqual(
    { total: summary.total, online: summary.online, offline: summary.offline, disabled: summary.disabled },
    { total: 6, online: 2, offline: 3, disabled: 1 },
  );
  assert.equal(summary.online + summary.offline + summary.disabled, summary.total);
  assert.equal(typeof summary.updated_at, 'string');

  // ⚠️ 与 /hosts 的口径一致性：列表里出现的台数 = total - disabled
  const list = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  assert.equal(list.items.length, summary.total - summary.disabled);
});

test('公开汇总：alerts 按规则严重度统计 firing 事件（本期恒 0 —— 告警引擎在 M3）', async () => {
  await seedStandardWorld({ withAlert: false });
  const empty = await getPublicSummary({ pool, redis, config: CONFIG, logger: silentLogger });
  assert.deepEqual(empty.alerts, { critical: 0, warn: 0, info: 0 }, '没有告警时必须是三个 0，而不是报错');

  // 造一条 firing 事件：验证**查询本身**正确（跨 alert_events × alert_rules 的 JOIN 与分组）。
  // ⛔ 这不代表"告警引擎已实现"——引擎仍属 M3，本用例只证明 M3 落地后本字段会自动变对。
  await seedFiringAlert(A1, 'warn');
  now += (CONFIG.rateLimit.publicCacheTtlS + 1) * 1000;
  const withAlert = await getPublicSummary({ pool, redis, config: CONFIG, logger: silentLogger });
  assert.deepEqual(withAlert.alerts, { critical: 0, warn: 1, info: 0 });
});

test('公开汇总：一条 SQL 就能拿到计数（与 /hosts 共用同一份派生判定）', async () => {
  await seedStandardWorld();
  const before = sqlCount;
  await getPublicSummary({ pool, redis, config: CONFIG, logger: silentLogger });
  assert.equal(sqlCount - before, 3, '主机计数 / 告警计数 / DB 时钟');
});

// -----------------------------------------------------------------------------
// 私有列表
// -----------------------------------------------------------------------------

test('私有列表：三态齐全 + 运维字段（IP / 漂移 / Flapping / 活动告警 / 精确 last_seen_at）', async () => {
  await seedStandardWorld();
  const body = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger });
  const bySlug = publicBySlug(body);

  const a1 = bySlug[slugOf(A1)];
  assert.equal(a1.id, A1, '私有接口必须给出内部 UUID（面板要靠它调详情/时序接口）');
  assert.equal(a1.status, 'online');
  assert.equal(a1.last_ip, '203.0.113.77');
  assert.equal(a1.reported_ip, '198.51.100.9');
  assert.equal(a1.clock_drift_ms, -1234, '符号口径：负值 = Agent 慢');
  assert.equal(a1.ip_flapping, true);
  assert.equal(typeof a1.flapping_since, 'string');
  assert.equal(a1.active_alerts, 1);
  assert.deepEqual(a1.tags, ['prod', 'web']);
  assert.equal(a1.display_name, '主机甲');
  assert.equal(a1.arch, 'x86_64');
  // ⚠️ 私有侧 last_seen_at 是**精确值**（docs/api.md §4.2），⛔ 不做分钟级取整。
  //    ⛔ 这里不断言"毫秒不为 000"——`now()` 的微秒部分是随机的，那样写有 1/1000 的偶发红。
  //    改为与公开侧的取整值对照：精确值必然落在 [取整值, 取整值 + 60s) 里。
  assert.match(a1.last_seen_at, /\.\d{3}Z$/);
  const publicBody = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  const floored = publicBySlug(publicBody)[slugOf(A1)].last_seen_at;
  assert.equal(Date.parse(floored) % 60_000, 0, '公开侧必须是分钟级取整');
  assert.ok(
    Date.parse(a1.last_seen_at) >= Date.parse(floored) && Date.parse(a1.last_seen_at) - Date.parse(floored) < 60_000,
    `私有精确值（${a1.last_seen_at}）应落在公开取整值（${floored}）之后的同一分钟内`,
  );
  assert.equal(a1.snapshot.cpu_pct, 23.8);
  assert.deepEqual(a1.probes, { up: 2, down: 1 });

  // disabled 也必须在私有列表里（三态齐全），且 last_seen_ago 为 null
  assert.equal(bySlug[slugOf(A3)].status, 'disabled');
  assert.equal(bySlug[slugOf(A3)].last_seen_ago, null);
});

test('私有列表：⛔ 不得出现凭证列（agent_key_hash / agent_secret_enc / host_info 原始对象）', async () => {
  await seedStandardWorld();
  const body = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger });
  const text = JSON.stringify(body);

  assert.equal(text.includes(AGENT_KEY_HASH), false);
  assert.equal(text.includes('v1:AAAA:BBBB:CCCC'), false);
  assert.equal(text.includes('real-host-internal-1'), false, '⛔ host_info 必须逐字段投影，整体回显会连 hostname/device 一起泄出去');
  assert.equal(text.includes('nvme-SAMSUNG-990-PRO'), false);
  for (const key of ['agent_key_hash', 'agent_secret_enc', 'host_info', 'capabilities']) {
    assert.equal(key in body.items[0], false, `私有条目不得含字段 ${key}`);
  }
});

test('私有列表：?status= 过滤的是**推导后**的值（失联的 online 机器不得被当成在线返回）', async () => {
  await seedStandardWorld();

  const online = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger, status: 'online' });
  assert.deepEqual(online.items.map((item) => item.slug).sort(), [slugOf(A1), slugOf(A6)].sort());

  const offline = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger, status: 'offline' });
  assert.deepEqual(offline.items.map((item) => item.slug), [slugOf(A4), slugOf(A2), slugOf(A5)]);

  const disabled = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger, status: 'disabled' });
  assert.deepEqual(disabled.items.map((item) => item.slug), [slugOf(A3)]);
});

test('私有列表：排序与公开侧同一套（disabled/offline 在前，含 disabled）', async () => {
  await seedStandardWorld();
  const body = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger });
  assert.deepEqual(body.items.map((item) => item.slug), [
    slugOf(A3), // disabled（最近 30s 前上报过，故在同组内排最前）
    slugOf(A4),
    slugOf(A2),
    slugOf(A5),
    slugOf(A1),
    slugOf(A6),
  ]);
});

test('私有列表：q 模糊搜索转义 LIKE 元字符（⛔ `_` 不得变成通配符）', async () => {
  await seedStandardWorld();
  await seedAgent({ id: A7, name: 'a_b', status: 'online', ageSeconds: 5 });
  await seedAgent({ id: A8, name: 'axb', status: 'online', ageSeconds: 5 });

  // ⚠️ 传**原样文本**（转义由 agent.repo.js 做）；⛔ 不要在这里手动转义，
  //    否则会与实现双重转义，测试反而变成"验证了一个谁都不会用的调用方式"。
  const body = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger, q: 'a_b' });
  // ⚠️ 按 id 断言而不是按 name：`name` 字段是**显示名**
  //    （A1 的 `name` 列是 `web%01`，但回显的是 display_name「主机甲」），按 name 断言会引入这种歧义。
  assert.deepEqual(body.items.map((item) => item.id), [A7], '未经转义时 axb（A8）也会被 LIKE 命中');

  const percent = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger, q: 'web%01' });
  assert.deepEqual(percent.items.map((item) => item.id), [A1], '`%` 必须是字面量而不是通配符');

  // 反斜杠自身也要能搜（用户可能真的在找名字里带 `\` 的机器）
  await run(`UPDATE agents SET name = $2 WHERE id = $1`, [A8, 'back\\slash']);
  const slash = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger, q: 'back\\slash' });
  assert.deepEqual(slash.items.map((item) => item.id), [A8]);
});

test('私有列表：tag 过滤（tags @> [x]）', async () => {
  await seedStandardWorld();
  const prod = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger, tag: 'prod' });
  assert.deepEqual(prod.items.map((item) => item.slug).sort(), [slugOf(A1), slugOf(A2)].sort());

  const none = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger, tag: '不存在' });
  assert.deepEqual(none.items, []);
});

test('私有列表：limit 生效且 next_cursor 恒为 null（本期无真游标）', async () => {
  await seedStandardWorld();
  const body = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger, limit: 2 });
  assert.equal(body.items.length, 2);
  assert.equal(body.next_cursor, null);
  // 形状合规（docs/api.md §1.2 ③）：⛔ 不得返回假游标让前端以为要翻页
  assert.deepEqual(Object.keys(body).sort(), ['items', 'next_cursor', 'updated_at']);
});

test('私有列表：limit 上限可被调用方使用（页大小上限 = 200，超过由路由层夹取）', async () => {
  await seedStandardWorld();
  const body = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger, limit: PANEL_LIMIT_MAX });
  assert.equal(body.items.length, 6);
});

// -----------------------------------------------------------------------------
// 边界：阈值与扫描任务同源
// -----------------------------------------------------------------------------

test('读路径与 offline_sweep **同源**：阈值 ±1s 两侧判定必须一致（⛔ 不允许出现两份判定式）', async () => {
  // 阈值 = 90s（30s × 3）。89s → online；91s → offline。
  await seedAgent({ id: A1, name: 'edge-online', status: 'online', ageSeconds: THRESHOLD_S - 1 });
  await seedAgent({ id: A2, name: 'edge-offline', status: 'online', ageSeconds: THRESHOLD_S + 1 });

  const body = await listPublicHosts({ pool, redis, config: CONFIG, logger: silentLogger });
  const bySlug = publicBySlug(body);
  assert.equal(
    bySlug[makeSlug('edge-online')].status,
    'online',
    `阈值 ${THRESHOLD_S}s 内必须判在线（否则正常上报的机器会随机闪离线）`,
  );
  assert.equal(bySlug[makeSlug('edge-offline')].status, 'offline');
});

test('读路径：阈值随 OFFLINE_CYCLES_MULTIPLIER 走，⛔ 不写死 90s', async () => {
  const loose = loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/vantage',
      SECRET_KEY: Buffer.alloc(32, 11).toString('base64'),
      OFFLINE_CYCLES_MULTIPLIER: '5', // 阈值 → 150s
    },
    { skipEnvFile: true },
  );
  assert.equal(offlineThresholdS(loose), 150);

  await seedAgent({ id: A1, name: 'loose', status: 'online', ageSeconds: 120 }); // 120s：默认阈值下是 offline
  const body = await listPublicHosts({ pool, redis, config: loose, logger: silentLogger });
  assert.equal(body.items[0].status, 'online');
});

test('disabled 的高优先级：即使刚刚上报过也仍然是 disabled（人工状态不参与超时判定）', async () => {
  await seedAgent({ id: A1, name: 'just-disabled', status: 'disabled', ageSeconds: 1 });
  const body = await listPanelHosts({ pool, config: CONFIG, logger: silentLogger });
  assert.equal(body.items[0].status, 'disabled');
});
