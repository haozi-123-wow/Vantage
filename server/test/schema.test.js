/**
 * 真实数据库结构验证 —— 把 server/migrations/*.sql 逐条跑在**真正的 PostgreSQL** 上
 *
 * 为什么用 PGlite：它把 PostgreSQL 编译成 WASM 在**本进程内**运行，因此
 *   · 不需要 Docker / 不需要本机装 PG / 不需要网络；
 *   · 不受受限沙箱「禁止子进程命名管道」的影响（`node --test` 会 spawn EPERM 的那类问题）；
 *   · 跑的是真 PG 解析器与执行器：DDL 语法、约束、分区、触发器、权限都是**真验证**，不是字符串匹配。
 *
 * ⚠️ 版本差异：PGlite 当前内置的是 PostgreSQL 18.x，而部署目标是 **16**。
 *    本文件用到的特性全部是 PG 9.4–13 就稳定的（declarative partitioning / BRIN / jsonb /
 *    `gen_random_uuid()` / `ALTER DEFAULT PRIVILEGES` / `to_regclass`），因此 16 上同样成立；
 *    但**首次上真库前仍应在一台 PG 16 上跑一次 `npm run migrate`**（见 migrations/README.md §7）。
 *
 * 迁移通过 `scripts/migrate.js` 的 `applyOne()` 应用 —— 与生产走**同一条代码路径**，
 * 因此本文件也顺带验证了运行器的「单事务 + 写 schema_migrations」逻辑。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { buildMetric } from '../src/utils/metric.js';

/** 今天（UTC）的日期字符串，与分区函数口径一致 */
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** PGlite 的 date 列可能是 Date 也可能是字符串，统一成 YYYY-MM-DD */
const asDay = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

/** 文档 §3 表清单（去掉 §3 里重复编号的 `user_recovery_codes`/`agent_ip_history` 后共 17 张） */
const EXPECTED_TABLES = [
  'agents',
  'users',
  'user_recovery_codes',
  'agent_ip_history',
  'ip_change_events',
  'metrics_raw',
  'metrics_1m',
  'metrics_5m',
  'process_snapshots',
  'probe_results',
  'alert_rules',
  'channels',
  'alert_events',
  'notification_log',
  'silences',
  'audit_logs',
  'settings',
];

const db = await PGlite.create();

// --- 准备：角色先建好，这样迁移 0008 的授权分支才会真正跑到 -------------------
await db.exec(`
  CREATE ROLE vantage_migrator LOGIN;
  CREATE ROLE vantage_app LOGIN;
  CREATE ROLE vantage_ro LOGIN;
`);

// --- 应用全部迁移（与生产同一条代码路径）------------------------------------
await db.exec(BOOTSTRAP_SQL);

const migrations = loadMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
/** PGlite 适配器：无参数语句走 exec（允许一次多条），带参数走 query（扩展协议） */
const client = {
  query: (sql, params) => (Array.isArray(params) && params.length > 0 ? db.query(sql, params) : db.exec(sql)),
};

for (const migration of migrations) {
  await applyOne(client, migration, false);
}

after(async () => {
  await db.close();
});

// -----------------------------------------------------------------------------
// 助手
// -----------------------------------------------------------------------------

async function count(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return Number(rows[0].n);
}

/** 断言某条 SQL 因指定 SQLSTATE 失败（23514=CHECK / 23505=UNIQUE / 23503=FK / 23502=NOT NULL） */
async function expectSqlError(sql, params, sqlState) {
  try {
    if (Array.isArray(params) && params.length > 0) await db.query(sql, params);
    else await db.exec(sql);
  } catch (err) {
    assert.equal(err.code, sqlState, `期望 SQLSTATE ${sqlState}，实际 ${err.code}：${err.message}`);
    return err;
  }
  assert.fail(`该语句本应失败（${sqlState}）：${sql}`);
}

const VALID_ENVELOPE = 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAA';
const KEY_HASH = 'a'.repeat(64);

/**
 * 由名字派生一个**必然合法**的 public_slug。
 * ⚠️ 字符集必须与迁移 0003 的 CHECK 以及 crypto.js 的 PUBLIC_SLUG_ALPHABET 一致：
 *    排除易混字符 0 O 1 l I —— 手写 slug 极易踩到 'l'/'1'，所以这里统一派生。
 */
const SLUG_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function makeSlug(seed) {
  let x = 7;
  for (const ch of seed) x = (x * 31 + ch.codePointAt(0)) % 2_147_483_647;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_647;
    out += SLUG_ALPHABET[x % SLUG_ALPHABET.length];
  }
  return out;
}

