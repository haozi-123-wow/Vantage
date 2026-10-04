/**
 * 私有客户端的网络层断言（docs/frontend.md §9 / §11 回归防越线）。
 *
 * 这些条都是**开发期就该炸掉**或"绝不能误伤用户"的行为，而不是运行期容忍的行为：
 * - 公开域调用私有接口 → 直接抛错（防公开页触发 401 噪音与隐私泄露）；
 * - 写请求缺 CSRF → 直接抛错（缺 CSRF 视为前端缺陷；登录端点除外）；
 * - 401 分流：`invalid_credentials`（自助表单填错口令）**不是**会话失效，⛔ 不得清会话/跳登录。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { AppError } from '@/api/http'
import { authApi, hostsApi, isPublicDomain, isSessionExpiry, markPublicDomain } from '@/api/private'

afterEach(() => {
  markPublicDomain(false)
})

describe('公开域硬隔离', () => {
  it('公开域下调用 GET 私有接口直接抛错（不发请求）', async () => {
    markPublicDomain(true)
    expect(isPublicDomain()).toBe(true)

    await expect(hostsApi.list()).rejects.toBeInstanceOf(AppError)
    await expect(hostsApi.list()).rejects.toMatchObject({ code: 'private_api_in_public_domain' })
  })

  it('公开域下调用写接口同样直接抛错', async () => {
    markPublicDomain(true)
    await expect(authApi.logoutAll()).rejects.toMatchObject({ code: 'private_api_in_public_domain' })
  })

  it('离开公开域后断言解除', () => {
    markPublicDomain(true)
    markPublicDomain(false)
    expect(isPublicDomain()).toBe(false)
  })
})

describe('CSRF 注入', () => {
  it('写请求缺少 CSRF token 时抛错', async () => {
    markPublicDomain(false)
    await expect(authApi.logout()).rejects.toMatchObject({ code: 'csrf_missing' })
  })
})

describe('401 分流：填错口令 ≠ 会话失效', () => {
  it('invalid_credentials 不按会话失效处理（否则打错一次密码就被踢出控制台）', () => {
    const error = new AppError({ code: 'invalid_credentials', message: '用户名或密码错误。', status: 401 })
    expect(isSessionExpiry(error)).toBe(false)
  })

  it('session_expired 仍按会话失效处理', () => {
    const error = new AppError({ code: 'session_expired', message: '会话已过期，请重新登录。', status: 401 })
    expect(isSessionExpiry(error)).toBe(true)
  })

  it('非 401 一律不按会话失效处理', () => {
    const error = new AppError({ code: 'conflict', message: '安全策略要求保留二次验证', status: 409 })
    expect(isSessionExpiry(error)).toBe(false)
  })
})
