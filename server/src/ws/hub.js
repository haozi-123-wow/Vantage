/**
 * Vantage · WebSocket 订阅中心（**与 socket 实现无关**）
 *
 * 依据：docs/api.md §5（频道与握手 / 消息格式 / 语义约束，✅ 2026-10-05 定稿）
 *
 * 🔑 为什么把这一层单独抽出来、且**不 import 任何 socket 库**：
 *    `app.inject()` 测不了 WebSocket（inject 不走真实 socket），所以如果"订阅过滤 + 广播"
 *    写在路由里，它就只能靠真实连接去测（慢、脆、还难并发）。抽出来之后：
 *      · 频道白名单 / 未知频道 / agent 过滤 / 死连接不影响别人 —— 全部是纯函数级单测；
 *      · 路由那层只剩"握手鉴权 + 建连接 + 把消息喂进来"，真实连接冒烟测试只跑 1–2 条。
 *
 * ⛔ 本模块**不做**任何鉴权、不查库、不碰 Redis —— 它只回答一个问题：
 *    "这条已经构造好的消息，该发给哪几条连接？"
 */

import { AppError } from '../utils/errors.js';

/**
 * 服务端 → 客户端的四个频道（✅ 2026-10-05 定稿）。
 *
 * ⚠️ 这四个是**增量**的频道，⛔ 不要再往里塞 `hosts`：
 *    主机是管理员在面板上创建的，**不会因为 Agent 上报而"冒出来"**，
 *    所以它属于**快照**（连接建立时那一发），不是增量。
 *    主机列表"动起来"靠的是 `status`（某台上/下线）与 `metrics`（某台数字变了）。
 *
 * | 频道 | 谁在发 | 现在有数据吗 |
 * |---|---|---|
 * | `metrics` | `ingest.service.js::publishDeltas()` | ✅ |
 * | `status`  | 同上（恢复）+ `cron.service.js::publishOfflineDeltas()`（掉线） | ✅ |
 * | `probes`  | `ingest.service.js::publishDeltas()` | ✅ |
 * | `alerts`  | ——（告警引擎 = M3，尚未实现） | ⏳ **暂时收不到**，合法但安静 |
 */
export const WS_CHANNELS = Object.freeze(['metrics', 'status', 'probes', 'alerts']);

/**
 * 公开连接（`/ws/public`）能订阅的频道。
 *
 * 🔑 **只给 `status`**，不是偷懒：生产端发出来的 delta 里带着**指标全名**
 *    （`disk.used_pct{device=sda1,mount=/data}`），直接转发给匿名访客等于把
 *    磁盘/网卡/挂载点全泄露出去 —— 而公开 REST 那边是**刻意**做了设备名泛化的
 *    （✅ docs/api-status.md §4.6.1 E6：「响应里一个指标名都没有」）。
 *    公开侧真正需要的是"哪台上线/掉线了"，那正是 `status`。
 */
export const WS_PUBLIC_CHANNELS = Object.freeze(['status']);

/** 协议违规的关闭码（RFC 6455：1008 = policy violation） */
export const WS_CLOSE_POLICY_VIOLATION = 1008;

/** 单连接的 `agents[]` 过滤上限（防"订阅一万台"把内存撑起来） */
export const WS_MAX_AGENT_FILTERS = 200;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 协议级错误（**区别于** HTTP 级 `AppError`）。
 *
 * 🔑 为什么必须分开：连接**建立之后**发现的问题（未知频道、非 `subscribe` 消息）
 *    已经不可能再回一个 400 了 —— 唯一的正确动作是**关连接 + 1008**。
 *    如果这里抛 `AppError`，路由层会把它当 HTTP 错误处理（而那时响应早就发出去了），
 *    结果是一条**连接一直开着但什么都不推**的"僵尸连接"，正是本项目最忌讳的静默失效。
 */
export class WsProtocolError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'WsProtocolError';
    this.details = details;
  }
}

/** 该连接**默认**订阅哪些频道（缺省 = 全部它被允许订的） */
export function defaultChannelsFor(kind) {
  return kind === 'public' ? [...WS_PUBLIC_CHANNELS] : [...WS_CHANNELS];
}

