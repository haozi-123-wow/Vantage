/**
 * 需登录私有接口客户端（docs/api.md §4）。
 *
 * 职责（docs/frontend.md §5.1）：
 * - 只访问 `/api/v1/*`，`credentials: 'include'`（会话在 HttpOnly Cookie 里，⛔ 前端不读不写 sid）；
 * - 所有非 GET 请求**自动注入** `X-CSRF-Token`（取自登录 / `me` 响应，仅存内存）；
 * - 统一错误映射：401 → 清理 auth store + 跳登录（保留 redirect）；403 `totp_required` → 回登录第二步；
 *   403 `totp_setup_required` → 引导到设置页绑定 2FA；429 → 由 `AppError.retryAfterS` 支撑倒计时提示。
 *
 * ⛔ 公开域硬隔离：公开页（`/`、`/login`）调用本模块直接抛错 —— 这是网络层断言，
 *    目的是让「公开页误调私有接口」在开发期就炸掉而不是漏数据（docs/frontend.md §9 / §11 回归断言）。
 */
import { AppError, requestJson } from '@/api/http'
import type { QueryValue } from '@/types/http'
import type {
  LoginResponse,
  MeResponse,
  MetricSeries,
  PublicSnapshot,
} from '@/types/domain'

const BASE_URL = '/api/v1'
const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE'])

let inPublicDomain = false

/** 由路由守卫在每次导航前设置（公开域 = 免登录路由） */
export function markPublicDomain(active: boolean): void {
  inPublicDomain = active
}

export function isPublicDomain(): boolean {
  return inPublicDomain
}

/** 与 store 解耦的钩子：避免 api ↔ store 循环依赖（在 main.ts 里接线） */
export interface PrivateClientHooks {
  /** 写请求取 CSRF token（来自 auth store，仅内存） */
  getCsrf?: () => string | null
  onUnauthorized?: (error: AppError) => void
  onTotpRequired?: (error: AppError) => void
  onTotpSetupRequired?: (error: AppError) => void
  onRateLimited?: (error: AppError) => void
}

let hooks: PrivateClientHooks = {}

export function configurePrivateClient(next: PrivateClientHooks): void {
  hooks = next
}

interface CallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, QueryValue>
  signal?: AbortSignal
  /**
   * 豁免 CSRF 断言。只用于**建立会话之前**的端点（`/auth/login`）：此时还没有会话，
   * 拿不到 CSRF token；它由 SameSite Cookie 与 Origin 校验保护。
   * ⛔ 其它写请求一律不得豁免。
   */
  skipCsrf?: boolean
}

async function call<T>(path: string, options: CallOptions = {}): Promise<T> {
  if (inPublicDomain) {
    throw new AppError({
      code: 'private_api_in_public_domain',
      message: `公开视图不得调用私有接口：${path}`,
      status: 0,
    })
  }

  const method = options.method ?? 'GET'
  const isWrite = WRITE_METHODS.has(method)
  const csrf = isWrite && !options.skipCsrf ? (hooks.getCsrf?.() ?? null) : null

  if (isWrite && !options.skipCsrf && !csrf) {
    // 缺 CSRF 视为前端缺陷（docs/frontend.md §9），⛔ 不要静默发出裸写请求
    throw new AppError({
      code: 'csrf_missing',
      message: `写请求缺少 CSRF token：${method} ${path}`,
      status: 0,
    })
  }

  try {
    return await requestJson<T>(BASE_URL, path, {
      method,
      body: options.body,
      query: options.query,
      csrf,
      credentials: 'include',
      signal: options.signal,
    })
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status === 401) hooks.onUnauthorized?.(error)
      else if (error.status === 403 && error.code === 'totp_required') hooks.onTotpRequired?.(error)
      else if (error.status === 403 && error.code === 'totp_setup_required') {
        hooks.onTotpSetupRequired?.(error)
      } else if (error.status === 429) hooks.onRateLimited?.(error)
    }
    throw error
  }
}

// ---- 会话与二次验证（docs/api.md §4.1）-------------------------------------

export interface RecoveryVerifyResult {
  /** 剩余可用恢复码数量；≤2 时前端强提示重新生成 */
  remaining_recovery_codes?: number
}

