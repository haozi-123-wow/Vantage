#!/usr/bin/env node
/**
 * Vantage · vantage-core 数据库迁移运行器
 *
 * 依据：docs/database.md §10「迁移：server/migrations/ 版本化 SQL，只前进不回滚；每迁移附带幂等说明」
 *
 * 用法：
 *   node scripts/migrate.js               # 应用所有未执行的迁移
 *   node scripts/migrate.js --status      # 只查看已应用/待应用（含校验和漂移）
 *   node scripts/migrate.js --only=0008   # 只应用指定版本（含已应用的，需配 --force）
 *   node scripts/migrate.js --only=0008_privileges.sql --force
 *
 * 约定与安全：
 *   · 连接使用 MIGRATOR_DATABASE_URL（缺省回退 DATABASE_URL）——DDL 权限只给迁移，
 *     ⛔ 运行时的 vantage_app 连接不得有 DDL 权限（docs/database.md §2）。
 *   · 全库 advisory lock：多实例/多人同时迁移时串行等待，不会交叉执行。
 *   · 每个迁移文件在**单个事务**内执行；失败自动回滚且**不写记录**。
 *     ⛔ 因此迁移脚本不得包含 CREATE INDEX CONCURRENTLY / VACUUM 等非事务性语句。
 *   · 已应用迁移的**校验和**会被核对：文件被改动 → 直接报错退出（防止偷偷改历史）。
 *   · 密码不进日志：连接串一律经 redactUrl 脱敏后再打印。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

import { SERVER_ROOT, getConfig, redactUrl } from '../src/config/index.js';

const { Client } = pg;

/** 固定 advisory lock key（vantage-core 迁移专用，避免与业务锁冲突） */
const MIGRATION_LOCK_KEY = 8787001;

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version      TEXT        PRIMARY KEY,
  filename     TEXT        NOT NULL,
  checksum     TEXT        NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_ms INTEGER
);
COMMENT ON TABLE schema_migrations IS
  'vantage-core 迁移记录（由 scripts/migrate.js 维护）；只前进不回滚，已应用迁移的 checksum 会被核对';
