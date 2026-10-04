<script setup lang="ts">
/**
 * 我的账号（自助类；`requiresAuth`，⛔ 不要求 `admin`）。
 *
 * 为什么单独开一页（2026-10-03 Owner 拍板「方案 A」）：
 * - `/settings` 按 docs/frontend.md §3 是**管理员页面**（Agent 管理、用户与权限、系统设置、公开视图开关）；
 * - 二次验证（绑定 / 解绑 / 恢复码）是**任何登录用户自己的事**，服务端对它也不设 admin 门槛
 *   （`server/src/routes/auth.js` 的 `2fa/*` 只有 requireSession / requireFullSession + requireCsrf，
 *   无 requireRole）；
 * - 两者原本都塞在 `Settings.vue` 里 → 普通用户（`role=user`）在完整态下**永远无法自助开启 2FA**
 *   （受限态虽被守卫特批，但那只是「被策略强制绑定」这一条路径）。
 *
 * 后续自助项（我的会话、SSO 绑定状态）也落在这里，见 docs/frontend.md §4.6。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import TwoFactorPanel from '@/components/two-factor/TwoFactorPanel.vue'
import { useAuthStore } from '@/store/auth'

const { t } = useI18n()
const auth = useAuthStore()

/** 受限态下本页只承担绑定职责：⛔ 不展示其它区块（那些接口此刻一律 403 `totp_setup_required`） */
const restricted = computed(() => auth.status === 'totp_setup_required')
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('view.account.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.account.hint') }}</p>

    <TwoFactorPanel />

    <ElAlert
      v-if="!restricted"
      class="account__pending"
      type="info"
      :closable="false"
      :title="t('view.account.pending')"
      :description="t('common.specPointer')"
    />
  </section>
</template>

<style scoped>
.account__pending {
  margin-top: 20px;
  max-width: 560px;
}
</style>
