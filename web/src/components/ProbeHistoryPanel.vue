<script setup lang="ts">
/**
 * 探活历史（详情页，`GET /api/v1/hosts/{id}/probes`）。
 *
 * 口径（docs/api.md §4.2）：
 * - `availability` 是**整个窗口**的统计，⛔ 不受返回点数截断影响；窗口内无探活时 `ratio: null`（⛔ 不是 1）；
 * - `results` 按时间**倒序**（最近的在最前），每 probe 最多 500 点，被截断时 `truncated: true`；
 * - 失败点展示 `error` / `status_code`（**私有域**给完整 target，公开侧才脱敏）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { HostProbeHistory, ProbeHistoryItem, ProbeResult } from '@/api/private'
import { formatLocalWithOffset } from '@/utils/time'
import { formatMs } from '@/utils/units'

const props = defineProps<{
  data: HostProbeHistory | null
  loading?: boolean
}>()

const { t } = useI18n()

const items = computed<ProbeHistoryItem[]>(() => props.data?.items ?? [])

function ratioText(item: ProbeHistoryItem): string {
  if (item.availability.ratio === null) return '—'
  return `${(item.availability.ratio * 100).toFixed(2)}%`
}

/** 时间条：倒序数组反过来画，左旧右新；色块只表达 up/down，⛔ 不插值 */
function barOf(item: ProbeHistoryItem): ProbeResult[] {
  return [...item.results].reverse()
}

function pointTitle(point: ProbeResult): string {
  const parts = [point.up ? t('probe.up') : t('probe.down'), formatLocalWithOffset(point.checked_at, { seconds: true })]
  if (point.latency_ms !== null) parts.push(formatMs(point.latency_ms))
  if (point.status_code !== null) parts.push(`HTTP ${point.status_code}`)
  if (point.error) parts.push(point.error)
  return parts.join(' · ')
}
</script>

<template>
  <div class="probe-history">
    <ElAlert
      v-if="data?.truncated"
      class="probe-history__notice"
      type="warning"
      :closable="false"
      :title="t('probe.windowTruncated')"
    />

    <ElEmpty v-if="items.length === 0 && !loading" :description="t('probe.empty')" :image-size="48" />

    <section v-for="item in items" :key="`${item.name}/${item.type}`" class="probe-history__item">
      <header class="probe-history__head">
        <strong>{{ item.name }}</strong>
        <ElTag size="small" type="info" disable-transitions>{{ item.type }}</ElTag>
        <span class="probe-history__target vc-num">{{ item.target }}</span>
        <span class="probe-history__spacer" />
        <span class="vc-num">
          {{ t('probe.availability', { ratio: ratioText(item) }) }}
          <span class="probe-history__sub">
            {{ t('probe.counts', { up: item.availability.up, down: item.availability.down, total: item.availability.total }) }}
          </span>
        </span>
      </header>

      <div class="probe-history__bar" :aria-label="t('probe.barLabel')">
        <span
          v-for="(point, index) in barOf(item)"
          :key="index"
          class="probe-history__blip"
          :class="point.up ? 'probe-history__blip--up' : 'probe-history__blip--down'"
          :title="pointTitle(point)"
        />
      </div>

      <p class="probe-history__latest vc-num">
        <template v-if="item.latest">
          {{ t('probe.latest') }}
          <ElTag size="small" disable-transitions :type="item.latest.up ? 'success' : 'danger'">
            {{ item.latest.up ? t('probe.up') : t('probe.down') }}
          </ElTag>
          {{ formatMs(item.latest.latency_ms) }}
          <span class="probe-history__sub">
            {{ formatLocalWithOffset(item.latest.checked_at, { seconds: true }) }}
          </span>
          <span v-if="item.latest.status_code !== null" class="probe-history__sub">HTTP {{ item.latest.status_code }}</span>
          <!-- `error` 视为不可信文本：默认插值转义，⛔ 不用 v-html -->
          <span v-if="item.latest.error" class="probe-history__sub probe-history__error">{{ item.latest.error }}</span>
        </template>
        <template v-else>{{ t('probe.noResultInWindow') }}</template>
      </p>
    </section>
  </div>
</template>

<style scoped>
.probe-history__notice {
  margin-bottom: 10px;
}

.probe-history__item {
  padding: 10px 0;
  border-bottom: 1px dashed var(--vc-border);
}

.probe-history__item:last-child {
  border-bottom: none;
}

.probe-history__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.probe-history__target {
  color: var(--vc-text-2);
  font-size: 12px;
}

.probe-history__spacer {
  flex: 1;
}

.probe-history__sub {
  color: var(--vc-text-2);
  font-size: 12px;
}

.probe-history__error {
  color: var(--vc-critical);
}

.probe-history__bar {
  display: flex;
  gap: 1px;
  margin: 6px 0;
  overflow-x: auto;
}

.probe-history__blip {
  flex: 0 0 auto;
  width: 4px;
  height: 14px;
  border-radius: 1px;
  background: var(--vc-offline);
}

.probe-history__blip--up {
  background: var(--vc-online);
}

.probe-history__blip--down {
  background: var(--vc-critical);
}

.probe-history__latest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
}
</style>
