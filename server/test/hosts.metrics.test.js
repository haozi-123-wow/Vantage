/**
 * 历史曲线接口测试（`GET /api/v1/hosts/{id}/metrics`，✅ 2026-10-05 定稿）
 *
 * 依据：docs/api.md §4.3、docs/api-status.md §4.8（决策记录 G1–G10）
 *
 * 本文件用**真 PGlite + 真 buildApp**：要验的结论全都长在"SQL 与 HTTP 的交界处"——
 *   ① `step=auto` 的选档规则必须**恰好复现**前端那 5 个预设按钮（这是它唯一的存在理由）；
 *   ② 缺失的桶**不补 0**（补了就把"采集断了"画成"CPU 掉到 0"）；
 *   ③ 两道闸门**先判后取**，且超限是 400 而不是截断；
 *   ④ `from`/`to` 回显的是**对齐后**的桶边界（前端画横轴要用它）。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { sessionCookieName } from '../src/middleware/authPanel.js';
import { createSession } from '../src/services/session.service.js';
import {
  METRIC_AGG_VALUES,
  METRIC_MAX_SERIES,
  METRIC_MAX_TOTAL_POINTS,
  resolveStep,
} from '../src/services/metricQuery.service.js';
import { PUBLIC_SLUG_ALPHABET } from '../src/utils/crypto.js';
import { createLogger } from '../src/utils/log.js';
import { createFakeRedisHash } from './helpers/fake-redis-hash.js';

// -----------------------------------------------------------------------------
// 真库（PGlite）
// -----------------------------------------------------------------------------
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

const USER_ID = '77777777-8888-9999-aaaa-bbbbbbbbbb00';
const A1 = '77777777-8888-9999-aaaa-bbbbbbbbbb01';
const MISSING = '77777777-8888-9999-aaaa-bbbbbbbbbb09';

/** 固定的时间基准（UTC 整 5 分钟），让桶对齐的断言可以写死 */
const BASE = new Date('2026-10-01T00:00:00.000Z');
const iso = (date) => date.toISOString();
/** BASE + N 秒 */
const plusS = (seconds) => new Date(BASE.getTime() + seconds * 1000);
/** 把时刻向下对齐到 N 秒的桶 */
const alignDown = (date, sizeS) => new Date(Math.floor(date.getTime() / (sizeS * 1000)) * sizeS * 1000);

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

async function seedAgent({ id = A1, name = 'web-01', status = 'online', ageSeconds = 5 }) {
  await run(
    `INSERT INTO agents (id, name, public_slug, agent_key_hash, agent_secret_enc, tags, status, last_seen_at)
     VALUES ($1, $2, $3, $4, 'v1:AAAA:BBBB:CCCC', '[]'::jsonb, $5,
             CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(secs => $6::double precision) END)`,
    [id, name, makeSlug(name), 'c'.repeat(64), status, ageSeconds],
  );
}

async function seedRaw({ metric = 'cpu.usage', value = 1, ts = BASE, labels = {}, agentId = A1 }) {
  await run(
    `INSERT INTO metrics_raw (agent_id, metric, value, labels, ts)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5::timestamptz)`,
    [agentId, metric, value, JSON.stringify(labels), ts],
  );
}

async function seedDownsampled(input) {
  const { table = 'metrics_1m', metric = 'cpu.usage', bucket = BASE, avg = 1, min = 1, max = 1, last = 1, n = 2, agentId = A1 } = input;
  assert.ok(table === 'metrics_1m' || table === 'metrics_5m', '表名必须是白名单里的降采样层');
  await run(
    `INSERT INTO ${table} (agent_id, metric, bucket, v_avg, v_min, v_max, v_last, n)
     VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6, $7, $8)`,
    [agentId, metric, bucket, avg, min, max, last, n],
  );
}

let app = null;
let redis = null;

beforeEach(async () => {
  if (app) await app.close();
  for (const table of ['metrics_raw', 'metrics_1m', 'metrics_5m']) {
    await run(`DELETE FROM ${table} WHERE agent_id = $1::uuid`, [A1]);
  }
  await run(`DELETE FROM agents WHERE id = $1::uuid`, [A1]);

  redis = createFakeRedisHash();
  app = await buildApp({ config: CONFIG, logger: SILENT, db: { app: pool, migrator: null }, redis });
});

