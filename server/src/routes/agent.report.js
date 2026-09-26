/**
 * Vantage · Agent 上报路由（`/api/v1/agent/report` 与 `/api/v1/agent/heartbeat`）
 *
 * 依据：docs/api.md §2.1（report）、§2.2（heartbeat：签名/幂等/响应体/错误码**完全一致**）、
 *       §1.5（中间件顺序固定）、§5.3（扇出）、§6.1（验收用例）、
 *       docs/database.md §6.1（落库顺序）
 *
 * ⛔ 单向宗旨（设计 §2.1、决策 #1）：本文件是**唯一**的 Agent 接入面，且
 *   - 不注册任何 GET/下发类路径（`/agent/config`、`/agent/tasks`、`/agent/command` … 永不存在）；
 *   - 成功响应体经 `AGENT_OK_RESPONSE_SCHEMA` 序列化，**结构上只可能有** `{ok, server_ts}`
 *     —— 想塞 config/command/threshold 必须先改 schema，而 test/report.test.js 会当场失败。
 *
 * 两条路由共用的管线（顺序即 §1.5 的顺序）：
 *   preParsing  → 体积上限 → gzip 解压 → 验签（⚠️ 先于 JSON.parse）→ 交回原始字节
 *   [Fastify]   → JSON.parse → schema 校验（字段白名单/范围/数组上限）
 *   preHandler  → 限流（Redis）→ agent_id 一致性 + 首次上报字段（+ 审计）
 *   handler     → 幂等占位 → 防重放 nonce → 单事务落库 → COMMIT → 扇出 → {ok, server_ts}
 */

import { createAgentBodyGuard, createAgentConsistencyCheck } from '../middleware/authAgent.js';
import { createAgentRateLimiter } from '../middleware/rateLimit.js';
import {
  AGENT_RESPONSE_SCHEMAS,
  HEARTBEAT_BODY_SCHEMA,
  REPORT_BODY_SCHEMA,
} from '../models/report.js';
import { beginBatch, persistHeartbeat, persistReport } from '../services/ingest.service.js';
import { prepareIp } from '../utils/ip.js';

/** Agent 侧版本标识（只记日志，⛔ 不入库、不回显） */
function userAgentOf(request) {
  const raw = request.headers['user-agent'];
  return typeof raw === 'string' && raw.length <= 128 ? raw : undefined;
}

/**
 * 注册 Agent 上报路由。
 * @param {import('fastify').FastifyInstance} app
 */
export async function registerAgentReportRoutes(app) {
  const { config, deps, log } = app;
  const db = deps.db;
  const redis = deps.redis;

  const bodyGuard = createAgentBodyGuard({ config, db, logger: log });
  const rateLimit = createAgentRateLimiter({ redis, config, logger: log });
  const reportConsistency = createAgentConsistencyCheck({ db, logger: log, requireHostOnFirstReport: true });
  const heartbeatConsistency = createAgentConsistencyCheck({ db, logger: log, requireHostOnFirstReport: false });

  /**
   * 批次生命周期包装：占位 → 业务写入 →（失败时）释放占位。
   * 幂等命中时**直接返回**，⛔ 不触碰数据库（✅ 决策 #18：第二次同 batch_id 不入库、仍 200）。
   */
  async function runBatch(request, persist) {
    const body = request.body;
    // ⚠️ server_ts 在 preParsing 阶段就已取定（`request.receivedAt`）：签名窗口校验与落库必须
    //    基于**同一个**时刻，否则「验签时还在窗口内、写库时已越窗」会出现两种解释。
    const serverTs = new Date(request.receivedAt);

    const batch = await beginBatch({
      redis,
      config,
      agent: request.agent,
      batchId: body.batch_id,
      nonce: request.agentAuth.nonce,
      logger: log,
    });

    if (batch.duplicate) {
      // ✅ 幂等命中**不加** `duplicate: true`（docs/api.md §2.1）：响应形态恒定，Agent 无需分支
      return { ok: true, server_ts: serverTs.getTime() };
    }

    let outcome;
    try {
      outcome = await persist({ serverTs });
    } catch (err) {
      // 写库失败 → 撤掉 batch + nonce 占位，使 Agent 能用同一份签名原样重试
      await batch.release();
      throw err;
    }

    log.info(
      {
        agentId: request.agent.id,
        agent: request.agent.name,
        batchId: body.batch_id,
        seq: body.seq,
        ua: userAgentOf(request),
        series: outcome.seriesCount,
        metricRows: outcome.metricRows,
        probeRows: outcome.probeRows,
        snapshotId: outcome.snapshotId,
        driftMs: outcome.driftMs,
        ipChanges: outcome.ips?.changeEvents,
        flapping: outcome.ips?.flappingTriggered === true ? true : undefined,
      },
      'Agent 上报已入库',
    );

    return { ok: true, server_ts: serverTs.getTime() };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/agent/report
  // ---------------------------------------------------------------------------
  app.post(
    '/api/v1/agent/report',
    {
      // ⚠️ 路由级 bodyLimit 必须是**解压后**的上限：Fastify 的解析器看到的是我们交回的
      //    解压字节流，用全局值（1MB，压缩前上限）会把合法的 2MB 解压结果误判为超限。
      bodyLimit: config.security.maxDecompressedBytes,
      preParsing: bodyGuard,
      preHandler: [rateLimit, reportConsistency],
      schema: { body: REPORT_BODY_SCHEMA, response: AGENT_RESPONSE_SCHEMAS },
    },
    async (request) =>
      runBatch(request, ({ serverTs }) =>
        persistReport({
          db,
          redis,
          config,
          logger: log,
          agent: request.agent,
          body: request.body,
          serverTs,
          remoteIp: prepareIp(request.ip).ip,
        }),
      ),
  );

  // ---------------------------------------------------------------------------
  // POST /api/v1/agent/heartbeat（§2.2：无变更时只报心跳，省网络）
  // ---------------------------------------------------------------------------
  app.post(
    '/api/v1/agent/heartbeat',
    {
      bodyLimit: config.security.maxDecompressedBytes,
      preParsing: bodyGuard,
      preHandler: [rateLimit, heartbeatConsistency],
      schema: { body: HEARTBEAT_BODY_SCHEMA, response: AGENT_RESPONSE_SCHEMAS },
    },
    async (request) =>
      runBatch(request, ({ serverTs }) =>
        persistHeartbeat({
          db,
          redis,
          config,
          logger: log,
          agent: request.agent,
          body: request.body,
          serverTs,
          remoteIp: prepareIp(request.ip).ip,
        }),
      ),
  );
}