/**
 * 创建订阅中心。
 *
 * @param {object} [input]
 * @param {{ warn?: Function, info?: Function }} [input.logger]
 * @param {number} [input.maxClients] 单进程连接总数上限（保护中心自己）
 */
export function createWsHub({ logger, maxClients = 500 } = {}) {
  /** id → client。client = `{ id, kind, ip, user_id, channels: Set, agents: Set|null, send(text), close(code, reason) }` */
  const clients = new Map();
  let sequence = 0;

  function makeId(kind) {
    sequence += 1;
    return `${kind}-${sequence}`;
  }

  /**
   * 登记一条连接（由路由在握手成功后调用）。
   * @throws {AppError} `rate_limited` —— 单进程连接数到顶（保护中心自己，与每 IP 上限是两回事）
   */
  function add(input) {
    if (clients.size >= maxClients) {
      logger?.warn?.({ maxClients }, 'WS 连接总数已达上限，拒绝新连接');
      throw new AppError('rate_limited', {
        message: `服务端连接数已达上限（${maxClients}），请稍后再试`,
        retryAfterS: 30,
        details: { scope: 'ws_total', max_clients: maxClients },
      });
    }

    const kind = input.kind === 'public' ? 'public' : 'live';
    const client = {
      id: makeId(kind),
      kind,
      ip: input.ip ?? null,
      userId: input.userId ?? null,
      send: input.send,
      close: input.close ?? (() => {}),
      channels: new Set(defaultChannelsFor(kind)),
      agents: null, // null = 不过滤（全收）
      /**
       * ⚠️ **未就绪**：刚登记时不能收广播。
       *
       * 🔑 这条不是优化，是契约要求（§5.3「先 snapshot 后 delta」）：
       *    快照要查库/查缓存（async），而广播是 Redis 回调驱动的 —— 两者之间有一个真实的窗口。
       *    只靠"快照先发、广播后到"的时序运气，在负载高时就会偶发"客户端先收到增量、后收到快照"，
       *    前端表现为列表被增量覆盖成残缺状态，且**难复现**。
       *    所以登记时先挂着，`activate()` 之后才开始收 —— 顺序由构造保证，不靠时序。
       */
      ready: false,
      connectedAt: Date.now(),
    };
    clients.set(client.id, client);
    return client;
  }

  /** 摘掉一条连接（幂等：`ws.close` 与 `error` 可能都触发一次） */
  function remove(clientOrId) {
    const id = typeof clientOrId === 'string' ? clientOrId : clientOrId?.id;
    if (!id) return false;
    return clients.delete(id);
  }

  /**
   * 把连接标记为**就绪**（快照已发出）—— 之后就允许接收广播了。
   * ⛔ 只能在快照 `send()` **之后**调用，见 `add()` 里 `ready` 的说明。
   */
  function activate(client) {
    if (client) client.ready = true;
    return client;
  }

  /**
   * 校验并套用一次 `subscribe`。
   *
   * @throws {WsProtocolError} 未知频道 / 非法 `agents[]`（调用方据此关连接 1008）
   * @returns {{ channels: string[], agents: string[]|null }} 实际生效的订阅
   */
  function subscribe(client, payload) {
    const allowed = client.kind === 'public' ? WS_PUBLIC_CHANNELS : WS_CHANNELS;

    // ⚠️ `channels` 缺省**或空数组**都按"全部"处理（沿用本项目 `?q=` / `?tag=` 的口径：
    //    空值 = 未提供）。⛔ 不把"空数组"读成"什么都不订"——那会得到一条**连着但永远安静**
    //    的连接，又是一次静默失效。
    const rawChannels = payload?.channels;
    if (rawChannels !== undefined && rawChannels !== null && !Array.isArray(rawChannels)) {
      throw new WsProtocolError('channels 必须是数组', { field: 'channels' });
    }
    const channelList = Array.isArray(rawChannels) && rawChannels.length > 0 ? rawChannels : [...allowed];

    const channels = new Set();
    for (const item of channelList) {
      if (typeof item !== 'string' || !allowed.includes(item)) {
        throw new WsProtocolError(`未知频道：${String(item)}`, {
          field: 'channels',
          allowed: [...allowed],
        });
      }
      channels.add(item);
    }

    const rawAgents = payload?.agents;
    let agents = null;
    if (rawAgents !== undefined && rawAgents !== null && !(Array.isArray(rawAgents) && rawAgents.length === 0)) {
      if (!Array.isArray(rawAgents)) throw new WsProtocolError('agents 必须是数组', { field: 'agents' });
      // `["*"]` = 不过滤。⚠️ 与 channels 不同，这里**空数组** = 也不过滤（空 = 未提供）。
      if (!rawAgents.includes('*')) {
        if (rawAgents.length > WS_MAX_AGENT_FILTERS) {
          throw new WsProtocolError(`agents 数量超限（> ${WS_MAX_AGENT_FILTERS}）`, {
            field: 'agents',
            max_items: WS_MAX_AGENT_FILTERS,
          });
        }
        agents = new Set();
        for (const id of rawAgents) {
          if (typeof id !== 'string' || !UUID_RE.test(id)) {
            throw new WsProtocolError(`agents 元素必须是 UUID：${String(id)}`, { field: 'agents' });
          }
          agents.add(id);
        }
      }
    }

    client.channels = channels;
    client.agents = agents;
    return { channels: [...channels], agents: agents === null ? null : [...agents] };
  }

  /**
   * 把一条**已经构造好**的消息投给匹配的连接。
   *
   * ⚠️ 单条连接抛异常**不影响别的连接**（死连接由 `ws` 的 close 事件负责摘除）：
   *    广播循环里任何一次 `send` 失败都必须被吞掉并计数，否则一条坏连接会让整轮广播中断，
   *    表现是"部分客户端收不到增量"，而服务端日志里只有一条难归因的错。
   *
   * @param {object} input
   * @param {string} input.channel 四个频道之一
   * @param {string} input.json 原始消息文本（对 live 连接是**原样转发**，⛔ 不翻译）
   * @param {string|null} [input.agentId] 消息涉及的 Agent（用于 `agents[]` 过滤）
   * @param {'live'|'public'|null} [input.onlyKind] 只投给该类连接
   */
  function broadcast(input) {
    let delivered = 0;
    let failed = 0;
    let skipped = 0;

    for (const client of clients.values()) {
      if (!client.ready) {
        // 快照还没发出去 —— 见 `add()` 里 `ready` 的说明：这是"先 snapshot 后 delta"的保证
        skipped += 1;
        continue;
      }
      if (input.onlyKind && client.kind !== input.onlyKind) {
        skipped += 1;
        continue;
      }
      if (!client.channels.has(input.channel)) {
        skipped += 1;
        continue;
      }
      if (client.agents && input.agentId && !client.agents.has(input.agentId)) {
        skipped += 1;
        continue;
      }
      try {
        client.send(input.json);
        delivered += 1;
      } catch (err) {
        failed += 1;
        logger?.warn?.({ err, clientId: client.id }, 'WS 推送失败（该连接等 close 事件摘除）');
      }
    }
    return { delivered, failed, skipped };
  }

  /** 只投给某一类连接（公开侧脱敏用；配合 `count('public') > 0` 先短路，避免白查库） */
  function listClients(kind = null) {
    if (!kind) return [...clients.values()];
    return [...clients.values()].filter((client) => client.kind === kind);
  }

  function count(kind = null) {
    if (!kind) return clients.size;
    let total = 0;
    for (const client of clients.values()) if (client.kind === kind) total += 1;
    return total;
  }

  function stats() {
    return {
      total: clients.size,
      live: count('live'),
      public: count('public'),
      max_clients: maxClients,
    };
  }

  /** 关掉全部连接（进程退出 / 测试收尾） */
  function closeAll(code = 1001, reason = 'server shutting down') {
    const all = [...clients.values()];
    clients.clear();
    for (const client of all) {
      try {
        client.close(code, reason);
      } catch {
        // 关连接失败无所谓：进程都要退了
      }
    }
    return all.length;
  }

  return { add, remove, activate, subscribe, broadcast, listClients, count, stats, closeAll };
}