/** 插入一台合法 agent，返回其 id（slug 由 name 派生，保证唯一且合法） */
async function insertAgent(name = 'node-a', slug = makeSlug(name)) {
  const { rows } = await db.query(
    `INSERT INTO agents (name, public_slug, agent_key_hash, agent_secret_enc)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, KEY_HASH, VALID_ENVELOPE],
  );
  return rows[0].id;
}

/** 共享夹具：后续多个用例都引用这台"基础主机"（必须在上面的助手之后创建） */
const NODE_A_ID = await insertAgent('node-a');

// -----------------------------------------------------------------------------
// 1. 结构
// -----------------------------------------------------------------------------

test('全部 17 张业务表均已创建，且类型/分区形态正确', async () => {
  for (const table of EXPECTED_TABLES) {
    const { rows } = await db.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${table}`]);
    assert.equal(rows[0].exists, true, `表不存在：${table}`);
  }

  // metrics_raw 必须是分区父表；其降采样层是普通表（✅ R14）
  const { rows } = await db.query(
    `SELECT relname, relkind, relispartition
       FROM pg_class WHERE relname IN ('metrics_raw', 'metrics_raw_default', 'metrics_1m', 'metrics_5m')`,
  );
  const byName = Object.fromEntries(rows.map((r) => [r.relname, r]));
  assert.equal(byName.metrics_raw.relkind, 'p', 'metrics_raw 必须是分区父表');
  assert.equal(byName.metrics_raw_default.relispartition, true, 'metrics_raw_default 必须是 DEFAULT 分区');
  assert.equal(byName.metrics_1m.relkind, 'r', 'metrics_1m 不应分区（✅ R14）');
  assert.equal(byName.metrics_5m.relkind, 'r', 'metrics_5m 不应分区（✅ R14）');

  // 时序三表必须挂上指标名校验。
  // ⚠️ 注意：父表上的 CHECK 会被**每个分区继承一份同名约束**，
  //    所以按 conname 全局计数会得到「父表 + 各分区」的合计，必须限定到具体关系。
  const { rows: checks } = await db.query(
    `SELECT conrelid::regclass::text AS tbl, count(*)::int AS n
       FROM pg_constraint
      WHERE conname IN ('metrics_raw_metric_ck', 'metrics_1m_metric_ck', 'metrics_5m_metric_ck')
      GROUP BY 1`,
  );
  const byTable = Object.fromEntries(checks.map((r) => [r.tbl, r.n]));
  assert.ok(byTable.metrics_raw >= 1, 'metrics_raw 缺少指标名校验（或校验未下推到分区）');
  assert.equal(byTable.metrics_1m, 1);
  assert.equal(byTable.metrics_5m, 1);
  // 分区确实继承到了校验（否则分区表可以绕过基名规范）
  assert.ok(
    checks.filter((r) => r.tbl.startsWith('metrics_raw_')).length > 1,
    'CHECK 约束未下推到 metrics_raw 的分区',
  );
});

