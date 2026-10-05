<script setup lang="ts">
/**
 * 公开页主机卡片（docs/frontend.md §4.1；✅ F2：点击**就地展开当前快照**，⛔ 不跳详情页）。
 *
 * ⛔ 公开侧硬约束（§3.1 / 决策 #21）——卡片里不得出现：
 *    真实 IP、内网网段、设备真名/挂载点/端口、指标全名、历史曲线、任何管理入口。
 *    设备只能用服务端下发的泛化 `label`（「磁盘 1」「网卡 1」「GPU 1」），⛔ 不试图反推真实设备。
 * ⛔ 无数据一律渲染 `—`（`utils/units.ts` 的 `NO_DATA`），⛔ 不补 0 —— 补 0 是把"失联"画成"空闲"。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import StatusBadge from '@/components/StatusBadge.vue'
import type { PublicDeviceRow, PublicHost, PublicHostNow } from '@/types/domain'
import { formatLocalWithOffset } from '@/utils/time'
import { formatBytes, formatBps, formatDuration, formatPct } from '@/utils/units'

const props = defineProps<{
  host: PublicHost
  /** 展开后的纵深块（`GET /api/public/hosts/{slug}/now`）；未加载为 null */
  detail?: PublicHostNow | null
  expanded: boolean
  loading?: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()

const { t } = useI18n()

/**
 * 设备行里取一个数值字段（缺省/非数值 → null，交给格式化函数渲染 `—`）。
 * ⚠️ 参数用宽松类型：`el-table` 的插槽行是 `DefaultRow`（`Record<string, any>`），
 *    声明成 `PublicDeviceRow` 会让模板里的 `num(row, 'used_pct')` 类型不通过。
 */
