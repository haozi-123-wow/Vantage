/**
 * Vantage · 人机验证提供方：**自建滑块**（`CAPTCHA_PROVIDER=selfbuilt`）
 *
 * 依据：docs/slider-captcha-selfbuilt.md §4（存储）、§5（接口契约）、§6（算法规范）
 *
 * 本文件是把原 `services/captcha.service.js` 里的滑块实现**原样搬出来**的结果（S6 纯重构），
 * 目的是让"提供方差异"收敛到 `createXxxProvider()` 这一个接缝上（docs/geetest-captcha.md §3）。
 *
 * 🔑 与编排层（`services/captcha.service.js`）的分工：
 *   · 本文件只回答「这道题怎么出 / 这次判定过没过」；
 *   · ⛔ 策略（是否要求验证）、失败计数、一次性凭证、审计、登录流程**都不在这里**。
 *
 * ✅ 保留它的理由（C12 = G1-a）：它是**内网/离线部署的唯一可用选项**（零外部依赖），
 *    也是极验不可用时的回滚目标。⛔ 不要因为"默认换极验了"就删掉它。
 */

import { randomToken } from '../../../utils/crypto.js';
import { keys } from '../../../utils/redisKeys.js';
import {
  SLIDER_HEIGHT,
  SLIDER_WIDTH,
  buildChallengeSvg,
  generateChallenge,
  toleranceForWidth,
  verifySlider,
} from '../../../utils/slider.js';

export const SELF_BUILT_PROVIDER_NAME = 'selfbuilt';

/**
 * 创建自建滑块提供方。
 * @param {{ redis: import('ioredis').Redis, config: object, logger?: object }} deps
 * @returns {import('./index.js').CaptchaProvider}
 */
export function createSelfbuiltProvider({ redis, config, logger }) {
  const ttlS = config.security.captcha.ttlS;
  const maxAttempts = config.security.captcha.maxAttempts;
  const tolerancePx = config.security.captcha.tolerancePx;

  return {
    name: SELF_BUILT_PROVIDER_NAME,

    /** 自建提供方是纯代码 + 本地 Redis，没有"凭据没配"这一态 */
    isConfigured: () => true,

    /**
     * 自建提供方**不存在"外部不可用"**：Redis 故障一律向上抛（由 errors.js 折叠为 503），
     * 因此 `failMode` 恒为 `closed`——编排层也就永远不会为它走"放行"分支。
     */
    failMode: 'closed',

    /**
     * 出题。答案（缺口位置）只写进 Redis，⛔ 响应里没有它。
     * @param {{ ip: string|null }} input
     */
    async issueChallenge({ ip }) {
      const answer = generateChallenge();
      const { bgSvg, pieceSvg } = buildChallengeSvg(answer);
      const captchaId = randomToken(16);
      const key = keys.captcha(captchaId);

      const multi = redis.multi();
      multi.hset(key, {
        x: String(answer.x),
        y: String(answer.y),
        created_at: new Date().toISOString(),
        attempts: '0',
      });
      multi.expire(key, ttlS);
      await multi.exec();

      // ⛔ 日志里只有"出了一道题"，没有答案、没有 captcha_id 全值（键名会进慢日志，不必再抄一遍）
      logger?.debug?.({ ip }, '滑动验证码已出题');

      return {
        provider: SELF_BUILT_PROVIDER_NAME,
        captcha_id: captchaId,
        bg_svg: bgSvg,
        piece_svg: pieceSvg,
        width: SLIDER_WIDTH,
        height: SLIDER_HEIGHT,
        expires_in: ttlS,
      };
    },

    /**
     * 验题。⛔ 只回答"过没过"：不发 token、不记失败计数、不写审计（那些是编排层的事）。
     *
     * ⚠️ 入参**直接就是 `/captcha/verify` 的请求体**（路由层原样透传），所以字段名是**线上的
     *    snake_case**（`captcha_id` / `x` / `track`），⛔ 不要改成驼峰 —— 那样解构出来全是 undefined，
     *    schema 还拦不住（字段都在，只是没人读），最后表现为"每次验题都 not_found"。
     *
     * @param {{ captcha_id: string, x: number, y?: number, track: unknown }} input
     * @returns {Promise<{ ok: true } | { ok: false, reason: string, detail?: object }>}
     *   `reason` ∈ mismatch / track_suspicious / not_found / too_many_attempts
     */
    async verifyChallenge({ captcha_id: captchaId, x: submittedX, track }) {
      const key = keys.captcha(captchaId);
      const raw = await redis.hgetall(key);

      // 不存在 = 过期或被前面的失败作废（两者对外同码：⛔ 不告诉攻击者"你是第几次"）
      if (!raw || raw.x === undefined) {
        return { ok: false, reason: 'not_found' };
      }

      const attempts = Number(raw.attempts) || 0;
      if (attempts >= maxAttempts) {
        await redis.del(key);
        return { ok: false, reason: 'too_many_attempts' };
      }

      const result = verifySlider({
        answer: { x: Number(raw.x) },
        submittedX,
        track,
        tolerancePx: toleranceForWidth(tolerancePx),
      });

      if (!result.ok) {
        const next = Number(await redis.hincrby(key, 'attempts', 1)) || attempts + 1;
        // ⚠️ 达到上限时**刻意不在这里删键**：让下一次请求命中上面的 `attempts >= maxAttempts` 守卫，
        //    才能真正返回契约里登记的 `too_many_attempts`（docs/api.md §4.1）。
        //    若在这里就删，那个原因码永远不可达 → 文档与代码漂移，且前端拿到的会是 not_found。
        return {
          ok: false,
          reason: result.reason,
          // ⛔ 只带"差了多少像素"用于调参：不带答案、不带用户提交的原值
          detail: {
            ...(result.deltaPx === undefined ? {} : { delta_px: result.deltaPx }),
            attempts: next,
          },
        };
      }

      // ✅ 一次性：验过即作废（同一题的第二个请求必然 not_found）
      await redis.del(key);
      return { ok: true };
    },
  };
}
