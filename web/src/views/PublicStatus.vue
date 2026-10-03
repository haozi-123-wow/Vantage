<script setup lang="ts">
/**
 * 免登录总览（docs/frontend.md §4.1，M1 交付物）。
 *
 * 骨架阶段：只落页面骨架与三态容器，**不接数据**。
 * 实现该页时必须遵守的硬约束（⛔ 都不是风格问题）：
 * - 只调 `/api/public/*` 与订阅 `/ws/public`，且只用 `display_name`（缺失回退泛化名）、
 *   标识一律用 `public_slug`；
 * - ⛔ 不得出现 IP、内网网段、设备真实名、历史曲线、进程 Top，以及任何管理入口；
 * - 点击主机**就地展开当前快照**，⛔ 不设公开详情路由（F2）。
 */
import { useI18n } from 'vue-i18n'

import AsyncState from '@/components/AsyncState.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import type { HostStatus } from '@/types/domain'

const { t } = useI18n()

// 骨架阶段没有数据源：故意走 AsyncState 的空态，避免展示任何假数据
const legend: HostStatus[] = ['online', 'offline', 'disabled']
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('view.publicStatus.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.publicStatus.hint') }}</p>

    <ElAlert
      type="info"
      :closable="false"
      :title="t('common.skeletonNotice')"
      :description="t('common.specPointer')"
    />

    <div class="legend">
      <span class="legend__label">{{ t('view.publicStatus.title') }}</span>
      <StatusBadge v-for="status in legend" :key="status" :status="status" />
    </div>

    <AsyncState empty :loading="false" :error="null" />
  </section>
</template>

<style scoped>
.legend {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 16px 0;
}

.legend__label {
  color: var(--vc-text-2);
  font-size: 13px;
}
</style>
