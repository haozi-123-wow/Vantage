/**
 * Vantage · 上报接收入口（幂等 / 防重放 / 事务编排 / 落库后扇出）
 *
 * 依据：docs/database.md §6.1（单次上报的落库顺序）、§6.2（一致性点）、§7（Redis 键空间）；
 *       docs/api.md §2.1、§2.2、§5.3（扇出语义）、决策 #16/#18/#36/#39
 *
 * ➕ 本文件是设计 §11.3 目录清单之外新增的一个服务：把「批次生命周期」从具体端点里抽出来，
 *    让 `report` 与 `heartbeat` 共用同一份幂等/防重放/事务语义（§2.2 要求两者"完全一致"），
 *    也避免同一段 Redis 逻辑在两条路由里各写一遍而悄悄分叉。
 *
 * 步骤与顺序（严格对齐 §6.1）
 *   ① 幂等占位 `batch:<batch_id>`（SETNX，TTL 600s）—— 已存在 → **直接应答 ok、不写库**（决策 #18）
 *   ② 防重放 `nonce:<agent_id>:<nonce>`（SETNX，TTL 600s，≥ 签名窗口 300s）—— 已存在 → 409
 *   ③ 单个事务：UPSERT agents → IP 追踪 → metrics_raw → process_snapshots → probe_results
 *   ④ COMMIT 之后才 PUBLISH `live:metrics`（Pub/Sub 不参与事务，先发后写会出现"面板有、库里没有"）
 *
 * ⚠️ 两处**刻意**偏离 §6.1 字面顺序的取舍（已登记在 server/README.md）
 *  1. 幂等检查排在 nonce 之前：一次**完全相同的重传**（Agent 重试同一份已签名字节）应当得到
 *     `{ok:true}`（数据本来就在库里），而不是 409 —— 把「已经成功的批次再问一次」判成重放，
 *     会让 Agent 陷入永远无法完成的死循环。真正的重放（同 nonce + 不同 batch）依然 409。
 *  2. 失败时**同时删掉 batch 与 nonce 两个占位**：只删 batch 会留下一个"已烧毁"的 nonce，
 *     于是 Agent 用同一份签名重试会立刻 409，批次永远补不上（§6.1 的"建议"只提到了 batch）。
 */

import { withTransaction } from '../db/pg.js';
import { publish } from '../db/redis.js';
import { AppError } from '../utils/errors.js';
import { CHANNEL, TTL_S, keys } from '../utils/redisKeys.js';
import { flattenMetrics, storeMetrics, storeProcessSnapshot } from './metrics.service.js';
import { touchAgent } from './heartbeat.service.js';
import { trackIps } from './ipTrack.service.js';
import { storeProbes } from './probe.service.js';

/**
 * 占住一个上报批次（幂等键 + nonce）。
 *
 * Redis 不可用时**直接失败**（503 upstream_unavailable）：此时幂等与防重放都失效，
 * 宁可拒收也不要在"防护全无"的状态下写库。
 *
 * @param {object} input
 * @param {import('ioredis').Redis} input.redis
 * @param {object} input.config
 * @param {{ id: string }} input.agent
 * @param {string} input.batchId
 * @param {string} input.nonce
 * @param {object} [input.logger]
 * @returns {Promise<{ duplicate: boolean, release: () => Promise<void> }>}
 */
export async function beginBatch({ redis, config, agent, batchId, nonce, logger }) {
  const batchKey = keys.batch(batchId);
  const nonceKey = keys.nonce(agent.id, nonce);
  const nonceTtlS = config.security.nonceTtlS;

  const claimed = await redis.set(batchKey, agent.id, 'EX', TTL_S.batch, 'NX');
  if (claimed === null) {
    logger?.debug?.({ agentId: agent.id, batchId }, '幂等命中：该批次已入库，跳过写入');
    return { duplicate: true, release: async () => {} };
  }

  const nonceClaimed = await redis.set(nonceKey, '1', 'EX', nonceTtlS, 'NX');
  if (nonceClaimed === null) {
    await redis.del(batchKey).catch(() => {});
    throw new AppError('nonce_reused', {
      message: 'nonce 已被使用（同一签名只允许出现一次）',
      details: { ttl_s: nonceTtlS },
    });
  }

  let released = false;
  return {
    duplicate: false,
    /** 仅在事务失败时调用：把两个占位都撤掉，使 Agent 能用同一份签名重试 */
    release: async () => {
      if (released) return;
      released = true;
      const results = await Promise.allSettled([redis.del(batchKey), redis.del(nonceKey)]);
      for (const result of results) {
        if (result.status === 'rejected') {
          logger?.warn?.(
            { err: result.reason, batchId },
            '释放批次占位失败（该批次在 TTL 内会被判为重复而跳过写入）',
          );
        }
      }
    },
  };
}

/**
 * 处理 `POST /api/v1/agent/report` 的业务写入。
 *
 * @param {object} input
 * @param {{ app: import('pg').Pool }} input.db
 * @param {import('ioredis').Redis} input.redis
 * @param {object} input.config
 * @param {object} [input.logger]
 * @param {{ id: string }} input.agent
 * @param {object} input.body 已通过 schema 校验的报文
 * @param {Date} input.serverTs
 * @param {string|null} input.remoteIp
 */