test('迁移记录写入 schema_migrations（与运行器同一路径）', async () => {
  assert.equal(await count('SELECT count(*)::int AS n FROM schema_migrations'), migrations.length);
  const { rows } = await db.query('SELECT version, filename, checksum FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((r) => r.filename), migrations.map((m) => m.filename));
  for (const [i, row] of rows.entries()) assert.equal(row.checksum, migrations[i].checksum);
});

test('🚫 单向宗旨：库里不存在任何"待下发/指令"类表（设计 §2.1）', async () => {
  const { rows } = await db.query(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND (tablename ~ 'command|task|instruction|queue|pending|download|dispatch|job' )`,
  );
  assert.deepEqual(rows, [], '数据层出现了疑似下发/指令表');
});

// -----------------------------------------------------------------------------
// 2. 分区维护
// -----------------------------------------------------------------------------

test('迁移时已预建「今天 + 未来 7 天」分区，DEFAULT 兜底分区存在', async () => {
  const { rows } = await db.query('SELECT * FROM vantage_metrics_raw_partitions()');
  const days = rows.map((r) => asDay(r.partition_day));

  assert.equal(days.length, 8, `应有 8 个按天分区，实际 ${days.length}：${days.join(', ')}`);
  assert.equal(days[0], todayUtc());
  assert.equal(days.includes('metrics_raw_default'), false, 'partitions() 不应返回 DEFAULT 分区');
  assert.deepEqual(
    days,
    [...days].sort(),
    '分区必须按日期升序返回（Drop 任务依赖顺带语义）',
  );
});

test('分区函数幂等：重复调用不报错，且新分区自带 BRIN 索引', async () => {
  const future = '2031-03-04';
  const first = await db.query('SELECT vantage_ensure_metrics_raw_partition($1) AS name', [future]);
  assert.equal(first.rows[0].name, 'metrics_raw_20310304');
  const second = await db.query('SELECT vantage_ensure_metrics_raw_partition($1) AS name', [future]);
  assert.equal(second.rows[0].name, 'metrics_raw_20310304');

  const { rows } = await db.query(
    `SELECT i.relname, am.amname
       FROM pg_class i
       JOIN pg_index x ON x.indexrelid = i.oid
       JOIN pg_am am ON am.oid = i.relam
      WHERE i.relname LIKE 'metrics_raw_20310304%'`,
  );
  assert.ok(rows.some((r) => r.amname === 'brin'), '新分区缺少 BRIN(ts) 索引');
});

test('DEFAULT 分区的陷阱可复现：先落进 DEFAULT 的行会挡住后续建分区', async () => {
  const agentId = await insertAgent('trap-agent');
  // 一个远期日期：此刻还没有对应分区，于是落进 DEFAULT
  await db.query('INSERT INTO metrics_raw (agent_id, metric, value, ts) VALUES ($1, $2, $3, $4)', [
    agentId,
    'cpu.usage',
    1,
    '2032-05-05T00:00:00Z',
  ]);
  assert.equal(await count('SELECT count(*)::int AS n FROM metrics_raw_default'), 1);

  // 现在为该天建分区 → 必须失败（PG 需要保证 DEFAULT 里没有属于新范围的行）
  const err = await expectSqlError("SELECT vantage_ensure_metrics_raw_partition('2032-05-05')", [], '23514');
  assert.match(err.message, /partition|constraint/i);

  // 清理，避免污染后续断言
  await db.query('DELETE FROM metrics_raw WHERE ts = $1', ['2032-05-05T00:00:00Z']);
  await db.query("SELECT vantage_ensure_metrics_raw_partition('2032-05-05')");
  assert.ok(await count("SELECT count(*)::int AS n FROM vantage_metrics_raw_partitions() WHERE partition_day = '2032-05-05'"));
});

// -----------------------------------------------------------------------------
// 3. 指标层语义（✅ R5 + §5.7.2）
// -----------------------------------------------------------------------------

test('指标名：JS 端 buildMetric 的产出必须被库层校验器全部接受（同源一致性）', async () => {
  const agentId = await insertAgent('metrics-agent');

  const produced = [
    buildMetric('cpu.usage'),
    buildMetric('cpu.core.usage', { core: 0 }),
    buildMetric('cpu.load1'),
    buildMetric('mem.used_pct'),
    buildMetric('swap.used_pct'),
    buildMetric('disk.used_pct', { mount: '/' }),
    buildMetric('disk.used_pct', { device: 'sda1', mount: '/data' }),
    buildMetric('disk.latency_ms', { device: 'nvme0n1p1', mount: '/var/lib/docker' }),
    buildMetric('net.rx_bps', { device: 'eth0' }),
    buildMetric('gpu.util', { index: 0 }),
    buildMetric('process.count'),
    buildMetric('disk.used_pct', { mount: '/data,a=b' }), // 含转义字符
    buildMetric('disk.used_pct', { mount: '/data 空间' }),
  ];

  for (const metric of produced) {
    await db.query('INSERT INTO metrics_raw (agent_id, metric, value, ts) VALUES ($1, $2, $3, $4)', [
      agentId,
      metric,
      1.5,
      new Date().toISOString(),
    ]);
  }
  assert.equal(await count('SELECT count(*)::int AS n FROM metrics_raw WHERE agent_id = $1', [agentId]), produced.length);

  // 反向：库层必须拒绝畸形指标名（大写基名、空维度块、裸空格、未转义的 = 或 ,）
  for (const bad of ['CPU.usage', 'cpu.usage{}', 'cpu usage', 'cpu.usage{a=1 b=2}', 'cpu.usage{a=1}b', 'Disk.Used_Pct']) {
    await expectSqlError(
      `INSERT INTO metrics_raw (agent_id, metric, value, ts) VALUES ('${agentId}', '${bad}', 1, now())`,
      [],
      '23514',
    );
  }

  // 超长（>200）也必须被拒
  await expectSqlError(
    `INSERT INTO metrics_raw (agent_id, metric, value, ts) VALUES ('${agentId}', 'disk.used_pct{mount=/${'x'.repeat(190)}}', 1, now())`,
    [],
    '23514',
  );
});

test('metrics_raw：主键区分维度序列，同序列同刻重复即冲突；NaN/Infinity 被拒', async () => {
  const agentId = await insertAgent('pk-agent');
  const ts = '2026-01-01T00:00:00Z';

  // ✅ R5：维度进了指标名，因此两个挂载点可同时存在（旧方案会主键冲突互相覆盖）
  await db.query('INSERT INTO metrics_raw (agent_id, metric, value, ts) VALUES ($1, $2, 1, $3)', [
    agentId,
    'disk.used_pct{mount=/}',
    ts,
  ]);
  await db.query('INSERT INTO metrics_raw (agent_id, metric, value, ts) VALUES ($1, $2, 2, $3)', [
    agentId,
    'disk.used_pct{mount=/data}',
    ts,
  ]);
  assert.equal(await count('SELECT count(*)::int AS n FROM metrics_raw WHERE agent_id = $1', [agentId]), 2);

  await expectSqlError(
    `INSERT INTO metrics_raw (agent_id, metric, value, ts) VALUES ('${agentId}', 'disk.used_pct{mount=/}', 3, '${ts}')`,
    [],
    '23505',
  );

  // isfinite 拒绝 NaN 与 ±Infinity（否则会污染 avg/min/max 降采样）
  await expectSqlError(
    `INSERT INTO metrics_raw (agent_id, metric, value, ts) VALUES ('${agentId}', 'cpu.usage', 'NaN', now())`,
    [],
    '23514',
  );
  await expectSqlError(
    `INSERT INTO metrics_raw (agent_id, metric, value, ts) VALUES ('${agentId}', 'cpu.usage', 'Infinity', now())`,
    [],
    '23514',
  );
  // labels 必须是对象，⛔ 不能是数组/字符串
  await expectSqlError(
    `INSERT INTO metrics_raw (agent_id, metric, value, labels, ts) VALUES ('${agentId}', 'cpu.usage', 1, '[]', now())`,
    [],
    '23514',
  );
});

test('降采样层：桶主键冲突 + ON CONFLICT DO UPDATE 幂等可重入（✅ 决策 #38）', async () => {
  const agentId = await insertAgent('downsample-agent');
  const bucket = '2026-01-01T00:00:00Z';
  const upsert = `
    INSERT INTO metrics_1m (agent_id, metric, bucket, v_avg, v_min, v_max, v_last, n)
    VALUES ($1, 'cpu.usage', $2, $3, $4, $5, $6, $7)
    ON CONFLICT (agent_id, metric, bucket) DO UPDATE
      SET v_avg = EXCLUDED.v_avg, v_min = EXCLUDED.v_min, v_max = EXCLUDED.v_max,
          v_last = EXCLUDED.v_last, n = EXCLUDED.n`;

  // 同一桶被重算两次（任务重启/回看 N=3 桶重算）→ 必须覆盖而不是报错或产生两行
  await db.query(upsert, [agentId, bucket, 10, 9, 11, 10, 4]);
  await db.query(upsert, [agentId, bucket, 30, 8, 32, 31, 12]);

  assert.equal(await count('SELECT count(*)::int AS n FROM metrics_1m WHERE agent_id = $1', [agentId]), 1);
  const { rows } = await db.query('SELECT v_avg, v_min, v_max, n FROM metrics_1m WHERE agent_id = $1', [agentId]);
  assert.equal(Number(rows[0].v_avg), 30);
  assert.equal(Number(rows[0].v_min), 8);
  assert.equal(Number(rows[0].v_max), 32);
  assert.equal(rows[0].n, 12);

  // n 必须为正（桶内样本数为 0 的桶不该被写入）
  await expectSqlError(
    `INSERT INTO metrics_1m (agent_id, metric, bucket, v_avg, n) VALUES ('${agentId}', 'cpu.usage', '2026-01-02T00:00:00Z', 1, 0)`,
    [],
    '23514',
  );
});

// -----------------------------------------------------------------------------
// 4. agents / 凭证（✅ R1/R2/R9/R18 + 本轮 secret_enc 修订）
// -----------------------------------------------------------------------------

test('agents：name 与 public_slug 唯一（✅ R2/R9）', async () => {
  await insertAgent('unique-agent');
  // 1) 重名（不同 slug）→ 拒绝
  await expectSqlError(
    `INSERT INTO agents (name, public_slug, agent_key_hash, agent_secret_enc)
     VALUES ('unique-agent', '${makeSlug('other-agent')}', '${KEY_HASH}', '${VALID_ENVELOPE}')`,
    [],
    '23505',
  );
  // 2) 重 slug（不同名）→ 拒绝：公开链接必须唯一
  await expectSqlError(
    `INSERT INTO agents (name, public_slug, agent_key_hash, agent_secret_enc)
     VALUES ('other-agent', '${makeSlug('unique-agent')}', '${KEY_HASH}', '${VALID_ENVELOPE}')`,
    [],
    '23505',
  );
});

test('agents：public_slug 形状约束顺带挡住「公开 URL 泄露内部 UUID」', async () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  // 内部 UUID 含连字符且长 36 → 必然不满足 8–12 位字符集约束
  await expectSqlError(
    `INSERT INTO agents (name, public_slug, agent_key_hash, agent_secret_enc) VALUES ('uuid-slug-agent', '${uuid}', '${KEY_HASH}', '${VALID_ENVELOPE}')`,
    [],
    '23514',
  );
  // 易混字符 0/O/1/l/I 同样被拒
  for (const bad of ['OOOOOOOOOO', '1111111111', 'llllllllll', 'IIIIIIIIII', '0000000000', 'short', 'WayTooLongSlug123']) {
    await expectSqlError(
      `INSERT INTO agents (name, public_slug, agent_key_hash, agent_secret_enc) VALUES ('slug-bad-${bad}', '${bad}', '${KEY_HASH}', '${VALID_ENVELOPE}')`,
      [],
      '23514',
    );
  }
});

test('agents：secret 必须落库为密文信封（⛔ 明文写入会被库直接拒绝）', async () => {
  await expectSqlError(
    `INSERT INTO agents (name, public_slug, agent_key_hash, agent_secret_enc) VALUES ('plain-secret', '${makeSlug('plain-secret')}', '${KEY_HASH}', 'vs_plaintext_secret')`,
    [],
    '23514',
  );
  // agent_key_hash 必须是 64 位十六进制（防止误存明文 key）
  await expectSqlError(
    `INSERT INTO agents (name, public_slug, agent_key_hash, agent_secret_enc) VALUES ('plain-key', '${makeSlug('plain-key')}', 'vk_plaintext', '${VALID_ENVELOPE}')`,
    [],
    '23514',
  );
});

test('agents：状态机只有 online/offline/disabled（✅ R18，⛔ 无 abnormal）', async () => {
  const agentId = await insertAgent('status-agent');
  const { rows } = await db.query('SELECT status FROM agents WHERE id = $1', [agentId]);
  assert.equal(rows[0].status, 'offline', '新建 Agent 未上报过，默认离线');

  for (const status of ['online', 'offline']) {
    await db.query('UPDATE agents SET status = $2 WHERE id = $1', [agentId, status]);
  }
  await db.query("UPDATE agents SET status = 'disabled', disabled_at = now() WHERE id = $1", [agentId]);
  // ⛔ R18：没有 abnormal 态
  await expectSqlError(`UPDATE agents SET status = 'abnormal' WHERE id = '${agentId}'`, [], '23514');
  // 标为 Flapping 必须带起始时间（单方向一致性约束）
  await expectSqlError(`UPDATE agents SET ip_flapping = true WHERE id = '${agentId}'`, [], '23514');
});

test('agents：tags 必须是 JSONB 数组，且可按标签检索（GIN）', async () => {
  const agentId = await insertAgent('tags-agent');
  await db.query("UPDATE agents SET tags = '[\"prod\",\"beijing\"]'::jsonb WHERE id = $1", [agentId]);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM agents WHERE tags @> '[\"prod\"]'::jsonb");
  assert.equal(rows[0].n, 1);
  await expectSqlError(`UPDATE agents SET tags = '{"a":1}'::jsonb WHERE id = '${agentId}'`, [], '23514');
});

// -----------------------------------------------------------------------------
// 5. users / settings（✅ R3/R4/R16）
// -----------------------------------------------------------------------------

test('users：两级权限 + 至少一种登录方式 + TOTP 自洽', async () => {
  const { rows } = await db.query(
    `INSERT INTO users (username, display_name, password_hash)
     VALUES ('alice', '爱丽丝', '$argon2id$v=19$m=19456,t=2,p=1$xxx$yyy') RETURNING id, role, status`,
  );
  assert.equal(rows[0].role, 'user', '权限默认必须是普通用户（最小权限）');
  assert.equal(rows[0].status, 'active');

  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [rows[0].id]);
  await expectSqlError(`UPDATE users SET role = 'root' WHERE id = '${rows[0].id}'`, [], '23514');

  // ⛔ 不允许「既无密码也未绑 SSO」的账号（防空密码本地登录）
  await expectSqlError("INSERT INTO users (username) VALUES ('nopassword')", [], '23514');

  // TOTP 已启用却没有密钥 → 拒绝（否则账号会被永久锁死）
  await expectSqlError(
    `UPDATE users SET totp_enabled = true WHERE id = '${rows[0].id}'`,
    [],
    '23514',
  );
  await db.query(
    `UPDATE users SET totp_enabled = true, totp_secret_enc = 'v1:AAAA:BBBB:CCCC', totp_bound_at = now() WHERE id = $1`,
    [rows[0].id],
  );

  // last_login_method 白名单
  await expectSqlError(`UPDATE users SET last_login_method = 'sms' WHERE id = '${rows[0].id}'`, [], '23514');
  await db.query(`UPDATE users SET last_login_method = 'totp' WHERE id = $1`, [rows[0].id]);
});

test('users：用户名/邮箱大小写不敏感唯一，OIDC 身份部分唯一（✅ R4）', async () => {
  await db.query("INSERT INTO users (username, email, password_hash) VALUES ('Bob', 'Bob@Example.com', 'h')");
  await expectSqlError("INSERT INTO users (username, password_hash) VALUES ('bob', 'h')", [], '23505');
  await expectSqlError("INSERT INTO users (username, email, password_hash) VALUES ('bob2', 'bob@example.com', 'h')", [], '23505');
  // email 可空且可重复（SSO-only 用户往往还没邮箱）
  await db.query("INSERT INTO users (username, password_hash) VALUES ('nobody', 'h')");
  await db.query("INSERT INTO users (username, password_hash) VALUES ('nobody2', 'h')");

  // OIDC：SSO-only 账号允许 password_hash 为空，但 (issuer, subject) 必须唯一
  await db.query(
    `INSERT INTO users (username, oidc_issuer, oidc_subject, oidc_linked_at)
     VALUES ('carol', 'https://idp.example.com', 'sub-1', now())`,
  );
  await expectSqlError(
    `INSERT INTO users (username, oidc_issuer, oidc_subject) VALUES ('carol2', 'https://idp.example.com', 'sub-1')`,
    [],
    '23505',
  );
});

test('user_recovery_codes：级联删除 + 可用码部分索引', async () => {
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash) VALUES ('dave', 'h') RETURNING id`,
  );
  const userId = rows[0].id;
  await db.query(`INSERT INTO user_recovery_codes (user_id, code_hash) SELECT $1, 'h' || g FROM generate_series(1, 10) g`, [
    userId,
  ]);
  assert.equal(
    await count('SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]),
    10,
  );

  await db.query('DELETE FROM users WHERE id = $1', [userId]);
  assert.equal(
    await count('SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1', [userId]),
    0,
    'ON DELETE CASCADE 未生效',
  );
});

test('settings：值不得为 JSON null；updated_at 由触发器维护（✅ R16）', async () => {
  await db.query("INSERT INTO settings (key, value) VALUES ('public_view.enabled', 'true'::jsonb)");
  await expectSqlError("INSERT INTO settings (key, value) VALUES ('bad.key', 'null'::jsonb)", [], '23514');

  const { rows } = await db.query("SELECT updated_at FROM settings WHERE key = 'public_view.enabled'");
  const before = rows[0].updated_at;
  await db.query("UPDATE settings SET value = 'false'::jsonb WHERE key = 'public_view.enabled'");
  const { rows: after1 } = await db.query("SELECT value, updated_at FROM settings WHERE key = 'public_view.enabled'");
  assert.equal(after1[0].value, false);
  assert.ok(after1[0].updated_at > before, 'updated_at 触发器未生效');
});

// -----------------------------------------------------------------------------
// 6. 告警与通知（✅ R8/R11/R12 + 零 RCE）
// -----------------------------------------------------------------------------

test('alert_rules：阈值类必填、expr 被锁死为 NULL、params/channels 形状校验', async () => {
  const { rows: userRows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
  const userId = userRows[0].id;

  await db.query("INSERT INTO channels (kind, name) VALUES ('wecom', '运维群')");
  const { rows: channelRows } = await db.query("SELECT id FROM channels WHERE name = '运维群'");
  const channelId = channelRows[0].id;

  const insert = (metric, op, threshold) =>
    db.query(
      `INSERT INTO alert_rules (name, target, kind, metric, op, threshold, severity, channels, created_by)
       VALUES ($1, '{"all":true}'::jsonb, 'threshold', $2, $3, $4, 'warn', $5, $6)`,
      [`rule-${metric ?? 'none'}-${op ?? 'none'}`, metric, op, threshold, JSON.stringify([channelId]), userId],
    );

  await insert('disk.used_pct', '>', 90); // 基名（逐维度判定）
  await insert('disk.used_pct{mount=/data}', '>=', 95); // 全名（单序列）
  await db.query(
    `UPDATE alert_rules SET metric_match = 'base' WHERE metric = 'disk.used_pct'`,
  );
  await db.query(
    `UPDATE alert_rules SET metric_match = 'exact' WHERE metric = 'disk.used_pct{mount=/data}'`,
  );

  // 阈值类缺 metric/op/threshold → 拒绝
  await expectSqlError(
    `INSERT INTO alert_rules (name, target, kind, severity) VALUES ('bad-nothreshold', '{"all":true}'::jsonb, 'threshold', 'warn')`,
    [],
    '23514',
  );
  // ⛔ 零 RCE：expr 非空必须被库拒绝
  await expectSqlError(
    `UPDATE alert_rules SET expr = 'value > 90 && process.exit()' WHERE name = 'rule-disk.used_pct->'`,
    [],
    '23514',
  );
  // 非法比较符 / 非法 severity / 非法 kind
  await expectSqlError(
    `UPDATE alert_rules SET op = '!=' WHERE metric = 'disk.used_pct'`,
    [],
    '23514',
  );
  await expectSqlError(`UPDATE alert_rules SET severity = 'fatal' WHERE metric = 'disk.used_pct'`, [], '23514');
  await expectSqlError(`UPDATE alert_rules SET kind = 'magic' WHERE metric = 'disk.used_pct'`, [], '23514');
  // metric_match 与 metric 形态必须自洽（base 不能配含 { 的全名）
  await expectSqlError(
    `UPDATE alert_rules SET metric_match = 'base' WHERE metric = 'disk.used_pct{mount=/data}'`,
    [],
    '23514',
  );
  // channels / params 必须是（对象）数组
  await expectSqlError(`UPDATE alert_rules SET channels = '{}'::jsonb WHERE metric = 'disk.used_pct'`, [], '23514');
  await expectSqlError(`UPDATE alert_rules SET params = '[]'::jsonb WHERE metric = 'disk.used_pct'`, [], '23514');

  // ✅ R12：非阈值类规则允许 metric/op/threshold 为空
  await db.query(
    `INSERT INTO alert_rules (name, target, kind, duration, severity, params)
     VALUES ('rule-offline', '{"all":true}'::jsonb, 'offline', 180, 'critical', '{"cycles":3}'::jsonb)`,
  );
});

test('alert_events：同一序列同一规则只允许一条 firing（部分唯一索引）', async () => {
  const { rows: ruleRows } = await db.query("SELECT id FROM alert_rules WHERE metric = 'disk.used_pct'");
  const ruleId = ruleRows[0].id;
  const { rows: agentRows } = await db.query("SELECT id FROM agents WHERE name = 'node-a'");
  const agentId = agentRows[0].id;

  const insert = (status = 'firing') =>
    db.query(
      `INSERT INTO alert_events (rule_id, agent_id, value, metric, started_at, status)
       VALUES ($1, $2, 93.5, 'disk.used_pct{mount=/}', now(), $3) RETURNING id`,
      [ruleId, agentId, status],
    );

  const { rows: event } = await insert();
  await expectSqlError(
    `INSERT INTO alert_events (rule_id, agent_id, value, metric, started_at, status)
     VALUES ('${ruleId}', '${agentId}', 94, 'disk.used_pct{mount=/}', now(), 'firing')`,
    [],
    '23505',
  );

  // resolved 必须带 resolved_at；且不得早于 started_at
  await expectSqlError(`UPDATE alert_events SET status = 'resolved' WHERE id = '${event[0].id}'`, [], '23514');
  await expectSqlError(
    `UPDATE alert_events SET status = 'resolved', resolved_at = started_at - interval '1 minute' WHERE id = '${event[0].id}'`,
    [],
    '23514',
  );
  await db.query(`UPDATE alert_events SET status = 'resolved', resolved_at = now() WHERE id = $1`, [event[0].id]);

  // 恢复后可以再开一条 firing（部分唯一索引只约束 firing）
  await insert();

  // 非法 status
  await expectSqlError(
    `UPDATE alert_events SET status = 'acked' WHERE id = '${event[0].id}'`,
    [],
    '23514',
  );
});

test('⚠️ 已知陷阱：metric 为 NULL 的事件型规则不受部分唯一索引去重', async () => {
  const { rows: ruleRows } = await db.query("SELECT id FROM alert_rules WHERE name = 'rule-offline'");
  const { rows: agentRows } = await db.query("SELECT id FROM agents WHERE name = 'node-a'");
  const insert = () =>
    db.query(
      `INSERT INTO alert_events (rule_id, agent_id, started_at, status)
       VALUES ($1, $2, now(), 'firing') RETURNING id`,
      [ruleRows[0].id, agentRows[0].id],
    );
  await insert();
  await insert(); // NULL 互不相等 → 不会冲突

  assert.equal(
    await count(
      "SELECT count(*)::int AS n FROM alert_events WHERE rule_id = $1 AND status = 'firing' AND metric IS NULL",
      [ruleRows[0].id],
    ),
    2,
    '本断言记录的是一个**已知缺口**（见 migrations/README.md §4 陷阱 2 / §6 M-2）：' +
      '库层不为此类规则去重，需由告警引擎状态机保证；若要库层兜底须先拍板加 COALESCE(metric,\'\') 部分唯一索引',
  );
});

test('notification_log：失败必须留原因；通道删除后历史仍可读（SET NULL）', async () => {
  const { rows: eventRows } = await db.query('SELECT id FROM alert_events LIMIT 1');
  const eventId = eventRows[0].id;
  const { rows: channelRows } = await db.query("SELECT id FROM channels WHERE name = '运维群'");
  const channelId = channelRows[0].id;

  // ok=false 但没写 error → 拒绝（排障依赖原因）
  await expectSqlError(
    `INSERT INTO notification_log (event_id, ok) VALUES ('${eventId}', false)`,
    [],
    '23514',
  );
  await db.query(
    `INSERT INTO notification_log (event_id, channel_id, channel, target, ok, error, attempt)
     VALUES ($1, $2, 'wecom', 'ops@example.com', false, 'timeout', 2)`,
    [eventId, channelId],
  );

  // 删除被规则引用的通道：本表 FK 是 SET NULL（⛔ 数据库层不阻拦；409 channel_in_use 由接口层把关）
  await db.query('DELETE FROM channels WHERE id = $1', [channelId]);
  const { rows } = await db.query('SELECT channel_id, channel, error FROM notification_log WHERE event_id = $1', [
    eventId,
  ]);
  assert.equal(rows[0].channel_id, null);
  assert.equal(rows[0].channel, 'wecom', '通道类型快照必须保留，否则历史读不懂');
});

// -----------------------------------------------------------------------------
// 7. 探活 / 进程 / 静默 / 审计
// -----------------------------------------------------------------------------

test('probe_results：类型白名单、状态码与延迟范围校验', async () => {
  const { rows } = await db.query("SELECT id FROM agents WHERE name = 'node-a'");
  const agentId = rows[0].id;
  const insert = (columns, values) =>
    db.query(`INSERT INTO probe_results (agent_id, probe_name, probe_type, target, up, checked_at, ${columns}) VALUES ($1, 'gw', 'ping', '10.0.0.1', true, now(), ${values})`, [
      agentId,
    ]);

  await insert('latency_ms, status_code', '1.2, 200');
  // ping 探活没有状态码；probe_type 必须在白名单内（`icmp` 不在白名单，统一用 ping/tcp/http/https/dns）
  await expectSqlError(
    `INSERT INTO probe_results (agent_id, probe_name, probe_type, target, up, checked_at) VALUES ('${agentId}', 'web', 'icmp', 'http://x', true, now())`,
    [],
    '23514',
  );
  await expectSqlError(
    `INSERT INTO probe_results (agent_id, probe_name, probe_type, target, up, checked_at, status_code) VALUES ('${agentId}', 'web', 'http', 'http://x', true, now(), 999)`,
    [],
    '23514',
  );
  await expectSqlError(
    `INSERT INTO probe_results (agent_id, probe_name, probe_type, target, up, checked_at, latency_ms) VALUES ('${agentId}', 'web', 'http', 'http://x', true, now(), -1)`,
    [],
    '23514',
  );
});

test('process_snapshots：top 必须是数组且 ≤ 50（与上报 schema 上限一致）', async () => {
  const { rows } = await db.query("SELECT id FROM agents WHERE name = 'node-a'");
  const agentId = rows[0].id;

  await db.query(
    `INSERT INTO process_snapshots (agent_id, ts, total, top)
     VALUES ($1, now(), 128, '[{"pid":1,"name":"systemd","cpu":0.1,"mem":1.2}]'::jsonb)`,
    [agentId],
  );
  await expectSqlError(
    `INSERT INTO process_snapshots (agent_id, ts, total, top) VALUES ('${agentId}', now(), 1, '{"pid":1}'::jsonb)`,
    [],
    '23514',
  );
  const tooMany = JSON.stringify(
    Array.from({ length: 51 }, (_, i) => ({ pid: i + 1, name: `p${i}`, cpu: 0, mem: 0 })),
  );
  await expectSqlError(
    `INSERT INTO process_snapshots (agent_id, ts, total, top) VALUES ('${agentId}', now(), 51, '${tooMany}'::jsonb)`,
    [],
    '23514',
  );
});

test('silences：窗口必须 ends_at > starts_at（✅ R10 过期 7 天清理）', async () => {
  const { rows } = await db.query("SELECT id FROM users WHERE username = 'alice'");
  const userId = rows[0].id;
  await db.query(
    `INSERT INTO silences (name, target, starts_at, ends_at, created_by)
     VALUES ('升级维护', '{"tags":["prod"]}'::jsonb, now(), now() + interval '2 hours', $1)`,
    [userId],
  );
  await expectSqlError(
    `INSERT INTO silences (name, target, starts_at, ends_at) VALUES ('坏的', '{"all":true}'::jsonb, now(), now() - interval '1 hour')`,
    [],
    '23514',
  );
});

test('audit_logs：detail 必须是对象，且可按时间/操作者/动作检索（✅ 保留 365 天）', async () => {
  await db.query(
    `INSERT INTO audit_logs (actor, actor_type, action, target, ip, detail)
     VALUES ('system', 'system', 'agent.create', 'node-a', '203.0.113.9', '{"name":"node-a"}'::jsonb)`,
  );
  await expectSqlError(
    `INSERT INTO audit_logs (actor, actor_type, action, detail) VALUES ('system', 'system', 'x', '[]'::jsonb)`,
    [],
    '23514',
  );
  await expectSqlError(
    `INSERT INTO audit_logs (actor, actor_type, action) VALUES ('system', 'robot', 'x')`,
    [],
    '23514',
  );
  assert.equal(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'agent.create'"), 1);
  // IPv6 也必须能进 INET 列（双栈部署）
  await db.query(
    `INSERT INTO audit_logs (actor, actor_type, action, ip) VALUES ('system', 'system', 'net.v6', '2001:db8::1')`,
  );
});

// -----------------------------------------------------------------------------
// 8. 外键行为与保留期清理
// -----------------------------------------------------------------------------

test('外键：⛔ 时序层故意不设 FK；关系型表一律 RESTRICT（Agent 只软删）', async () => {
  const { rows } = await db.query(
    `INSERT INTO agents (name, public_slug, agent_key_hash, agent_secret_enc)
     VALUES ('fk-agent', '${makeSlug('fk-agent')}', '${KEY_HASH}', '${VALID_ENVELOPE}') RETURNING id`,
  );
  const agentId = rows[0].id;

  // 引用不存在的主机 → 拒绝
  await expectSqlError(
    `INSERT INTO agent_ip_history (agent_id, ip, source, first_seen, last_seen)
     VALUES ('00000000-0000-0000-0000-000000000000', '203.0.113.1', 'remote', now(), now())`,
    [],
    '23503',
  );

  // 有历史区间的 Agent 不得被物理删除。
  // ⚠️ SQLSTATE 差异：`ON DELETE RESTRICT` 抛 **23001 restrict_violation**；
  //    默认的 NO ACTION 才抛 23503 foreign_key_violation。我们按文档用 RESTRICT（不推迟检查）。
  await db.query(
    `INSERT INTO agent_ip_history (agent_id, ip, source, first_seen, last_seen)
     VALUES ($1, '203.0.113.1', 'remote', now(), now())`,
    [agentId],
  );
  await expectSqlError(`DELETE FROM agents WHERE id = '${agentId}'`, [], '23001');

  // 时序层没有 FK：写一条指向不存在 agent 的指标不会被库拦住（越权由接入层把关）
  await db.query(
    `INSERT INTO metrics_raw (agent_id, metric, value, ts)
     VALUES ('00000000-0000-0000-0000-000000000000', 'cpu.usage', 1, now())`,
  );
});

test('保留期清理语句可用（分批 DELETE），并依赖我们补的时间列索引', async () => {
  const { rows } = await db.query("SELECT id FROM agents WHERE name = 'node-a'");
  const agentId = rows[0].id;

  // 造一批过期数据：1m 超 90 天、probe 超 90 天、audit 超 365 天
  await db.query(
    `INSERT INTO metrics_1m (agent_id, metric, bucket, v_avg, n)
     VALUES ($1, 'cpu.usage', now() - interval '100 days', 1, 1)`,
    [agentId],
  );
  await db.query(
    `INSERT INTO probe_results (agent_id, probe_name, probe_type, target, up, checked_at)
     VALUES ($1, 'gw', 'ping', '10.0.0.1', true, now() - interval '100 days')`,
    [agentId],
  );
  await db.query(`INSERT INTO audit_logs (actor, actor_type, action, ts) VALUES ('system','system','old', now() - interval '400 days')`);

  const deletions = [
    ['DELETE FROM metrics_1m WHERE bucket < now() - interval \'90 days\'', 'metrics_1m'],
    ['DELETE FROM metrics_5m WHERE bucket < now() - interval \'1 year\'', 'metrics_5m'],
    ['DELETE FROM probe_results WHERE checked_at < now() - interval \'90 days\'', 'probe_results'],
    ['DELETE FROM process_snapshots WHERE ts < now() - interval \'30 days\'', 'process_snapshots'],
    ['DELETE FROM agent_ip_history WHERE last_seen < now() - interval \'180 days\'', 'agent_ip_history'],
    ['DELETE FROM notification_log WHERE ts < now() - interval \'180 days\'', 'notification_log'],
    ['DELETE FROM audit_logs WHERE ts < now() - interval \'365 days\'', 'audit_logs'],
    ["DELETE FROM silences WHERE ends_at < now() - interval '7 days'", 'silences'],
  ];
  for (const [sql] of deletions) await db.exec(sql);

  // 过期行必须被清掉；同时**未过期行必须留着**（证明删除条件没有过宽）
  assert.equal(await count("SELECT count(*)::int AS n FROM metrics_1m WHERE bucket < now() - interval '90 days'"), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM probe_results WHERE checked_at < now() - interval '90 days'"), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM audit_logs WHERE ts < now() - interval '365 days'"), 0);
  assert.ok(
    (await count("SELECT count(*)::int AS n FROM probe_results WHERE checked_at >= now() - interval '90 days'")) > 0,
    '未过期的探活结果被误删了',
  );

  // 分区级清理：Drop 过期分区是秒级操作（这里用 2031 年的分区验证语句可用）
  await db.exec('DROP TABLE metrics_raw_20310304');
  assert.equal(
    await count("SELECT count(*)::int AS n FROM vantage_metrics_raw_partitions() WHERE partition_day = '2031-03-04'"),
    0,
  );
});

// -----------------------------------------------------------------------------
// 9. 权限（迁移 0008）
// -----------------------------------------------------------------------------

test('🔒 迁移 0008：vantage_app 只有 DML、无 DDL；vantage_ro 只读', async () => {
  const checks = [
    ["SELECT has_table_privilege('vantage_app', 'agents', 'SELECT') AS ok", true],
    ["SELECT has_table_privilege('vantage_app', 'metrics_raw', 'INSERT') AS ok", true],
    ["SELECT has_table_privilege('vantage_app', 'audit_logs', 'DELETE') AS ok", true],
    // ⛔ DDL 不得落在运行时连接上（✅ R13）
    ["SELECT has_schema_privilege('vantage_app', 'public', 'CREATE') AS ok", false],
    ["SELECT has_table_privilege('vantage_ro', 'agents', 'SELECT') AS ok", true],
    ["SELECT has_table_privilege('vantage_ro', 'agents', 'INSERT') AS ok", false],
    ["SELECT has_schema_privilege('vantage_ro', 'public', 'CREATE') AS ok", false],
  ];
  for (const [sql, expected] of checks) {
    const { rows } = await db.query(sql);
    assert.equal(rows[0].ok, expected, sql);
  }
});

test('🔒 schema_migrations 表也存在（运行器自建），且迁移未越权创建角色', async () => {
  const { rows } = await db.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists");
  assert.equal(rows[0].exists, true);
  // 角色是我们**预先手工**建的；0008 只授权、不创建（否则需要超级用户，会污染生产流程）
  const { rows: roles } = await db.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('vantage_app','vantage_migrator','vantage_ro') ORDER BY 1",
  );
  assert.deepEqual(roles.map((r) => r.rolname), ['vantage_app', 'vantage_migrator', 'vantage_ro']);
});
