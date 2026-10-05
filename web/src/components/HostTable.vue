<script setup lang="ts">
/**
 * 私有主机表（docs/frontend.md §4.3 表格列）。
 *
 * ⛔ 行内操作**只有「查看详情」**：本系统"中心永不下发"，不存在重启/改配置/下发类操作，
 *    连暗示都不给（docs/frontend.md §1.2、设计 §2.1）。
 * ⚠️ 排序：服务端默认「有问题优先」（离线 → 有告警 → 在线 → `last_seen_at DESC`）；
 *    表头排序只作用于**已取回的这一页**（状态类接口本期没有真游标，`next_cursor` 恒 null）。
 */
import { useI18n } from 'vue-i18n'

import StatusBadge from '@/components/StatusBadge.vue'
import type { HostListItem } from '@/api/private'
import { formatInt } from '@/utils/format'
import { formatLocalWithOffset, formatRelative } from '@/utils/time'
import { formatBps, formatPct } from '@/utils/units'

const props = defineProps<{
  items: HostListItem[]
  loading?: boolean
}>()

const emit = defineEmits<{ select: [string] }>()

const { t } = useI18n()

/** 时钟漂移：✅ 符号口径 = **负值表示 Agent 慢**（docs/api.md §4.2） */
function driftText(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  const sign = ms > 0 ? '+' : ''
  return `${sign}${formatInt(ms)} ms`
}

/**
 * ⚠️ Element Plus 的 `el-table` 把插槽行类型声明为 `DefaultRow`（`Record<string, any>`），
 *    所以行参数一律用 `HostListItem | Record<string, unknown>` 这种宽松类型收，
 *    内部再按 `HostListItem` 取值 —— 否则模板里 `probeText(row)` 这类调用会类型不通过。
 */
type RowLike = HostListItem | Record<string, unknown>

