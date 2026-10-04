<script setup lang="ts">
/**
 * 滑块人机验证组件（S3 交付物）。
 *
 * 依据：
 * - `docs/slider-captcha-selfbuilt.md` §5.1 / §5.2（两个端点契约）、§7.1（组件规范：props/emits/交互）、
 *   §7.5（降级与无障碍）；
 * - `docs/api.md` §4.1 的 `POST /api/v1/auth/captcha/challenge` 与 `POST /api/v1/auth/captcha/verify`。
 *
 * ⛔ 安全约束（都不是风格问题，改之前先读依据）：
 * - ⛔ 前端**不得**判定滑动是否对齐：对错只听服务端（§6.2）。前端判对错 = 纯前端滑块 = 零防护；
 * - ⛔ `v-html` **只**渲染 `bg_svg` / `piece_svg` 这两个来自本服务端 challenge 响应的字符串；
 *   用户输入、URL 参数、i18n 文案以及任何其它来源的字符串**一律不得**进入 `v-html`；
 * - ⛔ 不预加载、不轮询：组件只在被挂载（服务端确实要求人机验证）时才请求 challenge，
 *   首次进入登录页不出题（§7.2 最后一行）；
 * - ⛔ 组件内不硬编码任何文案（全部走 i18n，§7.4）。
 *
 * 交互取舍（写清楚，避免被当成 bug）：
 * - 只做横向滑动，故 verify 不传 `y`（契约里 `y` 是可选的，§5.2）；
 * - 「点一下没拖」与「没移动就按 Enter」不提交：服务端的轨迹规则要求 ≥8 点，退化轨迹只会白烧一次
 *   `attempts`。⛔ 这不是前端判对错 —— 前端从不判断是否对齐，只是不提交退化轨迹。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { AppError } from '@/api/http'
import { authApi, captchaReasonOf } from '@/api/private'
import type { CaptchaTrackPoint, SelfbuiltCaptchaChallenge } from '@/api/private'
import { errorText } from '@/i18n'

const props = defineProps<{
  /** 显示宽度（px）；默认取 challenge 响应的逻辑宽度 */
  width?: number
  /** 显示高度（px）；默认按逻辑高度等比缩放 */
  height?: number
}>()

const emit = defineEmits<{
  /** 服务端验题通过：一次性 `captcha_token`（调用方应立刻拿它自动重提登录） */
  success: [captchaToken: string]
  /** 验题失败：`reason` ∈ `mismatch` / `track_suspicious` / `expired` / `not_found` / `too_many_attempts` */
  fail: [reason: string]
  cancel: []
}>()

const { t } = useI18n()

type Phase = 'loading' | 'ready' | 'verifying' | 'done' | 'error'

/** 轨迹点数上限：与服务端一致（§5.2 `track` 上限 200 点，超了会 400 `schema_invalid`） */
const MAX_TRACK_POINTS = 200
/** 采样最小间隔（ms）：pointermove 每秒可达上百次；节流后仍远多于服务端要求的 8 点 */
const MIN_SAMPLE_INTERVAL_MS = 16
/** 键盘每次移动 5px（§7.1 可访问性要求） */
const KEYBOARD_STEP_PX = 5
/** 抖动动画时长（与 <style> 的 keyframes 一致，用于抖动结束后回位） */
const SHAKE_MS = 360

const phase = ref<Phase>('loading')
/**
 * 取到的**自建分支**题目。
 * ⚠️ 类型是收窄后的 `SelfbuiltCaptchaChallenge`（challenge 响应按 `provider` 判别）：
 *    本组件只处理 `provider='selfbuilt'`，极验分支的字段由 `GeetestCaptcha.vue` 消费。
 */
const challenge = ref<SelfbuiltCaptchaChallenge | null>(null)

/** 提示文案：`noticeKey` 走 i18n（可随语言切换），`noticeText` 是服务端错误码映射后的快照文案 */
const noticeKey = ref<string | null>(null)
const noticeText = ref<string | null>(null)
const notice = computed(() => noticeText.value ?? (noticeKey.value ? t(noticeKey.value) : null))
const noticeTone = computed<'error' | 'success' | null>(() => {
  if (!notice.value) return null
  return noticeKey.value === 'captcha.verified' ? 'success' : 'error'
})

