/**
 * Vantage · 人机验证**编排层**（策略 / 闸门 / 两层失败计数 / 一次性凭证 / 审计）
 *
 * 依据：docs/geetest-captcha.md §2（8 条跨提供方不变的契约）、§3（架构与接缝）、§9（失败模式）、
 *       §12 C12（G1-a：极验为默认、自建滑块保留）；docs/slider-captcha-selfbuilt.md §2/§6.4
 *
 * 分层：routes（HTTP 语义）→ **本文件（业务判断 + 审计 + 存储编排）** → `captcha/providers/*`（怎么出题/怎么判定）
 *
 * 🔑 本文件里的语义**与提供方无关**，换极验 / 回自建 / 关掉都不该改动其中任何一条：
 *  1. **首次登录永不要求**：两个失败计数都是 0 → 直接放行。
 *  2. **出现密码错误后引入**：同 IP **或**同账号计数 ≥ 阈值即要求。
 *  3. **两层计数都要**：少了"按账号"那层，代理池"每个 IP 只失败一次"永远打不到阈值。
 *  4. **闸门在验密之前**：否则攻击者不过验证就能让服务端每次跑满 19MiB 的 Argon2（DoS 放大器）。
 *  5. **触发器不查库**：只用 IP / 提交的用户名 + 设置项，不引入"账号是否存在"的计时侧信道。
 *  6. **凭证绑定来源 IP，且登录成功才消费**（失败不消费：否则用户打错一次密码就要重新验证）。
 *  7. **与三态矩阵正交**：它只决定"这次登录能不能进入验密环节"。
 *  8. **总开关关闭 → 整条链路像不存在**：出题端点 404，登录响应与接入前逐字节相同。
 *  9. **登录成功后清零两个失败计数**（✅ 2026-10-04 Owner 决策 A）：闸门在验密之前（第 4 条）+
 *     计数窗口默认 300s，若成功不清零，"错过一次密码"会让**整个窗口内每一次**登录都被要求验证 ——
 *     哪怕这一次密码完全正确（用户看不到"密码错"，只看到"请先完成人机验证"）。
 *
 * ⛔ 对**内部依赖**（Redis）fail-closed：异常一律向上抛（由 `errors.js` 折叠为 503），
 *    ⛔ 绝不"读不到策略就放行"——那正好是攻击者最想要的状态。
 * ⚠️ 对**外部服务**（极验）相反：不可用时按 `failMode` 处理，默认 **open（放行）**——
 *    理由与连带义务见 docs/geetest-captcha.md §9.2/§9.3：Vantage 是监控系统，
 *    "故障期间进不去自己的面板"比"少一层摩擦"严重得多；代价是必须有审计 + error 日志兜底。
 */

import { randomToken } from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';
import { keys } from '../utils/redisKeys.js';
import { bumpFixedWindow, readCounter } from '../utils/redisCounter.js';
import { insertAuditLog } from '../repositories/audit.repo.js';
import { GEETEST_PROVIDER_NAME, createCaptchaProvider } from './captcha/providers/index.js';
import { getSettingBool, getSettingInt } from './settings.service.js';

/** 策略设置项的 key（⛔ 与 `SETTING_DEFAULTS`、`docs/api.md` §4.10 白名单逐字一致） */
export const CAPTCHA_SETTING_ENABLED = 'security.login_captcha.enabled';
export const CAPTCHA_SETTING_AFTER_FAILURES = 'security.login_captcha.after_failures';

/**
 * 创建人机验证编排服务。
 * @param {{ redis: object, pool: object, config: object, logger: object, fetchImpl?: Function|null }} deps
 *   `fetchImpl` 仅供测试注入（⛔ 测试绝不真连极验）。
 */
