/**
 * Vantage · 审计日志数据访问（`audit_logs`）
 *
 * 依据：docs/database.md §5.13、§11（安全与合规）；设计 §13「面板侧操作留审计日志」、
 *       §6.2「跨机越权 → 拒绝并记审计」
 *
 * ⛔ 什么**不**进审计：Agent 的每一次正常上报。
 *    15s 周期 × 5 台 = 每天 28800 条，把审计表变成时序表，既撑爆保留期（365d）
 *    又让真正需要查的登录/凭证/规则变更淹没在噪声里。
 *    审计只记「异常与人为操作」：本模块目前只服务「跨机越权」这类**需要留痕的安全事件**。
 */

/**
 * 写一条审计。
 *
 * ⚠️ `detail` 必须是**对象**（`audit_logs_detail_ck` 用 `vantage_jsonb_is_object` 把关），
 *    且**已脱敏**：⛔ 禁止写入 agent_key/agent_secret 明文、Cookie、通道口令。
 *
 * 失败不抛：审计写不进去不应该让上报本身失败（那会把「审计坏了」升级成「监控坏了」），
 * 但必须留下 error 级日志——静默失败等于没有审计。
 *
 * @param {import('pg').Pool | import('pg').PoolClient} runner 池或事务客户端
 * @param {object} entry
 * @param {string} entry.actor 面板用户 uuid / `agent:<id>` / `system`
 * @param {'user'|'agent'|'system'} entry.actorType
 * @param {string} entry.action 如 agent.report.identity_mismatch
 * @param {string|null} [entry.target]
 * @param {string|null} [entry.ip]
 * @param {object} [entry.detail] 脱敏后的详情
 * @param {{ error: Function }} [logger]
 */
export async function insertAuditLog(runner, entry, logger) {
  try {
    await runner.query(
      `INSERT INTO audit_logs (actor, actor_type, action, target, ip, detail)
       VALUES ($1, $2, $3, $4, $5::inet, $6::jsonb)`,
      [
        entry.actor,
        entry.actorType,
        entry.action,
        entry.target ?? null,
        entry.ip ?? null,
        JSON.stringify(entry.detail ?? {}),
      ],
    );
    return true;
  } catch (err) {
    logger?.error?.({ err, action: entry.action }, '审计日志写入失败（已忽略，未阻断请求）');
    return false;
  }
}