export const authApi = {
  me: (signal?: AbortSignal) => call<MeResponse>('/auth/me', { signal }),

  /** 第一步：密码。会话尚未建立，因此豁免 CSRF（见 CallOptions.skipCsrf） */
  login: (body: { username: string; password: string }) =>
    call<LoginResponse>('/auth/login', { method: 'POST', body, skipCsrf: true }),

  /** 第二步：TOTP 6 位；成功后 sid 轮换 → 调用方必须重取 `me`（csrf 与角色都会变） */
  verifyTotp: (code: string) => call<void>('/auth/2fa/verify', { method: 'POST', body: { code } }),

  /** 恢复渠道一：一次性恢复码（用后即废） */
  verifyRecoveryCode: (code: string) =>
    call<RecoveryVerifyResult>('/auth/2fa/recovery/verify', { method: 'POST', body: { code } }),

  logout: () => call<void>('/auth/logout', { method: 'POST' }),

  logoutAll: () => call<void>('/auth/logout-all', { method: 'POST' }),
}

// ---- 主机（docs/api.md §4.2 / §4.3）---------------------------------------

export interface HostMetricsQuery {
  /** 基名或全名数组；基名 = 该基名下全部维度序列，全名 = 单序列（docs/api.md §4.3） */
  metrics: string[]
  from: string | number
  to: string | number
  /** 只允许 `auto` / `15s` / `1m` / `5m`；⛔ 前端不自行聚合（docs/frontend.md §6.2） */
  step?: 'auto' | '15s' | '1m' | '5m'
  agg?: 'avg' | 'max' | 'min'
  limit?: number
  cursor?: string
}

export interface HostMetricsResponse {
  /** 服务端回传的**实际** step（`auto` 时由服务端选档） */
  step: string
  from: string
  to: string
  series: MetricSeries[]
}

export interface HostListItem {
  id: string
  name: string
  display_name?: string | null
  tags?: string[]
  status: string
  os?: string | null
  arch?: string | null
  last_seen_at?: string | null
  last_ip?: string | null
  reported_ip?: string | null
  clock_drift_ms?: number | null
  ip_flapping?: boolean
  active_alerts?: number
  snapshot?: Partial<PublicSnapshot>
}

export const hostsApi = {
  list: (query?: {
    status?: 'online' | 'offline' | 'disabled'
    tag?: string
    q?: string
    limit?: number
    cursor?: string
  }) => call<HostListItem[]>('/hosts', { query }),

  get: (id: string) => call<Record<string, unknown>>(`/hosts/${encodeURIComponent(id)}`),

  metrics: (id: string, query: HostMetricsQuery) =>
    call<HostMetricsResponse>(`/hosts/${encodeURIComponent(id)}/metrics`, {
      query: { ...query, metrics: query.metrics.join(',') },
    }),

  probes: (id: string, query?: { from?: string | number; to?: string | number; name?: string; type?: string }) =>
    call<Record<string, unknown>>(`/hosts/${encodeURIComponent(id)}/probes`, { query }),

  ipHistory: (id: string, query?: { from?: string | number; to?: string | number }) =>
    call<Record<string, unknown>>(`/hosts/${encodeURIComponent(id)}/ip-history`, { query }),

  processes: (id: string, query?: { at?: number | string }) =>
    call<Record<string, unknown>>(`/hosts/${encodeURIComponent(id)}/processes`, { query }),
}

// ---- 告警事件 / 审计 / 设置（docs/api.md §4.6 / §4.8 / §4.10）-------------
// TODO(M3)：规则、通道、静默窗口的 CRUD 端点在 docs/api.md §4.5–§4.7，
//           实现告警页时按该节逐条补齐（⛔ 不要凭记忆猜路径）。

export const alertsApi = {
  events: (query?: { agent_id?: string; metric?: string; limit?: number; cursor?: string; order?: 'asc' }) =>
    call<Record<string, unknown>>('/alert-events', { query }),
}

export const auditApi = {
  logs: (query?: { limit?: number; cursor?: string }) =>
    call<Record<string, unknown>>('/audit-logs', { query }),
}

export interface SettingItem {
  key: string
  type: string
  value: unknown
  default?: unknown
}

export const settingsApi = {
  /** ✅ 统一渲染后端下发的白名单项，⛔ 前端不硬编码 key 列表与默认值（docs/frontend.md §4.6） */
  get: () => call<SettingItem[]>('/settings'),
  patch: (body: Record<string, unknown>) => call<void>('/settings', { method: 'PATCH', body }),
}

export const privateApi = { auth: authApi, hosts: hostsApi, alerts: alertsApi, audit: auditApi, settings: settingsApi }
