/**
 * Vantage · WebSocket 路由（`/ws/public` 与 `/ws/live`）
 *
 * 依据：docs/api.md §5（频道与握手 / 消息格式 / 语义约束，✅ 2026-10-05 定稿）
 *
 * 本文件只做**连接级的四件事**：握手把关（Origin / 会话 / 限流 / 并发数）、
 * 推全量快照、收 `subscribe`、保活与收尾。消息怎么过滤、怎么广播在 `src/ws/hub.js`，
 * Redis 怎么扇出在 `src/ws/fanout.js`（那两层都不 import socket，因而可以纯单测）。
 *
 * 🔑 **`app.inject()` 测不了 WebSocket**（inject 不走真实 socket），所以这里刻意做薄：
 *    凡是能挪进 hub 的判断都挪走了，留给"真实连接"测的只剩握手与两条端到端路径。
 *
 * ⚠️ 两条**顺序上的硬要求**（都踩过或差点踩到，见下面各自的注释）：
 *    ① `wsHub.add()` 与 socket 的 `error`/`close` 监听必须**同步**完成，⛔ 早于任何 `await`；
 *    ② 连接在快照发出**之前**不许收广播（靠 hub 的 `ready` 标志，不靠时序运气）。
 *
 * ⛔ 单向宗旨（设计 §2.1 / §18.3）：客户端 → 服务端的应用层消息**只有 `subscribe` 一种**；
 *    收到任何别的东西 → 立刻关连接（1008）并记审计。WS ⛔ 永远不能变成下发通道。
 */

import { createPanelAuth } from '../middleware/authPanel.js';
import { createPublicViewGuard } from '../middleware/publicView.js';
import { createWsRateLimiter } from '../middleware/rateLimit.js';
import { insertAuditLog } from '../repositories/audit.repo.js';
import {
  PANEL_LIMIT_MAX,
  getPanelSummary,
  getPublicSummary,
  listPanelHosts,
  listPublicHosts,
} from '../services/status.service.js';
import { AppError } from '../utils/errors.js';
import { prepareIp } from '../utils/ip.js';
import { WS_CLOSE_POLICY_VIOLATION, WsProtocolError } from '../ws/hub.js';

/** 单条客户端消息的体积上限（`subscribe` 是短消息；超了就是有人在灌东西） */
const MAX_CLIENT_MESSAGE_BYTES = 8192;

/** 收到协议违规后，`close(reason)` 的文本上限（RFC 6455 规定 reason ≤ 123 字节） */
const MAX_CLOSE_REASON_LENGTH = 120;

/**
 * 握手 Origin 白名单（防跨站 WS 劫持）。
 *
 * 🔑 **为什么"没有 Origin"要放行**：Origin 校验唯一能挡的是**浏览器**——
 *    它保护的是"别的站点用受害者的 Cookie 偷偷开一条 WS"。而非浏览器客户端
 *    （脚本、curl、本项目的集成测试）本来就可以随便伪造任何头，Origin 校验对它们**毫无意义**。
 *    所以缺 Origin = 不是浏览器发起的，交给会话鉴权把关即可，⛔ 不必也不该在这里 403。
 *
 * 🔑 期望值怎么来：配了 `PUBLIC_ORIGIN` 就用它（部署时的权威答案）；
 *    没配则**按当前请求推导同源**（`${协议}://${Host}`）—— 反代下 `Host` 与
 *    `X-Forwarded-Proto` 就是用户浏览器看到的那个，所以"同源部署"这个前提成立时它是准的。
 */
export function createOriginGuard({ config, logger }) {
  const configured = config.http.publicOrigin || null;

  return async function originGuard(request) {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin === '') return; // 见上方说明

    const expected = configured ?? `${request.protocol}://${request.host}`;
    if (origin !== expected) {
      logger?.warn?.({ origin, expected, ip: request.ip }, 'WS 握手被拒绝：Origin 不在白名单内');
      throw new AppError('origin_denied', { details: { origin, expected } });
    }
  };
}

/**
 * 同一 IP 的**并发连接数**上限。
 *
 * ⚠️ 这是**进程内**计数（按已登记的连接数），不是 Redis 全局计数。
 *    取舍：多实例部署时实际上限会变成"每实例 N 条"。之所以不落 Redis ——
 *    连接数这种"随连接生灭"的计数用 INCR/DECR 极容易在进程崩溃时**泄漏**，
 *    泄漏的后果是某个 IP 被永久挡住（比"上限略宽"严重得多）。
 *    本项目当前是同源单实例部署，进程内计数足够；要严格全局限制得用带 TTL 的 ZSET，留到 M3 之后。
 */
