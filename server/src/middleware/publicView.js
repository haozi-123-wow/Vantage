/**
 * Vantage · 公开视图总开关的**闸门**（`public_view.enabled`）
 *
 * 依据：docs/api.md §3.2（关闭时**所有** `/api/public/*` 与 `/ws/public` 返回 **404**）、
 *       §5.4（该开关存 `settings` 表、面板可改、**立即生效**）、
 *       docs/server-status-api.md §2.5（决策 D5）
 *
 * 🔑 三条容易踩错的地方（每条都写在决策里，这里逐条落地）
 *
 *  1. **每请求判定**：`public_view.enabled` 是**运行时**开关（`settings:cache` TTL 30s 内生效），
 *     ⛔ 绝不能在启动时判定一次并缓存到进程里 —— 那样"一键关闭"要等重启才生效，
 *     而"关闭公开视图"往往正是因为**现在**就有不该被看到的东西暴露着。
 *  2. **404 而不是 403**：403 等于告诉外部"这个资源存在、只是不给你看"，
 *     404 则连"存在性"都不泄露（设计 §5.2「默认拒绝」+ 不泄露拓扑）。
 *  3. **body 必须走统一错误信封**：⛔ 不能是空 body 或 HTML —— 直接 `throw new AppError('not_found')`，
 *     由 `app.js` 的 `setErrorHandler` 折叠成 `{ error: { code, message, request_id } }`，
 *     与 `setNotFoundHandler` 的形状完全一致（前端 `isPublicViewDisabled()` 按 404 判定，见 §2.5 第 3 条）。
 *
 * ⚠️ 读取失败（PG 或 Redis 挂掉）**不**吞异常：开关读不到时拒绝服务，
 *    ⛔ 不 fail-open ——"开关可能被关着但我读不到，那就先放行"正是最坏的一种默认值。
 */

import { getSettingBool } from '../services/settings.service.js';
import { AppError } from '../utils/errors.js';

/**
 * 创建公开视图闸门（preHandler）。
 *
 * ⚠️ 必须是 `async`：Fastify 对"既不是 async、也不接收 `done` 回调"的 hook 会按**回调式**处理，
 *    它会一直等 `done()`，于是请求**永久挂起**（详见 middleware/authPanel.js 文件头的同款说明）。
 *
 * @param {object} deps
 * @param {import('ioredis').Redis} deps.redis
 * @param {object} deps.config
 * @param {import('pg').Pool} deps.pool 运行时 DML 池（`settings` 表读取）
 * @param {object} [deps.logger]
 */
export function createPublicViewGuard({ redis, config, logger, pool }) {
  return async function publicViewGuard(request) {
    const enabled = await getSettingBool(redis, pool, 'public_view.enabled', {
      ttlS: config.security.settingsCacheTtlS,
      logger,
    });

    if (!enabled) {
      // warn（不是 info）：被关闭期间的每一次公开访问都值得留下痕迹，
      // 它既可能是"有人还在用已经关掉的页面"，也可能是"有人在扫我的公开端点"。
      logger?.warn?.(
        { ip: request.ip, url: request.url },
        '公开视图已关闭（public_view.enabled=false），按契约返回 404',
      );
      throw new AppError('not_found');
    }
  };
}
