<script setup lang="ts">
/**
 * 应用根：主题边界 + 外壳选择 + 路由出口。
 *
 * 两套外壳，按路由的 `meta.public` 二选一：
 * - 公开域（免登录）→ `PublicLayout`：只有品牌 + 登录/进入控制台入口。
 *   ⛔ 公开页不得出现任何**管理入口**；但也不能什么都不给 —— 匿名访客必须能从首页走到登录页。
 * - 其余（含 403 / 404 等需登录页面）→ `AppLayout`：侧栏 + 顶栏 + 实时连接状态。
 */
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'

import AppLayout from '@/components/AppLayout.vue'
import PublicLayout from '@/components/PublicLayout.vue'
import { useTheme } from '@/composables/useTheme'

// 主题切换的唯一入口（⛔ 组件里不要自己 classList.toggle('dark')）
useTheme()

const route = useRoute()
const isPublicRoute = computed(() => route.matched.some((record) => record.meta.public === true))
</script>

<template>
  <AppLayout v-if="!isPublicRoute">
    <RouterView />
  </AppLayout>
  <PublicLayout v-else>
    <RouterView />
  </PublicLayout>
</template>
