<script setup lang="ts">
/**
 * IP 变更时间线（详情页，`GET /api/v1/hosts/{id}/ip-history`）。
 *
 * ⚠️ 两条硬口径（docs/api.md §4.2）：
 * - `current_ip` / `reported_ip` 取自 `agents` 行（与列表同源），⛔ **不从区间表反推**；
 * - `intervals[]`（聚合的"出现区间"）与 `events[]`（逐次"变化/Flapping 事件"）语义不同，
 *   ⛔ 前端**不得**把两者按行对齐渲染。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { HostIpHistory } from '@/api/private'
import { formatLocalWithOffset } from '@/utils/time'
import { formatInt } from '@/utils/format'

const props = defineProps<{
  data: HostIpHistory | null
  loading?: boolean
}>()

const { t } = useI18n()

const intervals = computed(() => props.data?.intervals ?? [])
const events = computed(() => props.data?.events ?? [])

function sourceText(source: string | null): string {
  if (source === 'agent_reported') return t('ip.sourceAgent')
  if (source === 'remote') return t('ip.sourceRemote')
  return source ?? '—'
}

function kindText(kind: string): string {
  return kind === 'flapping' ? t('ip.kindFlapping') : t('ip.kindChange')
}

function subnetText(value: boolean | null): string {
  if (value === null) return '—'
  return value ? t('ip.sameSubnet') : t('ip.differentSubnet')
}
</script>

<template>
  <div class="ip-timeline">
    <dl class="ip-timeline__now">
      <div class="ip-timeline__cell">
        <dt>{{ t('ip.current') }}</dt>
        <dd class="vc-num">{{ data?.current_ip ?? '—' }}</dd>
      </div>
      <div class="ip-timeline__cell">
        <dt>{{ t('ip.reported') }}</dt>
        <dd class="vc-num">{{ data?.reported_ip ?? '—' }}</dd>
      </div>
      <div class="ip-timeline__cell">
        <dt>{{ t('ip.flapping') }}</dt>
        <dd>
          <ElTag v-if="data?.ip_flapping" size="small" disable-transitions class="ip-timeline__flapping">
            {{ t('badge.flapping') }}
            <template v-if="data.flapping_since">{{ formatLocalWithOffset(data.flapping_since) }}</template>
          </ElTag>
          <span v-else class="vc-num">—</span>
        </dd>
      </div>
    </dl>

    <h4 class="ip-timeline__section">{{ t('ip.events') }}</h4>
    <ElEmpty v-if="events.length === 0 && !loading" :description="t('ip.noEvents')" :image-size="40" />
    <ol v-else class="ip-timeline__events">
      <li v-for="(event, index) in events" :key="index" class="ip-timeline__event">
        <span class="ip-timeline__when vc-num">{{ formatLocalWithOffset(event.changed_at, { seconds: true }) }}</span>
        <ElTag
          size="small"
          disable-transitions
          :type="event.kind === 'flapping' ? 'warning' : 'info'"
        >
          {{ kindText(event.kind) }}
        </ElTag>
        <span class="vc-num">{{ event.old_ip ?? '—' }} → {{ event.new_ip }}</span>
        <span class="ip-timeline__sub">{{ subnetText(event.same_subnet) }}</span>
        <span class="ip-timeline__sub">{{ sourceText(event.source) }}</span>
        <span v-if="event.change_count !== null" class="ip-timeline__sub vc-num">
          {{ t('ip.changeCount', { count: formatInt(event.change_count) }) }}
        </span>
      </li>
    </ol>

    <h4 class="ip-timeline__section">{{ t('ip.intervals') }}</h4>
    <ElEmpty v-if="intervals.length === 0 && !loading" :description="t('ip.noIntervals')" :image-size="40" />
    <ElTable v-else :data="intervals" size="small" class="ip-timeline__table">
      <ElTableColumn :label="t('ip.address')" min-width="150" prop="ip" />
      <ElTableColumn :label="t('ip.source')" width="130">
        <template #default="{ row }">{{ sourceText(row.source) }}</template>
      </ElTableColumn>
      <ElTableColumn :label="t('ip.firstSeen')" min-width="180">
        <template #default="{ row }">
          <span class="vc-num">{{ formatLocalWithOffset(row.first_seen, { seconds: true }) }}</span>
        </template>
      </ElTableColumn>
      <ElTableColumn :label="t('ip.lastSeen')" min-width="180">
        <template #default="{ row }">
          <span class="vc-num">{{ formatLocalWithOffset(row.last_seen, { seconds: true }) }}</span>
        </template>
      </ElTableColumn>
    </ElTable>
  </div>
</template>

<style scoped>
.ip-timeline__now {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 6px 14px;
  margin: 0 0 8px;
}

.ip-timeline__cell dt {
  color: var(--vc-text-2);
  font-size: 12px;
}

.ip-timeline__cell dd {
  margin: 0;
}

.ip-timeline__flapping {
  background: color-mix(in srgb, var(--vc-flapping) 16%, transparent);
  border-color: var(--vc-flapping);
  color: var(--vc-flapping);
}

.ip-timeline__section {
  margin: 12px 0 6px;
  font-size: 13px;
}

.ip-timeline__events {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ip-timeline__event {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  border-bottom: 1px dashed var(--vc-border);
}

.ip-timeline__when {
  color: var(--vc-text-2);
  font-size: 12px;
}

.ip-timeline__sub {
  color: var(--vc-text-2);
  font-size: 12px;
}

.ip-timeline__table {
  width: 100%;
}
</style>
