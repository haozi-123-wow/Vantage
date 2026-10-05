/**
 * 图表契约（docs/frontend.md §6.1）：
 * - 序列标识必须是**指标全名**（`series.id`），⛔ 不是基名；
 * - 缺失桶**不补 0、不补 null**（数组里没有那个点，靠 `connectNulls: false` 断线）；
 * - ⛔ 不做二次抽稀（不得出现 `sampling`）；
 * - 实时只**追加尾部**，同一时间戳以实时值覆盖。
 */
import { describe, expect, it } from 'vitest'

import {
  axisTickLabel,
  buildLineChartOption,
  mergeSeriesPoints,
  renderTooltip,
  toTooltipRows,
  type ChartTheme,
} from '@/utils/chart'

const THEME: ChartTheme = {
  textColor: '#333',
  axisColor: '#ccc',
  splitColor: '#eee',
  surfaceColor: '#fff',
  palette: ['#111', '#222'],
}

function option(series: Array<{ id: string; name: string; points: Array<[number, number]> }>) {
  return buildLineChartOption({ series, unit: '%', step: '30s', theme: THEME })
}

describe('buildLineChartOption', () => {
  it('series.id 用指标全名，name 用图例文案', () => {
    const result = option([
      { id: 'disk.used_pct{mount=/data}', name: '/data', points: [[1_000, 12.5]] },
    ])
    const series = result.series as Array<Record<string, unknown>>
    expect(series).toHaveLength(1)
    expect(series[0]?.id).toBe('disk.used_pct{mount=/data}')
    expect(series[0]?.name).toBe('/data')
    expect(series[0]?.type).toBe('line')
  })

  it('缺失桶不补 0：没有的点就是不出现', () => {
    const result = option([{ id: 'cpu.usage', name: 'cpu.usage', points: [[1_000, 10], [3_000, 30]] }])
    const series = result.series as Array<Record<string, unknown>>
    expect(series[0]?.data).toEqual([
      [1_000, 10],
      [3_000, 30],
    ])
  })

  it('非有限值（null/NaN）被丢掉，而不是当成 0', () => {
    const result = option([
      {
        id: 'cpu.usage',
        name: 'cpu.usage',
        // 第二个点模拟"服务端给了 null"（契约上不该出现，但⛔ 绝不能补 0）
        points: [[1_000, 10], [2_000, Number.NaN]] as Array<[number, number]>,
      },
    ])
    const series = result.series as Array<Record<string, unknown>>
    expect(series[0]?.data).toEqual([[1_000, 10]])
  })

  it('断线不连线，且⛔ 不做二次抽稀', () => {
    const result = option([{ id: 'cpu.usage', name: 'cpu.usage', points: [[1_000, 10]] }])
    const series = result.series as Array<Record<string, unknown>>
    expect(series[0]?.connectNulls).toBe(false)
    expect(series[0]?.sampling).toBeUndefined()
  })

  it('默认关闭动画（实时追加时不能每帧重排）', () => {
    expect(option([]).animation).toBe(false)
  })

  it('x 轴是时间轴，y 轴带上单位名', () => {
    const result = option([])
    expect((result.xAxis as Record<string, unknown>).type).toBe('time')
    expect((result.yAxis as Record<string, unknown>).name).toBe('%')
  })
})

describe('mergeSeriesPoints：实时只追加尾部', () => {
  it('追加比历史更新的点，并保持时间升序', () => {
    const merged = mergeSeriesPoints(
      [
        [1_000, 10],
        [2_000, 20],
      ],
      [
        [3_000, 30],
        [4_000, 40],
      ],
    )
    expect(merged).toEqual([
      [1_000, 10],
      [2_000, 20],
      [3_000, 30],
      [4_000, 40],
    ])
  })

  it('同一时间戳以实时值覆盖（那是同一个桶的更新）', () => {
    const merged = mergeSeriesPoints([[1_000, 10]], [[1_000, 99]])
    expect(merged).toEqual([[1_000, 99]])
  })

  it('⛔ 不插值、不补洞：中间缺的桶依旧缺', () => {
    const merged = mergeSeriesPoints([[1_000, 10]], [[5_000, 50]])
    expect(merged).toEqual([
      [1_000, 10],
      [5_000, 50],
    ])
  })

  it('实时点为 NaN 时忽略，不污染历史', () => {
    const merged = mergeSeriesPoints([[1_000, 10]], [[2_000, Number.NaN]])
    expect(merged).toEqual([[1_000, 10]])
  })
})

describe('坐标轴与 tooltip', () => {
  it('百分比轴只写数字（轴名已给出 %）', () => {
    expect(axisTickLabel(12.34, '%')).toBe('12.3')
  })

  it('字节轴自动进位', () => {
    expect(axisTickLabel(1024, 'bytes')).toBe('1 KiB')
    expect(axisTickLabel(1024, 'Bps')).toBe('1 KiB/s')
  })

  it('tooltip 行里缺失值渲染 —，⛔ 不渲染 0', () => {
    const rows = toTooltipRows([{ seriesId: 'cpu.usage', seriesName: 'CPU', value: [1_000, null] }])
    expect(rows).toEqual([{ seriesId: 'cpu.usage', name: 'CPU', value: null }])
    const html = renderTooltip(rows, 1_000, '%')
    expect(html).toContain('—')
    expect(html).not.toContain('0%')
  })

  it('tooltip 里的序列名必须转义（名字来自服务端）', () => {
    const html = renderTooltip(
      [{ seriesId: 'x', name: '<img src=x onerror=alert(1)>', value: 1 }],
      1_000,
      '%',
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
