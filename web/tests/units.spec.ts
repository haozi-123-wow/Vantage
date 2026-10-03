/** 单位换算（docs/frontend.md §6.1；缺失一律渲染为占位符，⛔ 不渲染成 0） */
import { describe, expect, it } from 'vitest'

import {
  formatBps,
  formatBytes,
  formatDuration,
  formatMetricValue,
  formatMs,
  formatPct,
  formatTemp,
  formatWatts,
  NO_DATA,
} from '@/utils/units'

describe('formatBytes', () => {
  it('按 1024 进位并选择单位', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KiB')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(1024 * 1024)).toBe('1 MiB')
    expect(formatBytes(1024 ** 4)).toBe('1 TiB')
  })

  it('保留符号', () => {
    expect(formatBytes(-1536)).toBe('-1.5 KiB')
  })

  it('缺失值渲染为占位符', () => {
    expect(formatBytes(null)).toBe(NO_DATA)
    expect(formatBytes(undefined)).toBe(NO_DATA)
    expect(formatBytes(Number.NaN)).toBe(NO_DATA)
  })
})

describe('其余单位', () => {
  it('速率带 /s 后缀', () => {
    expect(formatBps(1536)).toBe('1.5 KiB/s')
    expect(formatBps(null)).toBe(NO_DATA)
  })

  it('百分比 / 温度 / 功率 / 毫秒', () => {
    expect(formatPct(12.34)).toBe('12.3%')
    expect(formatPct(0)).toBe('0%')
    expect(formatTemp(42.5)).toBe('42.5 ℃')
    expect(formatWatts(120)).toBe('120 W')
    expect(formatMs(37.4, 0)).toBe('37 ms')
  })
})

describe('formatDuration', () => {
  it('按粗粒度渲染', () => {
    expect(formatDuration(30)).toBe('30 秒')
    expect(formatDuration(90)).toBe('1 分')
    expect(formatDuration(3600)).toBe('1 小时 0 分')
    expect(formatDuration(86_400 + 3_600)).toBe('1 天 1 小时')
  })
})

describe('formatMetricValue', () => {
  it('按接口下发的 unit 分发', () => {
    expect(formatMetricValue(12.3, '%')).toBe('12.3%')
    expect(formatMetricValue(2048, 'bytes')).toBe('2 KiB')
    expect(formatMetricValue(2048, 'bytes/s')).toBe('2 KiB/s')
    expect(formatMetricValue(null, '%')).toBe(NO_DATA)
  })

  it('未知单位原样附上，⛔ 不静默丢单位', () => {
    expect(formatMetricValue(3.25, 'rpm')).toBe('3.3 rpm')
  })
})
