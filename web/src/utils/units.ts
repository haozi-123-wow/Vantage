/**
 * 单位格式化（docs/frontend.md §6.1「单位格式统一走 utils/units.js」）。
 *
 * 缺口一律渲染为占位符 `—`，⛔ 不要渲染成 0：采集缺失被画成 0 是监控面板最危险的一类谎言
 *（docs/api.md §4.3：缺失桶不补 0）。
 */

/** 缺口占位符 */
export const NO_DATA = '—'

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const
const BYTE_STEP = 1024

function isMissing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value)
}

/** 去掉小数尾部的 0（`1.0` → `1`，`12.30` → `12.3`） */
function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/** 字节：自动 B/KiB/MiB/GiB/TiB/PiB，1 KiB = 1024 B */
export function formatBytes(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return NO_DATA
  const sign = value < 0 ? '-' : ''
  let n = Math.abs(value)
  let unitIndex = 0
  while (n >= BYTE_STEP && unitIndex < BYTE_UNITS.length - 1) {
    n /= BYTE_STEP
    unitIndex += 1
  }
  const text = unitIndex === 0 ? String(Math.round(n)) : trimZeros(n.toFixed(digits))
  return `${sign}${text} ${BYTE_UNITS[unitIndex]}`
}

/** 速率：字节/秒 */
export function formatBps(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return NO_DATA
  return `${formatBytes(value, digits)}/s`
}

/** 百分比 */
export function formatPct(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return NO_DATA
  return `${trimZeros(value.toFixed(digits))}%`
}

/** 温度 */
export function formatTemp(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return NO_DATA
  return `${trimZeros(value.toFixed(digits))} ℃`
}

/** 功率 */
export function formatWatts(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return NO_DATA
  return `${trimZeros(value.toFixed(digits))} W`
}

/** 频率类（次/秒，如进程创建率） */
export function formatRate(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return NO_DATA
  return `${trimZeros(value.toFixed(digits))} 次/s`
}

/** 毫秒 */
export function formatMs(value: number | null | undefined, digits = 0): string {
  if (isMissing(value)) return NO_DATA
  return `${trimZeros(value.toFixed(digits))} ms`
}

/** 时长：由秒数渲染为「3 天 4 小时」这类粗粒度文案（uptime 用） */
export function formatDuration(seconds: number | null | undefined): string {
  if (isMissing(seconds)) return NO_DATA
  let rest = Math.max(0, Math.floor(seconds))
  const days = Math.floor(rest / 86_400)
  rest -= days * 86_400
  const hours = Math.floor(rest / 3_600)
  rest -= hours * 3_600
  const minutes = Math.floor(rest / 60)

  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分`
  return `${rest} 秒`
}

/**
 * 按接口下发的 `unit` 字段分发到对应格式化函数（docs/api.md §4.3 的 `series.unit`）。
 * 未知单位原样附在后面，⛔ 不静默丢弃单位。
 */
export function formatMetricValue(value: number | null | undefined, unit?: string | null): string {
  if (isMissing(value)) return NO_DATA
  switch (unit) {
    case '%':
      return formatPct(value)
    case 'B':
    case 'bytes':
      return formatBytes(value)
    case 'Bps':
    case 'bytes/s':
      return formatBps(value)
    case '℃':
    case 'C':
      return formatTemp(value)
    case 'W':
      return formatWatts(value)
    case '次/s':
    case 'count/s':
      return formatRate(value)
    case 'ms':
      return formatMs(value)
    default:
      return unit ? `${trimZeros(value.toFixed(1))} ${unit}` : trimZeros(value.toFixed(1))
  }
}
