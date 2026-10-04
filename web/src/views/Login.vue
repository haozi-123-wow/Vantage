<script setup lang="ts">
/**
 * 登录 + 二次验证（docs/frontend.md §4.2 / M2 交付物）。
 *
 * 人机验证：**按服务端下发的 `provider` 选组件**（`docs/api.md` §4.1 的两个端点按提供方分支）——
 * `selfbuilt` → `SliderCaptcha.vue`（自建滑块，S1–S4）；`geetest` → `GeetestCaptcha.vue`（极验 v4 官方按钮，S8）。
 * 两者的**触发语义完全相同**（`docs/geetest-captcha.md` §2 的 8 条契约与提供方无关）：
 * | 触发 | 处理 |
 * |---|---|
 * | 401 + `details.captcha_required === true` | **就地**展开验证入口，保留已填用户名/密码 |
 * | 400 `captcha_required`（服务端强制的兜底契约） | 同上 |
 * | 验证 `success(token)` | **自动重提**登录（携 `captcha_token`），⛔ 不需要用户再点登录 |
 * | `success(null)` | 服务端此刻不需要验证（链路被关闭/熔断的 fail-open）→ 同样自动重提，但不带 token |
 * | 验证 `fail(reason)` | 展示服务端原因（换题/作废在页面级补一条说明），允许重试 |
 * | `captcha_invalid` | 丢掉旧 token，并让验证组件重新出题/重置 |
 * | 首次进入页面 | ⛔ 用户**看不到**任何验证入口 |
 *
 * ⚠️ 与自建版的**唯一**差异在加载时机（`docs/geetest-captcha.md` §4.1 / §7.3）：极验要求"页面加载时
 * 就初始化"（行为采集），所以 `onMounted` 会先问一次 `/auth/captcha/challenge` 拿提供方与配置，
 * 极验组件**常驻挂载**、容器默认隐藏；自建滑块则仍只在服务端确实要求时才挂载（首次登录零摩擦）。
 *
 * 其它硬约束：
 * - 两步在同一路由内切换；`totp_required: true` 后**所有其它接口都 403**，UI 必须留在登录流程里；
 * - 第二步成功后 sid 已轮换 → 由 `store/auth.ts` 重新调 `GET /api/v1/auth/me` 刷新 csrf 与角色；
 * - 失败提示统一「用户名或密码错误」，⛔ 不区分账号是否存在；429 带倒计时（读 `Retry-After`）；
 * - ⛔ 不把 `captcha_token` 存进 store / localStorage（一次性短期凭证，只存在于提交那一瞬间）；
 * - ⛔ 任何本地存储都不写凭证（会话在 HttpOnly Cookie 里）；⛔ 本期不提供 SSO / OIDC 登录入口。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import { AppError } from '@/api/http'
import { authApi } from '@/api/private'
import type { CaptchaProvider, GeetestCaptchaChallenge } from '@/api/private'
import GeetestCaptcha from '@/components/GeetestCaptcha.vue'
import SliderCaptcha from '@/components/SliderCaptcha.vue'
import { errorText } from '@/i18n'
import { useAuthStore } from '@/store/auth'

type Step = 'password' | 'totp' | 'recovery'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const step = ref<Step>('password')
const username = ref('')
const password = ref('')
const totpCode = ref('')
const recoveryCode = ref('')
const submitting = ref(false)
const recoveryWarning = ref<string | null>(null)

/** 失败展示：优先用错误码走 i18n（⛔ 不靠 message 文案分支），本地校验时直接给文案 */
const errorCode = ref<string | null>(null)
const errorFallback = ref<string | null>(null)
/** 429 倒计时秒数（读 `Retry-After`，docs/frontend.md §4.2） */
const retryAfterS = ref(0)
let countdownTimer: number | undefined

/**
 * 人机验证：提供方由服务端决定（`docs/api.md` §4.1 的两个端点按 `CAPTCHA_PROVIDER` 分支）。
 * - `null` = 还没问到 / 问了但链路不生效（`challenge` 404 = 关闭·未配置·熔断）→ ⛔ 不显示任何验证入口；
 * - `selfbuilt` → 用 `SliderCaptcha.vue`（⛔ 它只在服务端确实要求时才挂载，首次登录零摩擦）；
 * - `geetest` → 用 `GeetestCaptcha.vue`（⚠️ **常驻挂载**：官方要求页面加载时就初始化行为采集）。
 */