`;

const log = {
  info: (msg) => console.log(`[${ts()}] ${msg}`),
  warn: (msg) => console.warn(`[${ts()}] ⚠️  ${msg}`),
  error: (msg) => console.error(`[${ts()}] ✖  ${msg}`),
};

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// -----------------------------------------------------------------------------
// 参数解析
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { status: false, only: null, force: false, dir: null, help: false };
  for (const arg of argv) {
    if (arg === '--status') opts.status = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--only=')) opts.only = arg.slice('--only='.length);
    else if (arg.startsWith('--dir=')) opts.dir = arg.slice('--dir='.length);
    else throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
  }
  return opts;
}

function usage() {
  console.log(
    [
      'Vantage 迁移运行器',
      '',
      '  node scripts/migrate.js                          应用所有未执行的迁移',
      '  node scripts/migrate.js --status                 查看迁移状态（含校验和漂移）',
      '  node scripts/migrate.js --only=0008_privileges   只应用匹配前缀的迁移',
      '  node scripts/migrate.js --only=<file> --force    重跑已应用的迁移（仅用于可控重建，勿随意用）',
      '  node scripts/migrate.js --dir=<path>             指定迁移目录（默认 server/migrations）',
      '',
      '连接串取自 MIGRATOR_DATABASE_URL（缺省回退 DATABASE_URL），见 server/.env.example。',
    ].join('\n'),
  );
}

// -----------------------------------------------------------------------------
// 迁移文件加载
// -----------------------------------------------------------------------------

/** 统一换行后再算校验和：避免 CRLF/LF 差异造成"假漂移" */
function normalize(sql) {
  return sql.replace(/\r\n/g, '\n');
}

function checksumOf(sql) {
  return crypto.createHash('sha256').update(normalize(sql), 'utf8').digest('hex');
}

function loadMigrations(dir) {
  if (!fs.existsSync(dir)) throw new Error(`迁移目录不存在：${dir}`);

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const seenVersions = new Map();
  return files.map((filename) => {
    const match = /^(\d+)_/.exec(filename);
    if (!match) {
      throw new Error(`迁移文件名必须以「数字_描述.sql」命名：${filename}`);
    }
    const version = match[1];
    if (seenVersions.has(version)) {
      throw new Error(`迁移版本号重复：${version}（${seenVersions.get(version)} 与 ${filename}）`);
    }
    seenVersions.set(version, filename);

    const fullPath = path.join(dir, filename);
    const sql = normalize(fs.readFileSync(fullPath, 'utf8'));
    return { version, filename, fullPath, sql, checksum: checksumOf(sql), bytes: Buffer.byteLength(sql, 'utf8') };
  });
}

// -----------------------------------------------------------------------------
// 主流程
// -----------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }

  const config = getConfig();
  const dir = opts.dir ? path.resolve(opts.dir) : path.join(SERVER_ROOT, 'migrations');
  const migrations = loadMigrations(dir);

  const target = redactUrl(config.db.migratorUrl || config.db.url);
  log.info(`迁移目录：${dir}`);
  log.info(`数据库：${target}`);
  if (!fs.existsSync(path.join(SERVER_ROOT, '.env'))) {
    log.warn('未找到 server/.env，配置全部来自进程环境变量');
  }

  const client = new Client({
    connectionString: config.db.migratorUrl || config.db.url,
    application_name: 'vantage-core-migrate',
    connectionTimeoutMillis: config.db.connectionTimeoutMs,
    // 迁移可能建索引，不限单语句时长，但别无限等锁
    statement_timeout: 0,
    lock_timeout: 15000,
  });

  await client.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;

    await client.query(BOOTSTRAP_SQL);
    const applied = await fetchApplied(client);

    if (opts.status) {
      printStatus(migrations, applied);
      return 0;
    }

    const pending = selectPending(migrations, applied, opts);
    if (pending.length === 0) {
      log.info('没有待应用的迁移，数据库结构已是最新。');
      printStatus(migrations, applied);
      return 0;
    }

    for (const migration of pending) {
      await applyOne(client, migration, applied.has(migration.version));
    }

    const after = await fetchApplied(client);
    log.info(`完成：本次应用 ${pending.length} 个迁移。`);
    printStatus(loadMigrations(dir), after);
    return 0;
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
    await client.end().catch(() => {});
  }
}

async function fetchApplied(client) {
  const { rows } = await client.query(
    'SELECT version, filename, checksum, applied_at, execution_ms FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.map((r) => [r.version, r]));
}

function selectPending(migrations, applied, opts) {
  if (opts.only) {
    const matches = migrations.filter(
      (m) => m.filename === opts.only || m.version === opts.only || m.filename.startsWith(opts.only),
    );
    if (matches.length === 0) throw new Error(`--only=${opts.only} 没有匹配到任何迁移文件`);
    if (matches.length > 1) {
      throw new Error(`--only=${opts.only} 匹配到多个文件：${matches.map((m) => m.filename).join(', ')}`);
    }
    const only = matches[0];
    if (applied.has(only.version) && !opts.force) {
      throw new Error(
        `${only.filename} 已应用（${applied.get(only.version).applied_at.toISOString()}）。` +
          '确需重跑请显式加 --force（仅用于 GRANT 之类的可重入脚本）。',
      );
    }
    return [only];
  }

  const pending = [];
  for (const migration of migrations) {
    const record = applied.get(migration.version);
    if (!record) {
      pending.push(migration);
      continue;
    }
    if (record.checksum !== migration.checksum) {
      throw new Error(
        `迁移 ${migration.filename} 在应用后被修改（校验和不一致）。\n` +
          `  已记录：${record.checksum}\n  当前值：${migration.checksum}\n` +
          '迁移只前进不回滚：请新增一个迁移文件来修正，⛔ 不要改历史文件。',
      );
    }
  }
  return pending;
}

async function applyOne(client, migration, isReapply) {
  const started = Date.now();
  log.info(`${isReapply ? '重跑' : '应用'} ${migration.filename}（${migration.bytes} 字节）…`);

  try {
    await client.query('BEGIN');
    // 迁移内部不设语句超时（可能建索引），但保留锁等待上限以快速失败
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = 0");
    await client.query(migration.sql); // 无参数 → 简单查询协议，允许多语句
    const executionMs = Date.now() - started;
    await client.query(
      `INSERT INTO schema_migrations (version, filename, checksum, execution_ms)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (version) DO UPDATE
         SET filename = EXCLUDED.filename,
             checksum = EXCLUDED.checksum,
             execution_ms = EXCLUDED.execution_ms,
             applied_at = now()`,
      [migration.version, migration.filename, migration.checksum, executionMs],
    );
    await client.query('COMMIT');
    log.info(`  ✔ 完成，用时 ${executionMs}ms`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const detail = err?.detail ? `\n  详情：${err.detail}` : '';
    const where = err?.where ? `\n  位置：${err.where}` : '';
    log.error(`${migration.filename} 执行失败，已回滚：${err.message}${detail}${where}`);
    throw new Error(`迁移 ${migration.filename} 失败：${err.message}`);
  }
}

function printStatus(migrations, applied) {
  const rows = migrations.map((m) => {
    const record = applied.get(m.version);
    let state = '待应用';
    if (record) state = record.checksum === m.checksum ? '已应用' : '⚠️ 校验和漂移';
    return {
      version: m.version,
      filename: m.filename,
      state,
      applied_at: record ? record.applied_at.toISOString().replace('T', ' ').slice(0, 19) : '—',
    };
  });

  const extra = [...applied.keys()].filter((v) => !migrations.some((m) => m.version === v));

  console.log('');
  console.log('  版本   状态              应用时间             文件');
  console.log('  ------ ---------------- ------------------- ----------------------------------------');
  for (const row of rows) {
    console.log(
      `  ${row.version.padEnd(6)} ${row.state.padEnd(16)} ${row.applied_at.padEnd(19)} ${row.filename}`,
    );
  }
  if (extra.length > 0) {
    console.log('');
    log.warn(`数据库中存在迁移目录里已不存在的版本：${extra.join(', ')}（历史文件被删除？）`);
  }
  console.log('');
}

// -----------------------------------------------------------------------------
// 入口（⛔ 仅在直接执行本文件时运行；被测试 import 时不得产生副作用）
// -----------------------------------------------------------------------------

const isEntryPoint =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      log.error(err.message);
      // 连接类错误给出可操作的下一步，而不是让使用者对着 ECONNREFUSED 干瞪眼
      if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|password authentication|does not exist/i.test(err.message)) {
        log.warn(
          '无法连接数据库。请确认：① PostgreSQL 已启动（deploy/docker-compose.yml）；' +
            '② server/.env 里的 MIGRATOR_DATABASE_URL 指向正确的库与账号；' +
            '③ 库已按 server/scripts/init-db.sql 建好。',
        );
      }
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    });
}

export {
  BOOTSTRAP_SQL,
  MIGRATION_LOCK_KEY,
  applyOne,
  checksumOf,
  fetchApplied,
  loadMigrations,
  main,
  normalize,
  parseArgs,
  selectPending,
};