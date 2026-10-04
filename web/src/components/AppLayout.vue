<script setup lang="ts">
/**
 * 导航壳（docs/frontend.md §2 / §5.3）：顶栏 + 侧栏 + 实时连接状态灯。
 *
 * 职责边界：
 * - 只做外壳与导航，业务内容由插槽传入（视图组件保持为组合面）；
 * - 实时连接**不由外壳发起**：连接由页面按需建立（公开页 `/ws/public`，登录后 `/ws/live`），
 *   这里只显示 realtime store 的状态；
 * - ⛔ 前端永不下发：导航里不存在任何「对 Agent 下发指令」的入口（docs/frontend.md §1.2）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'

import { useTheme } from '@/composables/useTheme'
import { useAuthStore } from '@/store/auth'
import { useRealtimeStore } from '@/store/realtime'
import { useUiStore } from '@/store/ui'
import type { LocaleCode } from '@/store/ui'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const ui = useUiStore()
const realtime = useRealtimeStore()
const { resolved, toggle } = useTheme()

const navItems = computed(() => {
  const items: Array<{ name: 'host-list' | 'alerts' | 'account' | 'settings'; label: string }> = [
    { name: 'host-list', label: t('nav.hosts') },
    { name: 'alerts', label: t('nav.alerts') },
    // 自助类：所有登录用户都要能进（⛔ 不要跟着 isAdmin 一起藏起来）
    { name: 'account', label: t('nav.account') },
  ]
  if (auth.isAdmin) items.push({ name: 'settings', label: t('nav.settings') })
  return items
})

const connectionLabel = computed(() => t(`realtime.${realtime.status}`))

/**
 * 受限态（`totp_setup_required`）下 `me` 返回 403、`auth.user` 为 null，但**会话仍然存在** ——
 * ⛔ 不能显示「登录」按钮（用户会以为自己没登录），也要能登出。
 */
const hasSession = computed(() => auth.isAuthenticated || auth.status === 'totp_setup_required')
const userLabel = computed(() => auth.user?.display_name || auth.user?.username || '')

async function onLogout(): Promise<void> {
  await auth.logout()
  await router.push({ name: 'login' })
}

function onLocaleChange(value: LocaleCode): void {
  ui.setLocale(value)
}
</script>

<template>
  <div class="shell" :class="{ 'shell--collapsed': ui.isSidebarCollapsed }">
    <header class="shell__topbar">
      <button
        type="button"
        class="shell__icon-btn"
        :title="t('common.sidebarToggle')"
        :aria-label="t('common.sidebarToggle')"
        @click="ui.toggleSidebar()"
      >
        ☰
      </button>

      <span class="shell__brand">{{ t('app.name') }}</span>

      <ElTag
        v-if="realtime.status !== 'closed'"
        class="shell__conn"
        size="small"
        :type="realtime.status === 'open' ? 'success' : 'warning'"
        disable-transitions
      >
        {{ connectionLabel }}
      </ElTag>

      <span class="shell__spacer" />

      <ElSelect
        :model-value="ui.locale"
        class="shell__locale"
        size="small"
        :aria-label="t('locale.label')"
        @update:model-value="onLocaleChange"
      >
        <ElOption :label="t('locale.zh-CN')" value="zh-CN" />
        <ElOption :label="t('locale.en-US')" value="en-US" />
      </ElSelect>

      <ElButton size="small" :title="t('theme.label')" @click="toggle">
        {{ resolved === 'dark' ? t('theme.dark') : t('theme.light') }}
      </ElButton>

      <template v-if="hasSession">
        <span v-if="userLabel" class="shell__user">{{ userLabel }}</span>
        <ElButton size="small" @click="onLogout">{{ t('nav.logout') }}</ElButton>
      </template>
      <ElButton v-else size="small" @click="router.push({ name: 'login' })">
        {{ t('nav.login') }}
      </ElButton>
    </header>

    <div class="shell__body">
      <nav class="shell__sidebar" :aria-label="t('app.name')">
        <RouterLink class="shell__nav-item" :to="{ name: 'public-status' }">
          {{ t('nav.publicStatus') }}
        </RouterLink>
        <RouterLink v-for="item in navItems" :key="item.name" class="shell__nav-item" :to="{ name: item.name }">
          {{ item.label }}
        </RouterLink>
      </nav>

      <main class="shell__content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.shell__topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--vc-topbar-h);
  padding: 0 12px;
  border-bottom: 1px solid var(--vc-border);
  background: var(--vc-surface);
}

.shell__brand {
  font-weight: 600;
}

.shell__spacer {
  flex: 1;
}

.shell__locale {
  width: 116px;
}

.shell__user {
  color: var(--vc-text-2);
  font-size: 13px;
}

.shell__icon-btn {
  border: 1px solid var(--vc-border);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  line-height: 1;
  padding: 4px 8px;
}

.shell__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.shell__sidebar {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: var(--vc-sidebar-w);
  padding: 8px;
  border-right: 1px solid var(--vc-border);
  background: var(--vc-surface);
}

.shell--collapsed .shell__sidebar {
  display: none;
}

.shell__nav-item {
  padding: 7px 10px;
  border-radius: 4px;
  color: var(--vc-text);
  font-size: 13px;
}

.shell__nav-item:hover {
  background: var(--vc-canvas);
  text-decoration: none;
}

.shell__nav-item.router-link-exact-active {
  background: var(--vc-canvas);
  font-weight: 600;
}

.shell__content {
  flex: 1;
  min-width: 0;
  overflow: auto;
}

@media (max-width: 767px) {
  .shell__sidebar {
    display: none;
  }
}
</style>