const captchaProvider = ref<CaptchaProvider | null>(null)
/** 极验分支的公开配置（`captcha_id`/`product`/`language`）：非空即渲染 `GeetestCaptcha` */
const geetestConfig = ref<GeetestCaptchaChallenge | null>(null)
/** 极验组件句柄：`captcha_token` 被服务端拒绝时让它 reset（§7.5 坑二） */
const geetestRef = ref<{ reset: () => void } | null>(null)
/** 服务端是否已要求人机验证（两种提供方共用）：false 时极验容器**已挂载但被 CSS 藏起来** */
const captchaVisible = ref(false)
/** 换题用：递增即重新挂载 SliderCaptcha（其 onMounted 会重新 challenge）——自建分支专用 */
const captchaKey = ref(0)
const captchaNotice = ref<string | null>(null)
/** 一次性 captcha_token：只存内存，⛔ 不入 store / localStorage（自建方案 §7.3） */
const captchaToken = ref<string | null>(null)

const errorMessage = computed(() => {
  const base = errorCode.value
    ? errorText(errorCode.value, errorFallback.value ?? undefined)
    : errorFallback.value
  if (!base) return null
  return retryAfterS.value > 0
    ? `${base} ${t('view.login.rateLimited', { seconds: retryAfterS.value })}`
    : base
})

/** 登录成功后的落地页：⛔ 只接受站内路径（挡 `//evil.com` 这类开放重定向） */
const redirectTarget = computed(() => {
  const raw = route.query.redirect
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) return raw
  return '/hosts'
})

function clearError(): void {
  errorCode.value = null
  errorFallback.value = null
}

function setError(code: string, fallback?: string): void {
  errorCode.value = code
  errorFallback.value = fallback ?? null
}

function setLocalError(text: string): void {
  errorCode.value = null
  errorFallback.value = text
}

function stopCountdown(): void {
  if (countdownTimer !== undefined) {
    window.clearInterval(countdownTimer)
    countdownTimer = undefined
  }
}

function startCountdown(seconds: number): void {
  stopCountdown()
  retryAfterS.value = Math.max(1, Math.ceil(seconds))
  countdownTimer = window.setInterval(() => {
    retryAfterS.value -= 1
    if (retryAfterS.value <= 0) stopCountdown()
  }, 1000)
}

/** 统一失败处理：429 倒计时 + 错误码映射 */
function applyError(error: unknown): void {
  if (error instanceof AppError) {
    if (error.status === 429) startCountdown(error.retryAfterS ?? 60)
    setError(error.code, error.message)
    return
  }
  setError('internal_error')
}

/** 服务端在"策略要求滑块"时给出的提示字段（§5.3：`details.captcha_required === true`） */
function captchaRequiredInDetails(error: AppError): boolean {
  const details = error.details
  if (!details || typeof details !== 'object') return false
  return (details as { captcha_required?: unknown }).captcha_required === true
}

/**
 * 问服务端"这次用哪个提供方、配置是什么"（`docs/geetest-captcha.md` §7.2 的 `onMounted` 那一行）。
 *
 * ⚠️ 与自建版的差异只在**加载时机**：极验要求"页面加载时就初始化"（行为采集），所以本方法
 *    首次进入页面也会调；自建分支拿到 `selfbuilt` 后**什么都不做** —— 出题仍由 `SliderCaptcha`
 *    在被挂载时自己做（首次登录零摩擦，§7.2 最后一行）。
 *
 * ⛔ 出题失败**不阻塞登录、也不报错**：404 = 验证码被关闭 / 提供方未配置 / 极验处于熔断窗口，
 *    这三种情况下服务端同样不会要求 `captcha_token`，直接提交登录即可 ——
 *    这正是 fail-open 在前端应有的样子（`docs/frontend.md` §4.2）。
 */
