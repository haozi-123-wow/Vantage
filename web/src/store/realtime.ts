/**
 * 实时数据 store（docs/frontend.md §5.3 / docs/api.md §5）。
 *
 * 语义要点（⛔ 都是已定口径，不要"顺手优化"）：
 * - `snapshot` → **整表替换**当前状态（不合并、不累加）；
 * - `delta` → 按 `agent_id` + **指标全名**就地更新当前值，并推入定长环形缓冲（默认 300 点）；
 * - ⛔ 环形缓冲的键必须是序列全名（含维度）：用基名做键会把多个挂载点混成一条线（F10）；
 * - 掉线期间缺失的增量**不补**：进入 `connecting` / 收到新 `snapshot` 都要清空缓冲，
 *   避免把断线期的空洞误连成一条线；
 * - 全站**单连接复用**（docs/frontend.md §10）：切页面只改订阅，不重建连接。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { createRealtimeConnection } from '@/api/ws'
import type { RealtimeConnection, SubscribeFilter, WsChannel } from '@/api/ws'
import { parseMetric } from '@/utils/metrics'
import { RingBuffer } from '@/utils/ring'
import type {
  RealtimeHost,
  RealtimeSeries,
  RealtimeStatus,
  RealtimeSummary,
  WsDeltaMessage,
  WsMessage,
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

export const useRealtimeStore = defineStore('realtime', () => {
  const status = ref<RealtimeStatus>('closed')
  const hosts = ref<Record<string, RealtimeHost>>({})
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
    const next: Record<string, RealtimeHost> = {}
    for (const host of message.hosts ?? []) next[host.id] = host
    hosts.value = next
    summary.value = message.summary ?? null
    // 快照意味着这是一个新连接：断线期空洞不可续（docs/frontend.md §5.3）
    clearSeries()
    lastMessageAt.value = message.ts
  }

  function applyDelta(message: WsDeltaMessage): void {
    lastMessageAt.value = message.ts
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

  /** 全站单连接：已连接时重复调用是空操作（切页面只改订阅） */
  function connect(channel: WsChannel = 'public'): void {
    if (connection) return

    connection = createRealtimeConnection(channel, {
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
