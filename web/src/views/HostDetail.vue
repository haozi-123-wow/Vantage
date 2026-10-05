<script setup lang="ts">
/**
 * 主机详情（docs/frontend.md §4.4，M4 交付物）。
 *
 * 区块与数据来源：
 * - 头部信息 + 当前快照 → `GET /api/v1/hosts/{id}`（`current_metrics` 给**全部序列**的当前值）；
 * - 历史曲线 → `GET /api/v1/hosts/{id}/metrics`（`step=auto` 由服务端选档并回传实际档位）；
 * - 探活历史 → `/hosts/{id}/probes`；IP 变更时间线 → `/hosts/{id}/ip-history`；进程 Top → `/hosts/{id}/processes`。
 *
 * 硬约束：
 * - 曲线缺失桶**不补 0**（`MetricChart` / `utils/chart.ts` 保证断线）；
 * - 实时增量只**追加尾部**，不参与历史重算（§6.1 数据源分层）——
 *   故只在历史档位就是最细档 `30s` 时合并，否则原始 30s 点会把 1m/5m 桶画歪；
 * - 页面 URL 带 `?range=` 保存当前选择（§4.4 ➕ 建议），刷新/分享能恢复；
 * - `/ws/live` + `trackAgent(id)` + `subscribe({ agents: [id] })` 降流量（docs/frontend.md §5.3）。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import { AppError } from '@/api/http'
import {
  hostsApi,
  type HostDetail,
  type HostIpHistory,
  type HostProcessSnapshot,
  type HostProbeHistory,
} from '@/api/private'
import AsyncState from '@/components/AsyncState.vue'
import IpTimeline from '@/components/IpTimeline.vue'
import MetricChart from '@/components/MetricChart.vue'
import ProbeHistoryPanel from '@/components/ProbeHistoryPanel.vue'
import ProcessTopTable from '@/components/ProcessTopTable.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import TimeRangePicker from '@/components/TimeRangePicker.vue'
import { errorText } from '@/i18n'
import { useRealtimeStore } from '@/store/realtime'
import type { MetricSeries } from '@/types/domain'
import { mergeSeriesPoints, type ChartSeriesInput } from '@/utils/chart'
import { formatInt } from '@/utils/format'
import { metricLabelText } from '@/utils/metrics'
import { buildCurrentSnapshot } from '@/utils/snapshot'
import {
  DEFAULT_TIME_RANGE,
  formatLocalWithOffset,
  isTimeRangeKey,
  resolveTimeRange,
  type TimeRangeKey,
} from '@/utils/time'
import { formatBytes, formatBps, formatDuration, formatMs, formatPct } from '@/utils/units'

const props = defineProps<{ id: string }>()

const { t, te } = useI18n()
const route = useRoute()
const router = useRouter()
const realtime = useRealtimeStore()

/** 单张曲线的加载状态（历史来自 `/metrics`，实时尾部来自 realtime store） */
interface ChartSlot {
  series: MetricSeries[]
  step: '30s' | '1m' | '5m' | null
  loading: boolean
  error: string | null
}

interface ChartConfig {
  key: string
  titleKey: string
  /** 图表单位（`null` = 无单位，如负载） */
  unit: string | null
  /** 请求用的指标（基名 = 服务端展开该基名下**全部维度**序列） */
  metrics: string[]
}

const detail = ref<HostDetail | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const probes = ref<HostProbeHistory | null>(null)
const probesLoading = ref(false)
const ipHistory = ref<HostIpHistory | null>(null)
const ipLoading = ref(false)
const processes = ref<HostProcessSnapshot | null>(null)
const processesLoading = ref(false)

const chartState = reactive<Record<string, ChartSlot>>({})

/** ✅ F9：默认 6h；范围存进 URL（`?range=6h`） */
const rangeKey = ref<TimeRangeKey>(isTimeRangeKey(route.query.range) ? route.query.range : DEFAULT_TIME_RANGE)
const showCores = ref(false)
const showMore = ref(false)