export function createCaptchaService({ redis, pool, config, logger, fetchImpl = null }) {
  const ttlS = config.security.captcha.ttlS;
  const settingsTtlS = config.security.settingsCacheTtlS;
  const loginWindowS = config.rateLimit.loginWindowS;

  const provider = createCaptchaProvider({ redis, config, logger, fetchImpl });

  const audit = (entry) => insertAuditLog(pool, entry, logger);

  /**
   * 读运行时策略（面板可改，带 `settings:cache` 缓存）。
   * ⚠️ 每次都走 `getSettingBool`/`getSettingInt`：它们负责"类型不对 → 回退默认值 + 夹取"，
   *    ⛔ 不要为了省一次读而直接 `readSettings()` 后自己判类型（两处口径必然漂移）。
   */
  async function readPolicy() {
    const enabled = await getSettingBool(redis, pool, CAPTCHA_SETTING_ENABLED, { ttlS: settingsTtlS, logger });
    const afterFailures = await getSettingInt(redis, pool, CAPTCHA_SETTING_AFTER_FAILURES, {
      min: 1,
      max: 10,
      ttlS: settingsTtlS,
      logger,
    });
    return { enabled, afterFailures };
  }

  /**
   * 外部提供方是否处于熔断窗口。
   * 🔑 只在 `failMode === 'open'` 时才去读：`closed`（自建滑块）下这一读毫无意义，
   *    省掉它还能让"回退到自建"的部署行为与引入极验前**完全一致**。
   * ⚠️ 读失败按"未熔断"处理（熔断是**性能优化**，不是安全控制）。
   */
  async function vendorDown() {
    if (provider?.failMode !== 'open' || typeof provider.isVendorDown !== 'function') return false;
    return provider.isVendorDown();
  }

  /** 发放一次性凭证（值 = 解出验证的 IP，挡"打码平台批量出 token 转卖"） */
  async function issueToken(ip) {
    const token = randomToken(24);
    await redis.set(keys.captchaOk(token), ip ?? '', 'EX', ttlS);
    return { captcha_token: token, expires_in: ttlS };
  }

  /**
   * 整条链路此刻是否"存在"。三个条件全为真才是：
   * ① 策略开启 ② 提供方凭据齐备 ③ 外部提供方不在熔断窗口（仅 failMode=open 时才有这一条）。
   *
   * ⛔ ② 是刻意加的一道保险：凭据缺失时**关掉整条链路**（出题 404、登录永不因人机验证被拒），
   *    而不是"配了就照用、用不了当通过"。见 docs/geetest-captcha.md §9.4 教训一。
   */
  async function isUsable() {
    if (!provider || !provider.isConfigured()) return false;
    if (!(await readPolicy()).enabled) return false;
    return !(await vendorDown());
  }

  return {
    /** 实际生效的提供方名（`geetest` / `selfbuilt` / `none`）——路由层据此挑 schema */
    providerName: provider?.name ?? 'none',

    /** 路由层用：当前是否是极验（决定两个端点的请求/响应形状） */
    isGeetest() {
      return provider?.name === GEETEST_PROVIDER_NAME;
    },

    /** 路由层用：false 时出题/验题端点一律 404（⛔ 不用 403，免得暴露"有这东西但被关了"） */
    isEnabled: isUsable,

    /**
     * 出题（委托给提供方）。
     * @param {{ ip: string|null }} input
     * @throws AppError('not_found') 链路不生效
     */
    async issueChallenge(input) {
      if (!(await isUsable())) throw new AppError('not_found');
      return provider.issueChallenge(input);
    },

    /**
     * 验题（委托给提供方），并统一处理三种结局。
     *
     * @param {{ ip: string|null, input: object }} payload `input` 就是 `request.body`（形状由提供方决定）
     * @returns {Promise<{ captcha_token: string, expires_in: number }>}
     * @throws AppError('captcha_invalid')     提供方明确判定"没通过"（`details.reason`）
     * @throws AppError('captcha_unavailable') 提供方不可用**且** failMode=closed（503）
     * @throws AppError('not_found')           链路不生效
     */
    async verifyChallenge({ ip, input }) {
      if (!(await isUsable())) throw new AppError('not_found');

      const result = await provider.verifyChallenge({ ...input, ip });

      // ① 通过 → 发一次性凭证
      if (result.ok) {
        logger?.debug?.({ ip, provider: provider.name }, '人机验证通过，已发放一次性凭证');
        return issueToken(ip);
      }

      // ② 提供方自身不可用：审计 + error 日志，再按 failMode 决定放行还是拒绝
      if (result.unavailable) {
        const failMode = provider.failMode ?? 'closed';
        await audit({
          actor: 'system',
          actorType: 'system',
          action: 'auth.captcha_unavailable',
          target: null,
          ip,
          // ⛔ 不记原始响应体（可能含 user_ip / referer）；也不记 pass_token / lot_number
          detail: {
            provider: provider.name,
            http_status: result.httpStatus ?? null,
            ...(result.vendorCode === undefined ? {} : { vendor_code: result.vendorCode }),
            elapsed_ms: result.elapsedMs ?? null,
            breaker: result.breaker === true,
            fail_mode: failMode,
          },
        });

        if (failMode === 'open') {
          // ⚠️ 这条 error 日志是 C13 选 open 的**连带义务**：放行对用户完全不可见，
          //    不主动打日志，就没人会知道这一层曾经失效过（docs/geetest-captcha.md §9.3）。
          logger?.error?.(
            { provider: provider.name, breaker: result.breaker === true, http_status: result.httpStatus ?? null },
            '外部人机验证不可用 → 按 failMode=open **放行**本次验证（该层此刻不生效）',
          );
          return issueToken(ip);
        }

        throw new AppError('captcha_unavailable');
      }

      // ③ 真的没通过：审计（⛔ 不含答案、不含用户提交的原值、不含 token）
      await audit({
        actor: 'system',
        actorType: 'system',
        action: 'auth.captcha_failed',
        target: null,
        ip,
        detail: {
          provider: provider.name,
          reason: result.reason,
          ...(result.vendorReason ? { vendor_reason: result.vendorReason } : {}),
          ...(result.detail ?? {}),
        },
      });

      throw new AppError('captcha_invalid', { details: { reason: result.reason } });
    },

    /**
     * 登录闸门：这次登录是否**必须**带 `captcha_token`。
     *
     * @returns {Promise<boolean>}
     */
    async requireForLogin({ ip, username }) {
      const { enabled, afterFailures } = await readPolicy();
      if (!enabled || !provider || !provider.isConfigured()) return false;

      const [byIp, byAcct] = await Promise.all([
        readCounter(redis, keys.loginFailIp(ip ?? '')),
        username ? readCounter(redis, keys.loginFailAcct(username)) : Promise.resolve(0),
      ]);
      if (byIp < afterFailures && byAcct < afterFailures) return false;

      // ⚠️ 熔断检查刻意放在**最后**：只有"策略确实要求验证"这一刻才多一次 Redis 读，
      //    首次登录（计数为 0）与正常路径的开销与引入极验前完全一致。
      if (await vendorDown()) {
        logger?.error?.(
          { provider: provider.name, ip },
          '外部人机验证处于熔断窗口 → failMode=open：本次登录**不要求**人机验证（该层此刻不生效）',
        );
        return false;
      }

      return true;
    },

    /**
     * 校验登录携带的 `captcha_token`（⛔ **不消费**，见文件头第 6 条）。
     * @throws AppError('captcha_required') 缺失
     * @throws AppError('captcha_invalid') 无效 / 已过期 / 已消费 / 换了 IP
     */
    async assertLoginToken({ ip, captchaToken }) {
      if (typeof captchaToken !== 'string' || captchaToken.length === 0) {
        throw new AppError('captcha_required');
      }
      const ownerIp = await redis.get(keys.captchaOk(captchaToken));
      if (ownerIp === null || ownerIp === undefined) {
        throw new AppError('captcha_invalid', { details: { reason: 'expired' } });
      }
      // ⚠️ ownerIp 为空串表示"出题时没有 IP 信息"（理论上不该发生在 HTTP 路径），此时不比对
      if (ownerIp !== '' && ip && ownerIp !== ip) {
        throw new AppError('captcha_invalid', { details: { reason: 'ip_mismatch' } });
      }
      return true;
    },

    /** 登录**成功**时消费一次性凭证；⛔ 失败路径不得调用 */
    async consumeLoginToken({ captchaToken }) {
      if (typeof captchaToken !== 'string' || captchaToken.length === 0) return false;
      return Number(await redis.del(keys.captchaOk(captchaToken))) > 0;
    },

    /**
     * 登录失败：两个计数器各 +1（TTL = 登录限流窗口，两者同窗口才不会被"卡边界"绕过）。
     *
     * @returns {Promise<{ enabled: boolean, required: boolean }>}
     *   `required=true` 时，路由层要在 401 响应里带 `details.captcha_required`，
     *   让前端**当场**把验证入口显示出来（而不是等下一次提交才知道）。
     *   ⚠️ 返回值直接来自本次 `INCR` 的计数，⛔ 不额外查 Redis。
     *   ⚠️ 这里**不查**熔断：失败响应里的 `captcha_required` 只是给前端的提示，
     *      真正的强制在 `requireForLogin`；多查一次会让每次登录失败都多一次 Redis 读。
     */
    async bumpLoginFailure({ ip, username }) {
      const { enabled, afterFailures } = await readPolicy();
      const usable = enabled && Boolean(provider?.isConfigured());

      const [byIp, byAcct] = await Promise.all([
        bumpFixedWindow(redis, keys.loginFailIp(ip ?? ''), loginWindowS),
        username
          ? bumpFixedWindow(redis, keys.loginFailAcct(username), loginWindowS)
          : Promise.resolve({ count: 0 }),
      ]);

      return {
        enabled: usable,
        required: usable && (byIp.count >= afterFailures || byAcct.count >= afterFailures),
      };
    },

    /**
     * 登录**成功**（密码已验对）后清零两个失败计数（✅ 2026-10-04 Owner 决策 A，见文件头第 9 条）。
     *
     * 🔑 为什么必须清：闸门在**验密之前**（第 4 条），而计数由**上一次**密码错误写入、
     *    TTL = 登录限流窗口（默认 300s）。不清的话，窗口内"错过一次"会让**每一次**登录都被要求
     *    人机验证 —— 包括密码完全正确的那次：用户看不到"密码错"，只看到"请先完成人机验证"。
     * ⛔ 这不削弱爆破防护：攻击者**不知道**密码时压根走不到这里，两个计数照旧累积。
     *
     * ⚠️ 只用一条 `DEL`（不读、不判存在），且失败**只告警不抛**：登录此刻已经成功，
     *    这里的清理是"体贴"而非安全边界；清理失败只会退回清理前的行为（下次仍可能要验证）。
     * @param {{ ip?: string|null, username?: string|null }} input
     */
    async clearLoginFailures({ ip, username } = {}) {
      const targets = [keys.loginFailIp(ip ?? '')];
      if (username) targets.push(keys.loginFailAcct(username));
      try {
        await redis.del(...targets);
      } catch (err) {
        logger?.warn?.({ err }, '登录成功后清理人机验证失败计数失败（下次仍可能要求验证）');
      }
    },
  };
}