async function mintSession(state = 'full', roles = ['admin']) {
  const { sid } = await createSession(redis, CONFIG, {
    userId: USER_ID,
    roles,
    totpOk: state === 'full',
    setupRequired: state === 'setup_required',
  });
  return { [COOKIE]: sid };
}

function metricsUrl(id, params) {
  return `/api/v1/hosts/${id}/metrics?${new URLSearchParams(params).toString()}`;
}

const get = (url, cookies) => app.inject({ method: 'GET', url, cookies: cookies ?? {} });

// -----------------------------------------------------------------------------
// 纯函数：选档规则
// -----------------------------------------------------------------------------

test('resolveStep：auto 的规则恰好复现前端 5 个预设按钮（1h→30s / 6h→30s / 24h→1m / 7d→5m / 30d→5m）', () => {
  const cases = [
    [3600, '30s'], // 120 点
    [6 * 3600, '30s'], // 720 点
    [24 * 3600, '1m'], // 1440 点（30s 会是 2880 点，超目标）
    [7 * 86400, '5m'], // 2016 点（1m 会是 10080 点）
    [30 * 86400, '5m'], // 8640 点（没得更粗了，只能 5m）
  ];
  for (const [spanS, expected] of cases) {
    assert.equal(resolveStep('auto', spanS), expected, `跨度 ${spanS}s`);
  }
  // 显式指定的档位必须被尊重（⛔ 不做"我比你更懂"的自动降档）
  assert.equal(resolveStep('1m', 24 * 3600), '1m');
  assert.equal(resolveStep('30s', 3600), '30s');
  // 门槛上的行为：30s 能撑到 16.6 小时（2000 × 30s），再多就落 1m
  assert.equal(resolveStep('auto', 2000 * 30), '30s');
  assert.equal(resolveStep('auto', 2000 * 30 + 1), '1m');
});

test('METRIC_AGG_VALUES：四种聚合都能从现成的列里读出来（avg/max/min/last）', () => {
  assert.deepEqual([...METRIC_AGG_VALUES], ['avg', 'max', 'min', 'last']);
});

// -----------------------------------------------------------------------------
// 参数校验
// -----------------------------------------------------------------------------

test('参数校验：metrics / from / to 缺失、枚举越界、非法指标名 → 400 schema_invalid（field 指名道姓）', async () => {
  await seedAgent({});
  const cookies = await mintSession();
  const window = { from: iso(BASE), to: iso(plusS(3600)) };
  const ok = { metrics: 'cpu.usage', ...window };

  const cases = [
    [`/api/v1/hosts/${A1}/metrics`, 'metrics'],
    [metricsUrl(A1, { ...ok, metrics: '' }), 'metrics'],
    // 21 个**去重之后**仍超限的元素（去重发生在"数条数"之前）
    [metricsUrl(A1, { ...ok, metrics: Array.from({ length: 21 }, (_, i) => String.fromCharCode(97 + i)).join(',') }), 'metrics'],
    [metricsUrl(A1, { metrics: 'cpu.usage', to: iso(plusS(3600)) }), 'from'],
    [metricsUrl(A1, { metrics: 'cpu.usage', from: iso(BASE) }), 'to'],
    [metricsUrl(A1, { ...ok, from: iso(plusS(3600)), to: iso(BASE) }), 'from'],
    [metricsUrl(A1, { ...ok, step: '15s' }), 'step'],
    [metricsUrl(A1, { ...ok, step: '1h' }), 'step'],
    [metricsUrl(A1, { ...ok, agg: 'p99' }), 'agg'],
    [metricsUrl(A1, { ...ok, include_n: 'yes' }), 'include_n'],
    [metricsUrl(A1, { ...ok, metrics: 'CPU.USAGE' }), 'metrics'],
    [metricsUrl(A1, { ...ok, metrics: 'a'.repeat(201) }), 'metrics'],
    [metricsUrl(A1, { ...ok, from: '2026-10-01 00:00:00' }), 'from'], // 裸时间串（无时区）必须拒绝
  ];

  for (const [url, field] of cases) {
    const res = await get(url, cookies);
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().error.code, 'schema_invalid', url);
    assert.equal(res.json().error.details.field, field, url);
  }

  // ⛔ 15s 是**硬删除**的档位（Agent 上报周期是 30s）：错误详情里必须能看到白名单
  const bad = await get(metricsUrl(A1, { ...ok, step: '15s' }), cookies);
  assert.deepEqual(bad.json().error.details.allowed, ['auto', '30s', '1m', '5m']);
});

