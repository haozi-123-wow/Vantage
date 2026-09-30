/**
 * 测试替身 · 记录型 PostgreSQL 连接池
 *
 * 做法：按 SQL 特征匹配并返回该语句应有的结果，同时**记录每一条 SQL 与参数**。
 * 这样可以在无库环境下断言两件事：
 *  1. 路由/服务层的行为（状态码、错误码、幂等、审计…）；
 *  2. 落库语句本身（顺序、参数、是否在事务内、是否误用 DO NOTHING…）。
 *
 * ⚠️ 这是"结构性"替身，不校验 SQL 语法 —— 语法与真实执行由
 *    test/schema.test.js（PGlite 真库跑全部迁移）与 test/report.live.test.js（真机联调）覆盖。
 */

/** 默认的 Agent 行（可被用例覆盖） */
export function makeAgentRow(overrides = {}) {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'test-host',
    status: 'online',
    agent_key_hash: 'a'.repeat(64),
    agent_secret_enc: 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA',
    last_ip: '203.0.113.7',
    reported_ip: null,
    ip_flapping: false,
    flapping_since: null,
    capabilities: { 'disk.io': true },
    host_info: { hostname: 'test-host', os: 'linux', kernel: '6.8.0', boot_time: 1710000000 },
    disabled_at: null,
    ...overrides,
  };
}

/**
 * @param {{ agentRow?: object|null }} [options]
 */
export function createFakeDb(options = {}) {
  const calls = [];
  const state = {
    agentRow: options.agentRow === undefined ? makeAgentRow() : options.agentRow,
    /** lockAgentForReport 的 ip_changed 结果 */
    ipChanged: options.ipChanged ?? false,
    recentIpChanges: options.recentIpChanges ?? 0,
    metricRowCount: options.metricRowCount ?? null, // null = 按 series 长度返回
    /** 置 true 后 INSERT metrics_raw 会抛 08006（连接断开） */
    failMetricsInsert: false,
    transactionOpen: false,
    committed: 0,
    rolledBack: 0,
  };

  function respond(sql, params) {
    const text = String(sql);

    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(text)) {
      if (/^COMMIT/i.test(text)) {
        state.committed += 1;
        state.transactionOpen = false;
      }
      if (/^ROLLBACK/i.test(text)) {
        state.rolledBack += 1;
        state.transactionOpen = false;
      }
      if (/^BEGIN/i.test(text)) state.transactionOpen = true;
      return { rows: [], rowCount: null };
    }

    // --- agents：鉴权查询 ----------------------------------------------------
    if (/FROM agents\s+WHERE id = \$1\s*$/i.test(text)) {
      return { rows: state.agentRow ? [state.agentRow] : [], rowCount: state.agentRow ? 1 : 0 };
    }

    // --- agents：事务内锁定 --------------------------------------------------
    if (/FROM agents[\s\S]*FOR UPDATE/i.test(text)) {
      if (!state.agentRow) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: state.agentRow.id,
            name: state.agentRow.name,
            status: state.agentRow.status,
            last_ip: state.agentRow.last_ip,
            reported_ip: state.agentRow.reported_ip,
            ip_flapping: state.agentRow.ip_flapping,
            flapping_since: state.agentRow.flapping_since,
            capabilities: state.agentRow.capabilities,
            host_info: state.agentRow.host_info,
            ip_changed: state.ipChanged,
          },
        ],
        rowCount: 1,
      };
    }

    // --- agents：心跳更新 ----------------------------------------------------
    if (/UPDATE agents[\s\S]*SET last_seen_at/i.test(text)) {
      return { rows: [{ last_seen_at: params[1], status: 'online' }], rowCount: 1 };
    }

    // --- agents：置 Flapping -------------------------------------------------
    if (/UPDATE agents[\s\S]*SET ip_flapping/i.test(text)) {
      return { rows: [], rowCount: 1 };
    }

    // --- ip_change_events：窗口计数 ------------------------------------------
    if (/FROM ip_change_events/i.test(text)) {
      return { rows: [{ n: state.recentIpChanges }], rowCount: 1 };
    }

    // --- agent_ip_history：区间 UPSERT --------------------------------------
    if (/INSERT INTO agent_ip_history/i.test(text)) {
      return { rows: [{ id: 1, inserted: true }], rowCount: 1 };
    }

    // --- ip_change_events：插入 ---------------------------------------------
    if (/INSERT INTO ip_change_events/i.test(text)) {
      return { rows: [{ id: 1 }], rowCount: 1 };
    }

    // --- metrics_raw：批量写入 ----------------------------------------------
    if (/INSERT INTO metrics_raw/i.test(text)) {
      if (state.failMetricsInsert) {
        // 模拟「事务中途连接断开」：用于验证批次占位会被释放、Agent 可原样重试
        throw Object.assign(new Error('connection to server was lost'), { code: '08006' });
      }
      const seriesCount = Array.isArray(params[2]) ? params[2].length : 0;
      return { rows: [], rowCount: state.metricRowCount ?? seriesCount };
    }

    // --- process_snapshots ---------------------------------------------------
    if (/INSERT INTO process_snapshots/i.test(text)) {
      return { rows: [{ id: 7 }], rowCount: 1 };
    }

    // --- probe_results -------------------------------------------------------
    if (/INSERT INTO probe_results/i.test(text)) {
      const count = Array.isArray(params[2]) ? params[2].length : 0;
      return { rows: [], rowCount: count };
    }

    // --- audit_logs ----------------------------------------------------------
    if (/INSERT INTO audit_logs/i.test(text)) {
      return { rows: [], rowCount: 1 };
    }

    if (/^SELECT 1/i.test(text)) return { rows: [{ ok: 1 }], rowCount: 1 };

    throw new Error(`记录型连接池没有为这条 SQL 定义结果：\n${text}`);
  }

  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params, inTransaction: state.transactionOpen });
      return respond(sql, params);
    },
    release() {
      calls.push({ release: true });
    },
  };

  const pool = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params, onPool: true });
      return respond(sql, params);
    },
    async connect() {
      return client;
    },
    async end() {},
  };

  return { pool, calls, state };
}

/** 从记录里挑出匹配某特征的 SQL 调用（断言用） */
export function pickCalls(calls, pattern) {
  return calls.filter((call) => call.sql && pattern.test(call.sql));
}
