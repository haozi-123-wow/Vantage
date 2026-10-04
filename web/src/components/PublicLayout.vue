<script setup lang="ts">
/**
 * 公开域外壳（免登录页面用）。
 *
 * 为什么需要它：公开路由不能套 `AppLayout`（✅ docs/frontend.md §1.2 / §4.1：⛔ 公开页不得出现
 * 任何**管理入口**），但当初把"不套导航壳"实现成了"什么都不给" —— 结果 `/` 上连**登录入口**都没有，
 * 匿名访客进了首页就无路可走（2026-10-03 实测反馈）。
 *
 * 本外壳只放两样东西：品牌 + 登录 / 进入控制台，⛔ 不引入任何管理入口。
 *
 * 与 docs/frontend.md §3 的关系：公开视图被整体关闭时（`public_view.enabled=false`，
 * 所有 `/api/public/*` 返回 404），本页还需给出「公开视图已关闭，请登录」的提示 ——
 * 那条随 M1 接 API 时落地；本外壳先保证入口**始终**存在。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'

import { useAuthStore } from '@/store/auth'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()

/** 登录页自己不再显示"登录"入口（避免自我链接） */
const showEntry = computed(() => route.name !== 'login')
/** 已登录访客（例如从侧栏点「公开总览」过来）给的是回控制台的出口，⛔ 不是让他再登录一次 */
const entryTarget = computed(() => (auth.isAuthenticated ? { name: 'host-list' } : { name: 'login' }))
const entryLabel = computed(() => (auth.isAuthenticated ? t('nav.enterConsole') : t('nav.login')))
</script>

<template>
  <div class="public-shell">
    <header class="public-shell__bar">
      <RouterLink class="public-shell__brand" :to="{ name: 'public-status' }">
        {{ t('app.name') }}
      </RouterLink>
      <span class="public-shell__spacer" />
      <RouterLink v-if="showEntry" class="public-shell__entry" :to="entryTarget">
        {{ entryLabel }}
      </RouterLink>
    </header>

    <!-- ⚠️ 用 div 而不是 main：登录页自己已经有 `<main class="login">`，再嵌一层 main 语义不对 -->
    <div class="public-shell__content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.public-shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.public-shell__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--vc-topbar-h);
  padding: 0 16px;
  border-bottom: 1px solid var(--vc-border);
  background: var(--vc-surface);
}

.public-shell__brand {
  color: var(--vc-text);
  font-weight: 600;
}

.public-shell__brand:hover {
  text-decoration: none;
}

.public-shell__spacer {
  flex: 1;
}

.public-shell__entry {
  font-size: 13px;
}

.public-shell__content {
  flex: 1;
  min-width: 0;
}
</style>
