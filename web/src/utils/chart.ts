/**
 * ECharts 折线图的**纯逻辑层**（docs/frontend.md §6.1 / §6.2）。
 *
 * 为什么把 option 的构建放在 utils 而不是组件里：这几条口径是**契约**级别的，
 * 必须有单测钉住（`web/tests/chart.spec.ts`），组件只负责生命周期（init / resize / dispose）：
 * - 序列标识用**指标全名**（`series.id`），⛔ 不用基名 —— 否则多个挂载点会被 ECharts 当成同一条线；
 * - 缺失桶**不补 0 也不补 null**：数组里没有那个点，`connectNulls: false` 让它断线
 *   （补 0 会把"采集断了"画成"CPU 掉到 0"，docs/api.md §4.3）；
 * - ⛔ 前端**不抽稀**（`sampling` 一律不设）：点数由服务端档位决定，抽稀会把尖刺整段抹掉（§6.1）；
 * - 实时流式追加时 `animation: false`（§6.1 性能）。
 *
 * ⛔ 组件里不要手写指标名拼接（docs/frontend.md F10），解析/拼装一律走 `utils/metrics.ts`。
 */
import { formatNumber } from '@/utils/format'
import { formatLocalWithOffset } from '@/utils/time'
import { NO_DATA, formatMetricValue } from '@/utils/units'
import type { MetricPoint, MetricSeries } from '@/types/domain'

/** 一条曲线的渲染输入（由 `MetricSeries` 或实时环形缓冲投影而来） */
export interface ChartSeriesInput {
  /** 权威序列全名，同时用作 ECharts `series.id` */
  id: string
  /** 图例文案（`utils/metrics.ts` 的 `metricLabelText`，如 `/data`、`eth0`） */
  name: string
  /** `[桶起点毫秒, 值]`，缺失桶**不出现** */
  points: MetricPoint[]
}

/** 从 CSS 变量读出来的图表配色（明/暗各一套，切换时重建 option） */
export interface ChartTheme {
  textColor: string
  axisColor: string
  splitColor: string
  palette: string[]
  /** 暗色下网格与提示框的底色 */
  surfaceColor: string
}

/** 状态语义色（docs/frontend.md §8.2）——图表配色只借用它们，⛔ 不顺带改含义 */
export const DEFAULT_CHART_PALETTE = [
  '#2b6cb0',
  '#1f7a4d',
  '#a35a00',
  '#6b3fa0',
  '#c02a2a',
  '#0f7b8a',
  '#8a6d00',
  '#4b5563',
]

/** 允许的 `step` 档位（⛔ 没有 `15s`：Agent 上报周期就是 30s，docs/api.md §4.3） */
export const CHART_STEPS = ['30s', '1m', '5m'] as const

/** 档位对应的毫秒数（实时尾部合并时判断"这条 delta 是否落在最新桶里"） */
export function stepToMs(step: string | null | undefined): number {
  if (step === '5m') return 300_000
  if (step === '1m') return 60_000
  return 30_000
}

/**
 * 只保留有限值：缺失桶在契约里就是"不出现"，但万一服务端给了 null/NaN，
 * 这里也必须丢掉而不是补 0（⛔ 不做 `?? 0` 兜底）。
 */
function sanitizePoints(points: MetricPoint[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const point of points) {
    const ts = point?.[0]
    const value = point?.[1]
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out.push([ts, value])
  }
  return out
}

/** Y 轴刻度：`%` 只写数字（轴名给出 `%`），其余走单位格式化（bytes 自动进位） */
export function axisTickLabel(value: number, unit?: string | null): string {
  if (!Number.isFinite(value)) return ''
  if (unit === '%') return formatNumber(value, { maximumFractionDigits: 1 })
  if (!unit) return formatNumber(value, { maximumFractionDigits: 2 })
  return formatMetricValue(value, unit)
}

/** Y 轴名称：`%` / `bytes/s` / `℃` …（未知单位原样给出，⛔ 不静默丢弃） */
export function axisNameForUnit(unit?: string | null): string {
  switch (unit) {
    case undefined:
    case null:
    case '':
      return ''
    case '%':
      return '%'
    case 'B':
    case 'bytes':
      return 'bytes'
    case 'Bps':
    case 'bytes/s':
      return 'bytes/s'
    case 'C':
    case '℃':
      return '℃'
    case 'W':
      return 'W'
    case 'ms':
      return 'ms'
    default:
      return unit
  }
}

/** ⛔ ECharts 的 tooltip 是 HTML：序列名来自服务端，必须转义后才能拼进字符串 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** tooltip 里的一行（纯数据，便于单测；HTML 拼接在 `renderTooltip`） */
export interface TooltipRow {
  seriesId: string
  name: string
  value: number | null
}

/** 从 ECharts 的 params 里抽出 tooltip 行（缺失点不渲染成 0，而是 `—`） */
export function toTooltipRows(params: unknown): TooltipRow[] {
  const list = Array.isArray(params) ? params : [params]
  const rows: TooltipRow[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as { seriesId?: unknown; seriesName?: unknown; value?: unknown }
    const seriesId = typeof item.seriesId === 'string' ? item.seriesId : String(item.seriesName ?? '')
    const name = typeof item.seriesName === 'string' ? item.seriesName : seriesId
    const value = Array.isArray(item.value) ? item.value[1] : item.value
    rows.push({
      seriesId,
      name,
      value: typeof value === 'number' && Number.isFinite(value) ? value : null,
    })
  }
  return rows
}