async function prepareCaptcha(): Promise<void> {
  try {
    const config = await authApi.captchaChallenge()
    if (config.provider === 'geetest') {
      // ⛔ 常驻挂载：容器默认隐藏，只有服务端要求时才显示官方按钮（§7.3）
      geetestConfig.value = config
      captchaProvider.value = 'geetest'
      return
    }
    captchaProvider.value = 'selfbuilt'
  } catch {
    // ⛔ 不吞掉用户的登录能力：把提供方留空，页面上只在"服务端确实要求验证"时给一条说明
    captchaProvider.value = null
    geetestConfig.value = null
  }
}

/**
 * 就地展开验证入口。
 * ⚠️ 服务端在策略命中时**每次**登录失败都会回 `details.captcha_required`（即使本次已带有效 token），
 *    若无脑重挂载就会变成「验证过一次 → 密码又错 → 又被要求重来」的死循环；token 在 120s 内本就可
 *    复用（§6.4），所以已有 token 时只提示密码错误，不再要求重来。
 */
function revealCaptcha(): void {
  if (captchaToken.value) return
  captchaVisible.value = true
  // 首屏那次 `challenge` 失败过（429 / 网络抖动）的话，此刻用户已经**确实被要求**验证了 ——
  // 再补一次机会；拿到了 provider 组件就会随即挂载，拿不到则页面上的说明提示仍然有效。
  if (!captchaProvider.value) void prepareCaptcha()
}

/**
 * 换一张题：递增 key 重新挂载 `SliderCaptcha`（新题由组件自己去 challenge）。
 * ⚠️ 这是**自建分支专用**的手段；极验的重新验证走 `geetestRef.reset()`，与这里互补而不冲突。
 */
function reissueCaptcha(): void {
  captchaNotice.value = null
  captchaKey.value += 1
  captchaVisible.value = true
}

function handleLoginFailure(error: unknown): void {
  if (error instanceof AppError) {
    if (error.status === 429) {
      applyError(error)
      return
    }
    // 路径一：401 invalid_credentials + details.captcha_required → 就地展开验证入口（§7.2）
    if (error.status === 401 && captchaRequiredInDetails(error)) {
      setError(error.code, error.message)
      revealCaptcha()
      return
    }
    // 路径二（服务端强制的兜底契约）：400 captcha_required → 同样展开验证入口（§7.2 / docs/api.md §4.1）
    if (error.code === 'captcha_required') {
      setError(error.code, error.message)
      revealCaptcha()
      return
    }
    // token 无效 / 已过期 / 已消费：丢掉旧 token，并让验证组件重新出题（§7.2 的 expired 分支）
    if (error.code === 'captcha_invalid') {
      setError(error.code, error.message)
      captchaToken.value = null
      // 极验：`pass_token` 一次性、这次的验证已被服务端判无效 → 允许用户重新验证（§7.5 坑二）
      geetestRef.value?.reset()
      reissueCaptcha()
      return
    }
  }
  applyError(error)
}

async function gotoAfterLogin(): Promise<void> {
  stopCountdown()
  await router.replace(redirectTarget.value)
}

async function submitPassword(): Promise<void> {
  if (submitting.value || retryAfterS.value > 0) return
  if (!username.value.trim() || !password.value) {
    setLocalError(t('view.login.missingCredentials'))
    return
  }
  submitting.value = true
  clearError()
  captchaNotice.value = null
  try {
    // captcha_token 是可选的：服务端只在失败计数超阈时才要求它
    const result = await auth.login(username.value, password.value, captchaToken.value ?? undefined)
    captchaToken.value = null
    if (result.totpRequired) {
      step.value = 'totp'
      return
    }
    await gotoAfterLogin()
  } catch (error) {
    handleLoginFailure(error)
  } finally {
    submitting.value = false
  }
}

async function submitTotp(): Promise<void> {
  if (submitting.value || retryAfterS.value > 0) return
  const code = totpCode.value.trim()
  if (!/^\d{6}$/.test(code)) {
    setLocalError(t('view.login.missingTotp'))
    return
  }
  submitting.value = true
  clearError()
  try {
    await auth.verifyTotp(code)
    await gotoAfterLogin()
  } catch (error) {
    // 会话失效 / 会话态与库态脱节（409 conflict）→ 第二步已无法继续，回第一步重新登录
    if (error instanceof AppError && (error.status === 401 || error.code === 'conflict')) {
      step.value = 'password'
    }
    applyError(error)
  } finally {
    submitting.value = false
  }
}

