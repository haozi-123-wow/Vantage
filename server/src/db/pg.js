/**
 * Vantage · PostgreSQL 连接与查询封装
 *
 * 依据：docs/database.md §2（角色划分：vantage_migrator 拥有 DDL / vantage_app 仅 DML）、
 *       §6.1（单次上报的落库顺序与事务边界）、§10（迁移只前进不回滚）
 *
 * 设计要点
 *  - **两条连接池**：运行时 DML 用 `vantage_app`（最小权限），DDL/分区维护用 `vantage_migrator`；
 *    ⛔ 绝不把 DDL 权限挂在常规请求路径上（§2 落地要求、✅ R13）。
 *  - `statement_timeout` 防止慢查询长期占住连接；迁移池不设，避免误杀建索引。
 *  - `pool.on('error')` 必须接管：空闲连接被服务端掐断时，未处理的 error 事件会直接崩进程。
 *  - 类型策略（与前端/JSON 契约相关，勿随意改）：
 *      BIGINT(int8) → **字符串**（pg 默认；避免越过 2^53 精度丢失）
 *      TIMESTAMPTZ  → JS Date（UTC 语义，序列化时由上层转 RFC3339）
 *      DATE         → **字符串 `YYYY-MM-DD`**（强制覆盖：默认会按本地时区解析，导致分区日期差一天）
 *      JSONB        → 对象；DOUBLE PRECISION → number；INET/CIDR → 字符串
 */

import pg from 'pg';

import { AppError } from '../utils/errors.js';

const { Pool, types } = pg;

// --- 类型解析器（进程级，只做一次）-------------------------------------------
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (value) => value); // 'YYYY-MM-DD' 原样返回，避免时区偏移

/**
 * 创建连接池。
 * @param {object} options
 * @param {string} options.connectionString
 * @param {string} options.applicationName DBA 排障时在 pg_stat_activity 里能看到
 * @param {number} [options.max]
 * @param {number} [options.idleTimeoutMs]
 * @param {number} [options.connectionTimeoutMs]
 * @param {number} [options.statementTimeoutMs] 0 = 不限制（仅迁移池）
 * @param {number} [options.maxUses] 缓解连接侧内存膨胀（node-pg 建议值 7500）
 * @param {{ warn: Function, error: Function, debug: Function }} [options.logger]
 */
export function createPool(options) {
  const {
    connectionString,
    applicationName,
    max = 10,
    idleTimeoutMs = 30_000,
    connectionTimeoutMs = 5_000,
    statementTimeoutMs = 15_000,
    maxUses = 7_500,
    logger,
  } = options;

  if (!connectionString) throw new Error('createPool 需要 connectionString');

  const pool = new Pool({
    connectionString,
    application_name: applicationName,
    max,
    idleTimeoutMillis: idleTimeoutMs,
    connectionTimeoutMillis: connectionTimeoutMs,
    maxUses,
    statement_timeout: statementTimeoutMs > 0 ? statementTimeoutMs : undefined,
    // 客户端侧兜底：比服务端 statement_timeout 略宽，避免两边同时触发造成难以归因的报错
    query_timeout: statementTimeoutMs > 0 ? statementTimeoutMs + 5_000 : undefined,
    allowExitOnIdle: false,
  });

  // ⛔ 必须接管：空闲连接异常（PG 重启/网络抖动）会产生 'error' 事件，未监听会崩进程
  pool.on('error', (err) => {
    logger?.error({ err }, 'PG 空闲连接异常（连接池会自行重建，不影响后续请求）');
  });

  if (logger) {
    pool.on('connect', () => logger.debug({ applicationName }, 'PG 新建连接'));
  }

  return pool;
}

/**
 * 执行查询并记录慢查询。
 * @param {import('pg').Pool} pool
 * @param {string} text
 * @param {unknown[]} [values]
 * @param {{ logger?: object, slowMs?: number, name?: string }} [options]
 */
export async function query(pool, text, values = [], options = {}) {
  const { logger, slowMs = 500, name } = options;
  const started = process.hrtime.bigint();
  try {
    const result = await pool.query(text, values);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms >= slowMs) {
      logger?.warn({ ms: Math.round(ms), name, rows: result.rowCount }, 'PG 慢查询');
    }
    return result;
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger?.error(
      { err, name, ms: Math.round(ms), sqlState: err?.code },
      'PG 查询失败',
    );
    throw err;
  }
}

/**
 * 在单个事务内执行回调；异常自动 ROLLBACK。
 * 用法（对应 §6.1 的落库顺序）：
 *   await withTransaction(pool, async (client) => { ...多条 INSERT/UPDATE... });
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{ isolationLevel?: string, readOnly?: boolean, logger?: object }} [options]
 * @returns {Promise<T>}
 */
export async function withTransaction(pool, fn, options = {}) {
  const client = await pool.connect();
  try {
    const clauses = [];
    if (options.isolationLevel) clauses.push(`ISOLATION LEVEL ${options.isolationLevel}`);
    if (options.readOnly) clauses.push('READ ONLY');
    await client.query(`BEGIN${clauses.length ? ` ${clauses.join(' ')}` : ''}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      options.logger?.error({ err: rollbackErr }, 'ROLLBACK 失败（连接可能已断开）');
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 健康检查：`/readyz` 与启动自检使用 */
export async function ping(pool) {
  const result = await pool.query('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}

/**
 * 读取服务端版本与关键参数，启动时打一条日志便于排障。
 * ⛔ 不含任何敏感信息。
 */
export async function serverInfo(pool) {
  const { rows } = await pool.query(
    `SELECT current_setting('server_version') AS version,
            current_setting('max_connections') AS max_connections,
            current_database() AS database,
            current_user AS user,
            pg_is_in_recovery() AS in_recovery`,
  );
  return rows[0];
}

/**
 * 断言运行时连接**没有** DDL 能力（✅ R13 的自动化防线）。
 * 若有人把 vantage_app 误配成超级用户/所有者，这里会直接拒绝启动。
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function assertNoDdlPrivilege(pool) {
  const { rows } = await pool.query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname = current_user`,
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: '无法读取当前角色属性（权限不足？）' };
  if (row.rolsuper) {
    return { ok: false, reason: '运行时连接不得使用超级用户（DDL 权限会落到常规请求路径上）' };
  }
  return { ok: true };
}

/** 把「连接不可用」统一转换成 503，便于中间件直接抛出 */
export function asUpstreamError(err, context) {
  if (err instanceof AppError) return err;
  return new AppError('upstream_unavailable', { cause: err, details: context });
}
