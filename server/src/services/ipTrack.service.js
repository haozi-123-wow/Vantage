/**
 * Vantage · IP 追踪服务（区间表 + 变化事件 + Flapping 防抖）
 *
 * 依据：Vantage-DESIGN-v0.7.md §8（IP 变化与防抖/Flapping）、决策 #39；
 *       docs/database.md §5.5、§5.6、§6.1（落库顺序第 3 步）
 *
 * 判定规则（✅ §8 原文）：**同一 Agent 在 10 分钟内变化超过 3 次 → 进入 Flapping 态**，
 * 暂停 IP 变化类告警、**只记一条 flapping 事件**，恢复稳定后由 cron 自动解除。
 *
 * 地址过滤与分类见 `utils/ip.js`（含与 §5.5「私网提前过滤」的口径差异说明，开放项 M-7）。
 */

import { prepareIp } from '../utils/ip.js';
import { markIpFlapping } from '../repositories/agent.repo.js';
import { countRecentIpChanges, insertIpChangeEvent, upsertIpHistory } from '../repositories/ipTrack.repo.js';

/**
 * 事务内完成 IP 追踪。
 *
 * 两个来源的分工（§8「双源比对」）：
 *  - `remote`（连接来源 IP）：区间 + **变化事件**（唯一驱动 Flapping 的源）+ 与 `agents.last_ip` 比较；
 *  - `agent_reported`（Agent 自报出口 IP）：**只进区间表**，⛔ 不产变化事件 ——
 *    自报值在 NAT 环境下会含大量 Agent 本机地址，用它驱动告警会变成噪声源。
 *
 * @param {import('pg').PoolClient} client
 * @param {object} input
 * @param {string} input.agentId
 * @param {object} input.locked lockAgentForReport 的结果（含 ipChanged/ipFlapping/lastIp）
 * @param {Date} input.serverTs
 * @param {string|null} input.remoteIp
 * @param {string|null} input.reportedIp
 * @param {{ windowS: number, changes: number }} input.flapping
 * @param {object} [input.logger]
 */
export async function trackIps(client, input) {
  const result = { historyRows: 0, changeEvents: 0, flappingTriggered: false, skipped: {} };

  // --- ① 连接来源 IP ---------------------------------------------------------
  const remote = prepareIp(input.remoteIp);

  if (!remote.trackable) {
    result.skipped.remote = remote.category;
  } else {
    await upsertIpHistory(client, {
      agentId: input.agentId,
      ip: remote.ip,
      source: 'remote',
      at: input.serverTs,
    });
    result.historyRows += 1;

    if (input.locked.ipChanged) {
      if (input.locked.ipFlapping) {
        // 已在 Flapping 态 → ⛔ 不再累加变化事件（否则每 15s 一条，把表刷爆且毫无信息量）
        result.skipped.remoteChange = 'flapping_active';
      } else {
        const prior = await countRecentIpChanges(client, {
          agentId: input.agentId,
          at: input.serverTs,
          windowS: input.flapping.windowS,
        });
        const changeCount = prior + 1;

        await insertIpChangeEvent(client, {
          agentId: input.agentId,
          oldIp: input.locked.lastIp ?? null, // 首次记录 IP 时为 NULL（§5.6）
          newIp: remote.ip,
          source: 'remote',
          kind: 'change',
          changeCount,
          at: input.serverTs,
        });
        result.changeEvents += 1;

        if (changeCount > input.flapping.changes) {
          await markFlapping(client, {
            agentId: input.agentId,
            at: input.serverTs,
            lastIp: input.locked.lastIp ?? null,
            newIp: remote.ip,
            changeCount,
            windowS: input.flapping.windowS,
            logger: input.logger,
          });
          result.flappingTriggered = true;
        }
      }
    }
  }

  // --- ② Agent 自报出口 IP（仅区间，供 §8 双源比对）-------------------------
  const reported = prepareIp(input.reportedIp);
  if (reported.ip) {
    if (reported.trackable) {
      await upsertIpHistory(client, {
        agentId: input.agentId,
        ip: reported.ip,
        source: 'agent_reported',
        at: input.serverTs,
      });
      result.historyRows += 1;
    } else {
      result.skipped.reported = reported.category;
    }
  }

  return result;
}

/** 置 Flapping 态并**只记一条** flapping 事件（✅ 决策 #39） */
async function markFlapping(client, input) {
  await markIpFlapping(client, { agentId: input.agentId, at: input.at });
  await insertIpChangeEvent(client, {
    agentId: input.agentId,
    oldIp: input.lastIp,
    newIp: input.newIp,
    source: 'remote',
    kind: 'flapping',
    changeCount: input.changeCount,
    at: input.at,
  });
  input.logger?.warn?.(
    {
      agentId: input.agentId,
      changeCount: input.changeCount,
      windowS: input.windowS,
    },
    'IP 变化进入 Flapping 态（同一 Agent 在窗口内变化次数超阈值）：暂停 IP 变化类告警，待稳定后由 cron 解除',
  );
}
