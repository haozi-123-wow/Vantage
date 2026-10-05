/**
 * i18n key 覆盖：源码里 `t('...')` / `te('...')` 用到的**字面量** key 必须能在 zh-CN 里解析出来。
 *
 * 为什么需要它：文案 key 写错一个字符不会报错，只会在界面上显示成裸 key（或静默回退）；
 * 页面一多，靠肉眼对不出来。
 *
 * ⚠️ 只检查**字面量** key：模板串拼出来的（如 ``t(`status.${x}`)``、``t(`chart.range.${k}`)``）
 *    依赖运行时取值，本测试覆盖不到 —— 那类 key 的完整性靠契约测试与人工联调。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import zhCN from '@/locales/zh-CN'

const SRC_DIR = join(process.cwd(), 'src')
/**
 * ⚠️ 必须锚定"独立的 t / te 标识符"：写成 `\bt?e?\(` 会让**任何函数调用**都命中
 *    （两个字母都可选 → `emit('select')` 也会被当成 i18n key）。
 */
const KEY_PATTERN = /(?<![A-Za-z0-9_$.])(?:te|t)\(\s*'([A-Za-z][A-Za-z0-9_.-]*)'/g

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full))
      continue
    }
    if (entry.endsWith('.vue') || entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** 收集所有 `t('a.b')` / `te('a.b')` 的字面量 key */
function collectKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>()
  for (const file of listSourceFiles(SRC_DIR)) {
    // 文案文件本身不算"使用方"（否则每个 key 都会自己证明自己存在）
    if (file.includes(`${join('src', 'locales')}`)) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(KEY_PATTERN)) {
      const key = match[1]
      if (!key) continue
      const owners = keys.get(key) ?? []
      owners.push(file.slice(SRC_DIR.length + 1))
      keys.set(key, owners)
    }
  }
  return keys
}

function resolve(messages: Record<string, unknown>, key: string): unknown {
  let node: unknown = messages
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

describe('i18n key 覆盖（zh-CN）', () => {
  const keys = collectKeys()

  it('至少扫到了足够多的 key（防止正则失效后测试变成空转）', () => {
    expect(keys.size).toBeGreaterThan(80)
  })

  it('每个字面量 key 都能在 zh-CN 里解析到文案', () => {
    const missing: string[] = []
    for (const [key, owners] of keys) {
      const value = resolve(zhCN as unknown as Record<string, unknown>, key)
      if (typeof value !== 'string') missing.push(`${key}（用于 ${owners.join(', ')}）`)
    }
    expect(missing).toEqual([])
  })
})