function num(row: PublicDeviceRow | Record<string, unknown>, key: string): number | null {
  const value = (row as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const snapshot = computed(() => props.host.snapshot)

const headline = computed(() => [
  { key: 'cpu', label: t('metric.cpu.usage'), text: formatPct(snapshot.value.cpu_pct) },
  { key: 'mem', label: t('metric.mem.used_pct'), text: formatPct(snapshot.value.mem_pct) },
  { key: 'disk', label: t('metric.disk.used_pct'), text: formatPct(snapshot.value.disk_pct) },
  { key: 'rx', label: t('metric.net.rx_bps'), text: formatBps(snapshot.value.net_rx_bps) },
  { key: 'tx', label: t('metric.net.tx_bps'), text: formatBps(snapshot.value.net_tx_bps) },
])

/** ⚠️ `gpu_pct` 在无 GPU 序列时**整键缺省**（不是 null）——只有存在才渲染这一格 */
const gpuText = computed(() =>
  'gpu_pct' in snapshot.value ? formatPct(snapshot.value.gpu_pct ?? null) : null,
)

const lastSeenTitle = computed(() => (props.host.last_seen_at ? formatLocalWithOffset(props.host.last_seen_at) : ''))

const cpu = computed(() => props.detail?.cpu ?? null)
const memory = computed(() => props.detail?.memory ?? null)
const disks = computed(() => props.detail?.disks ?? [])
const networks = computed(() => props.detail?.networks ?? [])
const gpus = computed(() => props.detail?.gpus ?? [])
</script>

<template>
  <article class="host-card" :class="{ 'host-card--expanded': expanded }">
    <header class="host-card__head" role="button" tabindex="0" @click="emit('toggle')" @keydown.enter="emit('toggle')">
      <div class="host-card__title">
        <StatusBadge :status="host.status" />
        <span class="host-card__name">{{ host.name }}</span>
        <span v-if="host.os" class="host-card__os">{{ host.os }}</span>
      </div>

      <div class="host-card__meta">
        <span v-if="host.uptime !== undefined" class="vc-num">
          {{ t('host.uptime') }} {{ formatDuration(host.uptime) }}
        </span>
        <span class="vc-num" :title="lastSeenTitle">
          {{ host.last_seen_ago ?? t('host.neverReported') }}
        </span>
        <span class="host-card__chevron">{{ expanded ? '▾' : '▸' }}</span>
      </div>
    </header>

    <dl class="host-card__snapshot">
      <div v-for="item in headline" :key="item.key" class="host-card__cell">
        <dt>{{ item.label }}</dt>
        <dd class="vc-num">{{ item.text }}</dd>
      </div>
      <div v-if="gpuText !== null" class="host-card__cell">
        <dt>{{ t('metric.gpu.util') }}</dt>
        <dd class="vc-num">{{ gpuText }}</dd>
      </div>
    </dl>

    <p class="host-card__probes vc-num">
      {{ t('host.probesSummary', { up: host.probes.up, down: host.probes.down }) }}
    </p>

    <div v-if="expanded" class="host-card__detail">
      <ElSkeleton v-if="loading && !detail" :rows="4" animated />

      <template v-else-if="detail">
        <h4 class="host-card__section">{{ t('host.currentSnapshot') }}</h4>

        <dl class="host-card__kv">
          <div class="host-card__cell">
            <dt>{{ t('metric.cpu.usage') }}</dt>
            <dd class="vc-num">{{ formatPct(cpu?.usage_pct ?? null) }}</dd>
          </div>
          <div class="host-card__cell">
            <dt>{{ t('metric.cpu.load1') }}</dt>
            <dd class="vc-num">{{ cpu?.load1 ?? '—' }}</dd>
          </div>
          <div class="host-card__cell">
            <dt>{{ t('metric.cpu.load5') }}</dt>
            <dd class="vc-num">{{ cpu?.load5 ?? '—' }}</dd>
          </div>
          <div class="host-card__cell">
            <dt>{{ t('metric.cpu.load15') }}</dt>
            <dd class="vc-num">{{ cpu?.load15 ?? '—' }}</dd>
          </div>
          <div class="host-card__cell">
            <dt>{{ t('metric.mem.used') }}</dt>
            <dd class="vc-num">{{ formatBytes(memory?.used_bytes ?? null) }}</dd>
          </div>
          <div class="host-card__cell">
            <dt>{{ t('metric.mem.total') }}</dt>
            <dd class="vc-num">{{ formatBytes(memory?.total_bytes ?? null) }}</dd>
          </div>
          <div class="host-card__cell">
            <dt>{{ t('metric.mem.available') }}</dt>
            <dd class="vc-num">{{ formatBytes(memory?.available_bytes ?? null) }}</dd>
          </div>
          <div class="host-card__cell">
            <dt>{{ t('metric.mem.used_pct') }}</dt>
            <dd class="vc-num">{{ formatPct(memory?.used_pct ?? null) }}</dd>
          </div>
        </dl>

        <h4 class="host-card__section">{{ t('host.disks') }}</h4>
        <ElTable :data="disks" size="small" class="host-card__table">
          <ElTableColumn prop="label" :label="t('host.deviceLabel')" width="90" />
          <ElTableColumn :label="t('metric.disk.used_pct')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ formatPct(num(row, 'used_pct')) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.disk.used')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBytes(num(row, 'used_bytes')) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.disk.total')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBytes(num(row, 'total_bytes')) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.disk.read_bps')" min-width="120">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBps(num(row, 'read_bps')) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.disk.write_bps')" min-width="120">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBps(num(row, 'write_bps')) }}</span>
            </template>
          </ElTableColumn>
        </ElTable>

        <h4 class="host-card__section">{{ t('host.networks') }}</h4>
        <ElTable :data="networks" size="small" class="host-card__table">
          <ElTableColumn prop="label" :label="t('host.deviceLabel')" width="90" />
          <ElTableColumn :label="t('metric.net.rx_bps')" min-width="120">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBps(num(row, 'rx_bps')) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.net.tx_bps')" min-width="120">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBps(num(row, 'tx_bps')) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.net.conn_count')" min-width="100">
            <template #default="{ row }">
              <span class="vc-num">{{ num(row, 'conn_count') ?? '—' }}</span>
            </template>
          </ElTableColumn>
        </ElTable>

        <template v-if="gpus.length > 0">
          <h4 class="host-card__section">{{ t('host.gpus') }}</h4>
          <ElTable :data="gpus" size="small" class="host-card__table">
            <ElTableColumn prop="label" :label="t('host.deviceLabel')" width="90" />
            <ElTableColumn :label="t('metric.gpu.util')" min-width="110">
              <template #default="{ row }">
                <span class="vc-num">{{ formatPct(num(row, 'util_pct')) }}</span>
              </template>
            </ElTableColumn>
            <ElTableColumn :label="t('metric.gpu.mem_used')" min-width="110">
              <template #default="{ row }">
                <span class="vc-num">{{ formatBytes(num(row, 'mem_used_bytes')) }}</span>
              </template>
            </ElTableColumn>
            <ElTableColumn :label="t('metric.gpu.temp')" min-width="100">
              <template #default="{ row }">
                <span class="vc-num">{{ num(row, 'temp_c') ?? '—' }} ℃</span>
              </template>
            </ElTableColumn>
            <ElTableColumn :label="t('metric.gpu.power')" min-width="100">
              <template #default="{ row }">
                <span class="vc-num">{{ num(row, 'power_w') ?? '—' }} W</span>
              </template>
            </ElTableColumn>
          </ElTable>
        </template>

        <p class="host-card__updated vc-num">{{ t('summary.updatedAt', { time: formatLocalWithOffset(detail.updated_at, { seconds: true }) }) }}</p>
      </template>

      <ElAlert v-else type="info" :closable="false" :title="t('common.empty')" />
    </div>
  </article>
</template>

<style scoped>
.host-card {
  border: 1px solid var(--vc-border);
  border-radius: 6px;
  background: var(--vc-surface);
  padding: 12px 14px;
}

.host-card--expanded {
  grid-column: 1 / -1;
}

.host-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
}

.host-card__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.host-card__name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-card__os {
  color: var(--vc-text-2);
  font-size: 12px;
}

.host-card__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--vc-text-2);
  font-size: 12px;
  white-space: nowrap;
}

.host-card__snapshot,
.host-card__kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 6px 14px;
  margin: 10px 0 6px;
}

.host-card__cell {
  min-width: 0;
}

.host-card__cell dt {
  color: var(--vc-text-2);
  font-size: 11px;
}

.host-card__cell dd {
  margin: 0;
  font-size: 14px;
}

.host-card__probes {
  margin: 0;
  color: var(--vc-text-2);
  font-size: 12px;
}

.host-card__detail {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--vc-border);
}

.host-card__section {
  margin: 12px 0 6px;
  font-size: 13px;
}

.host-card__table {
  width: 100%;
}

.host-card__updated {
  margin: 8px 0 0;
  color: var(--vc-text-2);
  font-size: 12px;
}

@media (max-width: 767px) {
  .host-card__table {
    display: block;
    overflow-x: auto;
  }
}
</style>
