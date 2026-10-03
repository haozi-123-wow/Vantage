<script setup lang="ts">
/**
 * 主机状态徽标。
 *
 * ✅ 状态语义固定（docs/frontend.md §8.2）：在线=绿 / 离线=灰 / warn=橙 / critical=红 /
 *    漂移=黄 / Flapping=紫 —— 本组件只负责在线/离线/禁用三态，其余角标在列表页实现。
 * ✅ 状态**不只靠颜色**：徽标始终带文字（可访问性要求）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { HostStatus } from '@/types/domain'

const props = defineProps<{ status: HostStatus }>()

const { t } = useI18n()

/** 只有在线/离线有语义色；「已禁用」是管理态，用中性灰 + 文字区分 */
const TAG_TYPE: Record<HostStatus, 'success' | 'info'> = {
  online: 'success',
  offline: 'info',
  disabled: 'info',
}

const label = computed(() => t(`status.${props.status}`))
const type = computed(() => TAG_TYPE[props.status])
</script>

<template>
  <ElTag :type="type" disable-transitions>{{ label }}</ElTag>
</template>