/** tooltip HTML（时间行 + 每个序列一行；缺失值渲染 `—`，⛔ 不渲染 0） */
export function renderTooltip(rows: TooltipRow[], ts: number | null, unit?: string | null): string {
  const header = ts === null ? '' : `<div class="vc-chart-tip__ts">${escapeHtml(formatLocalWithOffset(ts))}</div>`
  const body = rows
    .map((row) => {
      const value = row.value === null ? NO_DATA : formatMetricValue(row.value, unit)
      return `<div class="vc-chart-tip__row"><span class="vc-chart-tip__name">${escapeHtml(row.name)}</span><span class="vc-chart-tip__val">${escapeHtml(value)}</span></div>`
    })
    .join('')
  return `${header}${body}`
}

export interface LineChartOptionInput {
  series: ChartSeriesInput[]
  unit?: string | null
  /** 服务端回传的**实际**档位（`step=auto` 时由服务端选档），显示在图表角落 */
  step?: string | null
  theme: ChartTheme
  /** 拖动选择时间窗（默认开；小尺寸图表可关） */
  showDataZoom?: boolean
  /** 实时流式更新时关掉（§6.1） */
  animation?: boolean
}

/** 一行图例/序列的公共样式 */
function toEchartsSeries(series: ChartSeriesInput): Record<string, unknown> {
  return {
    id: series.id,
    name: series.name,
    type: 'line',
    showSymbol: false,
    symbol: 'none',
    // ⛔ 断线而不是连线：缺失桶在数据里本来就不存在，补 null 会让 ECharts 跨空档直连
    connectNulls: false,
    // ⛔ 不设 sampling：前端不做二次抽稀（docs/frontend.md §6.1）
    lineStyle: { width: 1.5 },
    emphasis: { focus: 'series' },
    data: sanitizePoints(series.points),
  }
}

/**
 * 构建折线图 option（纯函数，可直接单测）。
 * ⚠️ 这里返回的是**普通对象**：ECharts 的类型定义对 `formatter` 极严，
 *    而本项目的 option 由契约决定形状，故用 `Record<string, unknown>` 交给 ECharts。
 */
export function buildLineChartOption(input: LineChartOptionInput): Record<string, unknown> {
  const { series, unit, theme } = input
  const showDataZoom = input.showDataZoom !== false
  const axisName = axisNameForUnit(unit)

  return {
    // 实时追加时不能有动画（§6.1 性能）；历史加载完成后的首帧同样不需要
    animation: input.animation === true,
    color: theme.palette,
    textStyle: { color: theme.textColor, fontSize: 11 },
    grid: {
      left: 4,
      right: 12,
      top: 30,
      bottom: showDataZoom ? 46 : 4,
      containLabel: true,
    },
    legend: {
      type: 'scroll',
      top: 0,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { color: theme.textColor, fontSize: 11 },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: { backgroundColor: theme.axisColor } },
      backgroundColor: theme.surfaceColor,
      borderColor: theme.axisColor,
      textStyle: { color: theme.textColor, fontSize: 12 },
      formatter: (params: unknown) => {
        const rows = toTooltipRows(params)
        const first = Array.isArray(params) ? (params[0] as { value?: unknown } | undefined) : undefined
        const rawTs = Array.isArray(first?.value) ? first?.value[0] : null
        const ts = typeof rawTs === 'number' && Number.isFinite(rawTs) ? rawTs : null
        return renderTooltip(rows, ts, unit)
      },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: theme.axisColor } },
      axisLabel: { color: theme.textColor, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: axisName,
      scale: true,
      nameTextStyle: { color: theme.textColor },
      axisLine: { show: false },
      axisLabel: {
        color: theme.textColor,
        formatter: (value: number) => axisTickLabel(value, unit),
      },
      splitLine: { lineStyle: { color: theme.splitColor } },
    },
    dataZoom: showDataZoom
      ? [
          { type: 'inside', filterMode: 'none' },
          { type: 'slider', height: 16, bottom: 6, borderColor: theme.axisColor, textStyle: { color: theme.textColor } },
        ]
      : undefined,
    series: series.map(toEchartsSeries),
  }
}

/**
 * 把实时增量点并入历史序列。
 *
 * 语义（docs/frontend.md §6.1「数据源分层」）：历史是权威，实时只**追加尾部**，
 * ⛔ 不参与历史重算；同一时间戳以实时值覆盖（那是同一个桶的更新）。
 * ⛔ 掉线期间的缺失**不补**：这里只做并集，不做任何插值。
 */
export function mergeSeriesPoints(
  historical: MetricPoint[],
  realtime: Array<[number, number]>,
): MetricPoint[] {
  if (realtime.length === 0) return historical
  const merged = new Map<number, MetricPoint>()
  for (const point of historical) {
    if (typeof point?.[0] === 'number' && Number.isFinite(point[0])) merged.set(point[0], point)
  }
  for (const [ts, value] of realtime) {
    if (!Number.isFinite(ts) || !Number.isFinite(value)) continue
    merged.set(ts, [ts, value])
  }
  return [...merged.values()].sort((a, b) => a[0] - b[0])
}

/** 服务端序列 → 图表输入（图例文案走 `name`，无维度时回退基名） */
export function toChartSeries(
  series: MetricSeries,
  nameOf: (item: MetricSeries) => string,
): ChartSeriesInput {
  return { id: series.metric, name: nameOf(series), points: series.points }
}

/**
 * 该基名下是否"一条线都没有"——用于整块隐藏图表（如无 GPU 的机器）。
 * ⚠️ 服务端对"指标名合法但本机没有这条序列"返回的是 `series: []`（⛔ 不是 404）。
 */
export function hasAnyPoint(series: MetricSeries[]): boolean {
  return series.some((item) => item.points.length > 0)
}
