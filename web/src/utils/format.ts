/**
 * 数值格式化（docs/frontend.md §8.1：统一走 Intl，⛔ 不手写千分位逻辑）。
 */
import { NO_DATA } from '@/utils/units'

type NumInput = number | null | undefined

function isMissing(value: NumInput): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value)
}

/** 通用数值：默认 zh-CN 分组，最多 2 位小数 */
export function formatNumber(
  value: NumInput,
  options: Intl.NumberFormatOptions = { maximumFractionDigits: 2 },
  locale = 'zh-CN',
): string {
  if (isMissing(value)) return NO_DATA
  return new Intl.NumberFormat(locale, options).format(value)
}

/** 整数（千分位；用于计数类字段） */
export function formatInt(value: NumInput, locale = 'zh-CN'): string {
  return formatNumber(value, { maximumFractionDigits: 0 }, locale)
}

/** 固定小数位 */
export function formatFixed(value: NumInput, digits = 1, locale = 'zh-CN'): string {
  return formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits }, locale)
}