async function submitRecovery(): Promise<void> {
  if (submitting.value || retryAfterS.value > 0) return
  const code = recoveryCode.value.trim()
  if (!code) {
    setLocalError(t('view.login.missingRecovery'))
    return
  }
  submitting.value = true
  clearError()
  try {
    const remaining = await auth.verifyRecoveryCode(code)
    if (typeof remaining === 'number' && remaining <= 2) {
      // 剩余 ≤2 强提示（docs/frontend.md §4.2）。⚠️ 成功后立刻跳转，真正的"重新生成"入口在设置页。
      recoveryWarning.value = t('view.login.recoveryLow', { count: remaining })
    }
    await gotoAfterLogin()
  } catch (error) {
    if (error instanceof AppError && (error.status === 401 || error.code === 'conflict')) {
      step.value = 'password'
    }
    applyError(error)
  } finally {
    submitting.value = false
  }
}

/**
 * 验证通过：拿到一次性 token 后**立刻自动重提**登录（⛔ 不让用户重输、⛔ 不需再点登录）。
 * `token === null` 表示服务端此刻不需要验证（出题/验题 404 的 fail-open，见 `prepareCaptcha`）：
 * 照样重提，只是**不带** `captcha_token`。
 */
async function onCaptchaSuccess(token: string | null): Promise<void> {
  captchaToken.value = token
  captchaNotice.value = null
  clearError()
  await submitPassword()
}

function onCaptchaFail(reason: string): void {
  // ⛔ 前端不判定对错：这里只维护 token 状态（失败原因来自服务端）。
  // 「已为你换一张 / 该题已作废」属服务端状态变化，在页面级补一条说明；
  // `mismatch` / `track_suspicious` / `validate_failed` 只由各自的组件就地提示，避免同一句话出现两遍。
  captchaToken.value = null
  if (reason === 'expired' || reason === 'not_found' || reason === 'too_many_attempts') {
    captchaNotice.value =
      reason === 'too_many_attempts' ? t('captcha.tooManyAttempts') : t('captcha.expired')
  }
}

function onCaptchaCancel(): void {
  captchaVisible.value = false
  captchaNotice.value = null
  captchaToken.value = null
}

onMounted(() => {
  // ⚠️ 极验要求"页面加载时初始化行为采集"（§4.1/§7.3），故这里提前问一次提供方与配置；
  //    自建分支不会因此出题（零摩擦），失败（404 等）也不阻塞登录。
  void prepareCaptcha()
})

onBeforeUnmount(stopCountdown)
</script>

