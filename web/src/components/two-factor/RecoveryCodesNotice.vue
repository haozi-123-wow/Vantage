<script setup lang="ts">
/**
 * 恢复码一次性展示（docs/frontend.md §4.6 / docs/api.md §4.1 B6 的 D1）。
 *
 * 这 10 个码是**唯一的自救凭据**，且服务端只存 HMAC 哈希 —— 所以：
 * - ⛔ 不写 localStorage / sessionStorage、不进日志、不进 URL、不进 store 的持久化；
 * - 用户必须显式确认「已妥善保存」，父组件随即把码从内存里清空（见 TwoFactorPanel）；
 * - 离开本页后无法再次查看：真要再看只能重新生成（下一轮实现），旧码会整批作废。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useClipboard } from '@/composables/useClipboard'

const props = defineProps<{
  codes: string[]
  /** 剩余可用数量（绑定成功时恒为 10） */
  remaining?: number
}>()

const emit = defineEmits<{ acknowledged: [] }>()

const { t } = useI18n()
const { copied, copy } = useClipboard()

const copyFailed = ref(false)

const joinedCodes = computed(() => props.codes.join('\n'))
const remainingCount = computed(() => props.remaining ?? props.codes.length)

async function onCopyAll(): Promise<void> {
  copyFailed.value = !(await copy(joinedCodes.value))
}
</script>

<template>
  <ElAlert
    type="warning"
    :closable="false"
    show-icon
    :title="t('twoFactor.recoveryTitle')"
  >
    {{ t('twoFactor.recoveryHint') }}
  </ElAlert>

  <ol class="recovery" :aria-label="t('twoFactor.recoveryTitle')">
    <li v-for="code in codes" :key="code" class="recovery__item">
      <code class="recovery__code">{{ code }}</code>
    </li>
  </ol>

  <p class="recovery__meta vc-num">{{ t('twoFactor.recoveryCount', { count: remainingCount }) }}</p>

  <div class="recovery__actions">
    <ElButton size="small" @click="onCopyAll">
      {{ copied ? t('twoFactor.copied') : t('twoFactor.copyAll') }}
    </ElButton>
    <ElButton type="primary" size="small" @click="emit('acknowledged')">
      {{ t('twoFactor.recoveryAcknowledge') }}
    </ElButton>
  </div>

  <p v-if="copyFailed" class="recovery__note">{{ t('twoFactor.copyFailed') }}</p>
</template>

<style scoped>
.recovery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 6px 12px;
  margin: 12px 0;
  padding-left: 20px;
}

.recovery__code {
  font-family: var(--el-font-family, monospace);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}

.recovery__meta,
.recovery__note {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.recovery__actions {
  display: flex;
  gap: 12px;
}
</style>
