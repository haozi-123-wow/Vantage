/**
 * 实时数据 store（docs/frontend.md §5.3 / docs/api.md §5）。
 *
 * 语义要点（⛔ 都是已定口径，不要"顺手优化"）：
 * - `snapshot` → **整表替换**当前状态（不合并、不累加）；
 * - `delta` → 按 `agent_id` + **指标全名**就地更新当前值，并推入定长环形缓冲（默认 300 点）；
 *   ⚠️ `/ws/public` 的 delta **形状不同**（只有 `channel: 'status'` + 脱敏的 `host` 条目，
 *   docs/api.md §5.2）—— 同样在这一层归一化，视图不必认识两种形状；
 * - ⛔ 环形缓冲的键必须是序列全名（含维度）：用基名做键会把多个挂载点混成一条线（F10）；
 * - 掉线期间缺失的增量**不补**：进入 `connecting` / 收到新 `snapshot` 都要清空缓冲，
 *   避免把断线期的空洞误连成一条线；
 * - 全站**单连接复用**（docs/frontend.md §10）：切页面只改订阅，不重建连接；
 *   ⚠️ **换频道**（公开 ↔ 面板）必须重建：`/ws/public` 与 `/ws/live` 是两个不同的握手，
 *   复用会把公开页接到需要 Cookie 的频道上（或反之）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { createRealtimeConnection } from '@/api/ws'
import type { RealtimeConnection, SubscribeFilter, WsChannel } from '@/api/ws'
import { parseMetric } from '@/utils/metrics'
import { RingBuffer } from '@/utils/ring'
import type {
  PublicHost,
  RealtimeHost,
  RealtimeSeries,
  RealtimeStatus,
  RealtimeSummary,
  WsDeltaMessage,
  WsHostEntry,
  WsMessage,
  WsPublicDeltaMessage,
  WsSnapshotMessage,
} from '@/types/domain'

/** 每序列保留的实时点数（docs/frontend.md §5.3 建议值） */
export const SERIES_BUFFER_LIMIT = 300
/** 最近告警事件保留条数（事件页只做"最近发生了什么"） */
const RECENT_ALERT_LIMIT = 50

export interface RecentAlertEvent {
  id: number | string
  agentId: string
  severity?: string
  status?: string
  ts: number
}

function parseMetricSafe(metric: string): { base: string; labels: Record<string, string> } {
  try {
    return parseMetric(metric)
  } catch {
    // 服务端给了不合规的序列名：降级为"基名 = 原名"，⛔ 不能因此丢掉整条曲线
    return { base: metric, labels: {} }
  }
}

/**
 * 主机条目的键：面板频道用内部 `id`，公开频道只有 `slug`（✅ docs/api.md §5.2：
 * 公开 `snapshot.hosts[]` 就是 `GET /api/public/hosts` 的 items，⛔ 无内部 UUID）。
 * 两者都没有 → 返回 null（⛔ 不要退化成字符串 "undefined" 把所有主机挤进同一个键）。
 */
function hostKey(entry: WsHostEntry | undefined): string | null {
  if (!entry) return null
  const id = (entry as RealtimeHost).id
  if (typeof id === 'string' && id.length > 0) return id
  const slug = (entry as PublicHost).slug
  if (typeof slug === 'string' && slug.length > 0) return slug
  return null
}

