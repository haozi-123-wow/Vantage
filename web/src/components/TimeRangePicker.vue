<script setup lang="ts">
/**
 * 时间范围选择器（docs/frontend.md §6.2）。
 *
 * ✅ 已定：只提供 5 个预设（1h/6h/24h/7d/30d），默认 **6h**（F9）；
 *    ⛔ 前端**不硬编码**档位映射（`TimeRangePicker` 只传 `from`/`to`，服务端按 `step=auto` 选档，
 *    并把**实际**用的 step 回传，由图表角落展示）。
 * ⛔ 也不校验"这个范围配这个档位行不行"：超限是服务端 400 `range_too_large`，原样展示。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { TIME_RANGE_PRESETS, resolveTimeRange, type TimeRangeKey } from '@/utils/time'
import { formatLocalWithOffset } from '@/utils/time'

const props = defineProps<{ modelValue: TimeRangeKey }>()
const emit = defineEmits<{ 'update:modelValue': [TimeRangeKey] }>()

const { t } = useI18n()

const range = computed(() => resolveTimeRange(props.modelValue))

function onChange(value: string | number | boolean | undefined): void {
  emit('update:modelValue', String(value) as TimeRangeKey)
}
</script>

<template>
  <div class="time-range">
    <ElRadioGroup
      :model-value="modelValue"
      size="small"
      :aria-label="t('chart.rangeLabel')"
      @update:model-value="onChange"
    >
      <ElRadioButton v-for="preset in TIME_RANGE_PRESETS" :key="preset.key" :value="preset.key">
        {{ t(`chart.range.${preset.key}`) }}
      </ElRadioButton>
    </ElRadioGroup>

    <span class="time-range__hint vc-num" :title="`${range.from} → ${range.to}`">
      {{ formatLocalWithOffset(range.from) }} → {{ formatLocalWithOffset(range.to) }}
    </span>
  </div>
</template>

<style scoped>
.time-range {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.time-range__hint {
  color: var(--vc-text-2);
  font-size: 12px;
}
</style>
