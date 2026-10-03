<script setup lang="ts">
/**
 * 应用根：主题边界 + 外壳选择 + 路由出口。
 *
 * 公开域（免登录）**不套导航壳**：⛔ 公开页不得出现任何管理入口（docs/frontend.md §1.2 / §4.1）。
 */
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'

import AppLayout from '@/components/AppLayout.vue'
import { useTheme } from '@/composables/useTheme'

// 主题切换的唯一入口（⛔ 组件里不要自己 classList.toggle('dark')）
useTheme()

const route = useRoute()
const withShell = computed(() => route.matched.every((record) => record.meta.public !== true))
</script>

<template>
  <AppLayout v-if="withShell">
    <RouterView />
  </AppLayout>
  <RouterView v-else />
</template>
