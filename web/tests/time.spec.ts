/** 时间展示（✅ F4：本地时区展示且必须标注偏移；⛔ 前端不自行纠正时间） */
import { describe, expect, it } from 'vitest'

import { formatLocalDateTime, formatLocalWithOffset, formatRelative, formatUtcOffset, toDate } from '@/utils/time'
import { NO_DATA } from '@/utils/units'

const NOW = Date.UTC(2025, 8, 25, 12, 0, 0) // 2025-09-25T12:00:00Z

describe('toDate', () => {
  it('接受 RFC3339 / 毫秒 / Date，非法输入返回 null', () => {
    expect(toDate('2025-09-25T12:00:00.000Z')?.getTime()).toBe(NOW)
    expect(toDate(NOW)?.getTime()).toBe(NOW)
    expect(toDate(new Date(NOW))?.getTime()).toBe(NOW)
    expect(toDate('not-a-date')).toBeNull()
    expect(toDate(null)).toBeNull()
    expect(toDate('')).toBeNull()
  })
})

describe('formatUtcOffset', () => {
  it('偏移标签带符号，整点不带分', () => {
    const label = formatUtcOffset(new Date(NOW))
    expect(label === 'UTC' || /^UTC[+-]\d{1,2}(:\d{2})?$/.test(label)).toBe(true)
  })
})

describe('formatLocalWithOffset', () => {
  it('渲染为「本地时间 (UTC±N)」', () => {
    const text = formatLocalWithOffset(NOW)
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC/)
    expect(text.endsWith(')')).toBe(true)
  })

  it('带秒时多一段秒', () => {
    expect(formatLocalWithOffset(NOW, { seconds: true })).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC/)
  })

  it('缺失值渲染为占位符', () => {
    expect(formatLocalWithOffset(null)).toBe(NO_DATA)
    expect(formatLocalDateTime(undefined)).toBe(NO_DATA)
  })
})

describe('formatRelative', () => {
  it('按跨度选择粒度', () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe('刚刚')
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前')
    expect(formatRelative(NOW - 2 * 86_400_000, NOW)).toBe('2 天前')
  })

  it('时间在未来（服务端与浏览器有轻微时钟差）时不显示负数', () => {
    expect(formatRelative(NOW + 5_000, NOW)).toBe('刚刚')
  })

  it('超过 30 天回退为绝对时间', () => {
    expect(formatRelative(NOW - 40 * 86_400_000, NOW)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})
