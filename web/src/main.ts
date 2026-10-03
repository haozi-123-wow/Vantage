/**
 * 应用装配（docs/frontend.md §2：router / store / i18n / 样式）。
 *
 * 顺序要点：
 * 1. pinia 必须早于 router —— 路由守卫里要用 auth store；
 * 2. ⛔ 这里**不做** `auth.bootstrap()`：公开域不允许触发任何私有接口（避免 401 噪音，docs/frontend.md §3），
 *    登录态由路由守卫在进入受保护路由时按需获取；
 * 3. api ↔ store 的接线集中在这里，避免 api 与 store 互相 import 形成环。
 */
import { createPinia } from 'pinia'
import { createApp, watch } from 'vue'

import App from '@/App.vue'
import { configurePrivateClient } from '@/api/private'
import { i18n } from '@/i18n'
import router from '@/router'
import { useAuthStore } from '@/store/auth'
import { useUiStore } from '@/store/ui'

import 'element-plus/theme-chalk/dark/css-vars.css'
import '@/styles/base.scss'
import '@/styles/element-overrides.scss'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(i18n)
app.use(router)

const auth = useAuthStore(pinia)
const ui = useUiStore(pinia)

// 语言偏好 → vue-i18n（默认 zh-CN，✅ 决策 #26）
i18n.global.locale.value = ui.locale
watch(
  () => ui.locale,
  (next) => {
    i18n.global.locale.value = next
  },
)

configurePrivateClient({
  getCsrf: () => auth.csrf,
  onUnauthorized: () => {
    auth.clear()
    const current = router.currentRoute.value
    if (current.name !== 'login') {
      void router.replace({ name: 'login', query: { redirect: current.fullPath } })
    }
  },
  onTotpRequired: () => {
    auth.markTotpPending()
    void router.replace({ name: 'login' })
  },
  onTotpSetupRequired: () => {
    auth.markTotpSetupRequired()
    if (router.currentRoute.value.name !== 'settings') {
      void router.replace({ name: 'settings' })
    }
  },
  onRateLimited: (error) => {
    // 429 的倒计时提示由触发请求的视图负责（读 error.retryAfterS）
    console.warn(`[vantage] 触发限流，Retry-After: ${error.retryAfterS ?? '?'}s`)
  },
})

// 等首次导航（含守卫里的登录态确认）完成再挂载，避免未登录时先闪一下受保护页面
await router.isReady()
app.mount('#app')