// -----------------------------------------------------------------------------
// 基本形状与落桶
// -----------------------------------------------------------------------------

test('200：30s 档落桶、点用 [ts,value]、labels/base/unit 齐备，且窗口原样回显（已对齐）', async () => {
  await seedAgent({});
  await seedRaw({ value: 10, ts: plusS(0) });
  await seedRaw({ value: 20, ts: plusS(30) });
  await seedRaw({ value: 30, ts: plusS(60) });

  const res = await get(
    metricsUrl(A1, { metrics: 'cpu.usage', from: iso(BASE), to: iso(plusS(90)), step: '30s' }),
    await mintSession(),
  );
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(Object.keys(body).sort(), ['agg', 'from', 'host_id', 'series', 'step', 'to', 'updated_at']);
  assert.equal(body.host_id, A1);
  assert.equal(body.step, '30s');
  assert.equal(body.agg, 'avg');
  assert.equal(body.from, iso(BASE));
  assert.equal(body.to, iso(plusS(90)));
  assert.equal(body.series.length, 1);

  const [series] = body.series;
  assert.equal(series.metric, 'cpu.usage');
  assert.equal(series.base, 'cpu.usage');
  assert.deepEqual(series.labels, {});
  assert.equal(series.unit, '%');
  assert.deepEqual(series.points, [
    [plusS(0).getTime(), 10],
    [plusS(30).getTime(), 20],
    [plusS(60).getTime(), 30],
  ]);
});

test('落桶：同一 30s 桶内的多个样本按 avg 合并，且 ts 是桶起点（不补 0）', async () => {
  await seedAgent({});
  // 同一个 30s 桶（BASE..BASE+30）里的两个样本 → 合成一个点
  await seedRaw({ value: 1, ts: plusS(0) });
  await seedRaw({ value: 3, ts: plusS(10) });
  // 中间整段没有采集（BASE+30 / +60 / +90 三个桶都空）
  await seedRaw({ value: 8, ts: plusS(120) });

  const res = await get(
    metricsUrl(A1, { metrics: 'cpu.usage', from: iso(BASE), to: iso(plusS(150)), step: '30s', include_n: 'true' }),
    await mintSession(),
  );
  assert.equal(res.statusCode, 200);
  const [series] = res.json().series;

  // ⛔ 只有 2 个点：空洞**不补 0 也不补 null**（补 0 会把"采集断了"画成"CPU 掉到 0"）
  assert.deepEqual(series.points, [
    [plusS(0).getTime(), 2, 2],
    [plusS(120).getTime(), 8, 1],
  ]);
});

test('include_n=false（默认）时点是二元组；=true 时是 [ts,value,n]', async () => {
  await seedAgent({});
  await seedRaw({ value: 5, ts: plusS(0) });
  await seedRaw({ value: 7, ts: plusS(5) });

  const base = { metrics: 'cpu.usage', from: iso(BASE), to: iso(plusS(30)), step: '30s' };
  const without = await get(metricsUrl(A1, base), await mintSession());
  const withN = await get(metricsUrl(A1, { ...base, include_n: 'true' }), await mintSession());

  assert.deepEqual(without.json().series[0].points, [[plusS(0).getTime(), 6]]);
  assert.deepEqual(withN.json().series[0].points, [[plusS(0).getTime(), 6, 2]]);
});

test('窗口向外对齐：请求 00:00:07 → 00:00:08，回显 00:00:00 → 00:00:30（⛔ 第一个桶不许被丢掉）', async () => {
  await seedAgent({});
  await seedRaw({ value: 42, ts: plusS(10) }); // 落在对齐后的第一个桶 [0,30)

  const res = await get(
    metricsUrl(A1, { metrics: 'cpu.usage', from: iso(plusS(7)), to: iso(plusS(8)), step: '30s' }),
    await mintSession(),
  );
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.from, iso(plusS(0)), '下界必须**向下**取整');
  assert.equal(body.to, iso(plusS(30)), '上界必须**向上**取整（上界排他）');
  assert.deepEqual(body.series[0].points, [[plusS(0).getTime(), 42]]);
});

// -----------------------------------------------------------------------------
// 基名展开 / 聚合列
// -----------------------------------------------------------------------------