function diskPct(row: RowLike): number | null {
  const value = (row as HostListItem).snapshot?.disk_pct
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function probeText(row: RowLike): string {
  const probes = (row as HostListItem).probes ?? { up: 0, down: 0 }
  return `${probes.up} / ${probes.down}`
}

/** ⚠️ 判据必须与角标的渲染条件**同一个**：漂移恰为 0 是合法读数（`!0` 为真会让角标和「—」同时出现） */
function hasDrift(row: RowLike): boolean {
  return typeof (row as HostListItem).clock_drift_ms === 'number'
}

// 表头排序只作用于"已取回的这一页"（状态类接口本期无真游标，`next_cursor` 恒 null）
function byName(a: HostListItem, b: HostListItem): number {
  return a.name.localeCompare(b.name)
}

function byCpu(a: HostListItem, b: HostListItem): number {
  return (a.snapshot?.cpu_pct ?? -1) - (b.snapshot?.cpu_pct ?? -1)
}

function byMem(a: HostListItem, b: HostListItem): number {
  return (a.snapshot?.mem_pct ?? -1) - (b.snapshot?.mem_pct ?? -1)
}

function byDisk(a: HostListItem, b: HostListItem): number {
  return (diskPct(a) ?? -1) - (diskPct(b) ?? -1)
}

function onRowClick(row: HostListItem): void {
  emit('select', row.id)
}
</script>

<template>
  <ElTable
    :data="items"
    size="small"
    class="host-table"
    :class="{ 'host-table--loading': loading }"
    row-key="id"
    @row-click="onRowClick"
  >
    <ElTableColumn :label="t('hostTable.name')" min-width="180" sortable :sort-method="byName">
      <template #default="{ row }">
        <div class="host-table__name">
          <span>{{ row.name }}</span>
          <ElTag v-for="tag in row.tags ?? []" :key="tag" size="small" type="info" disable-transitions>
            {{ tag }}
          </ElTag>
        </div>
        <div v-if="row.display_name && row.display_name !== row.name" class="host-table__sub">{{ row.id }}</div>
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('hostTable.status')" width="96">
      <template #default="{ row }">
        <StatusBadge :status="row.status" />
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('metric.cpu.usage')" width="104" sortable :sort-method="byCpu">
      <template #default="{ row }">
        <span class="vc-num">{{ row.snapshot ? formatPct(row.snapshot.cpu_pct ?? null) : '—' }}</span>
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('metric.mem.used_pct')" width="104" sortable :sort-method="byMem">
      <template #default="{ row }">
        <span class="vc-num">{{ row.snapshot ? formatPct(row.snapshot.mem_pct ?? null) : '—' }}</span>
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('hostTable.diskMax')" width="104" sortable :sort-method="byDisk">
      <template #default="{ row }">
        <span class="vc-num">{{ formatPct(diskPct(row)) }}</span>
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('metric.net.rx_bps')" width="120">
      <template #default="{ row }">
        <span class="vc-num">{{ row.snapshot ? formatBps(row.snapshot.net_rx_bps ?? null) : '—' }}</span>
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('metric.net.tx_bps')" width="120">
      <template #default="{ row }">
        <span class="vc-num">{{ row.snapshot ? formatBps(row.snapshot.net_tx_bps ?? null) : '—' }}</span>
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('hostTable.probes')" width="90">
      <template #default="{ row }">
        <span class="vc-num">{{ probeText(row) }}</span>
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('hostTable.lastSeen')" width="120">
      <template #default="{ row }">
        <span
          class="vc-num"
          :title="row.last_seen_at ? formatLocalWithOffset(row.last_seen_at, { seconds: true }) : ''"
        >
          {{ row.last_seen_ago ?? '—' }}
        </span>
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('hostTable.ip')" width="150">
      <template #default="{ row }">
        <div class="vc-num">{{ row.last_ip ?? '—' }}</div>
        <div v-if="row.reported_ip && row.reported_ip !== row.last_ip" class="host-table__sub vc-num">
          {{ t('hostTable.reportedIp') }} {{ row.reported_ip }}
        </div>
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('hostTable.badges')" width="190">
      <template #default="{ row }">
        <div class="host-table__badges">
          <ElTag
            v-if="typeof row.clock_drift_ms === 'number'"
            size="small"
            disable-transitions
            :type="Math.abs(row.clock_drift_ms) >= 60_000 ? 'danger' : 'warning'"
          >
            {{ t('badge.drift') }} {{ driftText(row.clock_drift_ms) }}
          </ElTag>
          <ElTag v-if="row.ip_flapping" size="small" disable-transitions class="tag--flapping">
            {{ t('badge.flapping') }}
            <template v-if="row.flapping_since">
              {{ formatRelative(row.flapping_since) }}
            </template>
          </ElTag>
          <ElTag v-if="(row.active_alerts ?? 0) > 0" size="small" type="danger" disable-transitions>
            {{ t('badge.alerts', { count: row.active_alerts }) }}
          </ElTag>
          <span v-if="!hasDrift(row) && !row.ip_flapping && !(row.active_alerts ?? 0)" class="host-table__none">—</span>
        </div>
      </template>
    </ElTableColumn>

    <ElTableColumn :label="t('hostTable.actions')" width="110" fixed="right">
      <template #default="{ row }">
        <ElButton link type="primary" size="small" @click.stop="emit('select', row.id)">
          {{ t('hostTable.detail') }}
        </ElButton>
      </template>
    </ElTableColumn>
  </ElTable>
</template>

<style scoped>
.host-table {
  width: 100%;
}

.host-table :deep(.el-table__row) {
  cursor: pointer;
}

.host-table__name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.host-table__sub {
  color: var(--vc-text-2);
  font-size: 11px;
}

.host-table__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.host-table__none {
  color: var(--vc-text-2);
}

.host-table__hint {
  margin: 8px 0 0;
  color: var(--vc-text-2);
  font-size: 12px;
}

.tag--flapping {
  background: color-mix(in srgb, var(--vc-flapping) 16%, transparent);
  border-color: var(--vc-flapping);
  color: var(--vc-flapping);
}
</style>