function createConcurrencyGuard({ hub, config, logger }) {
  const perIp = config.rateLimit.wsConcurrentPerIp;

  return async function concurrencyGuard(request) {
    const active = hub.listClients().filter((client) => client.ip === request.ip).length;
    if (active >= perIp) {
      logger?.warn?.({ ip: request.ip, active, perIp }, 'WS 握手被拒绝：同 IP 连接数达上限');
      throw new AppError('rate_limited', {
        message: `同一 IP 的 WebSocket 连接数已达上限（${perIp}）`,
        retryAfterS: 30,
        details: { scope: 'ws_per_ip', limit: perIp, active },
      });
    }
  };
}

/**
 * 注册 WebSocket 路由。
 * ⚠️ 调用前 `app.js` 必须已 `register(websocket)`，否则 `{ websocket: true }` 不会生效。
 * @param {import('fastify').FastifyInstance} app
 */
export async function registerWsRoutes(app) {
  const { config, deps, log, wsHub } = app;
  const pool = deps.db.app;
  const redis = deps.redis;

  const panel = createPanelAuth({ redis, config, logger: log });
  const publicView = createPublicViewGuard({ redis, config, logger: log, pool });
  const originGuard = createOriginGuard({ config, logger: log });
  const concurrencyGuard = createConcurrencyGuard({ hub: wsHub, config, logger: log });
  const wsRateLimit = createWsRateLimiter({ redis, config, logger: log });

  /** 统一的协议违规处置：记日志 → 记审计 → 关连接（1008） */
  async function violate({ socket, client, request, reason, details = null }) {
    log?.warn?.(
      { clientId: client?.id, kind: client?.kind, ip: request?.ip, reason, details },
      'WS 协议违规：关闭连接（1008）',
    );
    try {
      await insertAuditLog(
        pool,
        {
          actor: client?.userId ? `user:${client.userId}` : `ws:${prepareIp(request?.ip).ip ?? 'unknown'}`,
          actorType: client?.userId ? 'user' : 'system',
          action: 'ws.protocol_violation',
          target: client?.kind === 'public' ? 'ws:public' : 'ws:live',
          ip: prepareIp(request?.ip).ip,
          detail: { reason, ...(details ?? {}) },
        },
        log,
      );
    } catch (err) {
      // 审计写不进去不该阻止我们把这个连接关掉
      log?.error?.({ err }, 'WS 协议违规审计写入失败');
    }
    try {
      socket.close(WS_CLOSE_POLICY_VIOLATION, String(reason).slice(0, MAX_CLOSE_REASON_LENGTH));
    } catch (err) {
      log?.warn?.({ err }, 'WS 关闭失败（连接可能已经没了）');
    }
  }

  /**
   * 给一条新连接挂上收尾与保活（**同步**，⛔ 必须在任何 await 之前调用）。
   *
   * ⚠️ 为什么顺序这么讲究：`sendSnapshot()` 要查库/查缓存（async），而在这段时间里
   *    连接完全可能已经出错或被对端关掉。如果 `error`/`close` 监听是在 await **之后**才挂的，
   *    那段窗口里的 socket 错误就没有监听者 —— Node 会把 `'error'` 事件升级成**未捕获异常**
   *    （生产里直接命中 `uncaughtException` → **进程退出**）。这不是理论问题：
   *    集成测试里已经稳定复现为一个 `read ECONNRESET`。
   *
   * ⚠️ `ping` 是**协议层帧**（RFC 6455）：浏览器自动回 `pong`，JS 完全不参与 ——
   *    所以"保活"不占用应用层消息，客户端→服务端的消息面才能只剩 `subscribe` 一条。
   */
  function attachLifecycle({ socket, client, request, onMessage }) {
    const keepaliveMs = config.ws.keepaliveIntervalS * 1000;
    let lastPongAt = Date.now();
    /** 定时器句柄放在可变对象里：`close` 可能早于定时器创建（见上面的窗口） */
    const state = { timer: null };

    // ① 先挂 error/close（同步，⛔ 不能挪到 await 之后）
    socket.on('error', (err) => {
      log?.warn?.({ err, clientId: client.id }, 'WS 连接出错');
    });
    socket.on('close', (code, reasonBuf) => {
      if (state.timer) clearInterval(state.timer);
      wsHub.remove(client);
      log?.info?.(
        { clientId: client.id, kind: client.kind, code, reason: reasonBuf?.toString?.() ?? '' },
        'WS 连接已关闭',
      );
    });

    // ② 再做消息与保活
    socket.on('pong', () => {
      lastPongAt = Date.now();
    });

    socket.on('message', (data, isBinary) => {
      void (async () => {
        if (isBinary) {
          await violate({ socket, client, request, reason: 'binary_message_not_allowed' });
          return;
        }
        const text = data.toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > MAX_CLIENT_MESSAGE_BYTES) {
          await violate({ socket, client, request, reason: 'message_too_large' });
          return;
        }
        await onMessage(text);
      })().catch((err) => log?.error?.({ err, clientId: client.id }, 'WS 消息处理异常'));
    });

    state.timer = setInterval(() => {
      if (socket.readyState !== 1) return; // 1 = OPEN
      if (Date.now() - lastPongAt > keepaliveMs * 2.5) {
        log?.warn?.({ clientId: client.id, ip: request.ip }, 'WS 保活超时（未收到协议层 pong），断开连接');
        try {
          socket.terminate();
        } catch {
          // 已经断了
        }
        return;
      }
      try {
        socket.ping();
      } catch (err) {
        log?.warn?.({ err, clientId: client.id }, 'WS ping 发送失败');
      }
    }, keepaliveMs);
    // ⛔ unref：不能因为一条空闲连接就把进程钉住（否则优雅关闭会卡到超时强退）
    state.timer.unref?.();

    return state;
  }

  /** 登记连接 + 挂生命周期的监听（**同步**，一次做完，中间不许 await） */
  function registerConnection({ socket, request, kind, userId = null }) {
    const client = wsHub.add({
      kind,
      ip: request.ip,
      userId,
      send: (text) => {
        if (socket.readyState === 1) socket.send(text);
      },
      close: (code, reason) => socket.close(code, reason),
    });
    // client 先建出来，消息处理器才拿得到它（`violate` 要用 client 记审计）
    attachLifecycle({ socket, client, request, onMessage: makeOnMessage({ socket, client, request }) });
    return client;
  }

  /**
   * 推全量快照，然后才把连接标记为"可收广播"。
   *
   * ⚠️ 快照的 `hosts[]` **就是**对应 REST 列表端点的 items（同一形状、同一函数）——
   *    前端同一张表格两个来源，形状不一致就得写两套渲染，那是纯浪费。
   */
  async function sendSnapshot({ socket, client, kind }) {
    const [hosts, summary] =
      kind === 'public'
        ? await Promise.all([
            listPublicHosts({ pool, redis, config, logger: log }),
            getPublicSummary({ pool, redis, config, logger: log }),
          ])
        : await Promise.all([
            listPanelHosts({ pool, config, logger: log, limit: PANEL_LIMIT_MAX }),
            getPanelSummary({ pool, config }),
          ]);

    if (socket.readyState === 1) {
      socket.send(
        JSON.stringify({
          type: 'snapshot',
          ts: Date.now(),
          channels: [...client.channels],
          hosts: hosts.items,
          summary,
          updated_at: hosts.updated_at,
        }),
      );
    }

    // ✅ 快照已出，从现在起才允许收增量（顺序由构造保证，不靠时序运气）
    wsHub.activate(client);
    log?.info?.(
      { clientId: client.id, kind, ip: client.ip, hosts: hosts.items.length },
      'WS 连接已建立并推送快照',
    );
  }

  /** 两条路由共用的消息处理（只有 `subscribe` 一条合法路径） */
  function makeOnMessage({ socket, client, request }) {
    return async function onMessage(text) {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        await violate({ socket, client, request, reason: 'invalid_json' });
        return;
      }
      if (payload?.type !== 'subscribe') {
        // ⛔ 这是"WS 不得成为下发通道"在协议层的最小化落实（设计 §18.3）
        await violate({
          socket,
          client,
          request,
          reason: 'unsupported_message_type',
          details: { type: payload?.type ?? null },
        });
        return;
      }
      try {
        const effective = wsHub.subscribe(client, payload);
        log?.debug?.({ clientId: client.id, ...effective }, 'WS 订阅已更新');
      } catch (err) {
        if (err instanceof WsProtocolError) {
          await violate({ socket, client, request, reason: err.message, details: err.details });
          return;
        }
        throw err;
      }
    };
  }

  // --- /ws/public（免登录、只读、脱敏）---------------------------------------
  app.get(
    '/ws/public',
    {
      websocket: true,
      preValidation: [originGuard, wsRateLimit, concurrencyGuard, publicView],
    },
    async (socket, request) => {
      // ⚠️ 先同步登记 + 挂监听，再 await 取快照 —— 顺序错了会漏掉错误监听（见 attachLifecycle）
      const client = registerConnection({ socket, request, kind: 'public' });
      await sendSnapshot({ socket, client, kind: 'public' });
    },
  );

  // --- /ws/live（需登录，且必须**完整态**会话）-------------------------------
  // ⚠️ 刻意**不加** `requireCsrf`：CSRF 保护的是"浏览器自动带 Cookie 的**写**请求"，
  //    而 WS 这条连接对客户端是只读的（唯一的应用层消息 `subscribe` 只影响它自己收什么）。
  //    "浏览器自动带 Cookie"这个前提在这里由 **Origin 白名单**接管（见 createOriginGuard）。
  app.get(
    '/ws/live',
    {
      websocket: true,
      preValidation: [originGuard, wsRateLimit, concurrencyGuard],
      preHandler: [panel.loadPanelSession, panel.requireFullSession],
    },
    async (socket, request) => {
      const client = registerConnection({
        socket,
        request,
        kind: 'live',
        userId: request.session?.userId ?? null,
      });
      await sendSnapshot({ socket, client, kind: 'live' });
    },
  );
}