test('基名展开：disk.used_pct 展开成各挂载点；labels 反解出来；unit 来自 unitOf()', async () => {
  await seedAgent({});
  await seedRaw({ metric: 'disk.used_pct{device=sda1,mount=/data}', value: 12.5, ts: plusS(0) });
  await seedRaw({ metric: 'disk.used_pct{device=sdb1,mount=/}', value: 60, ts: plusS(0) });
  await seedRaw({ metric: 'mem.used_pct', value: 33, ts: plusS(0) }); // 不该被带出来

  const res = await get(
    metricsUrl(A1, { metrics: 'disk.used_pct', from: iso(BASE), to: iso(plusS(30)), step: '30s' }),
    await mintSession(),
  );
  assert.equal(res.statusCode, 200);
  const { series } = res.json();
  assert.equal(series.length, 2, '⛔ mem.used_pct 不能被 disk.used_pct 的前缀匹配带出来');
  assert.deepEqual(
    series.map((item) => [item.metric, item.base, item.labels, item.unit]),
    [
      ['disk.used_pct{device=sda1,mount=/data}', 'disk.used_pct', { device: 'sda1', mount: '/data' }, '%'],
      ['disk.used_pct{device=sdb1,mount=/}', 'disk.used_pct', { device: 'sdb1', mount: '/' }, '%'],
    ],
  );
});

test('同时请求"基名"和"它下面的某个全名"：同一条序列只出现一次（行级谓词天然去重）', async () => {
  await seedAgent({});
  await seedRaw({ metric: 'disk.used_pct{device=sda1,mount=/data}', value: 1, ts: plusS(0) });
  await seedRaw({ metric: 'disk.used_pct{device=sdb1,mount=/}', value: 2, ts: plusS(0) });

  const res = await get(
    metricsUrl(A1, {
      metrics: 'disk.used_pct,disk.used_pct{device=sda1,mount=/data}',
      from: iso(BASE),
      to: iso(plusS(30)),
      step: '30s',
    }),
    await mintSession(),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().series.length, 2);
});

test('全名精确匹配：只要一个挂载点时不展开（前端"只看根分区"就是这么发的）', async () => {
  await seedAgent({});
  await seedRaw({ metric: 'disk.used_pct{device=sda1,mount=/data}', value: 1, ts: plusS(0) });
  await seedRaw({ metric: 'disk.used_pct{device=sdb1,mount=/}', value: 2, ts: plusS(0) });

  const res = await get(
    metricsUrl(A1, { metrics: 'disk.used_pct{device=sdb1,mount=/}', from: iso(BASE), to: iso(plusS(30)), step: '30s' }),
    await mintSession(),
  );
  assert.equal(res.statusCode, 200);
  const { series } = res.json();
  assert.equal(series.length, 1);
  assert.equal(series[0].metric, 'disk.used_pct{device=sdb1,mount=/}');
  assert.deepEqual(series[0].points, [[plusS(0).getTime(), 2]]);
});

test('⛔ 顶层逗号切分：一条请求里写**两个带维度的全名**都要认（花括号里的逗号不是分隔符）', async () => {
  await seedAgent({});
  await seedRaw({ metric: 'disk.used_pct{device=sda1,mount=/data}', value: 1, ts: plusS(0) });
  await seedRaw({ metric: 'disk.used_pct{device=sdb1,mount=/}', value: 2, ts: plusS(0) });
  await seedRaw({ metric: 'mem.used_pct', value: 3, ts: plusS(0) });

  const res = await get(
    metricsUrl(A1, {
      // ⚠️ 这条用例是回归防线：`raw.split(',')` 会把下面两条全名各劈成两半（都变成非法名字 → 400）。
      //    全名的维度分隔符**就是逗号**，所以只能按花括号之外的逗号切。
      metrics: 'disk.used_pct{device=sda1,mount=/data},disk.used_pct{device=sdb1,mount=/}',
      from: iso(BASE),
      to: iso(plusS(30)),
      step: '30s',
    }),
    await mintSession(),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().series.map((item) => item.metric),
    ['disk.used_pct{device=sda1,mount=/data}', 'disk.used_pct{device=sdb1,mount=/}'],
  );
});

test('agg=avg|max|min|last：降采样层读的是**预先算好的四列**（不是重新算）', async () => {
  await seedAgent({});
  await seedDownsampled({ table: 'metrics_1m', avg: 10, min: 5, max: 99, last: 7, n: 4, bucket: BASE });

  const read = async (agg) => {
    const res = await get(
      metricsUrl(A1, { metrics: 'cpu.usage', from: iso(BASE), to: iso(plusS(60)), step: '1m', agg }),
      await mintSession(),
    );
    assert.equal(res.statusCode, 200, agg);
    const body = res.json();
    assert.equal(body.agg, agg);
    return body.series[0].points[0][1];
  };

  assert.equal(await read('avg'), 10);
  assert.equal(await read('max'), 99);
  assert.equal(await read('min'), 5);
  assert.equal(await read('last'), 7);
});

