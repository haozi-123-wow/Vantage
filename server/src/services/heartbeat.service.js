/**
 * Vantage · 心跳服务（`agents` 表的每次上报写入）
 *
 * 依据：docs/database.md §5.1、§5.3（离线判定阈值 = 上报周期 × 倍数）、
 *       §6.1（落库顺序第 1–2 步）、docs/api.md §2.2（heartbeat 端点语义）
 *
 * 时间权威（✅ 决策 #16）：`now()` / `server_ts` 是唯一权威；
 * Agent 的 `ts` **只**用于算漂移并存 `last_agent_ts`，⛔ 绝不参与任何写入的时间列。
 *
 * ⚠️ 状态机的两个方向分属两处，改任一处都必须同时想到另一处：
 *    `offline/从未上报 → online`  **本文件**（`touchAgent` → `updateAgentAfterReport` 的 CASE）
 *    `online → offline`            `services/offline.service.js`（每 30s 的 `offline_sweep` 定时任务）
 * 上报是请求驱动的，因此"机器掉线"这件事只能靠主动扫描发现（详见 offline.service.js 的文件头）。
 */

import { AppError } from '../utils/errors.js';
import { lockAgentForReport, updateAgentAfterReport } from '../repositories/agent.repo.js';

/**
 * 时钟漂移 = agent_ts − server_ts。
 *
 * ⚠️ 符号口径（务必与告警规则、前端徽标一致）：**负值表示 Agent 的时钟慢于中心**。
 *    这个值直接来自 `sign.js::evaluateTimestampSkew` 的 skewMs，两处必须同源同号，
 *    否则「面板显示快了 2 分钟」与「日志显示慢了 2 分钟」会同时存在。
 *    ⛔ 漂移**告警阈值**（60s）只有一处定义：utils/sign.js 的 CLOCK_DRIFT_ALERT_MS。
 */
export function computeClockDriftMs(agentTs, serverTs) {
  return Number(agentTs) - Number(serverTs);
}

/**
 * 事务内更新 Agent 的心跳字段并返回被锁定的旧状态（IP 追踪要用它做变化判定）。
 *
 * @param {import('pg').PoolClient} client
 * @param {object} input
 * @param {{ id: string }} input.agent 鉴权阶段已确认的 Agent
 * @param {{ ts: number, host?: object }} input.body 上报体
 * @param {Date} input.serverTs
 * @param {string|null} input.remoteIp
 * @param {string|null} input.reportedIp
 * @param {object} [input.logger]
 * @returns {Promise<{ locked: object, driftMs: number }>}
 */
export async function touchAgent(client, input) {
  const locked = await lockAgentForReport(client, input.agent.id, input.remoteIp);
  if (!locked) {
    // 鉴权通过到事务开始之间被删除：按「不存在」处理（4xx 而不是 5xx）
    throw new AppError('agent_unknown_or_disabled', {
      message: 'Agent 不存在或已被移除',
      details: { agent_id: input.agent.id },
    });
  }
  if (locked.status === 'disabled') {
    // 极小概率竞态：preParsing 时还是 online，事务开始前被面板禁用
    throw new AppError('agent_unknown_or_disabled', {
      message: 'Agent 已被禁用',
      details: { agent_id: input.agent.id },
    });
  }

  const driftMs = computeClockDriftMs(input.body.ts, input.serverTs.getTime());

  await updateAgentAfterReport(client, {
    agentId: locked.id,
    serverTs: input.serverTs,
    agentTs: input.body.ts,
    clockDriftMs: driftMs,
    remoteIp: input.remoteIp,
    reportedIp: input.reportedIp,
    hostInfo: input.body.host ?? null,
    capabilities: input.body.host?.capabilities ?? null,
  });

  return { locked, driftMs };
}
