<script setup lang="ts">
/**
 * 汇总计数条（公开页与主机列表页**共用**）。
 *
 * ⚠️ 数字必须来自 `GET /api/public/summary` / `GET /api/v1/summary`（服务端同一份计数实现），
 *    ⛔ 不要用列表条数自己数：`limit` 一截断（默认 20）数出来的只是"这一页有几台"（docs/api.md §4.2）。
 * ⚠️ `alerts` 本期恒为 0（告警引擎 M3 未落地），照实展示，⛔ 不隐藏也不编造。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PublicSummary } from '@/types/domain'
import { formatLocalWithOffset } from '@/utils/time'

const props = defineProps<{
  summary: PublicSummary | null
  loading?: boolean
}>()

const { t } = useI18n()

const items = computed(() => [
  { key: 'total', label: t('summary.total'), value: props.summary?.total ?? null, tone: 'neutral' },
  { key: 'online', label: t('summary.online'), value: props.summary?.online ?? null, tone: 'online' },
  { key: 'offline', label: t('summary.offline'), value: props.summary?.offline ?? null, tone: 'offline' },
  { key: 'disabled', label: t('summary.disabled'), value: props.summary?.disabled ?? null, tone: 'muted' },
] as const)

/** 三个严重级分开显示（⛔ 不合并成一个"告警数"，那会让 critical 被 info 稀释） */
const alerts = computed(() => [
  { key: 'critical', value: props.summary?.alerts.critical ?? null },
  { key: 'warn', value: props.summary?.alerts.warn ?? null },
  { key: 'info', value: props.summary?.alerts.info ?? null },
] as const)

const updatedText = computed(() =>
  props.summary?.updated_at ? formatLocalWithOffset(props.summary.updated_at, { seconds: true }) : '',
)
</script>

<template>
  <div class="summary" :class="`summary--${loading ? 'loading' : 'idle'}`">
    <div v-for="item in items" :key="item.key" class="summary__cell">
      <span class="summary__label">{{ item.label }}</span>
      <span class="summary__value vc-num" :class="`summary__value--${item.tone}`">
        {{ item.value ?? '—' }}
      </span>
    </div>

    <div class="summary__cell summary__cell--alerts">
      <span class="summary__label">{{ t('summary.alerts') }}</span>
      <span class="summary__alerts">
        <ElTag
          v-for="alert in alerts"
          :key="alert.key"
          size="small"
          disable-transitions
          :type="alert.key === 'critical' ? 'danger' : alert.key === 'warn' ? 'warning' : 'info'"
        >
          {{ t(`alert.severity.${alert.key}`) }} {{ alert.value ?? '—' }}
        </ElTag>
      </span>
    </div>

    <span class="summary__spacer" />
    <span v-if="updatedText" class="summary__updated vc-num" :title="summary?.updated_at ?? ''">
      {{ t('summary.updatedAt', { time: updatedText }) }}
    </span>
  </div>
</template>

<style scoped>
.summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 20px;
  padding: 10px 14px;
  border: 1px solid var(--vc-border);
  border-radius: 6px;
  background: var(--vc-surface);
}

.summary__cell {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.summary__label {
  color: var(--vc-text-2);
  font-size: 12px;
}

.summary__value {
  font-size: 18px;
  font-weight: 600;
}

.summary__value--online {
  color: var(--vc-online);
}

.summary__value--offline {
  color: var(--vc-offline);
}

.summary__value--muted {
  color: var(--vc-text-2);
}

.summary__alerts {
  display: inline-flex;
  gap: 4px;
}

.summary__spacer {
  flex: 1;
}

.summary__updated {
  color: var(--vc-text-2);
  font-size: 12px;
}

@media (max-width: 767px) {
  .summary {
    flex-wrap: nowrap;
    overflow-x: auto;
  }
}
</style>
