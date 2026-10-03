/**
 * 指标序列命名的前端实现：`基名` 或 `基名{维度=值,维度=值}`（docs/database.md §5.7.2）。
 *
 * ⛔ 这是命名规范的**同源实现**。规范要求「两端各提供 buildMetric/parseMetric，必须同源实现 +
 *    共用测试向量」—— 共享向量在仓库根目录 `contracts/metric-names.json`，
 *    `web/tests/metrics.spec.ts` 直接逐字节消费它。
 *    拼法不一致的后果：中心 400，或者更糟 —— 同一挂载点在库里变成两条曲线而且不报错。
 *
 * ⛔ 组件里不要手写字符串拼接（docs/frontend.md §6.1 / F10）。
 */
import type { MetricLabels } from '@/types/domain'

/** 全名长度上限（超限由 schema 校验拒绝） */
export const METRIC_MAX_LENGTH = 200

/** 基名：小写字母开头，点分段，各段小写字母/数字/下划线 */
const BASE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/
/** 维度键：只允许小写字母、数字、下划线 */
const LABEL_KEY_RE = /^[a-z0-9_]+$/
/** 保留维度键：`base` 是 core 的便利字段，不允许出现在序列名里 */
const RESERVED_LABEL_KEYS = new Set(['base'])
/** 免转义、原样保留的字符（其余一律百分号编码，大写十六进制） */
const UNRESERVED_RE = /^[A-Za-z0-9_/:.\-@+]$/
const HEX2_RE = /^[0-9A-Fa-f]{2}$/
const WHITESPACE_RE = /\s/

export interface ParsedMetric {
  base: string
  labels: MetricLabels
}

/** 维度值编码：不在保留集里的字符一律百分号编码（`%` 也必须编码，否则编码不是单射） */
export function encodeLabelValue(value: string): string {
  let out = ''
  // for..of 按码点遍历：代理对（emoji / 生僻字）不会被拆成两半
  for (const ch of value) {
    out += UNRESERVED_RE.test(ch) ? ch : encodeURIComponent(ch)
  }
  return out
}

/** 维度值反解：非法转义（如 `%zz`、截断的 `%2`）必须报错，不能静默放过 */
export function decodeLabelValue(encoded: string): string {
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] !== '%') continue
    const hex = encoded.slice(i + 1, i + 3)
    if (!HEX2_RE.test(hex)) {
      throw new Error(`指标名里的百分号转义非法：%${hex}`)
    }
    i += 2
  }
  try {
    return decodeURIComponent(encoded)
  } catch {
    throw new Error(`指标名里的百分号转义无法解码：${encoded}`)
  }
}

export function assertValidBase(base: string): void {
  if (typeof base !== 'string' || base.length === 0) {
    throw new Error('指标基名不能为空')
  }
  if (base.length > METRIC_MAX_LENGTH) {
    throw new Error(`指标基名超过 ${METRIC_MAX_LENGTH} 字符`)
  }
  if (!BASE_RE.test(base)) {
    throw new Error(`指标基名不合法（必须小写、点分段、不含花括号/空白）：${base}`)
  }
}

function assertValidLabelKey(key: string): void {
  if (!LABEL_KEY_RE.test(key)) {
    throw new Error(`指标维度键不合法（只允许小写字母、数字、下划线）：${key}`)
  }
  if (RESERVED_LABEL_KEYS.has(key)) {
    throw new Error(`指标维度键使用了保留名：${key}`)
  }
}

/** 拼装序列全名。维度按**键名字母序**升序拼接，保证同一序列只有一种写法。 */
export function buildMetric(base: string, labels: MetricLabels = {}): string {
  assertValidBase(base)

  const keys = Object.keys(labels).sort()
  if (keys.length === 0) {
    // 无维度**不带**花括号（`cpu.usage`，而不是 `cpu.usage{}`）
    return base
  }

  const parts = keys.map((key) => {
    assertValidLabelKey(key)
    const value = labels[key]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`指标维度 ${key} 的值必须是非空字符串`)
    }
    return `${key}=${encodeLabelValue(value)}`
  })

  const full = `${base}{${parts.join(',')}}`
  if (full.length > METRIC_MAX_LENGTH) {
    throw new Error(`指标全名超过 ${METRIC_MAX_LENGTH} 字符：${full.length}`)
  }
  return full
}

/** 反解序列全名。任何不合规写法都抛错（⛔ 不静默返回半个结果）。 */
export function parseMetric(full: string): ParsedMetric {
  if (typeof full !== 'string' || full.length === 0) {
    throw new Error('指标全名不能为空')
  }
  if (full.length > METRIC_MAX_LENGTH) {
    throw new Error(`指标全名超过 ${METRIC_MAX_LENGTH} 字符：${full.length}`)
  }
  if (WHITESPACE_RE.test(full)) {
    throw new Error('指标全名里不允许出现空白字符（必须百分号编码）')
  }

  const braceAt = full.indexOf('{')
  if (braceAt === -1) {
    assertValidBase(full)
    return { base: full, labels: {} }
  }

  const base = full.slice(0, braceAt)
  assertValidBase(base)

  if (!full.endsWith('}')) {
    throw new Error(`指标全名的花括号不闭合：${full}`)
  }
  const inner = full.slice(braceAt + 1, -1)
  if (inner.length === 0) {
    throw new Error('无维度的序列名不带花括号')
  }

  const labels: MetricLabels = {}
  for (const pair of inner.split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) {
      throw new Error(`指标维度写法非法（应为 键=值）：${pair}`)
    }
    const key = pair.slice(0, eq)
    assertValidLabelKey(key)

    const rawValue = pair.slice(eq + 1)
    // `{` `}` 属于必须转义的字符，裸出现即非法（否则花括号结构可被伪造）
    if (rawValue.includes('{') || rawValue.includes('}')) {
      throw new Error(`指标维度值里的花括号必须百分号编码：${key}`)
    }
    const value = decodeLabelValue(rawValue)
    if (value.length === 0) {
      throw new Error(`指标维度 ${key} 的值不能为空`)
    }
    if (Object.prototype.hasOwnProperty.call(labels, key)) {
      throw new Error(`指标维度键重复：${key}`)
    }
    labels[key] = value
  }

  return { base, labels }
}

/** 图例文案：把维度值拼成人类可读的一段（如 `/data`、`eth0`），走 labels 而不是全名 */
export function metricLabelText(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => labels[key])
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
}

/** 取基名；全名非法时抛错（与 parseMetric 同源） */
export function baseOfMetric(full: string): string {
  return parseMetric(full).base
}
