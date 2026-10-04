/**
 * 极验 GeeTest v4 客户端装载器（`gt4.js`）。
 *
 * 依据：`docs/geetest-captcha.md` §7.1（C15：**动态注入**是推荐方案）、§7.3（初始化与 `appendTo`
 * 都在**页面加载时**完成，容器只负责隐藏）、§7.5 坑五（`captcha_id` ⛔ 不进构建期 env）、§15（资源地址）。
 *
 * 🔑 为什么是"动态注入"而不是在 `web/index.html` 里写死 `<script>`：
 *   ① `provider=selfbuilt` / `none`，或验证码被关闭、极验处于熔断窗口时**零外链** ——
 *      不把"这个站点用了极验"这件事塞给每一个只是打开登录页的人；
 *   ② `captcha_id` 由 `/auth/captcha/challenge` 运行时下发，换部署／换验证 id 不用重新构建前端产物。
 *
 * ⚠️ `gt4.js` 是 **loader**：真正的验证库还会由它继续从极验域名拉取（§15）。所以"脚本加载完成"
 *    只代表第一跳通了，**不代表极验可用**；后续失败一律走实例的 `onError`。
 * ⛔ 本文件的职责边界：把全局 `initGeetest4` 弄到手 + 声明**厂商对象的形状** + `toVerifyBody()`
 *    这个**纯形状投影**。**不做任何判定**（前端判对错 = 零防护价值），也不发任何请求。
 */

/** `gt4.js` 地址（极验的唯一常量） */
export const GT4_SCRIPT_URL = 'https://static.geetest.com/v4/gt4.js'

/** 脚本标签上的标记属性，便于排障时在 Elements 面板里一眼认出我们注入的那一个 */
const SCRIPT_DATASET_KEY = 'vantageGeetest'

/**
 * `captchaObj.getValidate()` 的返回值 —— ⚠️ **不止 4 个字段**。
 *
 * 🔑 **2026-10-04 实测**：极验 v4 的 `getValidate()` 返回的是客户端 `POST /verify` 响应里
 *    `data.seccode` 的**原样对象**，实测键序为
 *    `captcha_id, lot_number, pass_token, gen_time, captcha_output`（5 个）。
 *
 * ⛔ 因此**绝不允许把本对象整份转发**给 `/auth/captcha/verify`：服务端 schema 是
 *    `additionalProperties: false` 的白名单，多出来的 `captcha_id` 会让请求以 400
 *    `schema_invalid` 被拒（真实故障：极验弹窗显示"验证通过"，用户却永远登不进去，
 *    紧接着登录再吃一个 400 `captcha_required`）。
 * ➡️ 一律经 `toVerifyBody()` 投影后再提交。
 */
export interface GeetestValidate {
  lot_number: string
  captcha_output: string
  pass_token: string
  gen_time: string
  /**
   * 极验**会**带上它（公开值，等于 `/auth/captcha/challenge` 下发的那个）。
   * ⛔ 我们**不**把它提交给服务端：服务端用自己配置里的 `captchaId`（出站走 URL query）。
   */
  captcha_id?: string
}

/** `/auth/captcha/verify`（极验分支）的请求体：**只**有服务端白名单里的这 4 个字段 */
export type GeetestVerifyBody = Pick<
  GeetestValidate,
  'lot_number' | 'captcha_output' | 'pass_token' | 'gen_time'
>

/**
 * 把 `getValidate()` 的返回值**显式投影**成 `/auth/captcha/verify` 的请求体。
 *
 * 🔑 为什么必须显式挑字段，而不是 `captchaVerify(validate)`：
 *   ① 极验实际返回 5 个字段（见 `GeetestValidate`），整份转发必然 400 `schema_invalid`；
 *   ② 厂商**将来再加字段**时，这里不会有第二次事故 —— 白名单契约由这一处收口。
 * ⛔ 本函数是纯投影：不做判定、不丢错误、也不"顺手"补默认值。
 */
export function toVerifyBody(validate: GeetestValidate): GeetestVerifyBody {
  return {
    lot_number: validate.lot_number,
    captcha_output: validate.captcha_output,
    pass_token: validate.pass_token,
    gen_time: validate.gen_time,
  }
}

