/**
 * 私有客户端的网络层断言（docs/frontend.md §9 / §11 回归防越线）。
 *
 * 这两条都是**开发期就该炸掉**的缺陷，而不是运行期容忍的行为：
 * - 公开域调用私有接口 → 直接抛错（防公开页触发 401 噪音与隐私泄露）；
 * - 写请求缺 CSRF → 直接抛错（缺 CSRF 视为前端缺陷；登录端点除外）。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { AppError } from '@/api/http'
import { authApi, hostsApi, isPublicDomain, markPublicDomain } from '@/api/private'

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