/** 拼图块当前**逻辑**横坐标（起点 0）；提交给服务端的 `x` 就是它 —— ⛔ 前端不判断它对不对 */
const pieceX = ref(0)
/** 量出来的拼图块逻辑宽度，用于把拖动限制在 `[0, width - pieceWidth]`（§7.1） */
const pieceWidth = ref(0)
const dragging = ref(false)
const shaking = ref(false)

const pieceEl = ref<HTMLElement | null>(null)
const stageEl = ref<HTMLElement | null>(null)
/** 滑块轨道与手柄（2026-10-03 新增：把"拖图"补成"也有滑块条"，见 §7.1） */
const trackEl = ref<HTMLElement | null>(null)
const handleEl = ref<HTMLElement | null>(null)

/** 采集到的轨迹 `[[t_ms, x], …]`；`t_ms` 相对拖拽起点（服务端只用首尾差判时长） */
const track = ref<CaptchaTrackPoint[]>([])
let dragStartClientX = 0
let dragStartPieceX = 0
let dragStartAt = 0
let activePointerId: number | null = null
/** 本次拖拽的换算系数：**逻辑 px / CSS px**（图片拖动 = 1/scale；手柄拖动 = 轨道行程比） */
let dragCssToLogical = 1
/** 本次拖拽的指针捕获元素（图片=stage，手柄=track），松手/取消时释放 */
let captureEl: HTMLElement | null = null
let shakeTimer: number | undefined

/** 滑块手柄宽度（CSS px）。⛔ 必须与 <style> 里 `.slider-captcha__handle` 的 width 一致 */
const HANDLE_WIDTH_PX = 40

const logicalWidth = computed(() => challenge.value?.width ?? 0)
const logicalHeight = computed(() => challenge.value?.height ?? 0)
const viewportWidth = computed(() => props.width ?? logicalWidth.value)
/** 显示尺寸 / 逻辑尺寸：⛔ 提交的坐标必须是**逻辑**坐标，指针位移要除回这个比例 */
const scale = computed(() => (logicalWidth.value > 0 ? viewportWidth.value / logicalWidth.value : 1))
const viewportHeight = computed(() => props.height ?? logicalHeight.value * scale.value)

/**
 * 量拼图块**自身**的宽度（逻辑 px）。
 *
 * ⚠️ ⛔ 不要用 `pieceEl.offsetWidth`：服务端返回的 `piece_svg` 与**画布同尺寸**（320×160），
 *    量出来恒等于画布宽 → 只能走 15% 兜底（48px，而拼图块真实宽度是 44+10=54px），
 *    结果是允许拼图块多拖 6px 出画布（被 `overflow:hidden` 裁掉，不致命但是错的）。
 *    改量 SVG **内容包围盒**（`getBBox()` 返回 viewBox 用户单位 = 逻辑 px），与画布尺寸解耦。
 */
function measurePiece(): void {
  const width = logicalWidth.value
  const svg = pieceEl.value?.querySelector('svg')
  if (svg && typeof svg.getBBox === 'function') {
    try {
      const box = svg.getBBox()
      if (box.width > 0 && box.width < width) {
        pieceWidth.value = box.width
        return
      }
    } catch {
      // 未渲染 / 引擎不支持：落到下面的兜底
    }
  }
  const measured = pieceEl.value?.offsetWidth ?? 0
  pieceWidth.value = measured > 0 && measured < width ? measured : 0
}

/**
 * 拖动上限 = `width - pieceWidth`（§7.1）：拼图块**左边缘**能到的最大逻辑坐标。
 * 量不到拼图块宽度时退回 15% 画布宽 —— 宁可多给一点行程，也不要把行程退化成 0（那样根本没法拖）。
 */
const travelMax = computed(() => {
  const width = logicalWidth.value
  if (width <= 0) return 0
  const piece = pieceWidth.value > 0 ? pieceWidth.value : width * 0.15
  return Math.max(0, width - piece)
})

/** 手柄在轨道行程上的比例（0–1）。轨道可用行程 = 轨道宽 − 手柄宽，对应逻辑区间 `[0, travelMax]` */
const handleRatio = computed(() => {
  const max = travelMax.value
  if (max <= 0) return 0
  return clamp(pieceX.value / max, 0, 1)
})

