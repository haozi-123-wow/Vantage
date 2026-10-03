<script setup lang="ts">
/**
 * 主机列表（docs/frontend.md §4.3）。
 *
 * 骨架阶段：仅路由与页面占位。实现时的硬约束：
 * - 列含当前 IP / 漂移角标 / Flapping 角标 / 活动告警数；「当前值」列随 `/ws/live` 增量更新，
 *   历史列不随 WS 变化；
 * - 行内操作只有「进入详情」，⛔ 不存在重启/改配置/下发类操作；
 * - 默认按「有问题优先」排序，cursor 分页；
 * - 与公开页复用同一张表，靠 `mode: 'public' | 'private'` 裁剪字段（⛔ 不维护两套表格）。
 */
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('view.hostList.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.hostList.hint') }}</p>
    <ElAlert
      type="info"
      :closable="false"
      :title="t('common.skeletonNotice')"
      :description="t('common.specPointer')"
    />
  </section>
</template>
