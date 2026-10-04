/**
 * Vantage · 人机验证提供方工厂
 *
 * 依据：docs/geetest-captcha.md §3.2（架构：把"提供方差异"收敛到一个接缝）、§3.3（接口）、
 *       §12 C12（已定 = G1-a：极验为默认，自建滑块保留为可选 provider）
 *
 * 🔑 为什么要这一层：`services/captcha.service.js` 里的**编排语义**（触发策略、两层失败计数、
 *    一次性凭证、闸门顺序、审计）是跨提供方**完全不变**的 8 条契约（docs/geetest-captcha.md §2）。
 *    把提供方实现隔在这里，换/加提供方时那 8 条一行都不用改，也就没有被改坏的机会。
 *
 * ⚠️ `CAPTCHA_PROVIDER` 的取值（`geetest` / `selfbuilt` / `none`）定义在 `src/config/index.js`，
 *    与下面的 provider 名**刻意保持字面一致**（改一处必须改两处，故两边都留了交叉注释）。
 */

import { GEETEST_PROVIDER_NAME, createGeetestProvider } from './geetest.provider.js';
import { SELF_BUILT_PROVIDER_NAME, createSelfbuiltProvider } from './selfbuilt.provider.js';

export { GEETEST_PROVIDER_NAME, SELF_BUILT_PROVIDER_NAME };

/**
 * 提供方接口。⛔ 实现里不得出现：策略判定 / 失败计数 / 发放一次性凭证 / 写审计 / 登录流程。
 *
 * @typedef {object} CaptchaProvider
 * @property {'geetest'|'selfbuilt'} name
 * @property {() => boolean} isConfigured
 *   凭据是否齐备（⛔ 不查 Redis、不查库）。为 false 时编排层会**关掉整条链路**：
 *   出题端点 404、登录永不因人机验证被拒 —— 见 docs/geetest-captcha.md §9.4 教训一。
 * @property {'open'|'closed'} [failMode]
 *   仅对"有外部依赖"的提供方有意义：外部不可用时放行（open）还是拒绝（closed）。
 *   自建滑块恒为 closed（它没有外部依赖，Redis 故障会直接抛 → 503）。
 * @property {() => Promise<boolean>} [isVendorDown]
 *   外部服务是否处于熔断窗口。实现应保证**读不到时返回 false**（熔断是优化，不是安全控制）。
 * @property {(input: { ip: string|null, logger?: object }) => Promise<object>} issueChallenge
 *   出题。返回值**就是**路由层要回给前端的响应体（形状由提供方决定，见变更方案 §6.1）。
 * @property {(input: object) => Promise<
 *     { ok: true } |
 *     { ok: false, reason: string, detail?: object, vendorReason?: string|null, elapsedMs?: number } |
 *     { ok: false, reason: string, unavailable: true, httpStatus: number|null,
 *       vendorCode?: string|null, elapsedMs?: number, breaker?: boolean }
 *   >} verifyChallenge
 *   验题。`unavailable: true` 表示「**提供方自身不可用**，不是用户没通过」——
 *   ⛔ 这两者必须能被编排层区分开，否则失败模式（放行/拒绝）与审计口径全错。
 */

/**
 * 按配置构造提供方。
 *
 * @param {{ redis: object, config: object, logger?: object, fetchImpl?: Function|null }} deps
 * @returns {CaptchaProvider|null} `CAPTCHA_PROVIDER=none` 时返回 null（编排层据此关闭整条链路）
 */
export function createCaptchaProvider({ redis, config, logger, fetchImpl = null }) {
  const name = config.security.captcha.provider;

  if (name === 'none') return null;
  if (name === GEETEST_PROVIDER_NAME) return createGeetestProvider({ redis, config, logger, fetchImpl });
  if (name === SELF_BUILT_PROVIDER_NAME) return createSelfbuiltProvider({ redis, config, logger });

  // ⛔ 配置层的 oneOf 已经拦过一次；这里是兜底，宁可启动失败也不要静默退化成"没有验证码"
  throw new Error(`未知的人机验证提供方：${name}（CAPTCHA_PROVIDER 只接受 geetest / selfbuilt / none）`);
}
