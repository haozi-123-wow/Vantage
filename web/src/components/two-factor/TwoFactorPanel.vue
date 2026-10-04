<script setup lang="ts">
/**
 * 二次验证（2FA）面板（docs/frontend.md §4.6 / docs/api.md §4.1 B6、§4.1.0 三态矩阵）。
 *
 * 状态判定只看两个信号，⛔ 不看别的：
 * - `auth.status === 'totp_setup_required'` → 受限态：策略要求绑定但账号未绑定（`me` 返回 403）；
 * - `auth.status === 'authenticated'` → 是否已绑定看 `auth.user.totp_enabled`。
 *
 * ⚠️ 实现时发现的契约缺口（已报告 Owner，⛔ 不自行绕过）：受限态下 `me` 返回 403（D2 已定），
 *    因此**刷新页面后**前端手上没有 `csrf`；而 `/auth/2fa/setup|enable` 是写请求，服务端
 *    `requireCsrf` 在"有会话"时强制校验 —— 这条路径当前无解。这里显式识别并给「重新登录」动作，
 *    ⛔ 不静默失败、也不为它开 CSRF 后门。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import type { RecoveryCodesResult } from '@/api/private'
import RecoveryCodesNotice from '@/components/two-factor/RecoveryCodesNotice.vue'
import TwoFactorBindForm from '@/components/two-factor/TwoFactorBindForm.vue'
import TwoFactorUnbindForm from '@/components/two-factor/TwoFactorUnbindForm.vue'
import { useAuthStore } from '@/store/auth'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

/** 一次性恢复码：只活在内存里，用户确认保存后立刻丢弃（⛔ 不落存储） */
const recoveryCodes = ref<string[] | null>(null)
const remaining = ref<number | undefined>(undefined)
/** 刚刚自助解绑成功：给一条明确回执（面板随即回到"未绑定"态，否则用户会以为按钮没生效） */
const unbindDone = ref(false)

const restricted = computed(() => auth.status === 'totp_setup_required')
const bound = computed(() => auth.user?.totp_enabled === true)
const csrfMissing = computed(() => restricted.value && !auth.csrf)

async function onBound(result: RecoveryCodesResult): Promise<void> {
  // ⚠️ 先记住恢复码，再做任何网络调用：它们**只下发这一次**，状态刷新失败也不能弄丢
  recoveryCodes.value = result.recovery_codes
  remaining.value = result.remaining_recovery_codes
  try {
    // enable 成功 = 会话已置 full 且 sid 轮换 → 重取 me 更新 user/roles 与受限态
    await auth.refreshMe()
  } catch {
    // 状态刷新失败不影响"码已拿到"；下一次导航守卫会重新 bootstrap
  }
}

function onAcknowledged(): void {
  recoveryCodes.value = null
  remaining.value = undefined
}

/**
 * 解绑成功（服务端 204，恢复码已一并作废、会话仍是完整态）。
 * ⚠️ 必须 `refreshMe()`：`bound` 看的是 `auth.user.totp_enabled`，不刷新的话面板会一直显示"已绑定"。
 */
async function onUnbound(): Promise<void> {
  unbindDone.value = true
  try {
    await auth.refreshMe()
  } catch {
    // 状态刷新失败不影响"已经解绑"这件事；下一次导航守卫会重新 bootstrap
  }
}

async function relogin(): Promise<void> {
  await auth.logout()
  // 受限态刷新后拿不到 csrf（`me` 403），写请求必失败 → 打回重新登录；登录后直接回本页继续绑定
  await router.replace({ name: 'login', query: { redirect: '/account' } })
}
</script>

<template>
  <section class="two-factor">
    <h2 class="two-factor__title">{{ t('twoFactor.sectionTitle') }}</h2>

    <ElAlert
      v-if="restricted"
      type="warning"
      :closable="false"
      show-icon
      :title="t('twoFactor.restrictedTitle')"
    >
      {{ t('twoFactor.restrictedHint') }}
    </ElAlert>

    <ElAlert
      v-if="csrfMissing"
      type="error"
      :closable="false"
      show-icon
      :title="t('twoFactor.missingCsrfTitle')"
    >
      <p class="two-factor__hint">{{ t('twoFactor.missingCsrfHint') }}</p>
      <ElButton size="small" @click="relogin">{{ t('twoFactor.relogin') }}</ElButton>
    </ElAlert>

    <RecoveryCodesNotice
      v-else-if="recoveryCodes"
      :codes="recoveryCodes"
      :remaining="remaining"
      @acknowledged="onAcknowledged"
    />

    <template v-else-if="bound">
      <ElAlert
        type="success"
        :closable="false"
        show-icon
        :title="t('twoFactor.boundTitle')"
      >
        {{ t('twoFactor.boundHint') }}
      </ElAlert>

      <!-- 自助解绑（docs/frontend.md §4.6：解绑需**密码二次确认**）；require_2fa=true 时服务端回 409 -->
      <TwoFactorUnbindForm @unbound="onUnbound" />
    </template>

    <template v-else>
      <ElAlert
        v-if="unbindDone"
        type="info"
        :closable="false"
        show-icon
        :title="t('twoFactor.unbindDoneTitle')"
      >
        {{ t('twoFactor.unbindDoneHint') }}
      </ElAlert>

      <TwoFactorBindForm @bound="onBound" />
    </template>
  </section>
</template>

<style scoped>
.two-factor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 560px;
}

.two-factor__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.two-factor__hint {
  margin: 0 0 8px;
}
</style>