const snapshotView = computed(() => buildCurrentSnapshot(detail.value?.current_metrics))
const caps = computed<Record<string, unknown>>(() => detail.value?.capabilities ?? {})

/** GPU 相关整块隐藏的判据：能力声明**或**当前快照里确实有 GPU 序列（§6.2） */
const hasGpu = computed(
  () =>
    caps.value['gpu.nvidia'] === true ||
    caps.value['gpu.amd'] === true ||
    snapshotView.value.gpus.length > 0,
)

const charts = computed<ChartConfig[]>(() => {
  const list: ChartConfig[] = [
    {
      key: 'cpu',
      titleKey: 'chart.cpu',
      unit: '%',
      metrics: showCores.value ? ['cpu.usage', 'cpu.core.usage'] : ['cpu.usage'],
    },
    { key: 'mem', titleKey: 'chart.memory', unit: '%', metrics: ['mem.used_pct', 'swap.used_pct'] },
    { key: 'disk', titleKey: 'chart.disk', unit: '%', metrics: ['disk.used_pct'] },
    { key: 'net', titleKey: 'chart.network', unit: 'Bps', metrics: ['net.rx_bps', 'net.tx_bps'] },
  ]
  if (showMore.value) {
    list.push(
      { key: 'load', titleKey: 'chart.load', unit: null, metrics: ['cpu.load1', 'cpu.load5', 'cpu.load15'] },
      { key: 'diskIo', titleKey: 'chart.diskIo', unit: 'Bps', metrics: ['disk.read_bps', 'disk.write_bps'] },
    )
    if (hasGpu.value) {
      list.push({ key: 'gpu', titleKey: 'chart.gpu', unit: '%', metrics: ['gpu.util'] })
    }
  }
  return list
})

function toErrorText(err: unknown): string {
  return err instanceof AppError ? errorText(err.code, err.message) : errorText(undefined)
}

/**
 * 曲线接口的错误要带出服务端的**两道闸门**细节（docs/api.md §4.3）：
 * `too_many_series` 的 `details.hint` 与「本范围最多能选几条」，否则用户只看到"请求失败"。
 */
function chartErrorText(err: unknown): string {
  if (!(err instanceof AppError)) return errorText(undefined)
  const base = errorText(err.code, err.message)
  if (err.code !== 'too_many_series') return base

  const details = err.details as { hint?: unknown; max_series_at_this_range?: unknown } | undefined
  const max = typeof details?.max_series_at_this_range === 'number' ? details.max_series_at_this_range : null
  const hint = typeof details?.hint === 'string' ? details.hint : ''
  return [base, max === null ? '' : t('chart.maxSeriesAtRange', { count: max }), hint].filter(Boolean).join(' ')
}

async function loadDetail(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    detail.value = await hostsApi.get(props.id)
  } catch (err) {
    detail.value = null
    error.value = toErrorText(err)
  } finally {
    loading.value = false
  }
}

async function loadChart(config: ChartConfig): Promise<void> {
  const slot =
    chartState[config.key] ??
    (chartState[config.key] = { series: [], step: null, loading: false, error: null })
  slot.loading = true
  slot.error = null
  const range = resolveTimeRange(rangeKey.value)
  try {
    const response = await hostsApi.metrics(props.id, {
      metrics: config.metrics,
      from: range.from,
      to: range.to,
      // ✅ `auto`：服务端按"最细且点数 ≤ 2000"选档并回传实际 step（前端⛔ 不维护映射表）
      step: 'auto',
      agg: 'avg',
    })
    slot.series = response.series
    slot.step = response.step
  } catch (err) {
    slot.series = []
    slot.step = null
    slot.error = chartErrorText(err)
  } finally {
    slot.loading = false
  }
}

async function loadCharts(): Promise<void> {
  await Promise.all(charts.value.map((config) => loadChart(config)))
}

async function loadProbes(): Promise<void> {
  probesLoading.value = true
  try {
    const range = resolveTimeRange(rangeKey.value)
    probes.value = await hostsApi.probes(props.id, { from: range.from, to: range.to })
  } catch {
    probes.value = null
  } finally {
    probesLoading.value = false
  }
}

