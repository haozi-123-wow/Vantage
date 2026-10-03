<script setup lang="ts">
/**
 * 403：已登录但角色不足。
 *
 * ✅ 越权一律**显示提示页**，⛔ 不静默重定向（docs/frontend.md §3）。
 */
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('forbidden.title') }}</h1>
    <p class="vc-page__hint">{{ t('forbidden.hint') }}</p>
    <RouterLink :to="{ name: 'host-list' }">{{ t('nav.hosts') }}</RouterLink>
  </section>
</template>
