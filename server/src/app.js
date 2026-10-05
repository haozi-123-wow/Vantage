/**
 * Vantage · vantage-core 应用装配
 *
 * 依据：Vantage-DESIGN-v0.7.md §5.1（分层）、§5.2（中间件顺序固定）、§11.3（目录结构）；
 *       docs/api.md §1.2（通用请求约定）、§1.3（统一错误模型）、§1.5（中间件顺序）
 *
 * 本文件**只负责装配**：日志/错误模型/请求 ID/通用安全响应头/健康检查。
 * 业务路由按里程碑逐个挂载（见下方「路由挂载清单」）。
 * ⛔ 单向宗旨（设计 §2.1）：本服务⛔不得出现任何向 Agent 下发配置/命令的路径。
 */

import { randomUUID } from 'node:crypto';

import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';

import { registerAgentReportRoutes } from './routes/agent.report.js';
import { registerAgentAdminRoutes } from './routes/agents.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerHostRoutes } from './routes/hosts.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerWsRoutes } from './routes/ws.js';
import { buildErrorBody, normalizeError } from './utils/errors.js';
import { createWsFanout } from './ws/fanout.js';
import { createWsHub } from './ws/hub.js';

export const SERVICE_NAME = 'vantage-core';
export const SERVICE_VERSION = '0.8.0';

/**
 * 路由挂载清单（按里程碑推进）
 *
 *  ✅ 已实现  GET  /healthz · /readyz · /version
 *  ✅ M1      POST /api/v1/agent/report        （解压→验签→幂等→批量落库，docs/api.md §2.1）
 *  ✅ M1      POST /api/v1/agent/heartbeat     （共用 Agent 限流桶，§2.2）
 *  ✅ B4/B5   /api/v1/auth/login · me · logout · logout-all · password
 *             （会话/CSRF/登录限流/审计，docs/api.md §4.1、§4.1.1 ⑦；2FA 三件套与恢复码在 B6/B7）
 *  ✅ M2      GET /api/public/hosts · /api/public/summary
 *             （免登录只读快照：按 IP 严格限流 + 响应级短 TTL 缓存 + `public_view.enabled` 总开关，§3.2）
 *  ✅ M2      GET /api/v1/hosts                （主机列表：派生状态 / 快照 / 探活计数，§4.2）
 *  ✅ M2      GET /api/v1/summary · /api/v1/hosts/{id}[/probes|/ip-history|/processes]
 *             （面板汇总 + 单机纵深：详情/探活历史/IP 时间线/进程 Top，§4.2）
 *  ✅ M2      GET /api/public/hosts/{slug}/now · /api/public/probes
 *             （公开单机展开与探活概览：⛔ 设备名泛化、目标脱敏，§3.2）
 *  ✅ M3      POST /api/v1/agents              （添加 Agent：签发凭证，明文仅一次，§4.4）
 *  ✅ M2      GET /api/v1/hosts/{id}/metrics   （历史曲线：档位/两道闸门/桶对齐，§4.3）
 *  ✅ M3      /ws/public · /ws/live            （WebSocket 快照+增量，§5）
 *  ⏳ M3      /api/v1/agents 的其余管理端点（列表/详情/PATCH/rotate/disable|enable/revoke，§4.4）
 *  ⏳ M3      /api/v1/alert-rules|alert-events|channels|silences|settings|users|audit-logs（§4.5–§4.10）
 *  ⛔ 永不存在 GET /api/v1/agent/config、/agent/tasks、/agent/command 等下发型端点（§2.3）
 */

/**
 * 装配 Fastify 实例（不监听端口，便于测试直接 `app.inject()`）。
 * @param {object} deps
 * @param {object} deps.config loadConfig() 的结果
 * @param {object} deps.logger pino 实例
 * @param {object} deps.db { app: Pool, migrator?: Pool }
 * @param {object} deps.redis ioredis 实例
 * @param {boolean} [deps.startupChecks] 是否在 /readyz 中做真实探活（测试可关）
 * @param {Function|null} [deps.fetchImpl] 出站 HTTP 实现（仅测试注入，用于**打桩极验**；生产传 null 用内置 fetch）
 */
