<script setup lang="ts">
/**
 * 极验 GeeTest v4 人机验证组件（S8 交付物）。
 *
 * 依据：`docs/geetest-captcha.md` §7.2（接入点）、§7.3（官方按钮 + 隐藏容器）、§7.4（i18n）、
 *       §7.5（五个坑，逐条对照检查）；`docs/frontend.md` §4.2；`docs/api.md` §4.1。
 *
 * 与 `SliderCaptcha.vue` 的分工：**对调用方是同一个契约**（`success` / `fail`），
 * 所以 `Login.vue` 只需按 challenge 响应的 `provider` 选组件，⛔ 不需要知道里面是滑块还是极验。
 *
 * ⛔ 安全约束（都不是风格问题，改之前先读依据）：
 * - ⛔ 前端**不得**判定对错：极验的 `onSuccess` 也必须经服务端 `/captcha/verify` 才算数
 *   （变更方案 §4.4 场景 B：前端"一键通过"在服务端会被 `pass_token error` 拒掉）；
 * - ⛔ 不自绘按钮、不自绘验证窗：观感全部由极验提供（C16 已定），我们只控制**什么时候显示那个容器**；
 * - ⛔ 组件内不硬编码任何文案（全部走 i18n，§7.4）；
 * - ⛔ 不把极验的 `error.code` 展示给用户，也不与本服务的 `error.code` 混用（§7.5 坑三）。
 * - ⛔ **不把 `getValidate()` 的返回值整对象转发**给 `/auth/captcha/verify`：极验实测返回 **5** 个字段
 *   （它是客户端 `/verify` 响应里 `data.seccode` 的原样对象，多一个 `captcha_id`），而服务端 schema 是
 *   `additionalProperties: false` 的白名单 —— 整份转发会被 400 `schema_invalid` 拒掉，用户看到极验
 *   "验证通过"却永远登不进去（2026-10-04 真实事故）。➡️ 一律经 `toVerifyBody()` 投影。
 *
 * ⚠️ 初始化时机（§4.1 / §7.3）：**页面加载时**就 `initGeetest4` 并 `appendTo`（官方要求行为采集
 *    从页面打开即开始），容器由 `visible` 控制显示 —— 所以首次登录的用户**看不到任何验证入口**。
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { AppError } from '@/api/http'
import { authApi, captchaReasonOf } from '@/api/private'
import type { GeetestCaptchaChallenge } from '@/api/private'
import { errorText } from '@/i18n'
import { loadGeetest, toVerifyBody, type GeetestInstance, type GeetestValidate } from '@/utils/geetest'

const props = defineProps<{
  /** `/auth/captcha/challenge` 的**极验分支**响应（`captcha_id` 由服务端运行时下发，⛔ 不来自构建期 env） */
  config: GeetestCaptchaChallenge
  /** 服务端此刻是否要求人机验证：false 时容器**已挂载但不可见**（官方按钮的 DOM 早在页面加载时生成） */
  visible: boolean
}>()

const emit = defineEmits<{
  /**
   * 服务端验题通过 → 一次性 `captcha_token`（调用方应立刻拿它自动重提登录）。
   * `null` = **服务端此刻不需要验证**（链路被关闭 / 极验熔断的 fail-open），直接提交登录即可。
   */
  success: [captchaToken: string | null]
  /** 验题失败：`reason` 来自服务端 `error.details.reason`（极验为 `validate_failed`） */
  fail: [reason: string]
}>()

const { t } = useI18n()

/** 极验官方按钮／验证窗的宿主容器（DOM 由 `gt4.js` 注入，⛔ 我们不在里面写任何东西） */
const slotEl = ref<HTMLElement | null>(null)
/**
 * `loading` = 正在加载 `gt4.js` 并初始化；`ready` = 按钮已在容器里；`unavailable` = 前端这一层拿不到极验。
 * ⚠️ `unavailable` **不等于**"通过"，也**不**在前端放行（§9.4：不许为了内网能登录就前端放行）。
 */
const phase = ref<'loading' | 'ready' | 'unavailable'>('loading')
/** 验题请求在途：防重复提交（极验的 `pass_token` 是一次性的，重复提交只会白撞一次 400） */
const verifying = ref(false)

/** 提示文案：`noticeKey` 走 i18n（可随语言切换），`noticeText` 是服务端错误码映射后的快照文案 */
const noticeKey = ref<string | null>(null)
const noticeText = ref<string | null>(null)
const notice = computed(() => noticeText.value ?? (noticeKey.value ? t(noticeKey.value) : null))

let instance: GeetestInstance | null = null
/** 卸载标记：初始化是异步的，回调回来时组件可能已经不在了 */
let unmounted = false

function failToUnavailable(): void {
  phase.value = 'unavailable'
  noticeText.value = null
  noticeKey.value = 'captcha.vendorFailed'
}

onMounted(() => {
  void setup()
})

/**
 * 加载 `gt4.js` → 初始化 → **立刻** `appendTo` 隐藏容器（§7.3 第 2 步）。
 *
 * ⛔ 失败路径**只**标记 `unavailable` 并给提示：不伪造"通过"、不替服务端放行。
 *    服务端若确实需要凭证，会以 400 `captcha_required` 回来，用户看到的是可解释的提示而不是静默失败。
 */
