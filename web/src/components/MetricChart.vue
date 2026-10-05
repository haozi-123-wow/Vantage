<script setup lang="ts">
/**
 * 指标曲线（docs/frontend.md §6.1 `MetricChart.vue` 契约）。
 *
 * 组件只负责**生命周期**：init / resize / dispose / 可见性暂停；
 * option 的形状与缺失值口径全部在 `utils/chart.ts`（有单测）。
 *
 * 硬约束：
 * - 缺失桶**不补 0**（`connectNulls: false`，由 chart.ts 保证）—— 空档必须断开；
 * - 实时流式更新时 `animation: false`，⛔ 不做二次抽稀；
 * - 容器用 `ResizeObserver` 驱动 `resize()`；卸载必须 `dispose()`；
 * - `document.hidden` / 不可见时**暂停渲染**（§5.3 F5：只暂停渲染，⛔ 不动 WS 订阅）。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useTheme } from '@/composables/useTheme'
import { buildLineChartOption, type ChartSeriesInput } from '@/utils/chart'
import { echarts, readChartTheme, type EChartsType } from '@/utils/echarts'

const props = withDefaults(
  defineProps<{
    series: ChartSeriesInput[]
    unit?: string | null
    /** 服务端回传的**实际**档位（`step=auto` 时由服务端选），显示在右下角 */
    step?: string | null
    height?: number
    loading?: boolean
    /** 已经过 i18n 映射的错误文案（`errorText(error.code, error.message)`） */
    error?: string | null
    showDataZoom?: boolean
  }>(),
  { unit: null, step: null, height: 240, loading: false, error: null, showDataZoom: true },
)

const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()
const { resolved } = useTheme()

const host = ref<HTMLDivElement | null>(null)
const chart = shallowRef<EChartsType | null>(null)
/** 被暂停期间又有新数据：等重新可见时补一次渲染（⛔ 不丢最后一帧） */
const dirty = ref(false)
let visible = true

const hasData = computed(() => props.series.some((item) => item.points.length > 0))
const showEmpty = computed(() => !props.loading && !props.error && !hasData.value)

function render(): void {
  const instance = chart.value
  if (!instance) return
  if (!visible || (typeof document !== 'undefined' && document.hidden)) {
    dirty.value = true
    return
  }
  dirty.value = false
  instance.setOption(
    buildLineChartOption({
      series: props.series,
      unit: props.unit,
      step: props.step,
      theme: readChartTheme(),
      showDataZoom: props.showDataZoom,
      // 实时追加（点数会持续增长）时关掉动画，避免每帧重排（§6.1 性能）
      animation: false,
    }),
    // ⛔ notMerge：换指标/换范围时旧序列必须整体消失，合并会留下上一条曲线
    { notMerge: true },
  )
}

function ensureChart(): void {
  if (chart.value || !host.value) return
  chart.value = echarts.init(host.value, undefined, { renderer: 'canvas' })
  render()
}

let resizeObserver: ResizeObserver | null = null
let intersectionObserver: IntersectionObserver | null = null

function onVisibilityChange(): void {
  if (typeof document === 'undefined') return
  if (document.hidden) return
  if (dirty.value) render()
}

onMounted(() => {
  ensureChart()

  if (host.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => chart.value?.resize())
    resizeObserver.observe(host.value)
  }

  // 不可见的图表不渲染（§10 性能预算：同屏图 surface 有限，不可见即暂停）
  if (host.value && typeof IntersectionObserver !== 'undefined') {
    intersectionObserver = new IntersectionObserver((entries) => {
      const entry = entries[0]
      visible = entry?.isIntersecting ?? true
      if (visible) render()
    })
    intersectionObserver.observe(host.value)
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  resizeObserver?.disconnect()
  intersectionObserver?.disconnect()
  resizeObserver = null
  intersectionObserver = null
  chart.value?.dispose()
  chart.value = null
})

watch(
  () => [props.series, props.unit, props.step, resolved.value] as const,
  () => render(),
  { deep: false },
)
</script>

<template>
  <div class="metric-chart" :style="{ height: `${height}px` }">
    <div ref="host" class="metric-chart__canvas" />

    <div v-if="loading && !hasData" class="metric-chart__overlay">
      <ElSkeleton :rows="3" animated />
    </div>

    <div v-else-if="error" class="metric-chart__overlay metric-chart__overlay--solid">
      <ElAlert type="error" :closable="false" show-icon :title="error">
        <ElButton size="small" @click="emit('retry')">{{ t('common.retry') }}</ElButton>
      </ElAlert>
    </div>

    <div v-else-if="showEmpty" class="metric-chart__overlay metric-chart__overlay--solid">
      <ElEmpty :description="t('chart.noData')" :image-size="48" />
    </div>

    <span v-if="step" class="metric-chart__step">{{ t('chart.step', { step }) }}</span>
  </div>
</template>

<style scoped>
.metric-chart {
  position: relative;
  width: 100%;
}

.metric-chart__canvas {
  width: 100%;
  height: 100%;
}

.metric-chart__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
}

.metric-chart__overlay--solid {
  background: var(--vc-surface);
}

.metric-chart__step {
  position: absolute;
  right: 6px;
  bottom: 2px;
  color: var(--vc-text-2);
  font-size: 11px;
  pointer-events: none;
}
</style>