/** 用 `left: calc((100% - 手柄宽) × 比例)` 定位，⛔ 不需要测量轨道宽度（键盘/窗口变化都跟得上） */
const handleStyle = computed(() => ({
  left: `calc((100% - ${HANDLE_WIDTH_PX}px) * ${Math.round(handleRatio.value * 1e4) / 1e4})`,
}))
/** 已拖过的进度条：铺到把手的中心位置 */
const trackFillStyle = computed(() => ({
  width: `calc(${HANDLE_WIDTH_PX / 2}px + (100% - ${HANDLE_WIDTH_PX}px) * ${Math.round(handleRatio.value * 1e4) / 1e4})`,
}))

const viewportStyle = computed(() => ({
  width: `${viewportWidth.value}px`,
  height: `${viewportHeight.value}px`,
}))
const stageStyle = computed(() => ({
  width: `${logicalWidth.value}px`,
  height: `${logicalHeight.value}px`,
  transform: `scale(${scale.value})`,
}))

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function resetPiece(): void {
  pieceX.value = 0
  track.value = []
  activePointerId = null
}

/** 抖动回位（失败时）：抖完再回起点，用户能看出"没对上" */
function shakeAndReset(): void {
  shaking.value = true
  if (shakeTimer !== undefined) window.clearTimeout(shakeTimer)
  shakeTimer = window.setTimeout(() => {
    shaking.value = false
    resetPiece()
    shakeTimer = undefined
  }, SHAKE_MS)
}

async function loadChallenge(): Promise<void> {
  phase.value = 'loading'
  challenge.value = null
  resetPiece()
  try {
    const config = await authApi.captchaChallenge()
    // ⚠️ 本组件只认自建分支。`Login.vue` 是按响应里的 `provider` 选组件的，所以走到这里
    //    说明两侧不一致（例如服务端刚被切到极验）→ 按"不可用"处理。
    //    ⛔ 不要去猜极验分支的字段（那边没有 bg_svg/width，硬渲染只会得到一张空图）。
    if (config.provider !== 'selfbuilt') {
      throw new AppError({
        code: 'captcha_unavailable',
        message: `提供方不匹配：本组件只支持 selfbuilt，服务端返回 ${config.provider}`,
        status: 0,
      })
    }
    challenge.value = config
    phase.value = 'ready'
    await nextTick()
    measurePiece()
  } catch (error) {
    phase.value = 'error'
    // 404 = 出题端点被开关关闭（§5.1）→ 只给通用提示，⛔ 不向用户暴露"存在但被关"
    noticeText.value =
      error instanceof AppError && error.status !== 404 ? errorText(error.code, error.message) : null
    noticeKey.value = 'captcha.unavailable'
    emit('fail', error instanceof AppError ? error.code : 'network_error')
  }
}

function refresh(): void {
  noticeText.value = null
  noticeKey.value = null
  void loadChallenge()
}

/** 追加一个轨迹采样点（节流 + 硬上限） */
function pushSample(force = false): void {
  const at = Math.round(performance.now() - dragStartAt)
  const x = round2(pieceX.value)
  const last = track.value[track.value.length - 1]
  if (!force && last) {
    if (at - last[0] < MIN_SAMPLE_INTERVAL_MS) return
    if (last[1] === x) return
  }
  if (track.value.length >= MAX_TRACK_POINTS) return
  track.value.push([at, x])
}

/**
 * 提交前的轨迹收尾：保证「末点 x == 提交 x」（服务端规则，§6.2）。
 * 采满 200 点时挤掉一个旧点，⛔ 不能让末点与提交值不一致。
 */
function finalTrack(): CaptchaTrackPoint[] {
  const points = track.value.slice()
  const x = round2(pieceX.value)
  const last = points[points.length - 1]
  if (last && last[1] === x) return points
  if (points.length >= MAX_TRACK_POINTS) points.pop()
  points.push([Math.round(performance.now() - dragStartAt), x])
  return points
}