async function setup(): Promise<void> {
  const slot = slotEl.value
  if (!slot) return

  try {
    await loadGeetest()
  } catch {
    failToUnavailable()
    return
  }
  if (unmounted) return

  const init = window.initGeetest4
  if (typeof init !== 'function') {
    failToUnavailable()
    return
  }

  try {
    init(
      {
        captchaId: props.config.captcha_id,
        product: props.config.product,
        language: props.config.language,
        // 官方要求本地/混合场景显式指定协议头；我们一律 HTTPS（与 §4.2 服务端口径一致）
        protocol: 'https://',
      },
      (obj) => {
        if (unmounted) {
          obj.destroy?.()
          return
        }
        instance = obj
        obj.onReady(() => {
          phase.value = 'ready'
        })
        obj.onSuccess(onVendorSuccess)
        obj.onError(onVendorError)
        obj.onClose(onVendorClose)
        obj.onFail?.(() => {
          // 极验自己判"没通过"：⛔ 不展示极验的错误码，也不代表最终结论（我们仍以服务端为准）
          noticeKey.value = 'captcha.failed'
        })
        // ⛔ 不要改成"等需要时再 appendTo"：官方要求"初始化在业务页面加载时完成"，
        //    我们靠 CSS 隐藏容器来同时满足"首次不出现"（§7.3 的 🔑 段）。
        obj.appendTo(slot)
      },
    )
  } catch {
    failToUnavailable()
  }
}

/**
 * 极验判定通过 → **仍然要**送服务端二次校验（§4.4：前端"通过"毫无防护价值）。
 * §7.5 坑一：未成功验证时 `getValidate()` 返回 `false`，此时提交只会撞服务端 400 `schema_invalid`，
 * 而用户看到的是"验证失败"却永远过不去。
 */
function onVendorSuccess(): void {
  noticeKey.value = null
  noticeText.value = null
  const validate = instance?.getValidate()
  if (!validate) {
    noticeKey.value = 'captcha.vendorFailed'
    return
  }
  void submit(validate)
}

/** 极验侧的加载/配置错误：⛔ 不展示 `error.code`（那是极验的码，坑三），只给通用文案 */
function onVendorError(): void {
  failToUnavailable()
}

/**
 * §7.5 坑四：用户关掉验证窗必须**有反馈**，否则关掉后再点登录看起来像卡死。
 * 同时 `reset()`：坑二第 ② 种情形（用户关了窗想重来）。
 */
function onVendorClose(): void {
  noticeKey.value = 'captcha.closed'
  noticeText.value = null
  instance?.reset()
}

async function submit(validate: GeetestValidate): Promise<void> {
  if (verifying.value) return
  verifying.value = true
  noticeKey.value = null
  noticeText.value = null
  try {
    // ⛔ 只提交服务端白名单里的 4 个字段：极验的 `getValidate()` 实际会多带 `captcha_id`
    //    （= 客户端 `/verify` 响应里 `data.seccode` 的原样对象），整份转发会 400 `schema_invalid`。
    const result = await authApi.captchaVerify(toVerifyBody(validate))
    noticeKey.value = 'captcha.verified'
    emit('success', result.captcha_token)
  } catch (error) {
    handleVerifyFailure(error)
  } finally {
    verifying.value = false
  }
}

function handleVerifyFailure(error: unknown): void {
  if (!(error instanceof AppError)) {
    noticeKey.value = 'captcha.vendorFailed'
    emit('fail', 'network_error')
    return
  }

  // 404 `not_found`：链路此刻不生效（验证码被关闭 / 提供方未配置 / 极验熔断且 failMode=open）。
  // 服务端此时**不会**要求 `captcha_token`，所以按 fail-open 直接提交登录 —— 这正是
  // `docs/frontend.md` §4.2 与变更方案 §16.2 偏差 3 要求的前端表现。
  if (error.status === 404 || error.code === 'not_found') {
    noticeKey.value = null
    noticeText.value = null
    emit('success', null)
    return
  }

  noticeText.value = errorText(error.code, error.message)
  noticeKey.value = null
  emit('fail', captchaReasonOf(error) ?? error.code)

  // §7.5 坑二：**只在服务端拒绝了这次验证时**让极验回到"未验证"态（`pass_token` 一次性，已被用掉）。
  // ⛔ 通过之后**不要** reset：我们的 `captcha_token` 120s 内可复用、密码打错不消费（§2 第 6 条）。
  // ⚠️ 这里直接调 `instance.reset()` 而**不是**外层的 `reset()`：后者会顺手清掉提示，
  //    而此刻用户正需要看到"为什么这次没过"。
  if (error.code === 'captcha_invalid') instance?.reset()
}

/**
 * 让用户重新验证一次（**对外暴露**，由 `Login.vue` 调）。
 * ⛔ 只在"确实需要重新验证"时调：① 服务端拒绝了我们的 `captcha_token`；② 用户关窗后想重来。
 */
function reset(): void {
  noticeKey.value = null
  noticeText.value = null
  verifying.value = false
  instance?.reset()
}

defineExpose({ reset })

onBeforeUnmount(() => {
  unmounted = true
  instance?.destroy?.()
  instance = null
})
</script>

<template>
  <!-- 容器由 `visible` 控制显示：DOM 在页面加载时就已经生成（§7.3 第 3 步），只是被 CSS 藏起来 -->
  <div v-show="visible" class="geetest-captcha">
    <p v-if="phase === 'loading'" class="geetest-captcha__hint">{{ t('captcha.loading') }}</p>
    <!-- ⛔ 官方按钮由 gt4.js 注入这里：不自绘按钮、不自绘弹窗（C16） -->
    <div ref="slotEl" class="geetest-captcha__slot"></div>
    <p v-if="notice" class="geetest-captcha__notice" role="status">{{ notice }}</p>
  </div>
</template>

<style scoped>
.geetest-captcha {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 占位：极验按钮注入前也要有高度，避免容器从隐藏切到可见时页面抖动 */
.geetest-captcha__slot {
  min-height: 44px;
}

.geetest-captcha__hint,
.geetest-captcha__notice {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
