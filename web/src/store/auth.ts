/**
 * 会话 store（docs/frontend.md §5.2 / docs/api.md §4.1）。
 *
 * ⛔ 不持久化任何凭证：会话只存在于服务端下发的 HttpOnly Cookie 里；
 *    `csrf` 只存内存，页面刷新后由 `GET /api/v1/auth/me` 重新获取。
 * ✅ 权限暂时两级：`roles` 恒为单元素数组，判定一律走 `isAdmin`，⛔ 不要在组件里比对字符串。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { authApi } from '@/api/private'
import { AppError } from '@/api/http'
import type { AuthSession, AuthUser, MeResponse } from '@/types/domain'

export type AuthStatus =
  | 'unknown' // 尚未确认（启动时）
  | 'unauthenticated'
  | 'totp_pending' // 密码已过，等第二步验证码
  | 'totp_setup_required' // 受限态：策略要求绑定 2FA，只能访问绑定接口与 auth/me
  | 'authenticated'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null)
  /** ✅ 恒为 `["admin"]` 或 `["user"]` 单元素数组（docs/api.md §4.1） */
  const roles = ref<string[]>([])
  const csrf = ref<string | null>(null)
  const session = ref<AuthSession | null>(null)
  const status = ref<AuthStatus>('unknown')

  const isAdmin = computed(() => roles.value.includes('admin'))
  const isAuthenticated = computed(() => status.value === 'authenticated')

  function apply(me: MeResponse): void {
    user.value = me.user
    roles.value = Array.isArray(me.roles) ? me.roles : []
    csrf.value = me.csrf
    session.value = me.session
    status.value = 'authenticated'
  }

  /** 清理内存态（401 / 登出）。⛔ 不需要也不允许动 Cookie */
  function clear(): void {
    user.value = null
    roles.value = []
    csrf.value = null
    session.value = null
    status.value = 'unauthenticated'
  }

  /**
   * 进入等第二步验证码的状态。
   * ⚠️ 保留 `csrf`：登录响应在 `totp_required: true` 时也下发了 csrf，
   *    而 `/auth/2fa/verify` 是写请求，缺了它会被前端自己的断言拦下。
   */
  function markTotpPending(): void {
    status.value = 'totp_pending'
  }

  function markTotpSetupRequired(): void {
    status.value = 'totp_setup_required'
  }

  /** 取 `me`：启动、刷新后、以及 sid 轮换（2FA 成功后）都必须调用 */
  async function refreshMe(): Promise<void> {
    try {
      apply(await authApi.me())
    } catch (error) {
      if (error instanceof AppError && error.code === 'totp_setup_required') {
        status.value = 'totp_setup_required'
      }
      throw error
    }
  }

  /** 启动或刷新后的登录态恢复；失败即视为未登录，不抛错 */
  async function bootstrap(): Promise<void> {
    if (status.value === 'authenticated') return
    try {
      await refreshMe()
    } catch {
      if (status.value === 'unknown') status.value = 'unauthenticated'
    }
  }

  /** 第一步：密码。返回是否需要第二步验证码 */
  async function login(username: string, password: string): Promise<{ totpRequired: boolean }> {
    const result = await authApi.login({ username, password })
    csrf.value = result.csrf ?? null

    if (result.totp_required) {
      status.value = 'totp_pending'
      return { totpRequired: true }
    }

    // 成功时 sid 已下发 → 以 `me` 为权威来源（csrf / 角色 / 会话信息）
    await refreshMe()
    return { totpRequired: false }
  }

  /** 第二步：TOTP 6 位。成功后 sid 轮换 → 必须重取 `me` */
  async function verifyTotp(code: string): Promise<void> {
    await authApi.verifyTotp(code)
    await refreshMe()
  }

  /** 恢复渠道一：一次性恢复码；返回剩余数量供「快用完了」强提示 */
  async function verifyRecoveryCode(code: string): Promise<number | undefined> {
    const result = await authApi.verifyRecoveryCode(code)
    await refreshMe()
    return result.remaining_recovery_codes
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout()
    } finally {
      clear()
    }
  }

  async function logoutAll(): Promise<void> {
    try {
      await authApi.logoutAll()
    } finally {
      clear()
    }
  }

  return {
    user,
    roles,
    csrf,
    session,
    status,
    isAdmin,
    isAuthenticated,
    apply,
    clear,
    markTotpPending,
    markTotpSetupRequired,
    refreshMe,
    bootstrap,
    login,
    verifyTotp,
    verifyRecoveryCode,
    logout,
    logoutAll,
  }
})