export async function buildApp({ config, logger, db, redis, startupChecks = true, fetchImpl = null }) {
  const app = Fastify({
    loggerInstance: logger,
    // ✅ §13：X-Forwarded-For 可信代理白名单决定 client IP 的真实性（影响审计与 IP 追踪）
    trustProxy: config.http.trustProxy,
    // 请求 ID 贯通：反代传入的 X-Request-Id 优先，便于跨层对账
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : randomUUID();
    },
    // 全局体积上限：这是**收到（压缩后）**的字节数；解压输出上限在 Agent 上报路由内单独把关
    bodyLimit: config.security.maxCompressedBytes,
    // 校验策略：不做类型强制转换、不丢弃未声明字段（白名单由路由 schema 显式声明）——
    // ✅ §5.2「字段白名单」必须严格，宽松补全会掩盖 Agent 侧字段漂移
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        allErrors: true,
        useDefaults: false,
      },
    },
    // 请求日志保持开启（默认行为）。⛔ 不要再写 `disableRequestLogging`：
    // Fastify 5.12 起该顶层选项已弃用（改用 logController），写了会在启动时打弃用告警。
  });

  // --- 依赖注入（供路由/服务层通过 req.server.xxx 访问）-----------------------
  app.decorate('config', config);
  app.decorate('deps', { db, redis, startupChecks, fetchImpl });
  /**
   * 面板会话的挂载点（middleware/authPanel.js 写、路由读）。
   * ⚠️ 必须**声明**装饰器：Fastify 靠它给 request 生成稳定的隐藏类，
   *    运行时动态挂属性会退化成字典模式拖慢所有请求，且 schema/文档工具也看不到。
   */
  app.decorateRequest('session', null);

  /**
   * WebSocket 订阅中心（`src/ws/hub.js`）。
   * ⚠️ 与 socket 实现无关：路由把连接登记进来、扇出把消息喂进来，它只回答"该发给谁"。
   *    这样"频道白名单 / agent 过滤 / 死连接不拖垮广播"这些判断都能纯单测
   *    （`app.inject()` 测不了 WebSocket，见 `routes/ws.js` 的文件头）。
   */
  const wsHub = createWsHub({ logger, maxClients: config.ws.maxClients });
  app.decorate('wsHub', wsHub);

  // --- 插件 ------------------------------------------------------------------
  // ⚠️ WebSocket 插件必须在**定义** `{ websocket: true }` 的路由之前注册：
  //    晚于路由注册时，那些路由会静默退化成普通 HTTP 路由（握手直接 404/426），
  //    而且不会报任何错 —— 是本项目最忌讳的那种静默失效。
  await app.register(websocket, {
    options: {
      // 客户端→服务端只允许 `subscribe`（一条短 JSON）；64KB 已经宽松到离谱，防的是有人灌二进制
      maxPayload: 64 * 1024,
    },
  });

  await app.register(cookie, {
    secret: undefined, // sid 是不透明随机值、服务端在 Redis 校验，⛔ 不做「签名 cookie」以避免双重语义
  });

  await app.register(compress, {
    global: true,
    encodings: ['gzip', 'deflate'],
    threshold: 1024, // 小响应（如 {ok:true,server_ts}）不压缩，省 CPU
    // ⛔ 关掉**请求**侧解压：Agent 上报路径自己实现「压缩后 1MB / 解压后 4MB」两个上限
    //    （§6.6、决策 #47）。@fastify/compress 的解压流没有输出上限，zip bomb 会在
    //    数据交给 JSON 解析器之前就把内存吃掉；见 middleware/authAgent.js 的说明。
    //    响应侧压缩不受影响（public/panel 的 JSON 仍然照常 gzip）。
    globalDecompression: false,
  });

  // --- 通用响应头（安全加固，见设计 §13 安全清单）----------------------------
  app.addHook('onSend', async (req, reply, payload) => {
    // ✅ docs/api.md §1.2：响应头回传请求 ID，便于与审计日志/反代日志对账
    reply.header('X-Request-Id', req.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/api/')) {
      // 面板数据一律不落中间缓存：公开快照也走服务端 Redis 缓存，不依赖 HTTP 缓存
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // --- 统一错误模型（docs/api.md §1.3）---------------------------------------
  app.setErrorHandler((err, req, reply) => {
    const appErr = normalizeError(err, { logger: req.log });

    if (appErr.statusCode >= 500) {
      req.log.error({ err, code: appErr.code }, '请求处理失败');
    } else {
      req.log.warn(
        { code: appErr.code, statusCode: appErr.statusCode, method: req.method, url: req.url },
        '请求被拒绝',
      );
    }

    if (appErr.retryAfterS) reply.header('Retry-After', String(appErr.retryAfterS));
    reply.status(appErr.statusCode).send(buildErrorBody(appErr, req.id));
  });

  app.setNotFoundHandler((req, reply) => {
    req.log.warn({ method: req.method, url: req.url }, '路由未命中');
    reply.status(404).send(
      buildErrorBody(
        normalizeError(Object.assign(new Error('not found'), { statusCode: 404 })),
        req.id,
      ),
    );
  });

  // --- 健康检查（不在 /api 命名空间下，供反代与编排使用）---------------------
  // ⚠️ 选项名必须是 serviceVersion：`version` 是 Fastify register 的保留语义附近的名字，
  //    且插件侧读的是 opts.serviceVersion —— 两侧名字不一致会静默退化成 '0.0.0'（曾真踩过）。
  await app.register(registerHealthRoutes, {
    prefix: '/',
    serviceName: SERVICE_NAME,
    serviceVersion: SERVICE_VERSION,
  });

  // --- Agent 上报（✅ M1；唯一的上行入口，⛔ 不含任何下发路径）---------------
  await app.register(registerAgentReportRoutes);

  // --- 面板认证（✅ §4.1 B4/B5：登录/me/登出/改密；⛔ 无任何向 Agent 下发的路径）---
  await app.register(registerAuthRoutes);

  // --- 公开只读状态（✅ §3.2：免登录 + 按 IP 严格限流 + 总开关；⛔ 响应零内部标识）---
  await app.register(registerPublicRoutes);

  // --- 面板主机（✅ §4.2：需登录且必须完整会话三态；⚠️ 本路由会返回 IP，与公开路由严格分离）---
  await app.register(registerHostRoutes);

  // --- Agent 与凭证管理（✅ §4.4 的第一块：添加 Agent；⛔ 全站唯一返回明文凭证的响应）---
  await app.register(registerAgentAdminRoutes);

  // --- WebSocket（✅ §5：快照 + 增量；⛔ 客户端→服务端只允许 `subscribe`）------
  await app.register(registerWsRoutes);

  /**
   * Redis 扇出：订阅 `live:metrics`（生产者是 `ingest.service.js` 与 `cron.service.js`，
   * 二者已在发，本层**原样转发、不翻译**）。
   *
   * ⚠️ 启动失败**不让整个中心起不来**：实时增量是锦上添花，REST 完全不受影响；
   *    但必须**喊出来**（warn 日志），⛔ 不能静默降级成"面板永远不刷新"。
   *    测试环境里的假 Redis 没有 `duplicate/subscribe`，走的就是这条路。
   */
  const wsFanout = createWsFanout({ redis, hub: wsHub, config, pool: db.app, logger });
  app.decorate('wsFanout', wsFanout);
  await wsFanout.start().catch((err) => logger?.warn?.({ err }, 'WS 扇出启动异常（实时增量不可用）'));

  // 收尾顺序：先让扇出停止投递，再清掉连接记录（真实 socket 由 @fastify/websocket 关闭）
  app.addHook('onClose', async () => {
    await wsFanout.stop().catch((err) => logger?.warn?.({ err }, 'WS 扇出停止异常'));
    wsHub.closeAll();
  });

  return app;
}

/** 优雅关闭顺序：先停止接收新请求，再断开依赖连接 */
export async function closeApp(app, deps = {}) {
  const { db, redis, logger } = deps;
  await app.close().catch((err) => logger?.error({ err }, 'Fastify 关闭失败'));
  if (redis) {
    const { closeRedis } = await import('./db/redis.js');
    await closeRedis(redis, logger);
  }
  if (db?.app) await db.app.end().catch((err) => logger?.error({ err }, 'PG 运行时池关闭失败'));
  if (db?.migrator) await db.migrator.end().catch((err) => logger?.error({ err }, 'PG 迁移池关闭失败'));
}
