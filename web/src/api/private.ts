/**
 * 需登录私有接口客户端（docs/api.md §4）。
 *
 * 职责（docs/frontend.md §5.1）：
 * - 只访问 `/api/v1/*`，`credentials: 'include'`（会话在 HttpOnly Cookie 里，⛔ 前端不读不写 sid）；
 * - 所有非 GET 请求**自动注入** `X-CSRF-Token`（取自登录 / `me` 响应，仅存内存）；
 * - 统一错误映射：401 → 清理 auth store + 跳登录（保留 redirect）；403 `totp_required` → 回登录第二步；
 *   403 `totp_setup_required` → 引导到设置页绑定 2FA；429 → 由 `AppError.retryAfterS` 支撑倒计时提示。
 *
 * ⛔ 公开域硬隔离：公开页调用本模块直接抛错 —— 这是网络层断言，
 *    目的是让「公开页误调私有接口」在开发期就炸掉而不是漏数据（docs/frontend.md §9 / §11 回归断言）。
 *    ⚠️ 例外只有 `/login`：它虽免登录，但按 docs/frontend.md §4.2 必须调用 `/auth/login` 与
 *       `/auth/captcha/*`，故 `router/index.ts` 不对它打公开域标记（该文件里有取舍说明）。
 */
import { AppError, requestJson } from '@/api/http'
import type { QueryValue } from '@/types/http'
import type { GeetestValidate } from '@/utils/geetest'
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
   * 豁免 CSRF 断言。**只**用于「建立会话之前」的三个端点（`/auth/login` 与两个
   * `/auth/captcha/*`，docs/api.md §1.2 ② 的豁免范围）：此时还没有会话，拿不到 CSRF token；
   * 服务端侧同样按「无会话直接放行」处理，由 SameSite Cookie 与 Origin 校验保护。
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

/** `POST /api/v1/auth/2fa/setup` 响应（docs/api.md §4.1，B6） */
export interface TotpSetupResult {
  /**
   * Base32 密钥（无填充）—— 供**手工输入**认证器。
   * ⛔ 明文仅此一次：不写 localStorage / sessionStorage、不进日志、不进 URL。
   */
  secret: string
  /** `otpauth://totp/...`，认证器扫码内容 */
  otpauth_uri: string
  /**
   * 服务端渲染的 **SVG 文本**。
   * ⛔ 本前端**不用 `v-html`** 渲染它（docs/frontend.md §9 的红线）：
   *    改为装进 `data:` URL 交给 `<img>` —— SVG 在 `<img>` 里不执行脚本、不加载外部资源。
   */
  qr_svg: string
}

/** `2fa/enable` 与 `2fa/recovery/regenerate` 的成功响应（字段相同） */
export interface RecoveryCodesResult {
  /** 一次性恢复码，形如 `XXXXX-XXXXX`；⛔ 明文仅此一次，库里只存 HMAC 哈希 */
  recovery_codes: string[]
  remaining_recovery_codes: number
}

/**
 * 人机验证提供方（`docs/api.md` §4.1 的两个端点**按提供方分支**）。
 * ⛔ 它不是安全边界（真正的判定只在 `captcha/verify`），前端只用它来**选组件**。
 */
export type CaptchaProvider = 'selfbuilt' | 'geetest'

/** `POST /api/v1/auth/captcha/challenge` 响应 —— **自建滑块**分支（docs/api.md §4.1 / 自建方案 §5.1） */
export interface SelfbuiltCaptchaChallenge {
  provider: 'selfbuilt'
  /** 题目标识（Redis `captcha:<id>`，TTL 默认 120s） */
  captcha_id: string
  /**
   * 背景图（含缺口）的 SVG 文本。
   * ⛔ 只允许内联渲染本端点返回的字符串（`v-html`），⛔ 绝不渲染任何用户输入或其它来源的字符串。
   */
  bg_svg: string
  /** 拼图块的 SVG 文本。⛔ 与 `bg_svg` 同一条安全约束 */
  piece_svg: string
  /** **逻辑**画布宽（前端可等比缩放显示，但提交的坐标必须是逻辑坐标） */
  width: number
  /** **逻辑**画布高 */
  height: number
  /** 题目有效期（秒） */
  expires_in: number
}

