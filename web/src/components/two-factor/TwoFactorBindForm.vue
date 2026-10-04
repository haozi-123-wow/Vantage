<script setup lang="ts">
/**
 * 2FA 绑定表单：取密钥 → 扫码/手工输入 → 验证器 6 位码 enable（docs/api.md §4.1 B6）。
 *
 * 关键约定：
 * - 进页面**自动取一次**密钥（`setup` 只写"待确认密钥"、重复调用互相覆盖，无副作用）；
 * - 二维码**不用 `v-html`**：`qr_svg` 装进 `data:` URL 交给 `<img>`（SVG 在 `<img>` 里不可执行脚本、
 *   不加载外部资源）—— 这样既不踩 docs/frontend.md §9 的红线，也不需要新增依赖；
 * - `invalid_request`（未先 setup / 待确认密钥失效）时**自动重取**，⛔ 不让用户卡在"验证码永远不对"；
 * - ⛔ 密钥与验证码都不写本地存储、不进日志、不进 URL。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { AppError } from '@/api/http'
import { authApi } from '@/api/private'
import type { RecoveryCodesResult } from '@/api/private'
import { useClipboard } from '@/composables/useClipboard'
import { errorText } from '@/i18n'

const emit = defineEmits<{ bound: [result: RecoveryCodesResult] }>()

const { t } = useI18n()
const { copied, copy } = useClipboard()

const setup = ref<{ secret: string; otpauth_uri: string; qr_svg: string } | null>(null)
const loading = ref(false)
const submitting = ref(false)
const code = ref('')
const errorCode = ref<string | null>(null)
const errorFallback = ref<string | null>(null)
const copyFailed = ref(false)

const errorMessage = computed(() => {
  if (errorCode.value) return errorText(errorCode.value, errorFallback.value ?? undefined)
  return errorFallback.value
})

/** SVG → data URL：`<img>` 中的 SVG 不会执行脚本，因此不需要 v-html */
const qrSrc = computed(() => {
  const svg = setup.value?.qr_svg
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : ''
})

const secretText = computed(() => setup.value?.secret ?? '')

function clearError(): void {
  errorCode.value = null
  errorFallback.value = null
}

function setLocalError(text: string): void {
  errorCode.value = null
  errorFallback.value = text
}

function applyError(error: unknown): void {
  if (error instanceof AppError) {
    if (error.code === 'conflict') {
      // 服务端对"已绑定还 setup/enable"统一回 409；文案要说清自救渠道，⛔ 不要只说"状态冲突"
      setLocalError(t('twoFactor.alreadyBound'))
      return
    }
    errorCode.value = error.code
    errorFallback.value = error.message
    return
  }
  errorCode.value = 'internal_error'
  errorFallback.value = null
}

async function requestSetup(): Promise<void> {
  loading.value = true
  clearError()
  code.value = ''
  try {
    setup.value = await authApi.twoFactorSetup()
  } catch (error) {
    setup.value = null
    applyError(error)
  } finally {
    loading.value = false
  }
}

async function submit(): Promise<void> {
  if (submitting.value || loading.value) return
  const value = code.value.trim()
  if (!/^\d{6}$/.test(value)) {
    setLocalError(t('twoFactor.missingCode'))
    return
  }
  submitting.value = true
  clearError()
  try {
    emit('bound', await authApi.twoFactorEnable(value))
  } catch (error) {
    if (error instanceof AppError && error.code === 'invalid_request') {
      // 待确认密钥已失效（或压根没 setup）：重取一张再让用户重扫
      await requestSetup()
      setLocalError(t('twoFactor.invalidCodeResent'))
      return
    }
    applyError(error)
  } finally {
    submitting.value = false
  }
}

async function onCopySecret(): Promise<void> {
  copyFailed.value = !(await copy(secretText.value))
}

onMounted(requestSetup)
</script>

<template>
  <ElSkeleton v-if="loading" :rows="4" animated />

  <template v-else-if="setup">
    <p class="bind__hint">{{ t('twoFactor.scanHint') }}</p>

    <div class="bind__qr">
      <img v-if="qrSrc" class="bind__qr-image" :src="qrSrc" :alt="t('twoFactor.qrAlt')" />
    </div>

    <div class="bind__secret">
      <span class="bind__label">{{ t('twoFactor.manualSecret') }}</span>
      <code class="bind__secret-value">{{ secretText }}</code>
      <ElButton size="small" @click="onCopySecret">
        {{ copied ? t('twoFactor.copied') : t('twoFactor.copy') }}
      </ElButton>
    </div>
    <p v-if="copyFailed" class="bind__note">{{ t('twoFactor.copyFailed') }}</p>
    <p class="bind__note">{{ t('twoFactor.secretOnce') }}</p>

    <form class="bind__form" @submit.prevent="submit">
      <label class="bind__field">
        <span class="bind__label">{{ t('twoFactor.codeLabel') }}</span>
        <ElInput
          v-model="code"
          name="totp-code"
          inputmode="numeric"
          maxlength="6"
          autocomplete="one-time-code"
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

      <div class="bind__actions">
        <ElButton type="primary" native-type="submit" :loading="submitting">
          {{ t('twoFactor.enable') }}
        </ElButton>
        <ElButton :disabled="submitting" @click="requestSetup">
          {{ t('twoFactor.reissue') }}
        </ElButton>
      </div>
    </form>
  </template>

  <template v-else>
    <ElAlert
      type="error"
      :closable="false"
      show-icon
      :title="errorMessage ?? t('twoFactor.setupUnavailable')"
    />
    <ElButton class="bind__retry" size="small" @click="requestSetup">
      {{ t('twoFactor.setupFailedRetry') }}
    </ElButton>
  </template>
</template>

<style scoped>
.bind__hint {
  margin: 0 0 12px;
  font-size: 13px;
}

.bind__qr {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  /* 二维码必须在白底上才能被摄像头识别（暗色主题下尤其重要） */
  background: #ffffff;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
}

.bind__qr-image {
  display: block;
  width: 180px;
  height: 180px;
}

.bind__secret {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 4px;
  flex-wrap: wrap;
}

.bind__secret-value {
  font-family: var(--el-font-family, monospace);
  letter-spacing: 0.04em;
  word-break: break-all;
}

.bind__label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.bind__note {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.bind__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
  max-width: 320px;
}

.bind__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bind__actions {
  display: flex;
  gap: 12px;
}

.bind__retry {
  margin-top: 12px;
}
</style>