async function submit(): Promise<void> {
  const current = challenge.value
  if (!current || phase.value !== 'ready') return
  phase.value = 'verifying'
  noticeText.value = null
  noticeKey.value = null
  try {
    const result = await authApi.captchaVerify({
      captcha_id: current.captcha_id,
      x: round2(pieceX.value),
      track: finalTrack(),
    })
    // 题目是一次性的（服务端验过即 DEL），故成功即锁定本组件：Token 失效时由调用方
    // 换 key 重新挂载来换题（见 Login.vue 的 captcha_invalid 分支）。
    phase.value = 'done'
    noticeKey.value = 'captcha.verified'
    emit('success', result.captcha_token)
  } catch (error) {
    handleVerifyFailure(error)
  }
}

function handleVerifyFailure(error: unknown): void {
  const reason = captchaReasonOf(error)
  phase.value = 'ready'
  emit('fail', reason ?? (error instanceof AppError ? error.code : 'network_error'))

  if (!(error instanceof AppError) || error.code !== 'captcha_invalid') {
    // 限流 / 上游不可用 / 网络：题目本身还有效，保留当前题并给出对应提示
    noticeText.value = error instanceof AppError ? errorText(error.code, error.message) : null
    noticeKey.value = noticeText.value ? null : 'captcha.unavailable'
    return
  }

  switch (reason) {
    case 'expired':
    case 'not_found':
      // 题目已过期 / 已被作废：自动换一张（§7.2），提示沿用旧文案但内容已换
      void loadChallenge()
      noticeKey.value = 'captcha.expired'
      return
    case 'too_many_attempts':
      // 同一题失败 ≥3 次已作废（§5.2）：提示「换一张」并自动重出
      void loadChallenge()
      noticeKey.value = 'captcha.tooManyAttempts'
      return
    case 'track_suspicious':
      noticeKey.value = 'captcha.suspicious'
      shakeAndReset()
      return
    default:
      // mismatch：偏差超容差（⛔ 前端不判对错，只回位重试）
      noticeKey.value = 'captcha.failed'
      shakeAndReset()
  }
}

/**
 * 开始拖拽。两个拖动面（图片 / 手柄）共用同一套位移与采样逻辑，只有"CSS → 逻辑"的换算不同。
 *
 * @param cssToLogical 换算系数：逻辑 px / CSS px
 * @param captureTarget 指针捕获元素（图片面 = stage，手柄面 = track）
 */
function beginDrag(
  event: PointerEvent,
  cssToLogical: number,
  captureTarget: HTMLElement | null,
): void {
  // 抖动回位期间不接受新的拖动：否则抖动结束时会把拖动起点一起归零
  if (phase.value !== 'ready' || shaking.value) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  event.preventDefault()
  dragging.value = true
  activePointerId = event.pointerId
  dragStartClientX = event.clientX
  dragStartPieceX = pieceX.value
  dragStartAt = performance.now()
  dragCssToLogical = cssToLogical
  track.value = [[0, round2(pieceX.value)]]
  captureEl = captureTarget
  captureTarget?.setPointerCapture?.(event.pointerId)
}

/** 拖动面①：直接拖图片（原有交互，保留）。逻辑 px = CSS px / scale */
function onPointerDown(event: PointerEvent): void {
  beginDrag(event, 1 / (scale.value || 1), stageEl.value)
}

/**
 * 拖动面②：拖滑块手柄（轨道任意处按下都算，手柄是轨道子元素）。
 * 轨道可用行程 = 轨道宽 − 手柄宽，它与逻辑区间 `[0, travelMax]` 一一对应，
 * 故换算系数 = `travelMax / (轨道宽 − 手柄宽)`；拖动开始时量一次即可（⛔ 不进每帧）。
 */
function onHandlePointerDown(event: PointerEvent): void {
  const trackWidth = trackEl.value?.getBoundingClientRect().width ?? 0
  const handleWidth = handleEl.value?.offsetWidth ?? HANDLE_WIDTH_PX
  const handleTravel = Math.max(1, trackWidth - handleWidth)
  beginDrag(event, travelMax.value / handleTravel, trackEl.value)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value || event.pointerId !== activePointerId) return
  const dx = (event.clientX - dragStartClientX) * dragCssToLogical
  pieceX.value = clamp(dragStartPieceX + dx, 0, travelMax.value)
  pushSample()
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging.value || event.pointerId !== activePointerId) return
  dragging.value = false
  activePointerId = null
  const el = captureEl
  captureEl = null
  if (el?.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
  // 松手即调 verify（§7.1）；没位移就不提交（见文件头「交互取舍」）
  if (track.value.length < 2) {
    resetPiece()
    return
  }
  void submit()
}

