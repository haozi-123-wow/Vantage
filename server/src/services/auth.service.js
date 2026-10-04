/**
 * Vantage · 面板认证服务（登录 / 会话内账号查询 / 登出 / 改密 / 2FA 绑定·验证·恢复码）
 *
 * 依据：docs/api.md §4.1（契约）、§4.1.1（实现方案 ①②④⑤⑥⑧）、docs/database.md §5.3（users）、
 *       §5.13/§11（审计：登录/会话/凭证变更均须留痕）
 *
 * 分层：routes（HTTP/Cookie/状态码）→ 本服务（业务判断 + 审计）→ repositories（纯 SQL）。
 *
 * 🔑 安全要点（实现与文档的对应关系）
 *  - **不区分账号不存在/密码错**（§4.1「统一返回 401 invalid_credentials」）：响应、日志、
 *    审计的 reason 全部同词；响应体里 ⛔ 不出现"该账号存在"的任何线索。
 *  - **等时校验**：账号不存在时也对一个固定假哈希跑一次完整的 Argon2 校验 ——
 *    否则"账号不存在"（跳过 19MiB 的慢哈希）与"密码错"（跑完整校验）的响应时间差
 *    会把有效用户名清单白白送出去。
 *  - **改密后轮换 sid + 踢其它会话**（✅ 决策 #32）：密码泄露的补救必须立即切断旧凭证，
 *    ⛔ 不能只改哈希然后让旧会话继续活到 TTL。
 *  - **审计脱敏**（⛔）：detail 里禁止出现密码、新密码、sid、csrf、TOTP 明文验证码与恢复码 ——
 *    审计是给管理员查的，但 `role='user'` 也能读审计（§4.9），所以这里一行都不能松。
 *
 * 🔑 2FA 的两条红线（B6/B7 落地时新加，与文档偏差一并登记在 docs/api.md §4.1.1 ⑧ D7）
 *  - **只持密码者不得替换第二因子**：`setupTotp` 在 `totp_enabled=true` 时一律 409 ——
 *    若允许 totp_pending 用户"换绑再自验"，等于用密码绕过 2FA（矩阵原文字面放行是设计疏漏）。
 *  - **同一步号只收一次**：`verifyTotp()` 命中的步号必须先经 `claimTotpStep()`（Redis SET
 *    `totp:used:<uid>`，TTL 90s）原子认领，SADD 返回 0 即为重放，直接按验证码错误处理。
 */

import QRCode from 'qrcode';

import {
  createSession,
  destroyAllSessions,
  destroyOtherSessions,
  destroySession,
  rotateSession,
} from './session.service.js';
import { getSettingBool } from './settings.service.js';
import { withTransaction } from '../db/pg.js';
import {
  consumeRecoveryCode,
  countActiveRecoveryCodes,
  enableTotp as enableTotpInRepo,
  findUserAuthById,
  findUserById,
  findUserForAuth,
  replaceRecoveryCodes,
  resetTotp,
  setTotpSecret,
  toPublicUser,
  touchLogin,
  updatePasswordHash,
} from '../repositories/user.repo.js';
import { insertAuditLog } from '../repositories/audit.repo.js';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashRecoveryCode,
  totpSecretAad,
  verifyPassword,
} from '../utils/crypto.js';
import {
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  verifyTotp,
} from '../utils/totp.js';
import { keys, TTL_S } from '../utils/redisKeys.js';
import { AppError } from '../utils/errors.js';

/**
 * 等时校验用的假哈希（懒加载，进程内只算一次 Argon2 哈希）。
 * ⛔ 它对应的明文没有人在任何地方使用；它存在的意义只是"让不存在账号的校验同样耗时"。
 */
let dummyHashPromise = null;
function dummyPasswordHash() {
  dummyHashPromise ??= hashPassword('vantage:dummy:credential:timing-equalizer');
  return dummyHashPromise;
}

/**
 * 登录失败统一出口：审计 + 抛 401（响应体对三种失败情形**完全一致**）。
 *
 * ⚠️ `captchaRequired=true` 时响应里会带 `details.captcha_required`（docs/api.md §4.1）：
 *    它由 **IP / 提交用户名的失败计数**算出，与"账号是否存在"无关，因此三种失败情形拿到的
 *    `details` 仍然**完全一致**——防用户名枚举的那条不变量没有被破坏。
 *    （⛔ 对应的既有断言要按**意图**改写，而不是删掉，见 docs/slider-captcha-selfbuilt.md §5.3）
 *
 * @param {{ pool: object, logger: object }} deps
 * @param {{ username: string, ip: string|null, actor: string, actorType: 'user'|'system',
 *           captchaRequired?: boolean }} info
 */