// -----------------------------------------------------------------------------
// step=auto 走真实链路
// -----------------------------------------------------------------------------

test('step=auto 走真实链路：同一批数据按 5 种窗口请求，回传的 step 与预设表逐条一致', async () => {
  await seedAgent({});
  // 三张表各埋一条（哪档被选中都能查到），位置放在 5 分钟前 —— 5 个窗口都覆盖得到
  const moment = new Date(Date.now() - 5 * 60 * 1000);
  await seedRaw({ metric: 'cpu.usage', value: 1, ts: moment });
  await seedDownsampled({ table: 'metrics_1m', bucket: alignDown(moment, 60) });
  await seedDownsampled({ table: 'metrics_5m', bucket: alignDown(moment, 300) });

  const now = new Date();
  const cases = [
    [3600, '30s'],
    [6 * 3600, '30s'],
    [24 * 3600, '1m'],
    [7 * 86400, '5m'],
    [30 * 86400, '5m'],
  ];

  for (const [spanS, expected] of cases) {
    const from = new Date(now.getTime() - spanS * 1000);
    const res = await get(
      metricsUrl(A1, { metrics: 'cpu.usage', from: iso(from), to: iso(now) }),
      await mintSession(),
    );
    assert.equal(res.statusCode, 200, `${spanS}s`);
    const body = res.json();
    assert.equal(body.step, expected, `跨度 ${spanS}s 应选 ${expected}`);
    assert.equal(body.series.length, 1, `${spanS}s 应当查到那条序列`);
    assert.ok(body.series[0].points.length >= 1, `${spanS}s 应当有至少一个点`);
    // 每条线的点数必须与档位自洽（= 窗口 ÷ 网格）
    const gridS = { '30s': 30, '1m': 60, '5m': 300 }[expected];
    const buckets = (Date.parse(body.to) - Date.parse(body.from)) / 1000 / gridS;
    assert.ok(buckets <= 2000 + 1 || spanS >= 7 * 86400, `${spanS}s 选 ${expected} 的点数应当受控`);
  }
});

// -----------------------------------------------------------------------------
// 两道闸门（⛔ 超限是 400，绝不截断）
// -----------------------------------------------------------------------------

test(`闸门 A：基名展开超过 ${METRIC_MAX_SERIES} 条 → 400 too_many_series（且错误里给出下界与收窄建议）`, async () => {
  await seedAgent({});
  for (let i = 1; i <= METRIC_MAX_SERIES + 1; i += 1) {
    const index = String(i).padStart(2, '0');
    await seedRaw({ metric: `disk.used_pct{device=sd${index},mount=/m${index}}`, value: i, ts: plusS(0) });
  }

  const cookies = await mintSession();
  const res = await get(
    metricsUrl(A1, { metrics: 'disk.used_pct', from: iso(BASE), to: iso(plusS(3600)), step: '30s' }),
    cookies,
  );
  assert.equal(res.statusCode, 400);
  const error = res.json().error;
  assert.equal(error.code, 'too_many_series');
  assert.equal(error.details.reason, 'series_limit');
  assert.equal(error.details.max_series, METRIC_MAX_SERIES);
  assert.equal(error.details.expanded_series_at_least, METRIC_MAX_SERIES + 1, '只取到"上限+1"条就停手');
  assert.ok(error.details.hint.includes('全名'), '提示必须告诉用户怎么办');

  // ✅ 按提示收窄成具体全名 → 立刻能查
  const narrowed = await get(
    metricsUrl(A1, {
      metrics: 'disk.used_pct{device=sd01,mount=/m01}',
      from: iso(BASE),
      to: iso(plusS(3600)),
      step: '30s',
    }),
    cookies,
  );
  assert.equal(narrowed.statusCode, 200);
  assert.equal(narrowed.json().series.length, 1);
});

