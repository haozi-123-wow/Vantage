/**
 * 迁移脚本与运行器的静态测试
 *
 * 为什么需要它：`npm run migrate` 需要真实 PostgreSQL 才能端到端验证，而本机/CI 未必有库。
 * 以下断言把「不依赖数据库就能检查的契约」钉住：
 *   · 文件命名与顺序（迁移只前进不回滚的前提）；
 *   · 表清单与 docs/database.md §3 一致；
 *   · ⛔ 不得出现删表/建库/非事务语句（会破坏运行器的单事务语义）；
 *   · 关键决策的落地痕迹（维度进指标名、secret 加密存储、分区按天）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checksumOf, loadMigrations, normalize, parseArgs, selectPending } from '../scripts/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '..', 'migrations');
const migrations = loadMigrations(MIGRATIONS_DIR);
const sqlOf = (version) => migrations.find((m) => m.version === version).sql;
const allSql = migrations.map((m) => m.sql).join('\n');

/** 剥掉 `--` 行注释后的 SQL：用于"禁止语句"扫描，避免注释里提到的关键字造成误判 */
const allSqlNoComments = allSql.replace(/--.*$/gm, '');

/** docs/database.md §3 表清单总览（16 张业务表） */
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

test('迁移文件：4 位数字前缀、版本连续、字典序即执行序', () => {
  assert.ok(migrations.length >= 8, `至少有 8 个迁移文件，实际 ${migrations.length}`);
  assert.deepEqual(
    migrations.map((m) => m.version),
    migrations.map((_, i) => String(i + 1).padStart(4, '0')),
  );
  for (const migration of migrations) {
    assert.match(migration.filename, /^\d{4}_[a-z0-9_]+\.sql$/, migration.filename);
    assert.ok(migration.bytes > 0);
    assert.equal(migration.checksum.length, 64);
    // 文件头必须写明依据，便于追溯（见 migrations/README.md §5）
    assert.match(migration.sql.slice(0, 400), /依据/, `${migration.filename} 缺少「依据」注释`);
  }
});

test('checksumOf：CRLF/LF 视为同一版本（Windows 检出不应造成"假漂移"）', () => {
  const lf = 'CREATE TABLE a (x int);\n';
  assert.equal(checksumOf(lf), checksumOf(lf.replace(/\n/g, '\r\n')));
  assert.equal(normalize('a\r\nb'), 'a\nb');
  assert.notEqual(checksumOf(lf), checksumOf(`${lf}-- 改动`));
});

test('表清单与 docs/database.md §3 完全一致（不漏表、不多表）', () => {
  const created = [...allSqlNoComments.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/g)]
    .map((m) => m[1])
    // 兜底 DEFAULT 分区是同一张逻辑表的物理分区，不算独立表
    .filter((name) => name !== 'metrics_raw_default');

  for (const table of EXPECTED_TABLES) {
    assert.ok(created.includes(table), `迁移未创建表：${table}`);
  }
  const unexpected = created.filter((name) => !EXPECTED_TABLES.includes(name));
  assert.deepEqual(unexpected, [], `出现了文档未登记的表：${unexpected.join(', ')}`);

  // ⛔ schema_migrations 由运行器自建（scripts/migrate.js），迁移文件不得插手
  assert.equal(created.includes('schema_migrations'), false);
});