async function loadIpHistory(): Promise<void> {
  ipLoading.value = true
  try {
    ipHistory.value = await hostsApi.ipHistory(props.id, { limit: 100 })
  } catch {
    ipHistory.value = null
  } finally {
    ipLoading.value = false
  }
}

async function loadProcesses(): Promise<void> {
  processesLoading.value = true
  try {
    // `at` 省略 = 最近一条（⚠️ 语义是"该时刻**之前**最近的一条"）
    processes.value = await hostsApi.processes(props.id)
  } catch {
    processes.value = null
  } finally {
    processesLoading.value = false
  }
}

/**
 * 曲线数据：历史 + **实时尾部**。
 * ⚠️ 只在历史档位就是最细档 `30s` 时合并：realtime 的增量是原始上报粒度（30s），
 *    并进 1m/5m 的桶里会把曲线画歪（§6.1 数据源分层）。
 */
function chartSeries(key: string): ChartSeriesInput[] {
  const slot = chartState[key]
  if (!slot) return []
  const step = slot.step
  return slot.series.map((item) => {
    const tail =
      step === '30s' && realtime.trackedAgentId === props.id ? (realtime.series[item.metric]?.points ?? []) : []
    return {
      id: item.metric,
      name: seriesName(item),
      points: tail.length > 0 ? mergeSeriesPoints(item.points, tail) : item.points,
    }
  })
}

/** 图例文案：优先维度值（`/data`、`eth0`）；无维度时回退到该基名的中文名（`metric.*`） */
function seriesName(item: MetricSeries): string {
  if (item.base === 'cpu.core.usage') return `${t('metric.cpu.core.usage')} ${item.labels.core ?? ''}`.trim()
  if (item.base.startsWith('gpu.')) return `GPU ${item.labels.index ?? ''}`.trim()
  const labels = metricLabelText(item.labels)
  if (labels) return labels
  const key = `metric.${item.base}`
  return te(key) ? t(key) : item.base
}

function onRangeChange(next: TimeRangeKey): void {
  rangeKey.value = next
  // 范围写进 URL（可分享 / 刷新恢复）；⛔ 不用 push，避免污染浏览器历史
  void router.replace({ query: { ...route.query, range: next } })
}

/** 曲线尾部正在被实时流接续（只有最细档才合并，见 `chartSeries`） */
const realtimeMerged = computed(
  () =>
    realtime.trackedAgentId === props.id &&
    chartState.cpu?.step === '30s' &&
    Object.keys(realtime.series).length > 0,
)

watch([rangeKey, showCores, showMore], () => {
  void loadCharts()
})

async function refreshAll(): Promise<void> {
  await Promise.all([loadDetail(), loadCharts(), loadProbes(), loadIpHistory(), loadProcesses()])
}

watch(
  () => props.id,
  () => {
    realtime.trackAgent(props.id)
    realtime.subscribe({ agents: [props.id] })
    void refreshAll()
  },
)

onMounted(() => {
  realtime.connect('live')
  // 曲线即时追加只服务于"正在看的这台机"（docs/frontend.md §5.3）
  realtime.trackAgent(props.id)
  realtime.subscribe({ agents: [props.id] })
  void refreshAll()
})

onBeforeUnmount(() => {
  // ⛔ 不断开连接（全站单连接复用）；但要把被跟踪的主机清掉，否则别的页面会继续吃它的指标
  realtime.trackAgent(null)
})