test(`闸门 B：30 天档 6 条序列的总点数超 ${METRIC_MAX_TOTAL_POINTS} → 400，并给出"本范围最多几条"`, async () => {
  await seedAgent({});
  // 窗口两端都落在 5 分钟边界上 ⇒ 桶数恒为 8640，断言可以写死（不用 now，避免跨桶抖动）
  const from = BASE;
  const to = plusS(30 * 86400);
  const bucket = alignDown(plusS(3600), 300);
  const metricOf = (i) => `disk.used_pct{device=d${String(i).padStart(2, '0')},mount=/m${String(i).padStart(2, '0')}}`;
  for (let i = 1; i <= 6; i += 1) {
    await seedDownsampled({ table: 'metrics_5m', metric: metricOf(i), bucket });
  }

  const cookies = await mintSession();
  const window = { from: iso(from), to: iso(to) };

  const res = await get(metricsUrl(A1, { metrics: 'disk.used_pct', step: '5m', ...window }), cookies);
  assert.equal(res.statusCode, 400);
  const error = res.json().error;
  assert.equal(error.code, 'too_many_series');
  assert.equal(error.details.reason, 'point_budget');
  assert.equal(error.details.points_per_series, 8640, '30 天 ÷ 5 分钟 = 8640 点/条');
  assert.equal(error.details.series, 6);
  assert.equal(error.details.requested_points, 6 * 8640);
  // 前端拿这个数去限制勾选框：30 天档最多同时看 5 条
  assert.equal(error.details.max_series_at_this_range, 5);

  // 降到 5 条 → 放行（43,200 ≤ 50,000）
  await run(`DELETE FROM metrics_5m WHERE agent_id = $1::uuid AND metric = $2`, [A1, metricOf(6)]);
  const ok = await get(metricsUrl(A1, { metrics: 'disk.used_pct', step: '5m', ...window }), cookies);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().series.length, 5);
});

test('跨度护栏：超出该档上限 → 400 range_too_large；超过 30 天全局上限 → 同样拒绝', async () => {
  await seedAgent({});
  const cookies = await mintSession();

  const tooWide = await get(
    metricsUrl(A1, { metrics: 'cpu.usage', from: iso(BASE), to: iso(plusS(48 * 3600)), step: '30s' }),
    cookies,
  );
  assert.equal(tooWide.statusCode, 400);
  assert.equal(tooWide.json().error.code, 'range_too_large');
  assert.deepEqual(tooWide.json().error.details.max_span_s, 24 * 3600);

  // 31 天：任何档位都不允许（系统对外只承诺 30 天）
  const global = await get(
    metricsUrl(A1, { metrics: 'cpu.usage', from: iso(BASE), to: iso(plusS(31 * 86400)) }),
    cookies,
  );
  assert.equal(global.statusCode, 400);
  assert.equal(global.json().error.code, 'range_too_large');
  assert.equal(global.json().error.details.max_span_s, 30 * 86400);
});

// -----------------------------------------------------------------------------
// 边界与守卫
// -----------------------------------------------------------------------------

test('指标名合法但该机没有 → 200 + series: []（⛔ "没有 GPU" 不是客户端的错）', async () => {
  await seedAgent({});
  await seedRaw({ metric: 'cpu.usage', value: 1, ts: plusS(0) });

  const res = await get(
    metricsUrl(A1, { metrics: 'gpu.util', from: iso(BASE), to: iso(plusS(3600)), step: '30s' }),
    await mintSession(),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().series, []);
});

test('主机不存在 → 404；id 不是 UUID → 400 schema_invalid（⛔ 不让它撞到 SQL 的 22P02）', async () => {
  await seedAgent({});
  const cookies = await mintSession();
  const params = { metrics: 'cpu.usage', from: iso(BASE), to: iso(plusS(3600)) };

  const missing = await get(metricsUrl(MISSING, params), cookies);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'not_found');

  const badId = await get(metricsUrl('not-a-uuid', params), cookies);
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.json().error.code, 'schema_invalid');
});

test('守卫：未登录 401、受限态 403；但**不要求 admin**（普通 user 也能看曲线）', async () => {
  await seedAgent({});
  await seedRaw({ value: 1, ts: plusS(0) });
  const url = metricsUrl(A1, { metrics: 'cpu.usage', from: iso(BASE), to: iso(plusS(3600)), step: '30s' });

  assert.equal((await get(url)).statusCode, 401);
  assert.equal((await get(url, await mintSession('totp_pending'))).statusCode, 403);
  assert.equal(
    (await get(url, await mintSession('setup_required'))).json().error.code,
    'totp_setup_required',
  );
  assert.equal((await get(url, await mintSession('full', ['user']))).statusCode, 200);
});