test('⛔ 迁移中不得出现破坏性/非事务语句', () => {
  // ⚠️ 模式一律**行首锚定**（允许前置缩进与 EXECUTE ' 动态 SQL 前缀）：
  //    否则 COMMENT 的字符串字面量里出现「无 VACUUM 压力」这类说明文字会被误判。
  const forbidden = [
    [/^\s*(?:EXECUTE\s+)?['"]?\s*DROP\s+TABLE\b/im, 'DROP TABLE（只前进不回滚：改用新增迁移）'],
    [/^\s*(?:EXECUTE\s+)?['"]?\s*DROP\s+COLUMN\b/im, 'DROP COLUMN（只前进不回滚）'],
    [/^\s*(?:EXECUTE\s+)?['"]?\s*TRUNCATE\b/im, 'TRUNCATE'],
    [/^\s*(?:EXECUTE\s+)?['"]?\s*DELETE\s+FROM\b/im, 'DELETE（迁移不搬数据）'],
    [
      /^\s*(?:EXECUTE\s+)?['"]?\s*CREATE\s+(?:OR\s+REPLACE\s+)?DATABASE\b/im,
      'CREATE DATABASE（建库走 scripts/init-db.sql）',
    ],
    [
      /^\s*(?:EXECUTE\s+)?['"]?\s*CREATE\s+(?:OR\s+REPLACE\s+)?ROLE\b/im,
      'CREATE ROLE（建角色需要超级用户，走 scripts/init-db.sql）',
    ],
    [/CONCURRENTLY/i, 'CREATE INDEX CONCURRENTLY（不能在事务内执行）'],
    [/^\s*(?:EXECUTE\s+)?['"]?\s*VACUUM\b/im, 'VACUUM（不能在事务内执行）'],
    [/^\s*(?:EXECUTE\s+)?['"]?\s*ALTER\s+SYSTEM\b/im, 'ALTER SYSTEM'],
  ];
  for (const [pattern, label] of forbidden) {
    assert.equal(pattern.test(allSqlNoComments), false, `迁移中出现禁止语句：${label}`);
  }

  // 反向自检：这组模式必须真的能抓到东西（防止模式写歪导致"永远通过"）
  const trap = "BEGIN;\nDROP TABLE agents;\n  EXECUTE 'CREATE ROLE evil';\nVACUUM FULL;\n";
  const caught = forbidden.filter(([pattern]) => pattern.test(trap));
  assert.equal(caught.length >= 3, true, '禁止语句模式失效应立即修测试');
});

test('所有索引都显式命名（便于后续 DROP/REINDEX 定位）', () => {
  const statements = [...allSql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*?;/gis)].map((m) => m[0]);
  assert.ok(statements.length > 20, `索引数量异常偏少：${statements.length}`);
  for (const statement of statements) {
    assert.match(statement, /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?[a-z_][a-z0-9_]*/i, statement);
  }
});

test('✅ 决策 #40（R5）：维度写进指标名，主键保持 (agent_id, metric, ts)', () => {
  const metricsRaw = sqlOf('0004');
  assert.match(metricsRaw, /PRIMARY KEY \(agent_id, metric, ts\)/);
  assert.match(metricsRaw, /PARTITION BY RANGE \(ts\)/);
  // 指标名规范校验必须挂到三张时序表上（与 utils/metric.js 同源）
  for (const table of ['metrics_raw', 'metrics_1m', 'metrics_5m']) {
    const block = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\)`, 'm').exec(allSql);
    assert.ok(block, `${table} 定义未找到`);
    assert.match(block[1], /vantage_is_valid_metric_name\(metric\)/, `${table} 缺少指标名校验`);
  }
  // 分区辅助函数与 DEFAULT 兜底分区
  assert.match(metricsRaw, /vantage_ensure_metrics_raw_partition\(date\)/);
  assert.match(metricsRaw, /vantage_metrics_raw_partitions\(\)/);
  assert.match(metricsRaw, /PARTITION OF metrics_raw DEFAULT/);
  // BRIN 建在分区上（而非依赖父表分区索引对 BRIN 的支持）
  assert.match(metricsRaw, /USING BRIN \(ts\)/);
});

test('✅ 本轮修订：agent_secret 必须可逆存储（secret_enc），不能只存哈希', () => {
  const agents = sqlOf('0003');
  assert.match(agents, /agent_key_hash\s+TEXT\s+NOT NULL/);
  assert.match(agents, /agent_secret_enc\s+TEXT\s+NOT NULL/);
  // ⛔ 旧列名不得复活（命名回归会让"HMAC 验签缺 secret"这个坑再踩一次）
  assert.equal(/agent_secret_hash/.test(allSql), false, 'agent_secret_hash 已废弃，应为 agent_secret_enc');
  // 密文信封约束：误写明文会被库直接拒绝
  assert.match(agents, /\^v1:\[A-Za-z0-9\+\/\]\+/);
  assert.match(agents, /agent_key_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test('✅ R9：public_slug 的字符集约束顺带杜绝公开链接泄露内部 UUID', () => {
  const agents = sqlOf('0003');
  assert.match(agents, /UNIQUE \(public_slug\)/);
  assert.match(agents, /\^\[2-9A-HJ-NP-Za-km-z\]\{8,12\}\$/);
  // 内部 UUID 含连字符且长 36，必然不匹配该模式
  assert.doesNotMatch('11111111-2222-3333-4444-555555555555', /^[2-9A-HJ-NP-Za-km-z]{8,12}$/);
});

test('✅ R3/R4：users 含两级权限与 OIDC 预留字段，且禁止空密码本地登录', () => {
  const users = sqlOf('0002');
  assert.match(users, /role\s+TEXT\s+NOT NULL DEFAULT 'user'/);
  assert.match(users, /CHECK \(role IN \('admin', 'user'\)\)/);
  for (const column of [
    'oidc_issuer',
    'oidc_subject',
    'oidc_email',
    'oidc_linked_at',
    'oidc_last_sync_at',
  ]) {
    assert.match(users, new RegExp(column), column);
  }
  assert.match(users, /password_hash IS NOT NULL OR oidc_subject IS NOT NULL/);
  // 用户名/邮箱大小写不敏感唯一 + OIDC 身份部分唯一索引
  assert.match(users, /UNIQUE INDEX users_username_lower_uidx\s+ON users \(lower\(username\)\)/);
  assert.match(users, /UNIQUE INDEX users_email_lower_uidx\s+ON users \(lower\(email\)\) WHERE email IS NOT NULL/);
  assert.match(users, /UNIQUE INDEX users_oidc_identity_uidx\s+ON users \(oidc_issuer, oidc_subject\)/);
  // 2FA 自助绑定 + 一次性恢复码
  assert.match(users, /totp_enabled\s+BOOLEAN\s+NOT NULL DEFAULT false/);
  assert.match(sqlOf('0002'), /CREATE TABLE user_recovery_codes/);
});

test('✅ R16：settings 为 key 白名单 + JSONB，且不带任何密钥列', () => {
  const accounts = sqlOf('0002');
  assert.match(accounts, /CREATE TABLE settings/);
  assert.match(accounts, /key\s+TEXT\s+PRIMARY KEY/);
  assert.match(accounts, /value\s+JSONB\s+NOT NULL/);

  // ⛔ 密钥不得进 settings（通道密钥在 channels.config、TOTP 在 users.totp_secret_enc）
  // 先剥掉 SQL 注释再检查，否则注释里提到的列名会造成误判
  const settingsBlock = /CREATE TABLE settings \(([\s\S]*?)\n\);/
    .exec(accounts)[1]
    .replace(/--.*$/gm, '');
  assert.equal(/secret|password|token/i.test(settingsBlock), false, 'settings 不得存放任何密钥列');
  assert.equal(/key\s+TEXT\s+PRIMARY KEY/.test(settingsBlock), true);
});

test('⛔ 零 RCE 兜底：alert_rules.expr 本期被库约束锁死为 NULL', () => {
  const alerting = sqlOf('0006');
  assert.match(alerting, /CONSTRAINT alert_rules_expr_disabled_ck CHECK \(expr IS NULL\)/);
  // ✅ R11：规则只存 channels.id 数组
  assert.match(alerting, /CONSTRAINT channels_kind_ck/);
  assert.match(alerting, /alert_rules_channels_ck CHECK \(vantage_jsonb_is_array\(channels\)\)/);
  // ✅ R12：非阈值参数统一 params JSONB
  assert.match(alerting, /params\s+JSONB\s+NOT NULL DEFAULT '\{\}'::jsonb/);
  // 同一序列 + 同一规则同时只允许一条 firing
  assert.match(alerting, /UNIQUE INDEX alert_events_firing_uidx[\s\S]*WHERE status = 'firing'/);
});

test('🔒 权限迁移：角色不存在时必须静默跳过（单角色部署可用）', () => {
  const privileges = sqlOf('0008');
  assert.match(privileges, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'vantage_app'\)/);
  assert.match(privileges, /pg_has_role\(current_user, 'vantage_migrator', 'MEMBER'\)/);
  // 只读角色不得拿到 DDL
  assert.match(privileges, /REVOKE CREATE ON SCHEMA public FROM vantage_ro/);
  assert.match(privileges, /REVOKE CREATE ON SCHEMA public FROM vantage_app/);
});

test('运行器参数解析：未知参数必须报错而不是静默忽略', () => {
  assert.deepEqual(parseArgs([]), { status: false, only: null, force: false, dir: null, help: false });
  assert.equal(parseArgs(['--status']).status, true);
  assert.equal(parseArgs(['--only=0008']).only, '0008');
  assert.equal(parseArgs(['--force', '--help']).force, true);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});

test('运行器选批逻辑：跳过已应用、拦截校验和漂移、--only 必须唯一匹配', () => {
  const applied = new Map([
    ['0001', { version: '0001', checksum: migrations[0].checksum, applied_at: new Date() }],
  ]);

  const pending = selectPending(migrations, applied, {});
  assert.deepEqual(pending.map((m) => m.version), ['0002', '0003', '0004', '0005', '0006', '0007', '0008']);
  assert.equal(pending.length, migrations.length - 1);

  // 已应用文件被改动 → 直接报错（迁移只前进不回滚）
  const drifted = new Map([
    ['0001', { version: '0001', checksum: 'deadbeef', applied_at: new Date() }],
  ]);
  assert.throws(() => selectPending(migrations, drifted, {}), /在应用后被修改/);

  // --only：前缀唯一匹配才允许
  const only = selectPending(migrations, applied, { only: '0008_privileges' });
  assert.deepEqual(only.map((m) => m.filename), ['0008_privileges.sql']);

  // 重跑已应用迁移必须显式 --force
  assert.throws(() => selectPending(migrations, applied, { only: '0001' }), /已应用/);
  const forced = selectPending(migrations, applied, { only: '0001', force: true });
  assert.deepEqual(forced.map((m) => m.version), ['0001']);

  assert.throws(() => selectPending(migrations, applied, { only: 'nope' }), /没有匹配到/);
  assert.throws(() => selectPending(migrations, applied, { only: '000' }), /匹配到多个文件/);
});

test('迁移目录里没有被 README 漏记的文件', () => {
  const readme = fs.readFileSync(path.join(MIGRATIONS_DIR, 'README.md'), 'utf8');
  for (const migration of migrations) {
    assert.match(readme, new RegExp(migration.filename.replace('.', '\\.')), `${migration.filename} 未记录在 README`);
  }
});
