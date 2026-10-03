<script setup lang="ts">
/**
 * 登录 + 二次验证（docs/frontend.md §4.2，M2 交付物）。
 *
 * 骨架阶段：仅路由与页面占位。实现时的硬约束：
 * - 两步在同一路由内切换；`totp_required: true` 后**所有其它接口都 403**，UI 必须留在登录流程里；
 * - 第二步成功后 sid 已轮换 → 必须重新调 `GET /api/v1/auth/me` 刷新 csrf 与角色；
 * - 提供「使用恢复码登录」入口；恢复码剩余 ≤2 时强提示；
 * - 失败提示统一「用户名或密码错误」，不区分账号是否存在；429 带倒计时（读 `Retry-After`）；
 * - ⛔ 不在任何本地存储写入凭证（会话在 HttpOnly Cookie 里）；
 * - ⛔ 本期不提供 SSO / OIDC 登录入口。
 */
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <main class="login">
    <h1 class="vc-page__title">{{ t('view.login.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.login.hint') }}</p>
    <ElAlert
      type="info"
      :closable="false"
      :title="t('common.skeletonNotice')"
      :description="t('common.specPointer')"
    />
  </main>
</template>

<style scoped>
.login {
  max-width: 420px;
  margin: 0 auto;
  padding: 48px 24px;
}
</style>
