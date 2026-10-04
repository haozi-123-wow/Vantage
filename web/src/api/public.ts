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
import type {
  HostsResponse,
  PublicHost,
  PublicHostNow,
  PublicProbesResponse,
  PublicSummary,
} from '@/types/domain'

const BASE_URL = '/api/public'

/** 公开视图整体关闭：后端对所有 `/api/public/*` 返回 404（docs/api.md §3.2） */
export function isPublicViewDisabled(error: unknown): boolean {
  return error instanceof AppError && error.status === 404
}

/** `GET /api/public/summary` — 在线/离线/告警计数（全部为当前值） */
export function getSummary(signal?: AbortSignal): Promise<PublicSummary> {
  return requestJson<PublicSummary>(BASE_URL, '/summary', { signal })
}

/**
 * `GET /api/public/hosts` — ⛔ 无 IP、无内部 UUID，标识用 `public_slug`。
 * ⚠️ 2026-10-04 契约修正：列表端点返回 `{ items, next_cursor, updated_at }`（docs/api.md §1.2 ③），
 *    ⛔ 不再是裸数组。
 */
export function getHosts(signal?: AbortSignal): Promise<HostsResponse<PublicHost>> {
  return requestJson<HostsResponse<PublicHost>>(BASE_URL, '/hosts', { signal })
}

/**
 * `GET /api/public/hosts/{slug}/now` — 单机当前快照（公开页就地展开用）。
 * ⚠️ 服务端已把设备名/挂载点泛化成「磁盘 1 / 网卡 1」并剥离了 IP 与指标名，
 *    前端**只能**用返回的 `label` 与固定字段名渲染（⛔ 不要试图反推真实设备）。
 * slug 不存在**或**该机被人工禁用 → 404（两者不可区分）。
 */
export function getHostNow(slug: string, signal?: AbortSignal): Promise<PublicHostNow> {
  return requestJson<PublicHostNow>(BASE_URL, `/hosts/${encodeURIComponent(slug)}/now`, { signal })
}

/** `GET /api/public/probes` — 探活当前概览（每机最近一轮；`target_host` 已脱敏） */
export function getProbes(signal?: AbortSignal): Promise<PublicProbesResponse> {
  return requestJson<PublicProbesResponse>(BASE_URL, '/probes', { signal })
}

export const publicApi = { getSummary, getHosts, getHostNow, getProbes }
