<script setup lang="ts">
/**
 * 主机详情（docs/frontend.md §4.4）。
 *
 * 骨架阶段：仅路由与页面占位。实现时的硬约束：
 * - 区块：头部信息（含时钟漂移/Flapping 角标）、当前快照、历史曲线、探活历史、IP 时间线、进程 Top、
 *   该机关联告警；
 * - 曲线缺失桶**不补 0**（用 null 断线）；实时增量只追加尾部，不参与历史重算；
 * - 时间范围默认 6h（F9），默认四图 CPU/内存/磁盘/网络，GPU 与探活按需展开；
 * - 图表主题切换时 dispose 重建；不可见图表暂停渲染；
 * - 该页应调用 realtime store 的 `trackAgent(id)` 并 `subscribe({ agents: [id] })` 降低流量。
 */
import { useI18n } from 'vue-i18n'

const props = defineProps<{ id: string }>()

const { t } = useI18n()
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('view.hostDetail.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.hostDetail.hint') }}</p>
    <p class="vc-page__hint vc-num">主机 ID：{{ props.id }}</p>
    <ElAlert
      type="info"
      :closable="false"
      :title="t('common.skeletonNotice')"
      :description="t('common.specPointer')"
    />
  </section>
</template>
