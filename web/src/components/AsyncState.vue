<script setup lang="ts">
/**
 * 加载 / 空 / 错误三态统一封装（docs/frontend.md §2 的 `AsyncState.vue`）。
 *
 * 约定：所有依赖接口的区块都套这一层，⛔ 不要在业务组件里各写一套三态。
 * 默认三态可直接用；需要自定义外观时覆盖对应插槽。
 */
import { useI18n } from 'vue-i18n'

defineProps<{
  loading?: boolean
  /** 已经过 i18n 映射的错误文案（用 errorText(code, message) 得到） */
  error?: string | null
  empty?: boolean
}>()

const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()
</script>

<template>
  <div class="async-state">
    <slot v-if="loading" name="loading">
      <ElSkeleton :rows="4" animated />
    </slot>

    <slot v-else-if="error" name="error" :message="error">
      <ElAlert type="error" :closable="false" show-icon :title="error ?? ''">
        <ElButton size="small" @click="emit('retry')">{{ t('common.retry') }}</ElButton>
      </ElAlert>
    </slot>

    <slot v-else-if="empty" name="empty">
      <ElEmpty :description="t('common.empty')" />
    </slot>

    <slot v-else />
  </div>
</template>

<style scoped>
.async-state {
  min-height: 0;
}
</style>
