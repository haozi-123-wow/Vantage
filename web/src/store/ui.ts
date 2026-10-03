/**
 * UI 偏好 store（docs/frontend.md §2 的 `store/ui.js`）：主题 / 语言 / 布局。
 *
 * ⛔ 只存**偏好**，不存任何凭证（会话在 HttpOnly Cookie 里，docs/frontend.md §9）。
 * 存储 key 与字段名必须与 index.html 里的首屏内联脚本保持一致（否则暗色用户会白闪）。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

export const UI_STORAGE_KEY = 'vantage.ui'

export type ThemePreference = 'light' | 'dark' | 'auto'
export type LocaleCode = 'zh-CN' | 'en-US'

interface PersistedUi {
  theme: ThemePreference
  locale: LocaleCode
  sidebarCollapsed: boolean
}

function readPersisted(): Partial<PersistedUi> {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<PersistedUi>) : {}
  } catch {
    return {}
  }
}

export const useUiStore = defineStore('ui', () => {
  const persisted = readPersisted()

  const theme = ref<ThemePreference>(
    persisted.theme === 'light' || persisted.theme === 'dark' ? persisted.theme : 'auto',
  )
  const locale = ref<LocaleCode>(persisted.locale === 'en-US' ? 'en-US' : 'zh-CN')
  const sidebarCollapsed = ref(persisted.sidebarCollapsed === true)

  const isSidebarCollapsed = computed(() => sidebarCollapsed.value)

  watch([theme, locale, sidebarCollapsed], () => {
    try {
      localStorage.setItem(
        UI_STORAGE_KEY,
        JSON.stringify({
          theme: theme.value,
          locale: locale.value,
          sidebarCollapsed: sidebarCollapsed.value,
        }),
      )
    } catch {
      // 隐私模式 / 存储被禁用：偏好仅在本次会话内存里生效
    }
  })

  function setTheme(next: ThemePreference): void {
    theme.value = next
  }

  function setLocale(next: LocaleCode): void {
    locale.value = next
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  return {
    theme,
    locale,
    sidebarCollapsed,
    isSidebarCollapsed,
    setTheme,
    setLocale,
    toggleSidebar,
  }
})
