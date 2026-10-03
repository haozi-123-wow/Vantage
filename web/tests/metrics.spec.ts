/**
 * 指标序列命名：直接消费仓库共享测试向量 `contracts/metric-names.json`。
 *
 * ✅ docs/database.md §5.7.2 要求「两端各提供 buildMetric/parseMetric，必须同源实现 + 共用测试向量」，
 *    所以这里**不允许**自己另写一套期望值 —— 向量改了，前端必须跟着过或跟着改实现。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { buildMetric, parseMetric } from '@/utils/metrics'

interface RepeatForm {
  repeat: string
  count: number
}

interface VectorCase {
  name: string
  base: string
  labels: Record<string, string | RepeatForm>
  full?: string
  expectFullLength?: number
}

interface VectorFile {
  cases: VectorCase[]
  invalid: VectorCase[]
}

const vectorUrl = new URL('../../contracts/metric-names.json', import.meta.url)
const vectors = JSON.parse(readFileSync(vectorUrl, 'utf8')) as VectorFile

/** 向量文件用 `{repeat, count}` 精确构造长度边界，避免手写长串数错 */
function expandLabels(labels: VectorCase['labels']): Record<string, string> {
  const expanded: Record<string, string> = {}
  for (const [key, value] of Object.entries(labels)) {
    expanded[key] = typeof value === 'string' ? value : value.repeat.repeat(value.count)
  }
  return expanded
}

describe('buildMetric（对照 contracts/metric-names.json）', () => {
  it('向量文件读得到且非空', () => {
    expect(vectors.cases.length).toBeGreaterThan(0)
    expect(vectors.invalid.length).toBeGreaterThan(0)
  })

  for (const testCase of vectors.cases) {
    it(`${testCase.name}：拼装逐字节一致`, () => {
      const labels = expandLabels(testCase.labels)
      const full = buildMetric(testCase.base, labels)

      if (testCase.full !== undefined) expect(full).toBe(testCase.full)
      if (testCase.expectFullLength !== undefined) expect(full.length).toBe(testCase.expectFullLength)
    })
  }

  it('维度按键名字母序拼接，与书写顺序无关', () => {
    const a = buildMetric('disk.used_pct', { mount: '/data', device: 'sda1' })
    const b = buildMetric('disk.used_pct', { device: 'sda1', mount: '/data' })
    expect(a).toBe(b)
    expect(a).toBe('disk.used_pct{device=sda1,mount=/data}')
  })

  it('百分号必须一起转义（否则编码不是单射）', () => {
    expect(buildMetric('disk.used_pct', { mount: '%20' })).toBe('disk.used_pct{mount=%2520}')
    expect(buildMetric('disk.used_pct', { mount: ' ' })).toBe('disk.used_pct{mount=%20}')
    expect(buildMetric('disk.used_pct', { mount: '%20' })).not.toBe(
      buildMetric('disk.used_pct', { mount: ' ' }),
    )
  })
})

describe('buildMetric 拒绝非法输入', () => {
  for (const testCase of vectors.invalid) {
    it(`${testCase.name}：必须抛错`, () => {
      expect(() => buildMetric(testCase.base, expandLabels(testCase.labels))).toThrow()
    })
  }
})

describe('parseMetric（与 buildMetric 同源往返）', () => {
  for (const testCase of vectors.cases) {
    it(`${testCase.name}：反解回原 base/labels`, () => {
      const labels = expandLabels(testCase.labels)
      const parsed = parseMetric(buildMetric(testCase.base, labels))
      expect(parsed.base).toBe(testCase.base)
      expect(parsed.labels).toEqual(labels)
    })
  }

  it('拒绝非法写法', () => {
    expect(() => parseMetric('')).toThrow()
    expect(() => parseMetric('CPU.usage')).toThrow()
    expect(() => parseMetric('disk.used_pct{mount=/data')).toThrow() // 花括号不闭合
    expect(() => parseMetric('disk.used_pct{}')).toThrow() // 无维度不带花括号
    expect(() => parseMetric('disk.used_pct{mount=%zz}')).toThrow() // 非法转义
    expect(() => parseMetric('disk.used_pct{mount=a,b}')).toThrow() // 逗号必须转义
    expect(() => parseMetric('disk.used_pct{mount=/{x}}')).toThrow() // 花括号必须转义
    expect(() => parseMetric('disk.used pct')).toThrow() // 空白必须转义
  })
})