/**
 * `initGeetest4(config, callback)` 的 config。
 * ⛔ 刻意**不传** `userInfo`（变更方案 C17）：传了等于把账号交给第三方，
 *    且与「登录响应不得携带账号线索」的既有原则冲突。
 */
export interface GeetestInitOptions {
  captchaId: string
  /** `popup` = 官方按钮 + 带遮罩的验证窗（C16 已定）；由服务端经 challenge 下发，前端不硬编码 */
  product?: 'popup' | 'float'
  /** 验证窗语言（`zho` / `eng` …）；同样由服务端下发 */
  language?: string
  /**
   * 协议头（`https://`）。
   * ⚠️ 官方明确提示"本地或者混合开发一定要手动设置，否则一般会自动取到 file 协议"；
   *    我们**一律写 `https://`**：与变更方案 §4.2「服务端 `validate` 一律用 HTTPS」保持同一口径，
   *    也避免面板本身跑在 `http://`（自托管内网常见）时把极验的资源与接口请求降级成明文。
   */
  protocol?: string
}

/**
 * 极验实例（只声明**我们用得到**的成员）。
 * ⚠️ `onFail` / `destroy` 标为可选：我们不假装知道所有版本都提供它们（`?.` 调用）。
 */
export interface GeetestInstance {
  /** 把官方按钮／验证窗挂进宿主页面（⛔ 我们不自己画按钮） */
  appendTo(selector: string | HTMLElement): void
  /** ⚠️ **未成功验证时返回 `false`**（§7.5 坑一）——调用方必须先判它 */
  getValidate(): GeetestValidate | false
  /** 让用户重新验证一次（⛔ 只在"确实需要重新验证"时调用，见 §7.5 坑二） */
  reset(): void
  onReady(callback: () => void): void
  onSuccess(callback: () => void): void
  /** ⚠️ 入参是**极验自己**的错误码，⛔ 不要展示给用户、不要与本服务的 `error.code` 混用（坑三） */
  onError(callback: (error: { code?: string; msg?: string }) => void): void
  /** 用户关闭验证窗（⛔ 必须提示，否则看起来像卡死 —— 坑四） */
  onClose(callback: () => void): void
  onFail?(callback: () => void): void
  destroy?(): void
}

declare global {
  interface Window {
    /**
     * 极验 v4 的全局入口（由 `gt4.js` 挂载）。
     * ⚠️ 标为可选：脚本未加载／被拦截时它就是 `undefined`，调用方必须先 `loadGeetest()`。
     */
    initGeetest4?: (options: GeetestInitOptions, callback: (instance: GeetestInstance) => void) => void
  }
}

/** 在途的加载 Promise（幂等：同一页面只注入一次脚本标签） */
let pending: Promise<void> | null = null

function injectScript(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GT4_SCRIPT_URL
    script.async = true
    script.dataset[SCRIPT_DATASET_KEY] = 'gt4'
    script.addEventListener('load', () => resolve())
    script.addEventListener('error', () => {
      // 失败的标签直接摘掉：留着会让"重试"看起来像已经加载过
      script.remove()
      reject(new Error(`gt4.js 加载失败：${GT4_SCRIPT_URL}`))
    })
    document.head.appendChild(script)
  })
}

/**
 * 确保全局 `initGeetest4` 可用。
 *
 * ⚠️ 失败时**不缓存失败结果**（把在途 Promise 清空），让下一次调用可以重试 ——
 *    内网抖动场景下"一次加载失败就在本次会话里永久判死"会让登录页彻底没有验证入口。
 *
 * @throws 脚本加载失败 / 加载成功但没挂上 `initGeetest4`
 */
export async function loadGeetest(): Promise<void> {
  if (typeof window.initGeetest4 === 'function') return

  if (!pending) {
    pending = injectScript()
      .then(() => {
        if (typeof window.initGeetest4 !== 'function') {
          throw new Error('gt4.js 已加载但未挂载 initGeetest4')
        }
      })
      .catch((error: unknown) => {
        pending = null
        throw error
      })
  }

  await pending
}