function onPointerCancel(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return
  dragging.value = false
  captureEl = null
  resetPiece()
}

/** 键盘通道（挂**手柄**上）：`←/→` 每次 5px，`Enter` 提交（§7.1 / §7.5） */
function onKeydown(event: KeyboardEvent): void {
  if (phase.value !== 'ready') return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    if (track.value.length === 0) {
      dragStartAt = performance.now()
      track.value = [[0, round2(pieceX.value)]]
    }
    const delta = event.key === 'ArrowRight' ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX
    const next = clamp(pieceX.value + delta, 0, travelMax.value)
    if (next === pieceX.value) return
    pieceX.value = next
    pushSample(true)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (track.value.length < 2) return
    void submit()
  }
}

onMounted(() => {
  void loadChallenge()
})

onBeforeUnmount(() => {
  if (shakeTimer !== undefined) window.clearTimeout(shakeTimer)
})
</script>

<template>
  <section class="slider-captcha" :aria-busy="phase === 'loading'">
    <div class="slider-captcha__head">
      <span class="slider-captcha__title">{{ t('captcha.title') }}</span>
    </div>

    <p v-if="phase === 'loading'" class="slider-captcha__notice" role="status">
      {{ t('captcha.loading') }}
    </p>

    <!-- 出题失败（限流 / Redis 不可用 / 开关关闭）：fail-closed，⛔ 不静默放行（§7.5-3） -->
    <ElAlert
      v-else-if="!challenge"
      type="error"
      :closable="false"
      show-icon
      :title="notice ?? t('captcha.unavailable')"
    >
      <ElButton size="small" @click="refresh">{{ t('captcha.retry') }}</ElButton>
    </ElAlert>

    <template v-else>
      <div class="slider-captcha__viewport" :style="viewportStyle">
        <!--
          ⛔ v-html 只允许渲染 challenge 响应里的 bg_svg / piece_svg（服务端生成的 SVG 文本）。
          ⛔ 绝不把用户输入、URL 参数、i18n 文案或任何其它来源的字符串交给 v-html。
        -->
        <div
          ref="stageEl"
          class="slider-captcha__stage"
          :class="{ 'is-dragging': dragging, 'is-shaking': shaking }"
          :style="stageStyle"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerCancel"
        >
          <div class="slider-captcha__bg" v-html="challenge.bg_svg" />
          <div
            ref="pieceEl"
            class="slider-captcha__piece"
            :style="{ transform: `translate3d(${pieceX}px, 0, 0)` }"
            v-html="challenge.piece_svg"
          />
        </div>
      </div>

      <!--
        滑块轨道 + 手柄（2026-10-03 新增）：与拼图块联动，解决"提示说拖动滑块、界面上却没有滑块"。
        ✅ 无障碍：`role="slider"` 与 `tabindex` 放在**手柄**上（ARIA slider 的惯用位置），
        `←/→` 每次 5px、`Enter` 提交；图片拖动面因此退化为纯指针交互（见 §7.1）。
      -->
      <div
        ref="trackEl"
        class="slider-captcha__track"
        :class="{ 'is-dragging': dragging, 'is-disabled': phase !== 'ready' }"
        @pointerdown="onHandlePointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
      >
        <span class="slider-captcha__track-fill" :style="trackFillStyle" aria-hidden="true" />
        <span class="slider-captcha__track-text" aria-hidden="true">{{ t('captcha.hint') }}</span>
        <div
          ref="handleEl"
          class="slider-captcha__handle"
          :style="handleStyle"
          role="slider"
          tabindex="0"
          :aria-label="t('captcha.ariaLabel')"
          aria-valuemin="0"
          :aria-valuemax="Math.round(travelMax)"
          :aria-valuenow="Math.round(pieceX)"
          :aria-disabled="phase !== 'ready'"
          @keydown="onKeydown"
        >
          <span class="slider-captcha__handle-icon" aria-hidden="true">››</span>
        </div>
      </div>
    </template>

    <div class="slider-captcha__foot">
      <p
        class="slider-captcha__notice"
        :class="{ 'is-error': noticeTone === 'error', 'is-success': noticeTone === 'success' }"
        role="status"
        aria-live="polite"
      >
        {{ notice ?? '' }}
      </p>
      <div class="slider-captcha__actions">
        <ElButton
          size="small"
          text
          type="primary"
          :disabled="phase === 'loading'"
          @click="refresh"
        >
          {{ t('captcha.refresh') }}
        </ElButton>
        <ElButton size="small" text @click="emit('cancel')">{{ t('captcha.cancel') }}</ElButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 配色一律走 Element Plus 主题变量（桥接层在 src/styles/element-overrides.scss） */
