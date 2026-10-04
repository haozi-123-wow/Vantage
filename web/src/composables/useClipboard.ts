/**
 * 复制到剪贴板 + 短暂反馈。
 *
 * 用途：2FA 绑定页的「手工密钥」与「恢复码」都要能一键复制（两者都是**只显示一次**的敏感明文）。
 *
 * 硬约束：
 * - ⛔ 不落日志、不落存储、不进 URL —— 只把文本交给浏览器剪贴板；
 * - 非安全上下文或用户拒绝授权时返回 `false`，由调用方提示「请手动选择复制」，⛔ 不静默失败。
 */
import { onScopeDispose, ref } from 'vue'

export function useClipboard(resetMs = 2_000) {
  const copied = ref(false)
  let timer: number | undefined

  function stopTimer(): void {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
  }

  async function copy(text: string): Promise<boolean> {
    if (!text) return false
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false
      await navigator.clipboard.writeText(text)
    } catch {
      return false
    }
    copied.value = true
    stopTimer()
    timer = window.setTimeout(() => {
      copied.value = false
      timer = undefined
    }, resetMs)
    return true
  }

  onScopeDispose(stopTimer)

  return { copied, copy }
}