/**
 * 同一个端点的响应 —— **极验 v4** 分支（docs/api.md §4.1 / `docs/geetest-captcha.md` §6.1）。
 * ⚠️ 没有 `expires_in`、没有 `bg_svg`/`piece_svg`：题目与答案都由极验云端管理，服务端**没有答案可存**。
 */
export interface GeetestCaptchaChallenge {
  provider: 'geetest'
  /** 极验 `captcha_id`（**公开**值，前端 `initGeetest4` 要用）。⛔ `captcha_key` 永不下发 */
  captcha_id: string
  /** `popup`（默认：官方按钮 + 带遮罩的验证弹窗）或 `float` */
  product: 'popup' | 'float'
  /** 验证窗语言（`zho`/`eng`…）；⚠️ 由极验渲染，⛔ 不受本站 i18n 控制 */
  language: string
}

/**
 * `POST /api/v1/auth/captcha/challenge` 的响应：**按提供方判别**的联合类型。
 * 前端据此选 `SliderCaptcha.vue`（自建）或 `GeetestCaptcha.vue`（极验）。
 */
export type CaptchaChallengeResponse = SelfbuiltCaptchaChallenge | GeetestCaptchaChallenge

/** 轨迹采样点：`[t_ms, x]`（`t_ms` 为相对拖拽起点的毫秒数，服务端只用首尾差判时长） */
export type CaptchaTrackPoint = [t_ms: number, x: number]

/** `/auth/captcha/verify` 请求体 —— **自建滑块**分支（`provider=selfbuilt`） */
export interface SelfbuiltCaptchaVerifyBody {
  captcha_id: string
  /** 放下时拼图块的**逻辑**横坐标（0 ≤ x ≤ width） */
  x: number
  /** ➕ 仅纵向不动时可省：本前端只做横向滑动，故不传 */
  y?: number
  /** 轨迹采样，**点数上限 200**（服务端硬约束，超了会 400 `schema_invalid`） */
  track: CaptchaTrackPoint[]
}

/**
 * `/auth/captcha/verify` 请求体 —— **极验**分支 = `captchaObj.getValidate()` 的 4 个字段。
 * ⚠️ 极验分支**刻意不收 `captcha_id`**：服务端用自己的配置值（`docs/api.md` §4.1）。
 * 类型定义跟着极验实例走（`utils/geetest.ts`），避免同一个形状在仓库里写两遍。
 */
export type GeetestCaptchaValidate = GeetestValidate

/** `/auth/captcha/verify` 请求体：按提供方判别（两个分支字段完全不同，⛔ 不要混用） */
export type CaptchaVerifyBody = SelfbuiltCaptchaVerifyBody | GeetestCaptchaValidate

/** `POST /api/v1/auth/captcha/verify` 成功响应（两个提供方**完全一致**） */
export interface CaptchaVerifyResult {
  /** 一次性凭证（TTL 默认 120s，**值绑定解出该题的 IP**，登录成功时消费） */
  captcha_token: string
  expires_in: number
}

/**
 * 取验题失败原因：`error.details.reason`（枚举见 `docs/api.md` §4.1）。
 * - 自建：`mismatch` / `track_suspicious` / `expired` / `not_found` / `too_many_attempts`
 * - 极验：`validate_failed`（`details.vendor_reason` 附极验原文）
 * - 登录侧还可能遇到凭证问题：`ip_mismatch` / `expired`
 *
 * ⛔ 前端只用它**选择提示文案与重试动作**，绝不据此判定对错（判定只在服务端）。
 */
