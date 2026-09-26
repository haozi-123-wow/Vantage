/**
 * Vantage · 探活结果服务
 *
 * 依据：docs/database.md §5.10、docs/api.md §2.1（probes[] 元素）、
 *       Vantage-DESIGN-v0.7.md §4.6（探活闭环：Agent 自采自判，中心只判定与告警）
 *
 * ⛔ 本服务不做任何「目标改写/补全」：`name`/`type`/`target` 原样落库。
 *    中心一旦开始"帮 Agent 修正"探活目标，单向宗旨就在数据层被破坏了。
 */

import { insertProbeResults } from '../repositories/probe.repo.js';

/**
 * 批量落探活结果。
 * @param {import('pg').PoolClient} client 事务内客户端
 * @param {{ agentId: string, serverTs: Date, probes: Array<object>, logger?: object }} input
 * @returns {Promise<number>} 写入行数
 */
export async function storeProbes(client, input) {
  const rows = await insertProbeResults(client, {
    agentId: input.agentId,
    checkedAt: input.serverTs,
    probes: input.probes,
  });
  input.logger?.debug?.({ agentId: input.agentId, probes: input.probes.length, rows }, '探活结果已落库');
  return rows;
}