async function failLogin({ pool, logger }, { username, ip, actor, actorType, captchaRequired = false }) {
  await insertAuditLog(
    pool,
    {
      actor,
      actorType,
      action: 'auth.login_failed',
      target: username,
      ip,
      // ⛔ reason 恒为同一取值：审计可被普通用户读取（§4.9），在这里区分
      //    "账号不存在/密码错/已禁用" 等于把用户名枚举的答案写在库里。
      detail: { reason: 'invalid_credentials' },
    },
    logger,
  );
  throw new AppError(
    'invalid_credentials',
    captchaRequired ? { details: { captcha_required: true } } : undefined,
  );
}

/**
 * TOTP 防重放：把验证通过的**步号**原子认领进 `totp:used:<uid>`（docs/api.md §4.1.1 ④）。
 *
 * - SET + TTL 90s：90s = 当前步 30s + ±1 容差步 —— 只要某步号还落在可验证窗口内，
 *   "它已被用过"这一事实就一定还在 Redis 里；窗口外的步号 verifyTotp 本来就会拒绝。
 * - 每次成功都续期整个键的 TTL：键里永远只有最近 ±1 步的 2~3 个成员，续期不会放大占用。
 * - SADD 是原子的：并发两个同码请求只有一个拿到 1，另一个按重放拒绝。
 *
 * @returns {Promise<boolean>} true = 首次使用（放行）；false = 该步号已被接受过（重放）
 */
async function claimTotpStep(redis, userId, step) {
  const key = keys.totpUsed(userId);
  const multi = redis.multi();
  multi.sadd(key, String(step));
  multi.expire(key, TTL_S.totpUsed);
  const results = await multi.exec();
  return results?.[0]?.[1] === 1;
}

/**
 * 创建认证服务。
 * @param {{ pool: object, redis: import('ioredis').Redis, config: object, logger: object,
 *           captcha: object }} deps
 *   `captcha` = `services/captcha.service.js` 的实例（滑动验证码闸门）。由路由层构造后注入，
 *   ⛔ 不在本模块内 new：两个服务必须共用同一份 Redis 与设置缓存口径。
 */
