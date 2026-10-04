/**
 * Vantage · 人机验证提供方：**极验 GeeTest v4**（`CAPTCHA_PROVIDER=geetest`）
 *
 * 依据：docs/geetest-captcha.md §3.3（提供方接口）、§4（协议）、§5（改动清单）、§8.1（配置）、
 *       §9（失败模式：fail-open/closed + 熔断 + 审计口径）
 *
 * 职责边界（与编排层的分工）：
 *   ✅ 本文件负责：拼参数 + 签名 + 发一次 HTTPS 请求 + **把响应归一化成"过/没过/不可用"** + 熔断标记
 *   ⛔ 本文件**不做**：策略判定、失败计数、发放一次性凭证、写审计、碰登录流程
 *
 * 🔑 三条不可动摇的规则
 *  1. **未配置 ≠ 放行**：`isConfigured()===false` 时 `verifyChallenge()` 返回"不可用"，
 *     ⛔ 绝不返回 `ok:true`。编排层据此把整条链路关掉（出题 404）——这才是"静默失效"的正确处理。
 *     （前车之鉴见 docs/geetest-captcha.md §9.4 教训一：未配置时 `verify()` 直接放行）
 *  2. **不重试**：超时/异常只发一次请求。重试会把 3s 变成 6s/9s，并把流量翻倍打到已经出问题的极验上。
 *  3. **不可用与"没通过"必须分开**：前者走 `failMode`（放行或 503），后者才是 400 `captcha_invalid`。
 *     ⛔ 混为一谈会把「极验挂了」记成「用户作弊」。
 *
 * ⛔ 日志与审计纪律：`captcha_key` / `sign_token` / `pass_token` / `captcha_output` / `lot_number`
 *    **一律不得**进日志。本文件只记 http_status / elapsed_ms / vendor_code / 熔断状态。
 */

import { TTL_S, keys } from '../../../utils/redisKeys.js';
import {
  GEETEST_REASON,
  buildValidateBody,
  buildValidateUrl,
  parseValidateResponse,
} from '../../../utils/geetest.js';

export const GEETEST_PROVIDER_NAME = 'geetest';

/**
 * 创建极验提供方。
 * @param {{ redis: import('ioredis').Redis, config: object, logger?: object, fetchImpl?: Function|null }} deps
 *   `fetchImpl` 只为测试注入（⛔ 测试**绝不能**真连极验）；生产传 null → 用 Node ≥22 的内置 fetch。
 * @returns {import('./index.js').CaptchaProvider}
 */
