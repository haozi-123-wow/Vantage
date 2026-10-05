/**
 * Vantage · WebSocket 扇出（Redis Pub/Sub → 订阅中心）
 *
 * 依据：docs/api.md §5.3（扇出链路：Agent 上报 → 落库 → `PUBLISH live:metrics` → 各 WS 连接广播）、
 *       §5.2（消息格式，✅ 2026-10-05 定稿）、docs/api-status.md §4.4（离线扇出同频道同形状）
 *
 * 🔑 两个已经存在的生产者（本模块**只订阅、不生产**）：
 *   · `services/ingest.service.js::publishDeltas()` —— 每批上报落库**之后**发 `metrics` / `status`(恢复) / `probes`
 *   · `services/cron.service.js::publishOfflineDeltas()` —— 离线扫描发 `status`(掉线)
 *   两者的形状由各自的测试钉住，本层**原样转发、不翻译**（✅ §4.4 的明确要求）。
 *
 * 🔑 为什么订阅端要**单独一条 Redis 连接**：Redis 进入 subscribe 模式的连接**不能再执行普通命令**
 *    （ioredis 会直接报错）。所以用 `redis.duplicate()` 复制一条专用连接，主连接继续跑会话/限流/缓存。
 *
 * ⚠️ 公开连接（`/ws/public`）**不能**直接转发这些 delta：里面的指标全名带着
 *    `device`/`mount`（磁盘、挂载点），而公开 REST 是刻意做了设备名泛化的。
 *    所以公开侧走另一条路：**重新取一次公开列表（复用同一函数 = 形状必然一致），推出那一台**。
 *    成本可控是因为 `status` delta **只在上下线切换时才有**（不是每次上报都有），
 *    且公开列表本身有 10s 响应级缓存。
 */

import { findAgentPublicRef } from '../repositories/agent.repo.js';
import { getSettingBool } from '../services/settings.service.js';
import { listPublicHosts } from '../services/status.service.js';
import { CHANNEL } from '../utils/redisKeys.js';
import { WS_CHANNELS } from './hub.js';

/**
 * @param {object} input
 * @param {import('ioredis').Redis} input.redis 主连接（只用来 `duplicate()`）
 * @param {ReturnType<import('./hub.js').createWsHub>} input.hub
 * @param {object} input.config
 * @param {import('pg').Pool} input.pool
 * @param {object} [input.logger]
 * @param {Function} [input.createSubscriber] 仅测试注入（生产用 `redis.duplicate()`）
 */
