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

/**
 * 列表端点的统一响应壳（✅ docs/api.md §1.2 ③，2026-10-04 定）。
 * ⚠️ `next_cursor` 一期恒为 `null`（状态类接口没有 keyset 的自然键，见 `docs/server-status-api.md` §2.8）——
 * 前端按"有值才翻页"处理即可，⛔ 不要自己造页码。
 */
export interface ListResponse<T> {
  items: T[]
  next_cursor: string | null
}

/** 主机列表额外带快照生成时间（服务端/缓存同一时刻） */
export interface HostsResponse<T> extends ListResponse<T> {
  /** RFC3339；命中服务端响应缓存时 = 缓存生成时刻 */
  updated_at: string
}

/** 公开视图的每机快照（docs/api.md §3.2；⛔ 不含 IP / 内部标识） */
export interface PublicSnapshot {
  cpu_pct: number | null
  mem_pct: number | null
  disk_pct: number | null
  net_rx_bps: number | null
  net_tx_bps: number | null
  /** ⚠️ 无 GPU 序列时**整个字段缺省**（不是 null）—— 面板据此整块隐藏 GPU 图 */
  gpu_pct?: number | null
}

/**
 * 公开视图的主机条目（docs/api.md §3.2；标识用 `public_slug`，⛔ 无内部 UUID）。
 * ⚠️ `os` / `uptime` 缺失时**字段缺省**（不是 null）：与 `docs/server-status-api.md` §6.5 一致。
 */
export interface PublicHost {
  slug: string
  name: string
  /** ⛔ 公开侧不出现 `disabled`（人工禁用是内部运营信息） */
  status: Exclude<HostStatus, 'disabled'>
  os?: string
  uptime?: number
  snapshot: PublicSnapshot
  probes: { up: number; down: number }
  /** 中文相对化文案；从未上报 / `disabled` 时为 null（⛔ 不编造"超过 30 天"） */
  last_seen_ago: string | null
  /** **分钟级取整**后的绝对时间（防上下线行为指纹）；从未上报时为 null */
  last_seen_at: string | null
}

/** `GET /api/public/summary` / `GET /api/v1/summary`（**同一形状**，前端可共用类型） */
export interface PublicSummary {
  total: number
  online: number
  offline: number
  /** ➕ 2026-10-04：原字段表漏了它，但顶栏「禁用 N」需要；`total = online + offline + disabled` */
  disabled: number
  alerts: { critical: number; warn: number; info: number }
  updated_at: string
}

/** 面板汇总（`GET /api/v1/summary`）—— 与公开汇总同形，仅在"是否免登录"上不同 */
export type PanelSummary = PublicSummary

/**
 * 维度展开块的一行（公开侧专用）。
 * ⚠️ `label` 是**服务端生成的泛化标签**（「磁盘 1」/「网卡 1」）——
 * 公开侧⛔ 不下发设备名与挂载点（`docs/api.md` §3.1），故前端只能展示这个标签。
 */
export interface PublicDeviceRow {
  label: string
  [field: string]: number | string | null
}

/** 公开单机展开块（`GET /api/public/hosts/{slug}/now` 的 `cpu`/`memory`） */
export interface PublicUsageSummary {
  usage_pct?: number | null
  load1?: number | null
  load5?: number | null
  load15?: number | null
  ctx_switch?: number | null
  total_bytes?: number | null
  used_bytes?: number | null
  used_pct?: number | null
  available_bytes?: number | null
  cached_bytes?: number | null
  buffers_bytes?: number | null
}

/**
 * `GET /api/public/hosts/{slug}/now` —— 公开单机当前快照（就地展开）。
 * = 列表条目 + 分区/网卡/GPU 数组；⛔ 无指标名、无设备名、无 IP、无内部 UUID。
 */
export interface PublicHostNow extends PublicHost {
  cpu: PublicUsageSummary
  memory: PublicUsageSummary
  disks: PublicDeviceRow[]
  networks: PublicDeviceRow[]
  gpus: PublicDeviceRow[]
  updated_at: string
}

/** `GET /api/public/probes` 的一项（`target_host` 已按口径脱敏） */
export interface PublicProbe {
  slug: string | null
  host_name: string | null
  /** 探活名（Agent 本地 config.yaml 里起的名字，如「网关」「官网」） */
  name: string
  /** 域名 / 公网 IP / 哨兵值「内网地址」；解析不出来时为 null */
  target_host: string | null
  type: string
  up: boolean
  latency_ms: number | null
  checked_at: string | null
}

/** `GET /api/public/probes` 响应（⛔ 不是裸数组） */
export interface PublicProbesResponse extends ListResponse<PublicProbe> {
  /** 条数被服务端上限截断（⛔ 不静默丢数据，前端应提示"仅显示前 N 条"） */
  truncated: boolean
  updated_at: string
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
