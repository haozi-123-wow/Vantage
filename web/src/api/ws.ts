/**
 * WebSocket 客户端：连接、订阅、退避重连、失活检测、消息分发（docs/frontend.md §5.1 / §5.3）。
 *
 * 协议约束（docs/api.md §5.2–§5.3）：
 * - 客户端 → 服务端的**应用层消息只有 `subscribe` 一条**；⛔ 保活走协议层 ping/pong 帧，
 *   前端**不发**任何应用层保活消息，只做失活检测；
 * - 掉线期间的增量**不补传**：重连成功后由服务端重新推全量 snapshot，
 *   调用方（realtime store）看到 `connecting` 时清空环形缓冲，避免把空洞误连成一条线；
 * - 退避：1s → 2s → 4s → … 上限 30s，±20% 抖动。
 */
import type { RealtimeStatus, WsMessage, WsSubscribeMessage } from '@/types/domain'

export type WsChannel = 'public' | 'live'

export interface SubscribeFilter {
  /** 缺省 = 全部频道 */
  channels?: string[]
  /** 缺省 = `['*']`（全部主机）；详情页传具体 id 以降流量 */
  agents?: string[]
}

export interface RealtimeHandlers {
  onStatus: (status: RealtimeStatus) => void
  onMessage: (message: WsMessage) => void
}

export interface RealtimeConnection {
  sendSubscribe: (filter: SubscribeFilter) => void
  close: () => void
}

const BASE_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000
const JITTER_RATIO = 0.2
/**
 * 超过该时长未收到任何**应用层**消息 → 标记 `degraded`（⛔ 不关连接，见 `startStaleWatch`）。
 *
 * ⚠️ 阈值不能小：面板频道的增量来自"有机器在上报"（默认 30s 一次），
 *    但**所有机器都离线时一条 delta 都不会有** —— 那正是最需要看清状态的时刻，
 *    却恰好是消息面最安静的时刻。公开频道更极端：`status` delta 只在上下线切换时才发。
 */
const STALE_AFTER_MS = 90_000
const STALE_CHECK_MS = 5_000

function wsUrl(channel: WsChannel): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/${channel}`
}

/** ⛔ 只认 snapshot / delta；未知类型（含 ping/pong）一律忽略 */
function parseMessage(raw: string): WsMessage | null {
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return null
    const type = (data as { type?: unknown }).type
    if (type === 'snapshot' || type === 'delta') return data as WsMessage
    return null
  } catch {
    return null
  }
}

export function createRealtimeConnection(
  channel: WsChannel,
  handlers: RealtimeHandlers,
): RealtimeConnection {
  let socket: WebSocket | null = null
  let closedByCaller = false
  let attempt = 0
  let reconnectTimer: number | undefined
  let staleTimer: number | undefined
  let lastFrameAt = Date.now()
  let pendingSubscribe: WsSubscribeMessage | null = null

  function clearTimers(): void {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
    if (staleTimer !== undefined) window.clearInterval(staleTimer)
    reconnectTimer = undefined
    staleTimer = undefined
  }

  function scheduleReconnect(): void {
    if (closedByCaller) return
    const backoff = Math.min(BASE_RECONNECT_MS * 2 ** attempt, MAX_RECONNECT_MS)
    const jitter = backoff * JITTER_RATIO * (Math.random() * 2 - 1)
    const delay = Math.max(0, Math.round(backoff + jitter))
    attempt += 1
    handlers.onStatus('connecting')
    reconnectTimer = window.setTimeout(connect, delay)
  }

  function startStaleWatch(): void {
    if (staleTimer !== undefined) window.clearInterval(staleTimer)
    // ⛔ 公开频道不做静默判定：它的 `status` delta 只在上下线切换时才有，
    //    "长时间没有消息"是完全正常的（`snapshot` 之后可能几十分钟一片安静）。
    if (channel === 'public') return

    lastFrameAt = Date.now()
    staleTimer = window.setInterval(() => {
      if (Date.now() - lastFrameAt <= STALE_AFTER_MS) return
      // ⚠️ 只**提示**，⛔ 绝不 `socket.close()`：
      //    浏览器**不会**把协议层的 ping/pong 帧暴露给 JS —— 服务端每 30s 发的 ping 帧
      //    在 `onmessage` 里是看不见的。所以"没收到应用层消息"完全可能只是"这段时间没有增量"。
      //    真断线由 `onclose` / `onerror` 负责（服务端在收不到 pong 时会 terminate，
      //    TCP 层也会超时）—— 在这里主动关连接只会把健康连接变成每 90 秒一次的重连风暴。
      handlers.onStatus('degraded')
    }, STALE_CHECK_MS)
  }

  function connect(): void {
    if (closedByCaller) return
    handlers.onStatus('connecting')

    let next: WebSocket
    try {
      next = new WebSocket(wsUrl(channel))
    } catch {
      scheduleReconnect()
      return
    }
    socket = next

    next.onopen = () => {
      attempt = 0
      handlers.onStatus('open')
      startStaleWatch()
      if (pendingSubscribe) next.send(JSON.stringify(pendingSubscribe))
    }

    next.onmessage = (event: MessageEvent) => {
      lastFrameAt = Date.now()
      const parsed = parseMessage(String(event.data))
      if (!parsed) return
      handlers.onMessage(parsed)
    }

    next.onerror = () => {
      // 具体原因由 onclose 处理；这里只确保连接不会僵着不动
      next.close()
    }

    next.onclose = () => {
      if (socket === next) socket = null
      clearTimers()
      if (closedByCaller) return
      handlers.onStatus('closed')
      scheduleReconnect()
    }
  }

  connect()

  return {
    sendSubscribe(filter: SubscribeFilter): void {
      pendingSubscribe = {
        type: 'subscribe',
        ...(filter.channels ? { channels: filter.channels } : {}),
        agents: filter.agents ?? ['*'],
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(pendingSubscribe))
      }
    },
    close(): void {
      closedByCaller = true
      clearTimers()
      const current = socket
      socket = null
      current?.close()
      handlers.onStatus('closed')
    },
  }
}
