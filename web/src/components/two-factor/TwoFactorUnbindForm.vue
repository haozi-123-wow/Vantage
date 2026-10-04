<script setup lang="ts">
/**
 * 2FA 解绑表单：**密码二次确认**（`docs/api.md` §4.1 B6、`docs/frontend.md` §4.6）。
 *
 * 契约（`server/src/routes/auth.js` 的 `POST /api/v1/auth/2fa/disable`）：
 * - 门槛 = `requireFullSession` + `requireCsrf`（⛔ `totp_pending` 下不可解绑 —— 那等于"用密码关掉 2FA"）；
 * - 成功 **204**：解绑 **且连恢复码一起作废**（D5，事务内 `resetTotp`），⛔ 不轮换 sid（会话仍是完整态）；
 * - 密码错 → **401 `invalid_credentials`**；未绑定 / `security.require_2fa=true` 禁止自助解绑 → **409 `conflict`**（D3）。
 *
 * ⚠️ 这里的 401 是"**你刚填的密码不对**"，**不是会话过期**：`api/private.ts` 已按 `error.code`
 *    把它从 `onUnauthorized`（清会话 + 跳登录）里摘出来，所以输错一次密码不会把人踢出控制台。
 *
 * ⛔ 解绑是不可逆的安全态变更：不做"撤销"、不缓存密码、失败也不清空用户的输入（便于改错字重试）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { AppError } from '@/api/http'
import { authApi } from '@/api/private'
import { errorText } from '@/i18n'

const emit = defineEmits<{
  /** 解绑成功（服务端 204）；调用方负责刷新 `auth` 状态并提示 */
  unbound: []
}>()

const { t } = useI18n()

/** 默认只显示一个危险动作按钮，点了才展开表单 —— 避免"解绑"在页面上显得随手可得 */
const confirming = ref(false)
const password = ref('')
const submitting = ref(false)
const errorCode = ref<string | null>(null)
const errorFallback = ref<string | null>(null)

const errorMessage = computed(() => {
  if (errorCode.value) return errorText(errorCode.value, errorFallback.value ?? undefined)
  return errorFallback.value
})

function resetError(): void {
  errorCode.value = null
  errorFallback.value = null
}

function open(): void {
  confirming.value = true
  password.value = ''
  resetError()
}

function cancel(): void {
  confirming.value = false
  password.value = ''
  resetError()
}

function applyError(error: unknown): void {
  if (error instanceof AppError) {
    if (error.code === 'conflict') {
      // 服务端已经把"为什么不能解绑"写进 message（尚未绑定 / 策略要求保留二次验证），
      // ⛔ 不要换成通用文案，否则用户不知道该怎么办
      errorCode.value = null
      errorFallback.value = error.message
      return
    }
    errorCode.value = error.code
    errorFallback.value = error.message
    return
  }
  errorCode.value = 'internal_error'
  errorFallback.value = null
}

async function submit(): Promise<void> {
  if (submitting.value) return
  if (password.value === '') {
    errorCode.value = null
    errorFallback.value = t('twoFactor.unbindMissingPassword')
    return
  }
  submitting.value = true
  resetError()
  try {
    await authApi.twoFactorDisable(password.value)
    // ⛔ 立刻丢掉明文口令，不等调用方回调
    password.value = ''
    confirming.value = false
    emit('unbound')
  } catch (error) {
    applyError(error)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="unbind">
    <ElButton v-if="!confirming" type="danger" plain @click="open">
      {{ t('twoFactor.unbindStart') }}
    </ElButton>

    <form v-else class="unbind__form" @submit.prevent="submit">
      <p class="unbind__hint">{{ t('twoFactor.unbindHint') }}</p>

      <label class="unbind__field">
        <span class="unbind__label">{{ t('twoFactor.unbindPasswordLabel') }}</span>
        <ElInput
          v-model="password"
          name="current-password"
          type="password"
          show-password
          autocomplete="current-password"
          :disabled="submitting"
        />
      </label>

      <ElAlert
        v-if="errorMessage"
        type="error"
        :closable="false"
        show-icon
        :title="errorMessage"
      />

      <div class="unbind__actions">
        <ElButton type="danger" native-type="submit" :loading="submitting">
          {{ t('twoFactor.unbindConfirm') }}
        </ElButton>
        <ElButton :disabled="submitting" @click="cancel">{{ t('common.cancel') }}</ElButton>
      </div>
    </form>
  </div>
</template>

<style scoped>
.unbind {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.unbind__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 320px;
}

.unbind__hint {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.unbind__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.unbind__label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.unbind__actions {
  display: flex;
  gap: 12px;
}
</style>
