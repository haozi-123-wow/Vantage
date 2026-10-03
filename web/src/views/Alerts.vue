<script setup lang="ts">
/**
 * 告警（docs/frontend.md §4.5，M3 交付物）。
 *
 * 骨架阶段：仅路由与页面占位。实现时的硬约束：
 * - 四个页签：事件 / 规则 / 通道 / 静默；
 * - 规则表单**受控阈值 DSL**：指标选择是「基名下拉 + 全部维度 / 指定维度开关」，
 *   ⛔ 不提供自由表达式输入（`expr` 必须保持为空，零 RCE 的前端体现）；
 * - `params` 字段按 `kind` 动态渲染白名单字段，⛔ 前端不得发送白名单外的键；
 * - 通道敏感字段只显示遮罩，未修改则不提交（部分更新）；
 * - ⛔ 不做事件 ack（认领）UI（F8），用静默窗口覆盖。
 */
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('view.alerts.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.alerts.hint') }}</p>
    <ElAlert
      type="info"
      :closable="false"
      :title="t('common.skeletonNotice')"
      :description="t('common.specPointer')"
    />
  </section>
</template>