function num(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
</script>

<template>
  <section class="vc-page">
    <AsyncState :loading="loading && !detail" :error="error" :empty="!loading && !detail" @retry="refreshAll">
      <template v-if="detail">
        <header class="host-detail__head">
          <div class="host-detail__title">
            <h1 class="vc-page__title">{{ detail.name }}</h1>
            <StatusBadge :status="detail.status" />
            <ElTag v-for="tag in detail.tags ?? []" :key="tag" size="small" type="info" disable-transitions>
              {{ tag }}
            </ElTag>
            <ElTag v-if="detail.ip_flapping" size="small" disable-transitions class="tag--flapping">
              {{ t('badge.flapping') }}
            </ElTag>
            <ElTag
              v-if="typeof detail.clock_drift_ms === 'number'"
              size="small"
              disable-transitions
              :type="Math.abs(detail.clock_drift_ms) >= 60_000 ? 'danger' : 'warning'"
            >
              {{ t('badge.drift') }} {{ formatInt(detail.clock_drift_ms) }} ms
            </ElTag>
          </div>

          <ElButton size="small" :loading="loading" @click="refreshAll">{{ t('common.refresh') }}</ElButton>
        </header>

        <dl class="host-detail__facts">
          <div class="host-detail__fact">
            <dt>{{ t('host.os') }}</dt>
            <dd>{{ detail.os ?? '—' }}</dd>
          </div>
          <div class="host-detail__fact">
            <dt>{{ t('host.arch') }}</dt>
            <dd>{{ detail.arch ?? '—' }}</dd>
          </div>
          <div class="host-detail__fact">
            <dt>{{ t('host.kernel') }}</dt>
            <dd>{{ (detail.host_info?.kernel as string) ?? '—' }}</dd>
          </div>
          <div class="host-detail__fact">
            <dt>{{ t('host.uptime') }}</dt>
            <dd class="vc-num">{{ formatDuration(detail.uptime ?? null) }}</dd>
          </div>
          <div class="host-detail__fact">
            <dt>{{ t('host.lastSeen') }}</dt>
            <dd class="vc-num" :title="detail.last_seen_at ?? ''">
              {{ detail.last_seen_ago ?? '—' }}
              <span class="host-detail__sub">{{ formatLocalWithOffset(detail.last_seen_at, { seconds: true }) }}</span>
            </dd>
          </div>
          <div class="host-detail__fact">
            <dt>{{ t('host.currentIp') }}</dt>
            <dd class="vc-num">
              {{ detail.last_ip ?? '—' }}
              <span v-if="detail.reported_ip && detail.reported_ip !== detail.last_ip" class="host-detail__sub vc-num">
                {{ t('host.reportedIp') }} {{ detail.reported_ip }}
              </span>
            </dd>
          </div>
          <div class="host-detail__fact">
            <dt>{{ t('host.activeAlerts') }}</dt>
            <dd class="vc-num">{{ detail.active_alerts ?? 0 }}</dd>
          </div>
          <div class="host-detail__fact">
            <dt>{{ t('host.capabilities') }}</dt>
            <dd class="host-detail__caps">
              <ElTag v-for="(value, key) in caps" v-show="value === true" :key="key" size="small" disable-transitions>
                {{ key }}
              </ElTag>
            </dd>
          </div>
        </dl>

        <!-- 当前快照：`current_metrics` 是**全部序列**的当前值（键 = 指标全名） -->
        <h2 class="host-detail__section">{{ t('host.currentSnapshot') }}</h2>
        <div class="host-detail__snapshot">
          <div class="host-detail__block">
            <h3>CPU</h3>
            <dl class="host-detail__kv">
              <div>
                <dt>{{ t('metric.cpu.usage') }}</dt>
                <dd class="vc-num">{{ formatPct(num(snapshotView.scalars['cpu.usage'])) }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.cpu.load1') }}</dt>
                <dd class="vc-num">{{ num(snapshotView.scalars['cpu.load1']) ?? '—' }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.cpu.load5') }}</dt>
                <dd class="vc-num">{{ num(snapshotView.scalars['cpu.load5']) ?? '—' }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.cpu.load15') }}</dt>
                <dd class="vc-num">{{ num(snapshotView.scalars['cpu.load15']) ?? '—' }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.cpu.ctx_switch') }}</dt>
                <dd class="vc-num">{{ num(snapshotView.scalars['cpu.ctx_switch']) ?? '—' }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.process.count') }}</dt>
                <dd class="vc-num">{{ num(snapshotView.scalars['process.count']) ?? '—' }}</dd>
              </div>
            </dl>
            <p v-if="snapshotView.cores.length > 0" class="host-detail__cores">
              <span v-for="core in snapshotView.cores" :key="core.core" class="host-detail__core vc-num">
                {{ t('host.coreN', { n: core.core }) }} {{ formatPct(core.value) }}
              </span>
            </p>
          </div>

          <div class="host-detail__block">
            <h3>{{ t('host.memory') }}</h3>
            <dl class="host-detail__kv">
              <div>
                <dt>{{ t('metric.mem.used') }}</dt>
                <dd class="vc-num">{{ formatBytes(num(snapshotView.scalars['mem.used'])) }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.mem.total') }}</dt>
                <dd class="vc-num">{{ formatBytes(num(snapshotView.scalars['mem.total'])) }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.mem.available') }}</dt>
                <dd class="vc-num">{{ formatBytes(num(snapshotView.scalars['mem.available'])) }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.mem.used_pct') }}</dt>
                <dd class="vc-num">{{ formatPct(num(snapshotView.scalars['mem.used_pct'])) }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.mem.cached') }}</dt>
                <dd class="vc-num">{{ formatBytes(num(snapshotView.scalars['mem.cached'])) }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.mem.buffers') }}</dt>
                <dd class="vc-num">{{ formatBytes(num(snapshotView.scalars['mem.buffers'])) }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.swap.used') }}</dt>
                <dd class="vc-num">{{ formatBytes(num(snapshotView.scalars['swap.used'])) }}</dd>
              </div>
              <div>
                <dt>{{ t('metric.swap.used_pct') }}</dt>
                <dd class="vc-num">{{ formatPct(num(snapshotView.scalars['swap.used_pct'])) }}</dd>
              </div>
            </dl>
          </div>
        </div>

        <ElTable :data="snapshotView.disks" size="small" class="host-detail__table">
          <ElTableColumn :label="t('host.mount')" min-width="120">
            <template #default="{ row }">
              <span class="vc-num">{{ row.labels.mount ?? row.labels.device ?? row.label }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.disk.used_pct')" min-width="100">
            <template #default="{ row }">
              <span class="vc-num">{{ formatPct(num(row.values['disk.used_pct'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.disk.inode_used_pct')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ formatPct(num(row.values['disk.inode_used_pct'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.disk.read_bps')" min-width="120">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBps(num(row.values['disk.read_bps'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.disk.write_bps')" min-width="120">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBps(num(row.values['disk.write_bps'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.disk.latency_ms')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ formatMs(num(row.values['disk.latency_ms'])) }}</span>
            </template>
          </ElTableColumn>
        </ElTable>

        <ElTable :data="snapshotView.networks" size="small" class="host-detail__table">
          <ElTableColumn :label="t('host.device')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ row.labels.device ?? row.label }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.net.rx_bps')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBps(num(row.values['net.rx_bps'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.net.tx_bps')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBps(num(row.values['net.tx_bps'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.net.rx_total')" min-width="120">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBytes(num(row.values['net.rx_total'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.net.tx_total')" min-width="120">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBytes(num(row.values['net.tx_total'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.net.conn_count')" min-width="100">
            <template #default="{ row }">
              <span class="vc-num">{{ num(row.values['net.conn_count']) ?? '—' }}</span>
            </template>
          </ElTableColumn>
        </ElTable>

        <ElTable
          v-if="snapshotView.gpus.length > 0"
          :data="snapshotView.gpus"
          size="small"
          class="host-detail__table"
        >
          <ElTableColumn :label="t('host.device')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ row.label }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.gpu.util')" min-width="100">
            <template #default="{ row }">
              <span class="vc-num">{{ formatPct(num(row.values['gpu.util'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.gpu.mem_used')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBytes(num(row.values['gpu.mem_used'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.gpu.mem_total')" min-width="110">
            <template #default="{ row }">
              <span class="vc-num">{{ formatBytes(num(row.values['gpu.mem_total'])) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.gpu.temp')" min-width="100">
            <template #default="{ row }">
              <span class="vc-num">{{ num(row.values['gpu.temp']) ?? '—' }} ℃</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('metric.gpu.power')" min-width="100">
            <template #default="{ row }">
              <span class="vc-num">{{ num(row.values['gpu.power']) ?? '—' }} W</span>
            </template>
          </ElTableColumn>
        </ElTable>

        <!-- 历史曲线（ECharts）：默认 CPU / 内存 / 磁盘 / 网络 四图（✅ F9） -->
        <h2 class="host-detail__section">{{ t('chart.sectionTitle') }}</h2>
        <div class="host-detail__chartControls">
          <TimeRangePicker :model-value="rangeKey" @update:model-value="onRangeChange" />
          <ElCheckbox v-model="showCores" :label="t('chart.showCores')" />
          <ElCheckbox v-model="showMore" :label="t('chart.showMore')" />
          <span class="host-detail__spacer" />
          <span v-if="realtimeMerged" class="host-detail__sub">{{ t('chart.realtimeTail') }}</span>
        </div>

        <div class="host-detail__charts">
          <article v-for="config in charts" :key="config.key" class="host-detail__chart">
            <h3 class="host-detail__chartTitle">{{ t(config.titleKey) }}</h3>
            <MetricChart
              :series="chartSeries(config.key)"
              :unit="config.unit"
              :step="chartState[config.key]?.step ?? null"
              :loading="chartState[config.key]?.loading ?? false"
              :error="chartState[config.key]?.error ?? null"
              @retry="loadChart(config)"
            />
          </article>
        </div>

        <h2 class="host-detail__section">{{ t('host.probeHistory') }}</h2>
        <ProbeHistoryPanel :data="probes" :loading="probesLoading" />

        <h2 class="host-detail__section">{{ t('host.ipTimeline') }}</h2>
        <IpTimeline :data="ipHistory" :loading="ipLoading" />

        <h2 class="host-detail__section">{{ t('host.processTop') }}</h2>
        <ProcessTopTable :data="processes" :loading="processesLoading" />
      </template>
    </AsyncState>
  </section>
</template>

<style scoped>
.host-detail__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.host-detail__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.host-detail__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px 16px;
  margin: 12px 0 4px;
  padding: 10px 12px;
  border: 1px solid var(--vc-border);
  border-radius: 6px;
  background: var(--vc-surface);
}

.host-detail__fact dt {
  color: var(--vc-text-2);
  font-size: 12px;
}

.host-detail__fact dd {
  margin: 0;
  font-size: 13px;
}

.host-detail__sub {
  margin-left: 6px;
  color: var(--vc-text-2);
  font-size: 11px;
}

.host-detail__caps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.host-detail__section {
  margin: 20px 0 8px;
  font-size: 15px;
}

.host-detail__snapshot {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
}

.host-detail__block {
  padding: 10px 12px;
  border: 1px solid var(--vc-border);
  border-radius: 6px;
  background: var(--vc-surface);
}

.host-detail__block h3 {
  margin: 0 0 6px;
  font-size: 13px;
}

.host-detail__kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 6px 14px;
  margin: 0;
}

.host-detail__kv dt {
  color: var(--vc-text-2);
  font-size: 11px;
}

.host-detail__kv dd {
  margin: 0;
  font-size: 14px;
}

.host-detail__cores {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 0;
  color: var(--vc-text-2);
  font-size: 12px;
}

.host-detail__table {
  width: 100%;
  margin-top: 10px;
}

.host-detail__chartControls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.host-detail__spacer {
  flex: 1;
}

.host-detail__charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 12px;
}

.host-detail__chart {
  padding: 10px 12px;
  border: 1px solid var(--vc-border);
  border-radius: 6px;
  background: var(--vc-surface);
}

.host-detail__chartTitle {
  margin: 0 0 4px;
  font-size: 13px;
}

.tag--flapping {
  background: color-mix(in srgb, var(--vc-flapping) 16%, transparent);
  border-color: var(--vc-flapping);
  color: var(--vc-flapping);
}

@media (max-width: 1199px) {
  .host-detail__charts {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 767px) {
  .host-detail__table {
    display: block;
    overflow-x: auto;
  }
}
</style>