export function createGeetestProvider({ redis, config, logger, fetchImpl = null }) {
  const geetest = config.security.captcha.geetest;
  const { captchaId, captchaKey, apiServer, timeoutMs, failMode, product, language } = geetest;

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const configured = Boolean(captchaId && captchaKey && typeof doFetch === 'function');
  const breakerKey = keys.captchaVendorDown(GEETEST_PROVIDER_NAME);

  /**
   * 熔断标记：读失败按"未熔断"处理。
   * 🔑 这是**性能优化，不是安全控制**——放行/拒绝由 `failMode` 决定，
   *    所以这里读不到时继续走正常的（会超时的）路径才是正确取舍。
   */
  async function isVendorDown() {
    try {
      return (await redis.exists(breakerKey)) === 1;
    } catch (err) {
      logger?.warn?.({ err }, '极验熔断标记读取失败（按未熔断处理）');
      return false;
    }
  }

  async function tripBreaker() {
    try {
      await redis.set(breakerKey, String(Date.now()), 'EX', TTL_S.captchaVendorDown);
    } catch (err) {
      logger?.warn?.({ err }, '极验熔断标记写入失败（下次仍会正常尝试）');
    }
  }

  return {
    name: GEETEST_PROVIDER_NAME,
    isConfigured: () => configured,
    isVendorDown,
    failMode,

    /**
     * 「出题」——极验下我们无事可做：题目与答案都由极验云端管理，服务端**没有答案可存**。
     * 这里只下发前端 `initGeetest4()` 需要的公开配置（`captcha_id` 本来就是公开值）。
     * ⚠️ 因此响应里**没有** `expires_in`：题目有效期由极验掌握，我们唯一能承诺的 TTL
     *    是验题通过后自己发的一次性凭证（在 `/captcha/verify` 的响应里）。
     */
    async issueChallenge({ ip }) {
      logger?.debug?.({ ip, product }, '极验人机验证已下发前端配置');
      return {
        provider: GEETEST_PROVIDER_NAME,
        captcha_id: captchaId,
        product,
        language,
      };
    },

    /**
     * 二次校验：把前端 `getValidate()` 的 4 个参数转发给极验 `/validate`。
     *
     * ⚠️ 入参**直接就是 `/captcha/verify` 的请求体**（路由层原样透传），所以字段名是**线上的
     *    snake_case**（`lot_number` / `captcha_output` / `pass_token` / `gen_time`），
     *    ⛔ 不要改成驼峰 —— 那样解构出来全是 undefined，而 schema 又拦不住（字段都在，只是没人读）。
     *
     * @param {{ lot_number: string, captcha_output: string, pass_token: string, gen_time: string }} input
     * @returns {Promise<
     *   { ok: true } |
     *   { ok: false, reason: string, vendorReason?: string|null, elapsedMs: number } |
     *   { ok: false, reason: string, unavailable: true, httpStatus: number|null, vendorCode?: string|null,
     *     elapsedMs?: number, breaker?: boolean }
     * >}
     */
    async verifyChallenge({ lot_number, captcha_output, pass_token, gen_time }) {
      // ① 未配置：⛔ 绝不返回 ok:true（文件头第 1 条）
      if (!configured) {
        return {
          ok: false,
          reason: GEETEST_REASON.unavailable,
          unavailable: true,
          httpStatus: null,
          elapsedMs: 0,
        };
      }

      // ② 熔断中：直接给出"不可用"，不再干等一次超时（省的是**每次登录**的 3s）
      if (await isVendorDown()) {
        return {
          ok: false,
          reason: GEETEST_REASON.unavailable,
          unavailable: true,
          httpStatus: null,
          elapsedMs: 0,
          breaker: true,
        };
      }

      // ③ 真发一次请求（⛔ 不重试）
      const startedAt = Date.now();
      let httpStatus = null;
      let body = null;
      try {
        const response = await doFetch(buildValidateUrl({ apiServer, captchaId }), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: buildValidateBody({
            lotNumber: lot_number,
            captchaOutput: captcha_output,
            passToken: pass_token,
            genTime: gen_time,
            captchaKey,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        httpStatus = response.status;
        body = await response.text();
      } catch (err) {
        const elapsedMs = Date.now() - startedAt;
        // 只记错误类型与耗时：⛔ 不记请求体（含 sign_token）
        logger?.error?.(
          { err: err?.name ?? 'FetchError', elapsed_ms: elapsedMs, timeout_ms: timeoutMs },
          '极验二次校验请求失败（网络/超时）→ 计入熔断',
        );
        await tripBreaker();
        return {
          ok: false,
          reason: GEETEST_REASON.unavailable,
          unavailable: true,
          httpStatus,
          elapsedMs,
        };
      }

      const result = parseValidateResponse({ httpStatus, body });
      const elapsedMs = Date.now() - startedAt;

      if (result.unavailable) {
        logger?.error?.(
          { http_status: httpStatus, vendor_code: result.vendorCode ?? null, elapsed_ms: elapsedMs },
          '极验二次校验不可用（HTTP 非 200 / 非 JSON / error 形状）→ 计入熔断',
        );
        await tripBreaker();
      } else {
        logger?.debug?.(
          { http_status: httpStatus, elapsed_ms: elapsedMs, result: result.ok ? 'success' : 'fail' },
          '极验二次校验完成',
        );
      }

      return { ...result, elapsedMs };
    },
  };
}
