/**
 * ECharts 按需注册（docs/frontend.md §2 依赖边界：⛔ **禁止整包 import**）。
 *
 * 这里只注册本面板真正用到的模块（折线图 + 网格/图例/tooltip/dataZoom + Canvas 渲染器）。
 * 图表只在含曲线的页面（主机详情）被动态 import，公开页与列表页不会为它付首屏体积（§10）。
 *
 * ⛔ 不要在组件里 `import * as echarts from 'echarts'`：那会把整个图表库打进包里。
 */
import { LineChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

import { DEFAULT_CHART_PALETTE } from '@/utils/chart'
import type { ChartTheme } from '@/utils/chart'

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
])

export { echarts }
export type { EChartsType } from 'echarts/core'

/** 从 `:root` 上读一个 CSS 变量（明/暗两套值由 element-overrides.scss 提供） */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * 图表配色（✅ docs/frontend.md §6.1「主题」：明/暗两套，切换时 dispose 重建）。
 *
 * 实现口径：**不进 ECharts 的寄存器**（那是全局状态，切换主题时容易残留），
 * 而是每次构建 option 时从 CSS 变量取值 → 主题一变，option 自然跟着变。
 */
export function readChartTheme(): ChartTheme {
  return {
    textColor: cssVar('--vc-text-2', '#5c6570'),
    axisColor: cssVar('--vc-border', '#dfe3e8'),
    splitColor: cssVar('--vc-border', '#dfe3e8'),
    surfaceColor: cssVar('--vc-raised', '#ffffff'),
    // 语义色优先：在线绿 / warn 橙 / critical 红 / Flapping 紫，再补几个中性色
    palette: [
      cssVar('--vc-accent', DEFAULT_CHART_PALETTE[0]),
      cssVar('--vc-online', DEFAULT_CHART_PALETTE[1]),
      cssVar('--vc-warn', DEFAULT_CHART_PALETTE[2]),
      cssVar('--vc-flapping', DEFAULT_CHART_PALETTE[3]),
      cssVar('--vc-critical', DEFAULT_CHART_PALETTE[4]),
      ...DEFAULT_CHART_PALETTE.slice(5),
    ],
  }
}
