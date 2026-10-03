/**
 * i18n 装配（✅ 决策 #26：中文优先，代码预留 i18n 结构，文案抽 key）。
 *
 * ⛔ 至少把**错误码映射表**抽成 i18n（docs/frontend.md §8.1）—— 组件里不要各写一套提示文案。
 */
import { createI18n } from 'vue-i18n'

import enUS from '@/locales/en-US'
import zhCN from '@/locales/zh-CN'

export const DEFAULT_LOCALE = 'zh-CN'

export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
})

/**
 * 后端错误码 → 中文文案（docs/api.md §1.3 的状态码/code 表）。
 * 未知 code 回退到服务端给的 message，再回退到通用错误文案。
 */
export function errorText(code: string | undefined, fallbackMessage?: string): string {
  if (code) {
    const key = `error.${code}`
    if (i18n.global.te(key)) return i18n.global.t(key)
  }
  return fallbackMessage ?? i18n.global.t('error.internal_error')
}
