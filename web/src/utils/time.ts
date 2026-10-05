/**
 * 时间展示（✅ docs/frontend.md §8.1 / F4）。
 *
 * 硬约束：**时间权威在服务端**（一律 UTC）。前端只做时区转换与展示，
 * 且**必须标注偏移**（如 `2025-09-25 20:00 (UTC+8)`）—— ⛔ 不自行纠正时间。
 */
import { NO_DATA } from '@/utils/units'

type TimeInput = string | number | Date | null | undefined

/** 服务端时间 → Date；无法解析返回 null（供调用方区分「无数据」与「时间零点」） */
export function toDate(input: TimeInput): Date | null {
  if (input === null || input === undefined || input === '') return null
  const date = input instanceof Date ? input : new Date(input)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 时区偏移标签：`UTC` / `UTC+8` / `UTC+5:30` / `UTC-4` */
export function formatUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  if (offsetMinutes === 0) return 'UTC'
  const sign = offsetMinutes > 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  return `UTC${sign}${hours}${minutes > 0 ? `:${String(minutes).padStart(2, '0')}` : ''}`
}

interface FormatOptions {
  /** 是否带秒（详情页常用） */
  seconds?: boolean
}

/** 本地时区时间：`2025-09-25 20:00`（用 sv-SE 拿到 ISO 风格的稳定顺序，避免各浏览器差异） */
export function formatLocalDateTime(input: TimeInput, options: FormatOptions = {}): string {
  const date = toDate(input)
  if (!date) return NO_DATA
  const parts = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).format(date)
  return parts
}

/** ✅ F4：本地时间 + 偏移标注，如 `2025-09-25 20:00 (UTC+8)` */
export function formatLocalWithOffset(input: TimeInput, options: FormatOptions = {}): string {
  const date = toDate(input)
  if (!date) return NO_DATA
  return `${formatLocalDateTime(date, options)} (${formatUtcOffset(date)})`
}

/**
 * 时间范围预设（docs/frontend.md §6.2 / F9）。
 *
 * ⛔ 前端**不维护**「哪个预设对应哪个档位」的映射表：`TimeRangePicker` 只传 `from`/`to`，
 *    服务端按 `step=auto` 选档（"选最细的一档使点数 ≤ 2000"）并在响应里回传**实际** step。
 *    ⚠️ 最长 30 天是服务端的硬上限（超出 400 `range_too_large`，docs/api.md §4.3）。
 */
export type TimeRangeKey = '1h' | '6h' | '24h' | '7d' | '30d'

export interface TimeRangePreset {
  key: TimeRangeKey
  spanSeconds: number
}

export const TIME_RANGE_PRESETS: readonly TimeRangePreset[] = [
  { key: '1h', spanSeconds: 3_600 },
  { key: '6h', spanSeconds: 21_600 },
  { key: '24h', spanSeconds: 86_400 },
  { key: '7d', spanSeconds: 604_800 },
  { key: '30d', spanSeconds: 2_592_000 },
]

/** ✅ F9：默认 6h */
export const DEFAULT_TIME_RANGE: TimeRangeKey = '6h'

export function isTimeRangeKey(value: unknown): value is TimeRangeKey {
  return TIME_RANGE_PRESETS.some((preset) => preset.key === value)
}

export interface ResolvedTimeRange {
  key: TimeRangeKey
  /** RFC3339（带时区）——⛔ 服务端不接受不带时区的裸时间串（会 400） */
  from: string
  to: string
  spanSeconds: number
}

/** 预设 → 具体区间；`now` 可注入，便于单测 */
export function resolveTimeRange(key: TimeRangeKey, now: number = Date.now()): ResolvedTimeRange {
  const preset = TIME_RANGE_PRESETS.find((item) => item.key === key) ?? TIME_RANGE_PRESETS[1]
  const spanMs = preset.spanSeconds * 1000
  return {
    key: preset.key,
    from: new Date(now - spanMs).toISOString(),
    to: new Date(now).toISOString(),
    spanSeconds: preset.spanSeconds,
  }
}

/** 相对时间（列表页用；绝对时间走 `title` 提示，docs/frontend.md §4.3） */
export function formatRelative(input: TimeInput, now: number = Date.now()): string {
  const date = toDate(input)
  if (!date) return NO_DATA
  const diffMs = now - date.getTime()
  if (diffMs < 0) return '刚刚' // 服务端与浏览器有轻微时钟差时不显示「-3 秒前」

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return formatLocalDateTime(date)
}
