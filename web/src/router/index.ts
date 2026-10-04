/**
 * 路由与守卫（docs/frontend.md §3）。
 *
 * 三条必须遵守的规则：
 * - 公开域 = 免登录**只读**路由（`/`、`/status`）：进守卫时先给 api 层打标记，
 *   私有客户端在公开域被调用会直接抛错（网络层硬隔离，便于测试）；
 *   ⚠️ `/login` 虽也免登录，但按 docs/frontend.md §4.2 必须调用私有客户端的登录/人机验证端点，
 *      故**不**打该标记（取舍理由见下面 `markPublicDomain` 处的注释）；
 * - 受保护路由：`meta.requiresAuth`，进入前若未确认登录态先调 `GET /api/v1/auth/me`，
 *   失败 → `/login?redirect=<当前路径>`；
 * - `meta.role` 控制需管理员的页面：**越权显示 403 提示页**，⛔ 不静默重定向。
 */
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

import { markPublicDomain } from '@/api/private'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/store/auth'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'public-status',
    // 公开总览：⛔ 不设公开详情路由，点击主机就地展开当前快照（F2）
    component: () => import('@/views/PublicStatus.vue'),
    meta: { public: true, titleKey: 'nav.publicStatus' },
  },
  { path: '/status', redirect: { name: 'public-status' } },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { public: true, titleKey: 'view.login.title' },
  },
  {
    path: '/hosts',
    name: 'host-list',
    component: () => import('@/views/HostList.vue'),
    meta: { requiresAuth: true, titleKey: 'view.hostList.title' },
  },
  {
    path: '/hosts/:id',
    name: 'host-detail',
    component: () => import('@/views/HostDetail.vue'),
    props: true,
    meta: { requiresAuth: true, titleKey: 'view.hostDetail.title' },
  },
  {
    path: '/alerts',
    name: 'alerts',
    component: () => import('@/views/Alerts.vue'),
    meta: { requiresAuth: true, titleKey: 'view.alerts.title' },
  },
  {
    // 自助类（2FA / 我的会话 / SSO 绑定状态）：⛔ 不设 `role`，任何登录用户都要能进 ——
    // 否则普通用户在完整态下永远无法自助开启 2FA（服务端对 2fa/* 同样没有 admin 门槛）
    path: '/account',
    name: 'account',
    component: () => import('@/views/Account.vue'),
    meta: { requiresAuth: true, titleKey: 'view.account.title' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/Settings.vue'),
    meta: { requiresAuth: true, role: 'admin', titleKey: 'view.settings.title' },
  },
  {
    path: '/403',
    name: 'forbidden',
    component: () => import('@/views/Forbidden.vue'),
    meta: { requiresAuth: true, titleKey: 'forbidden.title' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFound.vue'),
    meta: { titleKey: 'notFound.title' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  const isPublicDomain = to.matched.some((record) => record.meta.public === true)
  // ⚠️ 取舍（实现 S3 时发现，两份文档在这里互相矛盾，已按"能工作"的那份实现）：
  //    docs/frontend.md §3 把 `/login` 也算作公开域（只允许调 `/api/public/*`），但 §4.2 又要求登录页
  //    调 `POST /api/v1/auth/login`；人机验证（滑块）同样要走私有客户端的 `/auth/captcha/*`
  //    （docs/slider-captcha-selfbuilt.md §7.1/§7.3）。若给 `/login` 打上公开域标记，`call()` 会直接抛
  //    `private_api_in_public_domain`，登录页根本没法工作 —— 所以公开域标记只覆盖「免登录**只读**」页
  //    （`/`、`/status`）。⛔ 这只解除网络层断言，`/login` 仍不得调用任何需要会话的私有接口。
  markPublicDomain(isPublicDomain && to.name !== 'login')

  if (isPublicDomain) {
    // 已登录用户访问 /login → 直接回 redirect 或 /hosts
    if (to.name === 'login' && auth.isAuthenticated) {
      return typeof to.query.redirect === 'string' ? to.query.redirect : { name: 'host-list' }
    }
    return true
  }

  // 登录态未确认时先问服务端（仅在此处会调用 /api/v1/auth/me，⛔ 公开页不会触发 401 噪音）
  if (auth.status === 'unknown') await auth.bootstrap()

  if (auth.status === 'totp_setup_required') {
    // 受限态：只放行 2FA 绑定所在的**我的账号**页（自助类；docs/api.md §4.1.0 三态矩阵）
    return to.name === 'account' ? true : { name: 'account' }
  }

  if (!auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  const requiredRole = to.meta.role
  if (typeof requiredRole === 'string' && !auth.roles.includes(requiredRole)) {
    return { name: 'forbidden' }
  }

  return true
})

router.afterEach((to) => {
  const titleKey = to.meta.titleKey
  const title = typeof titleKey === 'string' ? i18n.global.t(titleKey) : ''
  document.title = title ? `${title} · ${i18n.global.t('app.name')}` : i18n.global.t('app.name')
})

export default router