export async function persistReport(input) {
  const { body, serverTs, remoteIp, logger } = input;

  // ⛔ 在开事务**之前**完成展平：字段/维度非法时零数据库开销，且不会占用连接
  const series = flattenMetrics(body.metrics);
  const probes = body.probes ?? [];

  const outcome = await withTransaction(
    input.db.app,
    async (client) => {
      const { locked, driftMs } = await touchAgent(client, {
        agent: input.agent,
        body,
        serverTs,
        remoteIp,
        reportedIp: body.reported_ip ?? null,
        logger,
      });

      const ips = await trackIps(client, {
        agentId: input.agent.id,
        locked,
        serverTs,
        remoteIp,
        reportedIp: body.reported_ip ?? null,
        flapping: input.config.flapping,
        logger,
      });

      const metricRows = await storeMetrics(client, {
        agentId: input.agent.id,
        serverTs,
        series,
        logger,
      });

      const snapshotId = body.metrics.process
        ? await storeProcessSnapshot(client, {
            agentId: input.agent.id,
            serverTs,
            process: body.metrics.process,
            logger,
          })
        : null;

      const probeRows = probes.length > 0
        ? await storeProbes(client, { agentId: input.agent.id, serverTs, probes, logger })
        : 0;

      return {
        metricRows,
        probeRows,
        snapshotId,
        driftMs,
        ips,
        statusBefore: locked.status,
        hostChanged: body.host !== undefined,
      };
    },
    { logger },
  );

  // --- COMMIT 之后：扇出（失败不影响本次上报的成败）--------------------------
  await publishDeltas({
    redis: input.redis,
    logger,
    agentId: input.agent.id,
    serverTs,
    series,
    probes,
    statusBefore: outcome.statusBefore,
  });

  return { ...outcome, seriesCount: series.length };
}

/**
 * 处理 `POST /api/v1/agent/heartbeat`：只更新心跳字段，⛔ 不写任何时序数据。
 * 其余（签名/幂等/防重放/漂移/IP 追踪/响应体）与 report **完全一致**（§2.2）。
 */
export async function persistHeartbeat(input) {
  const { body, serverTs, remoteIp, logger } = input;

  const outcome = await withTransaction(
    input.db.app,
    async (client) => {
      const { locked, driftMs } = await touchAgent(client, {
        agent: input.agent,
        body,
        serverTs,
        remoteIp,
        reportedIp: null,
        logger,
      });

      const ips = await trackIps(client, {
        agentId: input.agent.id,
        locked,
        serverTs,
        remoteIp,
        reportedIp: null,
        flapping: input.config.flapping,
        logger,
      });

      return { driftMs, ips, statusBefore: locked.status };
    },
    { logger },
  );

  await publishDeltas({
    redis: input.redis,
    logger,
    agentId: input.agent.id,
    serverTs,
    series: [],
    probes: [],
    statusBefore: outcome.statusBefore,
  });

  return { ...outcome, seriesCount: 0, metricRows: 0, probeRows: 0, snapshotId: null };
}

/**
 * 落库后扇出（§5.3：`Agent 上报 → 落库 → PUBLISH live:metrics → 各 WS 连接广播`）。
 *
 * ⛔ 只在 COMMIT 之后调用；消息形状与 docs/api.md §5.2 的 `delta` 完全一致，
 *    这样 M2 的 WS 层只需要原样转发，不需要再翻译一层。
 */
async function publishDeltas({ redis, logger, agentId, serverTs, series, probes, statusBefore }) {
  const ts = serverTs.getTime();
  const commands = [];

  if (series.length > 0) {
    const metrics = {};
    for (const point of series) metrics[point.metric] = point.value;
    commands.push([CHANNEL.liveMetrics, JSON.stringify({ type: 'delta', ts, channel: 'metrics', agent_id: agentId, metrics })]);
  }

  // 只有「离线/从未上报 → 在线」这一次才值得广播（每批都发 status 是纯噪声）
  if (statusBefore !== 'online') {
    commands.push([
      CHANNEL.liveMetrics,
      JSON.stringify({
        type: 'delta',
        ts,
        channel: 'status',
        agent_id: agentId,
        status: 'online',
        last_seen_at: serverTs.toISOString(),
      }),
    ]);
  }

  for (const probe of probes) {
    commands.push([
      CHANNEL.liveMetrics,
      JSON.stringify({
        type: 'delta',
        ts,
        channel: 'probes',
        agent_id: agentId,
        probe: { name: probe.name, up: probe.up },
      }),
    ]);
  }

  if (commands.length === 0) return;

  try {
    // 一次 pipeline 完成全部 PUBLISH：批内 64 个探活时不至于打 64 个来回
    await publish(redis, commands);
  } catch (err) {
    logger?.warn?.({ err, agentId, count: commands.length }, 'live:metrics 扇出失败（数据已入库，不影响本次上报）');
  }
}
