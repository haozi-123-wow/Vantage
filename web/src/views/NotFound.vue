<script setup lang="ts">
/**
 * 404。公开访客访问不存在的地址时，会先被守卫要求登录（该路由不在公开域内）。
 */
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('notFound.title') }}</h1>
    <p class="vc-page__hint">{{ t('notFound.hint') }}</p>
    <RouterLink :to="{ name: 'public-status' }">{{ t('notFound.back') }}</RouterLink>
  </section>
</template>
