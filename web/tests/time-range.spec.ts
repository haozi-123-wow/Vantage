/**
 * 时间范围预设（docs/frontend.md §6.2 / F9）：
 * - 默认 6h；最长 30 天（服务端硬上限）；
 * - 前端**只传 from/to**，⛔ 不维护"哪个预设对应哪个 step"的映射表（服务端 `step=auto` 选档并回传）；
 * - `from`/`to` 必须是**带时区**的 RFC3339（不带时区的裸串会被服务端 400 拒掉）。
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TIME_RANGE,
  TIME_RANGE_PRESETS,
  isTimeRangeKey,
  resolveTimeRange,
} from '@/utils/time'

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)

describe('时间范围预设', () => {
  it('默认 6 小时（✅ F9）', () => {
    expect(DEFAULT_TIME_RANGE).toBe('6h')
  })

  it('五个预设，最长 30 天', () => {
    expect(TIME_RANGE_PRESETS.map((preset) => preset.key)).toEqual(['1h', '6h', '24h', '7d', '30d'])
    expect(Math.max(...TIME_RANGE_PRESETS.map((preset) => preset.spanSeconds))).toBe(2_592_000)
  })

  it('resolveTimeRange 产出带时区的 RFC3339 区间', () => {
    const range = resolveTimeRange('6h', NOW)
    expect(range.from).toBe('2026-10-05T06:00:00.000Z')
    expect(range.to).toBe('2026-10-05T12:00:00.000Z')
    expect(range.spanSeconds).toBe(21_600)
    // 必须能解析回同一个时刻（带 Z 的串）
    expect(new Date(range.from).getTime()).toBe(NOW - 21_600_000)
  })

  it('未知 key 回退默认档（⛔ 不抛错，也不静默给一个空区间）', () => {
    const range = resolveTimeRange('nope' as never, NOW)
    expect(range.key).toBe('6h')
  })

  it('isTimeRangeKey 只认白名单（URL 里的 ?range= 用它挡脏值）', () => {
    expect(isTimeRangeKey('30d')).toBe(true)
    expect(isTimeRangeKey('6h')).toBe(true)
    expect(isTimeRangeKey('12h')).toBe(false)
    expect(isTimeRangeKey(['6h'])).toBe(false)
    expect(isTimeRangeKey(undefined)).toBe(false)
  })
})