export const useRealtimeStore = defineStore('realtime', () => {
  const status = ref<RealtimeStatus>('closed')
  /**
   * 主机条目：面板频道按内部 `id`、公开频道按 `slug`（`id ?? slug`）。
   * ⚠️ 两个频道的键空间不同，故 `connect()` 换频道时**必须**先清空（见文件头）。
   */
  const hosts = ref<Record<string, WsHostEntry>>({})
  const summary = ref<RealtimeSummary | null>(null)
  /** 序列全名 → 当前缓冲（供曲线即时追加） */
  const series = ref<Record<string, RealtimeSeries>>({})
  /** agent_id → probe 名 → up */
  const probeStates = ref<Record<string, Record<string, boolean>>>({})
  const recentAlerts = ref<RecentAlertEvent[]>([])
  const lastMessageAt = ref<number | null>(null)

  /** 环形缓冲只服务于"正在看的那台机"（详情页），避免多机指标混进同一条曲线 */
  const trackedAgentId = ref<string | null>(null)

  const buffers = new Map<string, RingBuffer<[number, number]>>()

  let connection: RealtimeConnection | null = null
  /** 当前连接的频道（未连接为 null）—— 换频道必须重建连接 */
  const channel = ref<WsChannel | null>(null)

  const hostList = computed(() => Object.values(hosts.value))
  const isLive = computed(() => status.value === 'open')

  function clearSeries(): void {
    buffers.clear()
    series.value = {}
  }

  /** 详情页进入/离开时调用：切换被跟踪的主机必然意味着旧缓冲作废 */
  function trackAgent(agentId: string | null): void {
    if (trackedAgentId.value === agentId) return
    trackedAgentId.value = agentId
    clearSeries()
  }

  function appendSeries(agentId: string, ts: number, metrics: Record<string, number>): void {
    if (trackedAgentId.value !== agentId) return

    for (const [metric, value] of Object.entries(metrics)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue

      let buffer = buffers.get(metric)
      if (!buffer) {
        buffer = new RingBuffer<[number, number]>(SERIES_BUFFER_LIMIT)
        buffers.set(metric, buffer)
        const parsed = parseMetricSafe(metric)
        series.value[metric] = {
          metric,
          base: parsed.base,
          labels: parsed.labels,
          points: [],
        }
      }

      buffer.push([ts, value])
      const target = series.value[metric]
      if (target) target.points = buffer.toArray()
    }
  }

  function applySnapshot(message: WsSnapshotMessage): void {
    const next: Record<string, WsHostEntry> = {}
    for (const host of message.hosts ?? []) {
      const key = hostKey(host)
      if (key) next[key] = host
    }
    hosts.value = next
    summary.value = message.summary ?? null
    // 快照意味着这是一个新连接：断线期空洞不可续（docs/frontend.md §5.3）
    clearSeries()
    lastMessageAt.value = message.ts
  }

  /** ⚠️ 公开 delta 的判别靠 `host` 字段（面板 delta 没有它，只有 `agent_id`） */
  function isPublicDelta(message: WsDeltaMessage | WsPublicDeltaMessage): message is WsPublicDeltaMessage {
    return (message as WsPublicDeltaMessage).host !== undefined
  }

  function applyDelta(message: WsDeltaMessage | WsPublicDeltaMessage): void {
    lastMessageAt.value = message.ts

    if (isPublicDelta(message)) {
      // 公开侧只推 `status`：整条脱敏条目替换（`hosts[]` 与 REST 列表同形）
      const key = hostKey(message.host)
      if (key) hosts.value = { ...hosts.value, [key]: message.host }
      return
    }

    const host = hosts.value[message.agent_id]

    if (message.channel === 'metrics' && message.metrics) {
      if (host?.snapshot) Object.assign(host.snapshot, message.metrics)
      appendSeries(message.agent_id, message.ts, message.metrics)
      return
    }

    if (message.channel === 'status') {
      if (host && message.status) host.status = message.status
      return
    }

    if (message.channel === 'probes' && message.probe) {
      const perHost = probeStates.value[message.agent_id] ?? {}
      perHost[message.probe.name] = message.probe.up
      probeStates.value[message.agent_id] = perHost
      return
    }

    if (message.channel === 'alerts' && message.event) {
      recentAlerts.value = [
        {
          id: message.event.id,
          agentId: message.agent_id,
          severity: message.event.severity,
          status: message.event.status,
          ts: message.ts,
        },
        ...recentAlerts.value,
      ].slice(0, RECENT_ALERT_LIMIT)
    }
  }

  function applyMessage(message: WsMessage): void {
    if (message.type === 'snapshot') applySnapshot(message)
    else applyDelta(message)
  }

  /**
   * 建立（或切换到）某条频道。全站单连接：**同频道**重复调用是空操作（切页面只改订阅）；
   * **换频道**会重建连接并清空状态 —— 两个频道的鉴权与载荷完全不同，复用等于串台。
   */
  function connect(nextChannel: WsChannel = 'public'): void {
    if (connection && channel.value === nextChannel) return
    if (connection) {
      connection.close()
      connection = null
    }
    channel.value = nextChannel
    reset()

    connection = createRealtimeConnection(nextChannel, {
      onStatus: (next) => {
        const previous = status.value
        status.value = next
        if (next === 'connecting' && previous !== 'connecting') clearSeries()
      },
      onMessage: applyMessage,
    })
  }

  function disconnect(): void {
    connection?.close()
    connection = null
    channel.value = null
    status.value = 'closed'
  }

  /** ⛔ 这是客户端 → 服务端唯一允许的应用层消息（docs/api.md §5.2） */
  function subscribe(filter: SubscribeFilter): void {
    connection?.sendSubscribe(filter)
  }

  function reset(): void {
    hosts.value = {}
    summary.value = null
    probeStates.value = {}
    recentAlerts.value = []
    lastMessageAt.value = null
    clearSeries()
  }

  return {
    status,
    channel,
    hosts,
    summary,
    series,
    probeStates,
    recentAlerts,
    lastMessageAt,
    trackedAgentId,
    hostList,
    isLive,
    applyMessage,
    applySnapshot,
    applyDelta,
    trackAgent,
    clearSeries,
    connect,
    disconnect,
    subscribe,
    reset,
  }
})
