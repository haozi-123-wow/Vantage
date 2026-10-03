/**
 * 主题应用边界。
 *
 * 约定（本次初始化就立住，避免组件里到处 `classList.toggle('dark')`）：
 * - ⛔ 组件不得自己切 `html.dark`，一律通过本 composable / ui store；
 * - `auto` 跟随系统 `prefers-color-scheme`，并由 index.html 的首屏内联脚本预先应用，避免白闪；
 * - 同时设置 `color-scheme`，让滚动条与原生控件跟随主题。
 *
 * 视觉层怎么落地（Element Plus 变量、色值）不在本文件，见 styles/element-overrides.scss。
 */
import { computed, onScopeDispose, ref, watch } from 'vue'

import { useUiStore } from '@/store/ui'
import type { ThemePreference } from '@/store/ui'

type ResolvedTheme = 'light' | 'dark'

function readPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyTheme(value: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', value === 'dark')
  document.documentElement.style.colorScheme = value
}

export function useTheme() {
  const ui = useUiStore()
  const prefersDark = ref(readPrefersDark())

  const media =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null

  const onMediaChange = (event: MediaQueryListEvent): void => {
    prefersDark.value = event.matches
  }
  media?.addEventListener('change', onMediaChange)
  onScopeDispose(() => media?.removeEventListener('change', onMediaChange))

  const resolved = computed<ResolvedTheme>(() => {
    if (ui.theme === 'auto') return prefersDark.value ? 'dark' : 'light'
    return ui.theme
  })

  watch(resolved, applyTheme, { immediate: true })

  function setTheme(next: ThemePreference): void {
    ui.setTheme(next)
  }

  function toggle(): void {
    ui.setTheme(resolved.value === 'dark' ? 'light' : 'dark')
  }

  return {
    /** 用户偏好（含 `auto`） */
    preference: computed(() => ui.theme),
    /** 实际生效的主题 */
    resolved,
    setTheme,
    toggle,
  }
}