<template>
  <main class="login">
    <h1 class="vc-page__title">{{ t('view.login.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.login.hint') }}</p>

    <!-- 第一步：用户名 + 密码（滑块出现时表单**不清空**，用户名/密码始终保留） -->
    <form v-if="step === 'password'" class="login__form" @submit.prevent="submitPassword">
      <label class="login__field">
        <span class="login__label">{{ t('view.login.username') }}</span>
        <ElInput
          v-model="username"
          name="username"
          autocomplete="username"
          :disabled="submitting"
        />
      </label>

      <label class="login__field">
        <span class="login__label">{{ t('view.login.password') }}</span>
        <ElInput
          v-model="password"
          name="password"
          type="password"
          show-password
          autocomplete="current-password"
          :disabled="submitting"
        />
      </label>

      <!-- 人机验证（docs/frontend.md §4.2 / docs/geetest-captcha.md §7）：
           · 只有服务端要求时才显示入口（首次进入页面**什么都看不到**）；
           · 极验：组件**常驻挂载**（页面加载即 initGeetest4 + appendTo，官方要求的行为采集时机），
             官方按钮的 DOM 早已生成，仅由 `:visible` 控制容器显示（§7.3）；
           · 自建滑块：只在服务端确实要求时才挂载（首次登录零摩擦，自建方案 §7.2）。 -->
      <template v-if="captchaVisible">
        <ElAlert type="warning" :closable="false" show-icon :title="t('captcha.required')" />
        <!-- 连提供方都没问到（challenge 404 / 限流 / 网络）：⛔ 不假装能验证，给一条说明 -->
        <ElAlert
          v-if="!captchaProvider"
          type="info"
          :closable="false"
          show-icon
          :title="t('captcha.unavailable')"
        />
      </template>

      <GeetestCaptcha
        v-if="geetestConfig"
        ref="geetestRef"
        :config="geetestConfig"
        :visible="captchaVisible"
        @success="onCaptchaSuccess"
        @fail="onCaptchaFail"
      />

      <SliderCaptcha
        v-if="captchaVisible && captchaProvider === 'selfbuilt'"
        :key="captchaKey"
        @success="onCaptchaSuccess"
        @fail="onCaptchaFail"
        @cancel="onCaptchaCancel"
      />

      <p v-if="captchaVisible" class="login__note">{{ t('view.login.captchaFallback') }}</p>

      <ElAlert
        v-if="captchaNotice"
        type="info"
        :closable="false"
        show-icon
        :title="captchaNotice"
      />
      <ElAlert
        v-if="errorMessage"
        type="error"
        :closable="false"
        show-icon
        :title="errorMessage"
      />

      <div class="login__actions">
        <ElButton type="primary" native-type="submit" :loading="submitting" :disabled="retryAfterS > 0">
          {{ t('view.login.submit') }}
        </ElButton>
        <!-- ⛔ 密码步骤**不放**「使用恢复码登录」：恢复码是第二因子的替代品，不是密码的替代品。
             `POST /auth/2fa/recovery/verify` 带 requireSession（server/src/routes/auth.js），
             没有会话必然 401 session_expired —— 放这里是一条死路。
             ✅ docs/frontend.md §4.2 的口径是「**第二步**提供『使用恢复码登录』链接」。 -->
      </div>
    </form>

    <!-- 第二步：TOTP（`totp_required: true` 时所有其它接口都 403，UI 必须留在登录流程内） -->
    <form v-else-if="step === 'totp'" class="login__form" @submit.prevent="submitTotp">
      <p class="login__note">{{ t('view.login.totpHint') }}</p>
      <label class="login__field">
        <span class="login__label">{{ t('view.login.totp') }}</span>
        <ElInput
          v-model="totpCode"
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

      <div class="login__actions">
        <ElButton type="primary" native-type="submit" :loading="submitting" :disabled="retryAfterS > 0">
          {{ t('view.login.verify') }}
        </ElButton>
        <ElButton link type="primary" @click="step = 'recovery'">
          {{ t('view.login.useRecovery') }}
        </ElButton>
      </div>
    </form>

    <!-- 恢复渠道一：一次性恢复码（用后即废）。
         ✅ 入口只在**第二步（TOTP）**：恢复码替代的是第二因子，服务端 `recovery/verify` 要求已有会话
         （必须先过密码）。滑块不可用时登录页给的是**说明**而非入口（docs/slider-captcha-selfbuilt.md §7.5-2），
         该说明已经在滑块区块里以 `view.login.captchaFallback` 呈现。 -->
    <form v-else class="login__form" @submit.prevent="submitRecovery">
      <p class="login__note">{{ t('view.login.recoveryHint') }}</p>
      <label class="login__field">
        <span class="login__label">{{ t('view.login.recovery') }}</span>
        <ElInput v-model="recoveryCode" autocomplete="off" :disabled="submitting" />
      </label>

      <ElAlert
        v-if="recoveryWarning"
        type="warning"
        :closable="false"
        show-icon
        :title="recoveryWarning"
      />
      <ElAlert
        v-if="errorMessage"
        type="error"
        :closable="false"
        show-icon
        :title="errorMessage"
      />

      <div class="login__actions">
        <ElButton type="primary" native-type="submit" :loading="submitting" :disabled="retryAfterS > 0">
          {{ t('view.login.submit') }}
        </ElButton>
        <ElButton link type="primary" @click="step = 'password'">
          {{ t('view.login.usePassword') }}
        </ElButton>
      </div>
    </form>
  </main>
</template>

<style scoped>
.login {
  max-width: 420px;
  margin: 0 auto;
  padding: 48px 24px;
}

.login__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.login__label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.login__note {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.login__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