.slider-captcha {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-blank);
}

.slider-captcha__head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.slider-captcha__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.slider-captcha__notice {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.slider-captcha__notice.is-error {
  color: var(--el-color-danger);
}

.slider-captcha__notice.is-success {
  color: var(--el-color-success);
}

.slider-captcha__viewport {
  position: relative;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color);
  /* 触屏拖动的前提：不让浏览器把拖动解释成页面滚动 */
  touch-action: none;
  user-select: none;
}

.slider-captcha__stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
  outline: none;
  cursor: grab;
}

/* ⚠️ 焦点样式已随 `role="slider"` 一起移到手柄（见下方 `.slider-captcha__handle:focus-visible`） */
.slider-captcha__stage:active {
  cursor: grabbing;
}

.slider-captcha__bg {
  width: 100%;
  height: 100%;
}

/* v-html 的 SVG 不在 scoped 作用域内，必须用 :deep() */
.slider-captcha__bg :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.slider-captcha__piece {
  position: absolute;
  top: 0;
  left: 0;
  will-change: transform;
  transition: transform 200ms ease;
}

.slider-captcha__piece :deep(svg) {
  display: block;
  max-width: 100%;
}

/* 拖动时不要有过渡，否则拼图块跟不上指针 */
.slider-captcha__stage.is-dragging .slider-captcha__piece {
  transition: none;
}

.slider-captcha__stage.is-shaking .slider-captcha__piece {
  animation: slider-captcha-shake 120ms ease-in-out 3;
}

@keyframes slider-captcha-shake {
  0%,
  100% {
    margin-left: 0;
  }
  25% {
    margin-left: -6px;
  }
  75% {
    margin-left: 6px;
  }
}

.slider-captcha__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}

.slider-captcha__actions {
  display: flex;
  flex: none;
  gap: 4px;
}

/* ---- 滑块轨道 + 手柄（2026-10-03 新增，见 §7.1）------------------------------------
 * 配色走我们自己桥接过的变量（`--vc-*` 与已映射的 `--el-border-color` 等），
 * ⛔ 不用未桥接的 `--el-color-primary-light-*`（那是按需引入时才存在的变量）。 */
.slider-captcha__track {
  position: relative;
  height: 40px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--vc-canvas);
  overflow: hidden;
  /* 触屏拖动的前提：不让浏览器把拖动解释成页面滚动 */
  touch-action: none;
  user-select: none;
}

.slider-captcha__track-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: color-mix(in srgb, var(--vc-accent) 22%, transparent);
  transition: width 200ms ease;
}

.slider-captcha__track-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  /* 文案只作提示，指针事件交给轨道本身 */
  pointer-events: none;
}

.slider-captcha__handle {
  position: absolute;
  top: 0;
  /* width 必须与脚本里的 HANDLE_WIDTH_PX 一致 */
  width: 40px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--vc-surface);
  color: var(--vc-text);
  cursor: grab;
  transition: left 200ms ease;
}

.slider-captcha__handle-icon {
  font-size: 16px;
  letter-spacing: -2px;
}

.slider-captcha__track.is-dragging .slider-captcha__handle {
  cursor: grabbing;
  /* 拖动时不要有过渡，否则手柄跟不上指针 */
  transition: none;
}

.slider-captcha__track.is-dragging .slider-captcha__track-fill {
  transition: none;
}

.slider-captcha__track.is-disabled {
  opacity: 0.6;
}

.slider-captcha__handle:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: -2px;
}
</style>
