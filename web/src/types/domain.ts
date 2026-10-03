/**
 * Vantage Console 前端领域类型。
 *
 * 字段口径来源（⛔ 不要按记忆改）：
 * - 公开视图脱敏要求：docs/api.md §3.1；端点与响应要点：§3.2
 * - 会话与 2FA：docs/api.md §4.1；主机与历史：§4.2
 * - 指标序列命名：docs/database.md §5.7.2
 * - WS 消息编码：docs/api.md §5.2
 */

/** 主机状态（docs/frontend.md §4.3 过滤口径） */
export type HostStatus = 'online' | 'offline' | 'disabled'

/** 告警严重度（✅ docs/api.md §4.6：firing/resolved + severity） */
export type AlertSeverity = 'critical' | 'warn' | 'info'

/** 实时连接状态（供 AppLayout 的连接指示灯，docs/frontend.md §5.3） */
export type RealtimeStatus = 'connecting' | 'open' | 'closed' | 'degraded'

/** 指标维度（由序列全名反解，docs/database.md §5.7.2） */
export type MetricLabels = Record<string, string>

/** 时序查询返回的单条序列（docs/api.md §4.3） */
export interface MetricSeries {
  /** 权威序列全名（含维度），如 `disk.used_pct{mount=/data}` */
  metric: string
  /** 基名，用于分组 */
  base: string
  labels: MetricLabels
  unit: string
  /** `[ts_ms, value]`；缺失桶为 null（⛔ 不补 0） */
  points: Array<[number, number | null]>
}

/** 实时环形缓冲里的一条序列（docs/frontend.md §5.3，建议每序列 300 点） */
export interface RealtimeSeries {
  /** 序列全名，即权威键 */
  metric: string
  base: string
  labels: MetricLabels
  unit?: string
  points: Array<[number, number]>
}

/** 公开视图的每机快照（docs/api.md §3.2；⛔ 不含 IP / 内部标识） */
export interface PublicSnapshot {
  cpu_pct: number | null
  mem_pct: number | null
  disk_pct: number | null
  net_rx_bps: number | null
  net_tx_bps: number | null
  gpu_pct?: number | null
}

/** 公开视图的主机条目（⛔ 只用 display_name，且只给 slug 不给内部 UUID） */
export interface PublicHost {
  slug: string
  name: string
  status: HostStatus
  os?: string
  uptime?: number
  snapshot: PublicSnapshot
  probes: { up: number; down: number }
  last_seen_ago?: number
}

/** `GET /api/public/summary` */
export interface PublicSummary {
  total: number
  online: number
  offline: number
  alerts: { critical: number; warn: number; info: number }
  updated_at: string
}

/** `GET /api/public/probes`（target_host 已脱敏） */
export interface PublicProbe {
  slug: string
  name: string
  target_host: string
  type: string
  up: boolean
  latency_ms: number | null
  checked_at: string
}

/** 面板账号（⛔ 任何接口都不得返回 password_hash / totp_secret_enc，docs/api.md §4.9） */
export interface AuthUser {
  id: string
  username: string
  display_name?: string | null
  totp_enabled?: boolean
}

/** 会话信息（我的会话页用；IP/UA 只记录不强制校验） */
export interface AuthSession {
  created_at: string
  last_seen: string
  ip?: string | null
  ua?: string | null
}

/** `GET /api/v1/auth/me` 响应 */
export interface MeResponse {
  user: AuthUser
  /** ✅ 恒为单元素数组：`["admin"]` 或 `["user"]`（docs/api.md §4.1） */
  roles: string[]
  session: AuthSession
  csrf: string
}

/** `POST /api/v1/auth/login` 响应 */
export interface LoginResponse {
  user?: AuthUser
  roles?: string[]
  csrf: string
  /** 为真时必须停留在登录流程内做第二步（其余接口一律 403 totp_required） */
  totp_required: boolean
}

/** 实时快照里的主机条目（WS `snapshot`，docs/api.md §5.2） */
export interface RealtimeHost {
  id: string
  status: HostStatus
  snapshot?: Record<string, number | null>
  [key: string]: unknown
}

export interface RealtimeSummary {
  total: number
  online: number
  offline: number
  alerts: number
}

/** 服务端 → 客户端：连接建立后立即推送的全量快照 */
export interface WsSnapshotMessage {
  type: 'snapshot'
  ts: number
  hosts: RealtimeHost[]
  summary: RealtimeSummary
}

/** 服务端 → 客户端：增量（单机/单指标粒度） */
export interface WsDeltaMessage {
  type: 'delta'
  ts: number
  channel: 'metrics' | 'status' | 'probes' | 'alerts'
  agent_id: string
  metrics?: Record<string, number>
  status?: HostStatus
  last_seen_at?: string
  probe?: { name: string; up: boolean; latency_ms?: number | null }
  event?: { id: number | string; rule_id?: string; severity?: AlertSeverity; status?: string }
}

export type WsMessage = WsSnapshotMessage | WsDeltaMessage

/** ⛔ 客户端 → 服务端只允许 `subscribe`（docs/api.md §5.2：应用层消息面收敛为一条） */
export interface WsSubscribeMessage {
  type: 'subscribe'
  channels?: string[]
  agents?: string[]
}
