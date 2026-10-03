/**
 * 免登录公开接口客户端（docs/api.md §3）。
 *
 * 硬约束（docs/frontend.md §1.2 / §9）：
 * - 只访问 `/api/public/*`；
 * - ⛔ **绝不附带凭证**（`credentials: 'omit'`），公开页不允许因它触发 401 噪音；
 * - `public_view.enabled=false` 时所有公开接口返回 404（不泄露「存在但被关闭」）→
 *   调用方用 `isPublicViewDisabled()` 区分该情形并给出登录入口。
 */
import { AppError, requestJson } from '@/api/http'
import type { PublicHost, PublicProbe, PublicSummary } from '@/types/domain'

const BASE_URL = '/api/public'

/** 公开视图整体关闭：后端对所有 `/api/public/*` 返回 404（docs/api.md §3.2） */
export function isPublicViewDisabled(error: unknown): boolean {
  return error instanceof AppError && error.status === 404
}

/** `GET /api/public/summary` — 在线/离线/告警计数（全部为当前值） */
export function getSummary(signal?: AbortSignal): Promise<PublicSummary> {
  return requestJson<PublicSummary>(BASE_URL, '/summary', { signal })
}

/** `GET /api/public/hosts` — ⛔ 无 IP、无内部 UUID，标识用 `public_slug` */
export function getHosts(signal?: AbortSignal): Promise<PublicHost[]> {
  return requestJson<PublicHost[]>(BASE_URL, '/hosts', { signal })
}

/** `GET /api/public/hosts/{slug}/now` — 单机当前快照（公开页就地展开用） */
export function getHostNow(slug: string, signal?: AbortSignal): Promise<PublicHost> {
  return requestJson<PublicHost>(BASE_URL, `/hosts/${encodeURIComponent(slug)}/now`, { signal })
}

/** `GET /api/public/probes` — 探活当前概览（target 已脱敏） */
export function getProbes(signal?: AbortSignal): Promise<PublicProbe[]> {
  return requestJson<PublicProbe[]>(BASE_URL, '/probes', { signal })
}

export const publicApi = { getSummary, getHosts, getHostNow, getProbes }
