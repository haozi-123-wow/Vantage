/**
 * 请求底座：统一 fetch 包装 + 错误模型。
 *
 * 错误模型对齐 docs/api.md §1.3：`{ error: { code, message, details, request_id } }`，
 * 状态码语义见该表（401 会话失效 / 403 role_denied·totp_required·csrf_invalid /
 * 429 rate_limited 带 Retry-After / 503 upstream_unavailable …）。
 */
import type { QueryValue } from '@/types/http'

export { type QueryValue }

export interface ApiErrorPayload {
  code: string
  message: string
  details?: unknown
  request_id?: string
}

/** 前端统一错误类型：调用方按 `code` 分支，⛔ 不要靠 message 文案判断 */
export class AppError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId?: string
  readonly retryAfterS?: number
  readonly details?: unknown

  constructor(init: {
    code: string
    message: string
    status: number
    requestId?: string
    retryAfterS?: number
    details?: unknown
  }) {
    super(init.message)
    this.name = 'AppError'
    this.code = init.code
    this.status = init.status
    this.requestId = init.requestId
    this.retryAfterS = init.retryAfterS
    this.details = init.details
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, QueryValue>
  /** 写请求的 CSRF token（来自登录 / `me` 响应，仅存内存） */
  csrf?: string | null
  /** 公开域一律 `omit`（⛔ 绝不附带凭证）；私有域 `include` */
  credentials?: RequestCredentials
  signal?: AbortSignal
}

/** 拼查询串：跳过 null/undefined，数组按重复键展开 */
export function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
      continue
    }
    params.append(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** `Retry-After` 可能是秒数或 HTTP 日期（docs/api.md §1.4） */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const date = new Date(header)
  if (Number.isNaN(date.getTime())) return undefined
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000))
}

function toAppError(response: Response, payload: unknown): AppError {
  const errorPayload =
    payload && typeof payload === 'object' && 'error' in payload
      ? ((payload as { error?: Partial<ApiErrorPayload> }).error ?? undefined)
      : undefined

  const code = typeof errorPayload?.code === 'string' ? errorPayload.code : 'internal_error'
  const message =
    typeof errorPayload?.message === 'string' && errorPayload.message.length > 0
      ? errorPayload.message
      : `请求失败（HTTP ${response.status}）`

  return new AppError({
    code,
    message,
    status: response.status,
    requestId: errorPayload?.request_id,
    retryAfterS: parseRetryAfter(response.headers.get('Retry-After')),
    details: errorPayload?.details,
  })
}

/** 发一个 JSON 请求并把响应体解析为 T（204 返回 undefined） */
export async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: string | undefined

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    body = JSON.stringify(options.body)
  }
  if (options.csrf) headers['X-CSRF-Token'] = options.csrf

  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}${buildQuery(options.query)}`, {
      method,
      headers,
      body,
      credentials: options.credentials ?? 'omit',
      signal: options.signal,
    })
  } catch (error) {
    // ⛔ 不把原始错误往外抛：调用方只需认识 AppError
    throw new AppError({
      code: 'network_error',
      message: error instanceof Error ? error.message : '网络不可达或请求被中断',
      status: 0,
    })
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let payload: unknown = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) throw toAppError(response, payload)
  return payload as T
}