export function captchaReasonOf(error: unknown): string | null {
  if (!(error instanceof AppError)) return null
  const details = error.details
  if (details && typeof details === 'object' && 'reason' in details) {
    const reason = (details as { reason?: unknown }).reason
    if (typeof reason === 'string') return reason
  }
  return null
}

export const authApi = {
  me: (signal?: AbortSignal) => call<MeResponse>('/auth/me', { signal }),

  /**
   * 第一步：密码。会话尚未建立，因此豁免 CSRF（见 CallOptions.skipCsrf）。
   * `captcha_token` 为**可选**字段：服务端只在「人机验证策略命中」时强制要求它。
   */
  login: (body: { username: string; password: string; captcha_token?: string }) =>
    call<LoginResponse>('/auth/login', { method: 'POST', body, skipCsrf: true }),

  /**
   * 取人机验证入口配置（自建方案 §5.1 / 变更方案 §6.1）。
   *
   * ⚠️ 响应**按提供方分支**（`provider` 字段）：`selfbuilt` 回两张 SVG，`geetest` 回
   *    `captcha_id`/`product`/`language`。调用方据此选组件，⛔ 不要假定字段存在。
   *
   * ⛔ 豁免 CSRF 的理由与 `/auth/login` 相同：按 docs/api.md §1.2 ②，它与 `/auth/captcha/verify`
   *    同属「会话建立之前」的三个端点，此时既没有会话也没有 csrf token，
   *    服务端 `requireCsrf` 在无会话时直接放行。⛔ 除这三个端点外任何写请求都不得豁免。
   * ⚠️ 出题可能 **404**（验证码被关闭 / 提供方未配置 / 极验处于熔断窗口）：这是 fail-open，
   *    调用方**直接提交登录、不显示任何验证入口**（docs/frontend.md §4.2）。
   */
  captchaChallenge: (signal?: AbortSignal) =>
    call<CaptchaChallengeResponse>('/auth/captcha/challenge', {
      method: 'POST',
      skipCsrf: true,
      signal,
    }),

  /**
   * 验题并换一次性凭证（自建方案 §5.2 / 变更方案 §6.2）。服务端是**唯一**判定点：
   * 失败 400 `captcha_invalid`，`error.details.reason` 见 `captchaReasonOf` 的注释；
   * 极验不可达且 `failMode=closed` 时 503 `captcha_unavailable`（默认 `open` 则不会出现）。
   */
  captchaVerify: (body: CaptchaVerifyBody) =>
    call<CaptchaVerifyResult>('/auth/captcha/verify', { method: 'POST', body, skipCsrf: true }),

  /** 第二步：TOTP 6 位；成功后 sid 轮换 → 调用方必须重取 `me`（csrf 与角色都会变） */
  verifyTotp: (code: string) => call<void>('/auth/2fa/verify', { method: 'POST', body: { code } }),

  /** 恢复渠道一：一次性恢复码（用后即废） */
  verifyRecoveryCode: (code: string) =>
    call<RecoveryVerifyResult>('/auth/2fa/recovery/verify', { method: 'POST', body: { code } }),

  /**
   * 生成**待确认**的 TOTP 密钥 + 二维码（docs/api.md §4.1 B6）。
   * `full` / `totp_pending` / `setup_required` 三态皆可达；**已绑定**（含 pending）→ 409 `conflict`。
   * 只写"待确认密钥"，`totp_enabled` 保持 false；未绑定时重复调用会覆盖上一次的待确认密钥（无副作用）。
   */
  twoFactorSetup: () => call<TotpSetupResult>('/auth/2fa/setup', { method: 'POST' }),

  /**
   * 验码绑定（docs/api.md §4.1 B6）。
   * 成功 = 已证明持有 → 会话直接置为 `full` 并**轮换 sid**，同时下发 10 个恢复码 →
   * 调用方必须重取 `me`（csrf 不变，但 `user.totp_enabled` 与受限态都要更新）。
   */
  twoFactorEnable: (code: string) =>
    call<RecoveryCodesResult>('/auth/2fa/enable', { method: 'POST', body: { code } }),

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