export function createWsFanout({ redis, hub, config, pool, logger, createSubscriber = null }) {
  let subscriber = null;
  let started = false;

  /** 频道白名单校验：不认识的频道直接丢（⛔ 不进广播循环，避免把协议外的消息推给前端） */
  function readDelta(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      logger?.warn?.('WS 扇出收到非 JSON 消息，已丢弃');
      return null;
    }
    if (payload?.type !== 'delta' || typeof payload.channel !== 'string') {
      logger?.warn?.({ type: payload?.type }, 'WS 扇出收到非 delta 消息，已丢弃');
      return null;
    }
    if (!WS_CHANNELS.includes(payload.channel)) {
      logger?.warn?.({ channel: payload.channel }, 'WS 扇出收到未知频道，已丢弃');
      return null;
    }
    return payload;
  }

  /**
   * 公开侧的脱敏增量：**重新取一次公开列表**，只把那一台推出去。
   *
   * ⚠️ 三重短路，避免"没人在看还拼命查库"：
   *    ① 没有任何公开连接 → 直接返回；
   *    ② `public_view.enabled` 被关掉 → 关掉所有公开连接（与 REST 的 404 同义），不再推；
   *    ③ 那台机不在公开列表里（disabled / 不存在）→ 什么都不推。
   */
  async function pushPublicStatus(agentId) {
    if (hub.count('public') === 0) return;

    let enabled = false;
    try {
      enabled = await getSettingBool(redis, pool, 'public_view.enabled', {
        ttlS: config.security.settingsCacheTtlS,
        logger,
      });
    } catch (err) {
      // ⛔ 读不到开关**不 fail-open**：与 REST 侧同款——读不到就不推。
      logger?.warn?.({ err }, '公开视图开关读取失败，本轮不向公开连接推送');
      return;
    }
    if (!enabled) {
      for (const client of hub.listClients('public')) {
        try {
          client.close(1001, 'public view disabled');
        } catch {
          // 关连接失败交给 close 事件收尾
        }
      }
      logger?.warn?.('公开视图已被关闭（public_view.enabled=false），已断开全部公开 WS 连接');
      return;
    }

    const row = await findAgentPublicRef(pool, agentId).catch((err) => {
      logger?.warn?.({ err, agentId }, '公开 WS 增量查询失败');
      return null;
    });
    if (row === null) return;

    const list = await listPublicHosts({ pool, redis, config, logger });
    const host = list.items.find((item) => item.slug === row.public_slug);
    if (!host) return; // 该机不在公开列表里（刚被禁用/删除）—— 不推

    hub.broadcast({
      channel: 'status',
      agentId,
      onlyKind: 'public',
      json: JSON.stringify({ type: 'delta', channel: 'status', ts: Date.now(), host }),
    });
  }

  /**
   * 处理一条来自 Redis 的消息。
   *
   * ⚠️ 抽成公开方法（而不只是内部的 `subscriber.on('message')` 回调）是**刻意的**：
   *    单测可以直接喂消息进来，不需要 Redis、也不需要开 socket。
   */
  async function handleMessage(channel, raw) {
    if (channel !== CHANNEL.liveMetrics) return; // 目前只订了这一个频道

    const payload = readDelta(raw);
    if (payload === null) return;

    // ① 面板连接：**原样转发**（⛔ 不重新编码 —— 生产者的形状已被各自的测试钉住，
    //    在这里再拼一遍就等于有了第二份实现，两边迟早会漂移）
    const live = hub.broadcast({
      channel: payload.channel,
      agentId: typeof payload.agent_id === 'string' ? payload.agent_id : null,
      onlyKind: 'live',
      json: raw,
    });

    // ② 公开连接：只跟着 `status` 走（见文件头说明）
    if (payload.channel === 'status' && typeof payload.agent_id === 'string') {
      await pushPublicStatus(payload.agent_id);
    }

    return live;
  }

  async function start() {
    if (started) return { started: false, reason: 'already_started' };

    const factory =
      createSubscriber ?? (() => (typeof redis?.duplicate === 'function' ? redis.duplicate() : null));
    let candidate = null;
    try {
      candidate = factory();
    } catch (err) {
      logger?.warn?.({ err }, 'WS 扇出订阅连接创建失败（实时增量不可用，REST 不受影响）');
      return { started: false, reason: 'subscriber_unavailable' };
    }

    if (!candidate || typeof candidate.subscribe !== 'function') {
      // ⚠️ 这里**不能抛错**：测试与精简部署里 Redis 门面可能没有 subscribe/duplicate。
      //    实时增量是"锦上添花"，它挂掉不该让整个中心起不来 —— 但必须**喊出来**。
      logger?.warn?.('WS 扇出未启动：Redis 连接不支持 subscribe/duplicate（实时增量不可用，REST 不受影响）');
      return { started: false, reason: 'subscriber_unavailable' };
    }

    subscriber = candidate;
    subscriber.on('message', (channel, message) => {
      // 回调里不 await：Pub/Sub 是 fire-and-forget，任何异常都不能把订阅循环带崩
      void handleMessage(channel, message).catch((err) =>
        logger?.error?.({ err, channel }, 'WS 扇出处理消息失败'),
      );
    });
    await subscriber.subscribe(CHANNEL.liveMetrics);
    started = true;
    logger?.info?.({ channel: CHANNEL.liveMetrics }, 'WS 扇出已订阅实时频道');
    return { started: true };
  }

  async function stop() {
    const current = subscriber;
    subscriber = null;
    started = false;
    if (!current) return;
    try {
      await current.unsubscribe?.(CHANNEL.liveMetrics);
    } catch (err) {
      logger?.warn?.({ err }, 'WS 扇出退订失败');
    }
    try {
      // ⚠️ 是 `quit` 不是 `disconnect`：ioredis 的 duplicate 连接必须显式关掉，
      //    否则进程退出时事件循环里还挂着一条连接（表现为"服务停了但进程不退"）。
      await current.quit?.();
    } catch (err) {
      logger?.warn?.({ err }, 'WS 扇出订阅连接关闭失败');
    }
  }

  return { start, stop, handleMessage, pushPublicStatus, isStarted: () => started };
}