export function createAuthService({ pool, redis, config, logger, captcha }) {
  /** @param {object} entry insertAuditLog 的入参 */
  const audit = (entry) => insertAuditLog(pool, entry, logger);

  /**
   * 会话内账号装载（按 **id**，⛔ 不要用 findUserForAuth——uuid 撞不上 lower(username)）。
   * 账号已不存在 → 销毁该用户全部会话并按 401 处理，⛔ 不让悬空会话继续走鉴权路径。
   */
  async function requireAuthUser(userId) {
    const user = await findUserAuthById(pool, userId);
    if (!user) {
      await destroyAllSessions(redis, config, userId);
      throw new AppError('session_expired');
    }
    return user;
  }

  return {
    /**
     * 登录第一步（密码）。
     *
     * 检查顺序（⛔ 不可调换，docs/slider-captcha-selfbuilt.md §2.3）：
     *   ① 登录限流（路由层 preHandler）→ ② 读人机验证策略与失败计数 → ③ 校验 `captcha_token`
     *   → ④ 查库 + 验密码 → ⑤ 失败则两个计数器 +1 → ⑥ 成功则消费 token。
     * 🔑 ③ 必须在 ④ 之前：否则攻击者不必通过人机验证就能让服务端每次跑满 19MiB 的 Argon2，
     *    等于白送一个 DoS 放大器。
     *
     * @param {{ username: string, password: string, ip: string|null, ua: string|null,
     *           captchaToken?: string|null }} input
     * @returns {Promise<{ sid: string, csrf: string, totpRequired: boolean, user?: object, roles?: string[] }>}
     *   `totpRequired=true` 时**不带** user/roles（§4.1：此时其余接口一律 403，给用户资料没有意义）；
     *   `totpRequired=false` 且账号未绑定 2FA 时即为完整登录（若 `require_2fa=true`，会话处于受限态，
     *   由 `GET /me` 的 403 `totp_setup_required` 引导前端去绑定页 —— §4.1.1 ⑧ D2）。
     * @throws AppError('invalid_credentials') 三种失败情形同码同文（见 failLogin）
     * @throws AppError('captcha_required') 策略要求人机验证但未带 `captcha_token`（400）
     * @throws AppError('captcha_invalid') token 无效 / 已过期 / 已消费 / 换了 IP（400）
     */
    async login({ username, password, ip, ua, captchaToken = null }) {
      // ③ 人机验证闸门（⛔ 不查库：登录路径的等时校验不允许这里引入"账号是否存在"的差异）
      if (await captcha.requireForLogin({ ip, username })) {
        await captcha.assertLoginToken({ ip, captchaToken });
      }

      const user = await findUserForAuth(pool, username);

      let passwordOk = false;
      if (user?.passwordHash) {
        passwordOk = await verifyPassword(password, user.passwordHash);
      } else {
        // 等时校验：账号不存在（或 SSO-only 无本地密码）也必须跑满一次 Argon2
        await verifyPassword(password, await dummyPasswordHash());
      }

      if (!user || !passwordOk || user.status !== 'active') {
        // ⑤ 失败计数（IP + 账号两个维度）：⛔ 必须先 INCR 再抛错——否则"错一次"不会让下一次
        //    登录要求人机验证；返回值告诉我们这次要不要在响应里提示前端"当场弹滑块"。
        const { required } = await captcha.bumpLoginFailure({ ip, username });
        await failLogin({ pool, logger }, {
          username,
          ip,
          actor: user?.id ?? 'system',
          actorType: user ? 'user' : 'system',
          captchaRequired: required,
        });
      }

      const require2fa = await getSettingBool(redis, pool, 'security.require_2fa', {
        ttlS: config.security.settingsCacheTtlS,
        logger,
      });
      const needsTotp = user.totpEnabled;
      const setupRequired = require2fa && !user.totpEnabled;
      // 「已过第二步」的判定：没绑定 TOTP 且策略也不要求 → 无第二步可过，直接完整态；
      //   绑定了 → 必须先过 verifyTotp（totp_pending）；策略要求但未绑定 → 受限绑定态。
      const totpOk = !user.totpEnabled && !require2fa;

      const { sid, session, evicted } = await createSession(redis, config, {
        userId: user.id,
        roles: [user.role],
        totpOk,
        setupRequired,
        ip,
        ua,
        logger,
      });

      // ⚠️ 先建会话再记 last_login：若 Redis 挂了，登录在会话创建处失败，
      //    此时**不该**把 last_login_* 更新成"成功登录"的样子（审计与排障都要靠这两列）。
      await touchLogin(pool, user.id, { ip, method: 'password' });

      // ⑥ 登录成功才消费一次性人机验证凭证（⛔ 失败不消费：见 captcha.service.js 文件头第 4 条）
      const captchaUsed = await captcha.consumeLoginToken({ captchaToken });

      await audit({
        actor: user.id,
        actorType: 'user',
        action: 'auth.login',
        target: user.username,
        ip,
        detail: {
          totp_required: needsTotp,
          setup_required: setupRequired,
          sessions_evicted: evicted.length,
          // ✅ docs/api.md §4.1：用过人机验证不单独记一条审计，挂在登录这条上（避免噪声）
          captcha_used: captchaUsed,
        },
      });

      return {
        sid,
        csrf: session.csrf,
        totpRequired: needsTotp,
        ...(needsTotp
          ? {}
          : {
              // ⛔ 必须显式映射：authRow 里还有 passwordHash / totpSecretEnc，
              //    整个对象往外传等于把两列敏感数据带进响应（§4.9 红线）。
              user: {
                id: user.id,
                username: user.username,
                display_name: user.displayName ?? null,
                role: user.role,
                status: user.status,
                totp_enabled: user.totpEnabled,
              },
              roles: [user.role],
            }),
      };
    },

    /**
     * `GET /me` 的账号部分。返回 null = 会话有效但账号已不存在（被删）——
     * 由路由层销毁会话并回 401，⛔ 不能让一个悬空会话继续用。
     * @param {string} userId
     */
    async findSessionUser(userId) {
      return findUserById(pool, userId);
    },

    /**
     * 登出当前会话。
     * @returns {Promise<boolean>} 会话此前是否存在（不存在的 sid 也回 204，不泄露信息）
     */
    async logout({ userId, sid, ip }) {
      const destroyed = await destroySession(redis, config, sid);
      await audit({
        actor: userId,
        actorType: 'user',
        action: 'auth.logout',
        target: null,
        ip,
        detail: { session_found: destroyed },
      });
      return destroyed;
    },

    /**
     * 全部下线（✅ §4.1：删除 `user_sessions:<uid>` 内全部 sid）。
     * @returns {Promise<number>} 被销毁的会话数
     */
    async logoutAll({ userId, ip }) {
      const destroyed = await destroyAllSessions(redis, config, userId);
      await audit({
        actor: userId,
        actorType: 'user',
        action: 'auth.logout_all',
        target: null,
        ip,
        detail: { sessions_destroyed: destroyed },
      });
      return destroyed;
    },

    /**
     * 自助改密（docs/api.md §4.1：成功 → 轮换 sid + 踢其它会话 + 审计）。
     *
     * 顺序是刻意的：**先验证旧密码 → 再写新哈希 → 再轮换会话**。
     * 若先轮换后写库，中间失败会让用户"旧密码已不是旧密码、新密码又没生效"。
     *
     * @param {{ userId: string, sid: string, oldPassword: string, newPassword: string, ip: string|null }} input
     * @returns {Promise<{ sid: string|null, csrf: string|null }>} 新会话标识（null = 当前会话已失效，路由层清 Cookie 并回 401）
     * @throws AppError('invalid_credentials') 旧密码不对
     * @throws AppError('invalid_request') 新密码与旧密码相同（§4.1.1 ⑧ D4 建议）
     */
    async changePassword({ userId, sid, oldPassword, newPassword, ip }) {
      // ⛔ 必须按 **id** 查（会话里只有 user_id）；findUserForAuth 是按登录名查的，传 uuid 永远查不到
      const user = await findUserAuthById(pool, userId);
      if (!user?.passwordHash) {
        // 会话有效但账号没了/无本地密码：会话不可信，销毁并要求重新登录
        await destroyAllSessions(redis, config, userId);
        throw new AppError('session_expired');
      }

      if (!(await verifyPassword(oldPassword, user.passwordHash))) {
        await audit({
          actor: userId,
          actorType: 'user',
          action: 'auth.password_change_failed',
          target: user.username,
          ip,
          detail: { reason: 'invalid_credentials' },
        });
        throw new AppError('invalid_credentials');
      }
      if (newPassword === oldPassword) {
        throw new AppError('invalid_request', { message: '新密码不得与当前密码相同' });
      }

      // ⛔ hashPassword 自带「≥8 字符」防线；长度上限由路由 schema（8–128）把关（D4 建议）
      await updatePasswordHash(pool, userId, await hashPassword(newPassword));

      const rotated = await rotateSession(redis, config, sid);
      if (rotated) {
        // 当前会话保留（用户不能因为改密把自己踢下线），其余全部作废
        const kicked = await destroyOtherSessions(redis, config, userId, rotated.sid);
        await audit({
          actor: userId,
          actorType: 'user',
          action: 'auth.password_change',
          target: user.username,
          ip,
          detail: { other_sessions_kicked: kicked },
        });
        return { sid: rotated.sid, csrf: rotated.session.csrf };
      }

      // 极端情况：改密过程中当前会话恰好失效 → 只能全部下线，让用户重新登录
      await destroyAllSessions(redis, config, userId);
      await audit({
        actor: userId,
        actorType: 'user',
        action: 'auth.password_change',
        target: user.username,
        ip,
        detail: { other_sessions_kicked: null, note: 'session_lost_during_rotation' },
      });
      return { sid: null, csrf: null };
    },

    // -------------------------------------------------------------------------
    // B6/B7：面板 2FA（绑定 / 启用 / 解绑 / 第二步验证 / 恢复码）
    // 契约：docs/api.md §4.1（端点表）、§4.1.1 ④（totp:used 防重放）、⑤（TOTP/恢复码）、⑧（D1/D3/D5/D6/D7）
    // -------------------------------------------------------------------------

    /**
     * `POST /auth/2fa/setup`：生成待确认密钥（⛔ 不生效，enable 验码通过才算绑定）。
     *
     * 🔑 **已绑定即拒绝（409）**：§4.1.1 ②矩阵把 setup 列入 totp_pending 放行，但字面实现
     *    会构成 2FA 绕过——只持密码者可以换绑自己的验证器再自验通过。落地收敛为
     *    「已绑定 → 409，丢失设备走恢复码（渠道一）或管理员重置（渠道二）」，登记为 ⑧ D7 待追认。
     *
     * @returns {Promise<{ secret: string, otpauth_uri: string, qr_svg: string }>}
     *   secret 明文**仅此一次**下发（手工输入用）；库里只有 AES-256-GCM 密文。
     */
    async setupTotp({ userId, ip }) {
      const user = await requireAuthUser(userId);
      if (user.totpEnabled) {
        throw new AppError('conflict', { message: '已启用二次验证，请先解绑后重新绑定' });
      }

      const secret = generateTotpSecret();
      const envelope = encryptSecret(secret, config.security.secretKey, totpSecretAad(userId));
      const stored = await setTotpSecret(pool, userId, envelope);
      if (!stored) {
        await destroyAllSessions(redis, config, userId);
        throw new AppError('session_expired');
      }
      // 并发兜底：检查与写入之间账号被其它会话绑定 → 拒绝，⛔ 不覆盖已生效密钥
      if (stored.totpEnabled) {
        throw new AppError('conflict', { message: '已启用二次验证，请先解绑后重新绑定' });
      }

      const otpauthUri = buildOtpAuthUri({ secret, account: user.username });
      // qr_svg：服务端渲染（§4.1.1 ⑤，唯一新增运行时依赖 qrcode）；内容只是 otpauth_uri 的图形化，无敏感增量
      const qrSvg = await QRCode.toString(otpauthUri, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });

      await audit({
        actor: userId,
        actorType: 'user',
        action: 'user.2fa_setup',
        target: user.username,
        ip,
        detail: {},
      });

      return { secret, otpauth_uri: otpauthUri, qr_svg: qrSvg };
    },

    /**
     * `POST /auth/2fa/enable`：验码通过 → 正式绑定 + 生成 10 个恢复码（D1 建议）+ 轮换 sid。
     *
     * setup_required（强制绑定）与 full 态可调（`totp_pending` 由路由守卫 403，矩阵②）；
     * 成功后会话直接进入 full——用户刚用验证码证明了持有，不应再被踢回第二步。
     *
     * @returns {Promise<{ sid: string|null, csrf: string|null, recoveryCodes: string[] }>}
     *   `sid=null` = 轮换时会话已失效（绑定已完成，但须重新登录），路由层清 Cookie 并回 401。
     * @throws AppError('invalid_totp') 验证码错误 / 步号重放
     * @throws AppError('invalid_request') 尚未 setup（无待确认密钥）
     * @throws AppError('conflict') 已绑定 / 绑定状态并发变化
     */
    async enableTotp({ userId, sid, code, ip }) {
      const user = await requireAuthUser(userId);
      if (!user.totpSecretEnc) {
        throw new AppError('invalid_request', { message: '请先获取绑定二维码' });
      }
      if (user.totpEnabled) {
        throw new AppError('conflict', { message: '已启用二次验证' });
      }

      let secret;
      try {
        secret = decryptSecret(user.totpSecretEnc, config.security.secretKey, totpSecretAad(userId));
      } catch (err) {
        // 密钥轮换/信封损坏：让用户重新 setup 是唯一出路，按可解释的 400 而不是 500
        throw new AppError('invalid_request', { message: '绑定凭据已失效，请重新获取二维码', cause: err });
      }

      const verified = verifyTotp(secret, code);
      const reject = async (reason) => {
        await audit({
          actor: userId,
          actorType: 'user',
          action: 'user.2fa_enable_failed',
          target: user.username,
          ip,
          detail: { reason },
        });
        throw new AppError('invalid_totp');
      };
      if (!verified.ok) await reject('invalid_totp');
      // ⛔ 先认领步号再落库：SADD 返回 0 = 同一步号已被接受过（30s 窗口内重放）
      if (!(await claimTotpStep(redis, userId, verified.step))) await reject('replayed_step');

      const enabled = await enableTotpInRepo(pool, userId);
      if (!enabled) {
        // 种子在此期间被清（管理员重置）→ 拒绝，不留"enabled 但没码"的半态
        throw new AppError('conflict', { message: '绑定状态已变化，请重新发起绑定' });
      }

      // 恢复码（D1 建议）：明文仅本响应可见一次；库里只有 HMAC 哈希；整批替换须在事务内
      const recoveryCodes = generateRecoveryCodes();
      const codeHashes = recoveryCodes.map((code2) => hashRecoveryCode(code2, config.security.secretKey));
      await withTransaction(pool, (client) => replaceRecoveryCodes(client, userId, codeHashes));

      await audit({
        actor: userId,
        actorType: 'user',
        action: 'user.2fa_enable',
        target: user.username,
        ip,
        detail: { recovery_codes: recoveryCodes.length },
      });

      const rotated = await rotateSession(redis, config, sid, {
        patch: { totpOk: true, setupRequired: false },
      });
      if (!rotated) {
        await destroyAllSessions(redis, config, userId);
        return { sid: null, csrf: null, recoveryCodes };
      }
      return { sid: rotated.sid, csrf: rotated.session.csrf, recoveryCodes };
    },

    /**
     * `POST /auth/2fa/disable`：密码二次确认 → 解绑 + 作废全部恢复码（D5 建议）。
     *
     * 仅 full 态可调（`requireFullSession`）：totp_pending 下解绑等于"用密码关掉 2FA"。
     * `security.require_2fa=true` 时禁止自助解绑（D3 建议，409 conflict）——策略要保的是
     * 「账号必须至少有一种第二因子」，自助解绑会把它变成空话。
     *
     * ⚠️ 不轮换 sid、不动会话：解绑后用户仍是已完整鉴权状态；账号安全态的变化由审计留痕。
     * @throws AppError('invalid_credentials') 密码错误（含无本地密码的 SSO-only 账号）
     * @throws AppError('conflict') 未绑定 / require_2fa 策略禁止（D3）
     */
    async disableTotp({ userId, password, ip }) {
      const user = await requireAuthUser(userId);

      if (!(await verifyPassword(password, user.passwordHash))) {
        await audit({
          actor: userId,
          actorType: 'user',
          action: 'user.2fa_disable_failed',
          target: user.username,
          ip,
          detail: { reason: 'invalid_credentials' },
        });
        throw new AppError('invalid_credentials');
      }
      if (!user.totpEnabled) {
        throw new AppError('conflict', { message: '尚未启用二次验证' });
      }

      const require2fa = await getSettingBool(redis, pool, 'security.require_2fa', {
        ttlS: config.security.settingsCacheTtlS,
        logger,
      });
      if (require2fa) {
        await audit({
          actor: userId,
          actorType: 'user',
          action: 'user.2fa_disable_failed',
          target: user.username,
          ip,
          detail: { reason: 'require_2fa_policy' },
        });
        throw new AppError('conflict', { message: '安全策略要求保留二次验证，如需解绑请联系管理员' });
      }

      // D5：解绑必须连恢复码一起作废（resetTotp = 解绑 + 清码，两条语句 → 事务内）
      const { codesDeleted } = await withTransaction(pool, (client) => resetTotp(client, userId));
      await audit({
        actor: userId,
        actorType: 'user',
        action: 'user.2fa_disable',
        target: user.username,
        ip,
        detail: { recovery_codes_deleted: codesDeleted },
      });
      return { codesDeleted };
    },

    /**
     * `POST /auth/2fa/verify`：登录第二步（TOTP）。成功 → 轮换 sid（决策 #32）+ 会话转 full。
     *
     * 计入登录限流同一桶（§6.2 用例 14）；同一步号只接受一次（§4.1.1 ④）。
     * ⚠️ 不写 touchLogin：`users.last_login_method` 的 CHECK 只允许 password/totp/oidc，
     *    且第一步已记录本次登录（时间/IP），第二步不再覆盖。
     *
     * @returns {Promise<{ sid: string|null }>} `sid=null` = 轮换时会话已失效，路由层回 401
     * @throws AppError('invalid_totp') 验证码错误 / 重放
     * @throws AppError('conflict') 账号已解绑（会话态与库态脱节的边缘情形，请重新登录）
     */
    async verifyTotpLogin({ userId, sid, code, ip }) {
      const user = await requireAuthUser(userId);
      if (!user.totpEnabled || !user.totpSecretEnc) {
        throw new AppError('conflict', { message: '二次验证状态已变化，请重新登录' });
      }

      let secret;
      try {
        secret = decryptSecret(user.totpSecretEnc, config.security.secretKey, totpSecretAad(userId));
      } catch (err) {
        throw new AppError('invalid_request', { message: '验证凭据异常，请联系管理员重置', cause: err });
      }

      const verified = verifyTotp(secret, code);
      const reject = async (reason) => {
        await audit({
          actor: userId,
          actorType: 'user',
          action: 'auth.2fa_verify_failed',
          target: user.username,
          ip,
          // 'replayed' 刻意与 'invalid_totp' 区分：它在审计里的语义是"有人重复使用验证码"，
          // 属安全信号而非错误分类（此处会话已通过密码鉴权，不存在枚举泄露问题）
          detail: { reason },
        });
        throw new AppError('invalid_totp');
      };
      if (!verified.ok) await reject('invalid_totp');
      if (!(await claimTotpStep(redis, userId, verified.step))) await reject('replayed_step');

      const rotated = await rotateSession(redis, config, sid, {
        patch: { totpOk: true, setupRequired: false },
      });
      await audit({
        actor: userId,
        actorType: 'user',
        action: 'auth.2fa_verify',
        target: user.username,
        ip,
        detail: { rotated: Boolean(rotated) },
      });
      if (!rotated) {
        await destroyAllSessions(redis, config, userId);
        return { sid: null };
      }
      return { sid: rotated.sid };
    },

    /**
     * `POST /auth/2fa/recovery/verify`：恢复码替代 TOTP 过第二步（渠道一）。
     * 用后即废（单条 UPDATE 的行锁保证并发下同一码只可能成功一次）；响应带剩余数量
     * （前端 ≤2 强提示重新生成，docs/frontend.md §4.6）。
     *
     * @returns {Promise<{ sid: string|null, remaining: number }>}
     * @throws AppError('invalid_totp') 码不存在 / 已用过 / 格式非法（§6.2 用例 13 的 400 口径）
     * @throws AppError('conflict') 账号已解绑（恢复码随解绑作废，此时不可能有可用码）
     */
    async verifyRecoveryLogin({ userId, sid, code, ip }) {
      const user = await requireAuthUser(userId);
      if (!user.totpEnabled) {
        throw new AppError('conflict', { message: '二次验证状态已变化，请重新登录' });
      }

      let consumed = false;
      try {
        // hashRecoveryCode 内含归一化（大小写/连字符/易混字符），空码抛错 → 按验证失败处理
        consumed = await consumeRecoveryCode(pool, userId, hashRecoveryCode(code, config.security.secretKey));
      } catch {
        consumed = false;
      }
      if (!consumed) {
        await audit({
          actor: userId,
          actorType: 'user',
          action: 'user.recovery_verify_failed',
          target: user.username,
          ip,
          detail: { reason: 'invalid_code' },
        });
        throw new AppError('invalid_totp');
      }

      const remaining = await countActiveRecoveryCodes(pool, userId);
      const rotated = await rotateSession(redis, config, sid, {
        patch: { totpOk: true, setupRequired: false },
      });
      await audit({
        actor: userId,
        actorType: 'user',
        action: 'user.recovery_used',
        target: user.username,
        ip,
        detail: { remaining_recovery_codes: remaining },
      });
      if (!rotated) {
        await destroyAllSessions(redis, config, userId);
        return { sid: null, remaining };
      }
      return { sid: rotated.sid, remaining };
    },

    /**
     * `POST /auth/2fa/recovery/regenerate`：整批重发 10 个恢复码（旧码立即作废）。
     * 仅 full 态可调（requireFullSession）——pending 者应先用 TOTP/恢复码过第二步。
     *
     * @returns {Promise<{ recoveryCodes: string[] }>} 明文仅本响应可见一次
     */
    async regenerateRecoveryCodes({ userId, ip }) {
      const user = await requireAuthUser(userId);
      if (!user.totpEnabled) {
        throw new AppError('conflict', { message: '请先启用二次验证' });
      }

      const recoveryCodes = generateRecoveryCodes();
      const codeHashes = recoveryCodes.map((code) => hashRecoveryCode(code, config.security.secretKey));
      await withTransaction(pool, (client) => replaceRecoveryCodes(client, userId, codeHashes));
      await audit({
        actor: userId,
        actorType: 'user',
        action: 'user.recovery_regenerate',
        target: user.username,
        ip,
        detail: { recovery_codes: recoveryCodes.length },
      });
      return { recoveryCodes };
    },
  };
}
