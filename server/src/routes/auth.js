/**
 * Vantage · 面板认证路由（`/api/v1/auth/*`）
 *
 * 依据：docs/api.md §4.1（契约）、§4.1.1 ②（三态矩阵）/⑦（B4/B5 范围）、§1.2/§1.3（响应约定）；
 *       docs/frontend.md §4.2（两步登录：`me` 的 403 `totp_setup_required` 引导绑定页）
 *
 * 本文件只做 **HTTP 语义**（解析/Cookie/状态码/响应形状），业务判断全在 `services/auth.service.js`。
 *
 * 路由与三态矩阵（docs/api.md §4.1.1 ②）的对应：
 *   login                无会话（限流桶 `ratelimit:login:<ip>`）       CSRF：无会话天然放行
 *   me                   requireSession + rejectIfSetupRequired       GET，不校验 CSRF
 *   logout / logout-all  requireSession（受限态仍可登出 ⛔ 不能把人锁死在面板里）
 *   password             requireFullSession（⛔ 改密必须完整态，§4.1.1 ⑧ D4）+ requireCsrf
 *   2fa/setup            requireSession（setup_required 受限绑定态必须可达；服务层卡「已绑定→409」）
 *   2fa/enable           requireSession + rejectIfTotpPending（setup_required 必须可达，pending ⛔ 重复绑定）
 *   2fa/disable          requireFullSession（⛔ pending 下解绑 = 用密码关 2FA）+ requireCsrf
 *   2fa/verify           requireSession + 登录限流同一桶（§6.2 用例 14）+ requireCsrf
 *   2fa/recovery/*       verify 同 verify；regenerate 用 requireFullSession
 *
 * 响应形状由 response schema **结构性钉死**：`additionalProperties: false` 意味着
 * `password_hash` / `totp_secret_enc` / sid 想混进响应必须先改这里，测试会当场红。
 */

import { createPanelAuth, clearSessionCookie, setSessionCookie } from '../middleware/authPanel.js';
import { createLoginRateLimiter } from '../middleware/rateLimit.js';
import { createAuthService } from '../services/auth.service.js';
import { destroySession } from '../services/session.service.js';
import { toPublicUser } from '../repositories/user.repo.js';
import { AppError } from '../utils/errors.js';
import { prepareIp } from '../utils/ip.js';

/** 公开用户对象（⛔ 与 repositories/user.repo.js 的 toPublicUser 同一口径，无任何敏感列） */
const PUBLIC_USER_SCHEMA = {
  type: 'object',
  required: ['id', 'username', 'role', 'status', 'totp_enabled'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    username: { type: 'string' },
    display_name: { type: ['string', 'null'] },
    role: { type: 'string' },
    status: { type: 'string' },
    totp_enabled: { type: 'boolean' },
  },
};

const LOGIN_BODY_SCHEMA = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    // ⛔ 上限不是摆设：超长输入会原样进入 Argon2 与审计 target，必须在这里掐断
    username: { type: 'string', minLength: 1, maxLength: 128 },
    password: { type: 'string', minLength: 1, maxLength: 128 },
  },
};

const LOGIN_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['csrf', 'totp_required'],
  additionalProperties: false,
  properties: {
    user: PUBLIC_USER_SCHEMA,
    roles: { type: 'array', items: { type: 'string' } },
    csrf: { type: 'string' },
    totp_required: { type: 'boolean' },
  },
};

const ME_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['user', 'roles', 'session', 'csrf'],
  additionalProperties: false,
  properties: {
    user: PUBLIC_USER_SCHEMA,
    roles: { type: 'array', items: { type: 'string' } },
    session: {
      type: 'object',
      required: ['created_at', 'last_seen'],
      additionalProperties: false,
      properties: {
        created_at: { type: 'string' },
        last_seen: { type: 'string' },
        ip: { type: ['string', 'null'] },
        ua: { type: ['string', 'null'] },
      },
    },
    csrf: { type: 'string' },
  },
};

const PASSWORD_BODY_SCHEMA = {
  type: 'object',
  required: ['old_password', 'new_password'],
  additionalProperties: false,
  properties: {
    old_password: { type: 'string', minLength: 1, maxLength: 128 },
    // 8–128 与 scripts/create-user.js 的 CLI 口径一致（docs/api.md §4.1.1 ⑧ D4，❓ 待拍板）
    new_password: { type: 'string', minLength: 8, maxLength: 128 },
  },
};

// ---- B6/B7：2FA 请求/响应形状（docs/api.md §4.1；长度上限掐断超长输入进验证路径）----

/** TOTP 6 位（容忍粘贴带空白，verifyTotp 内部去空白后按 ^\d{6}$ 校验） */
const TOTP_CODE_BODY_SCHEMA = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: { type: 'string', minLength: 6, maxLength: 8 } },
};

/** 恢复码 `XXXXX-XXXXX`（10 字符 + 连字符；容忍大小写/空白差异，归一化在哈希口径内） */
const RECOVERY_CODE_BODY_SCHEMA = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: { type: 'string', minLength: 8, maxLength: 20 } },
};

const TOTP_PASSWORD_BODY_SCHEMA = {
  type: 'object',
  required: ['password'],
  additionalProperties: false,
  properties: { password: { type: 'string', minLength: 1, maxLength: 128 } },
};

const SETUP_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['secret', 'otpauth_uri', 'qr_svg'],
  additionalProperties: false,
  properties: {
    secret: { type: 'string' },
    otpauth_uri: { type: 'string' },
    qr_svg: { type: 'string' },
  },
};

/** enable 与 regenerate 共用（D1 建议：绑定成功即下发 10 个一次性恢复码） */
const RECOVERY_CODES_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['recovery_codes', 'remaining_recovery_codes'],
  additionalProperties: false,
  properties: {
    recovery_codes: { type: 'array', minItems: 10, maxItems: 10, items: { type: 'string' } },
    remaining_recovery_codes: { type: 'number' },
  },
};

/** recovery/verify（与 web/src/api/private.ts 的 RecoveryVerifyResult 对齐） */
const RECOVERY_VERIFY_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['remaining_recovery_codes'],
  additionalProperties: false,
  properties: { remaining_recovery_codes: { type: 'number' } },
};

const iso = (value) => value.toISOString();

/**
 * 注册面板认证路由。
 * @param {import('fastify').FastifyInstance} app
 */
export async function registerAuthRoutes(app) {
  const { config, deps, log } = app;
  const pool = deps.db.app;
  const redis = deps.redis;

  const panel = createPanelAuth({ redis, config, logger: log });
  const loginRateLimit = createLoginRateLimiter({ redis, config, logger: log });
  const service = createAuthService({ pool, redis, config, logger: log });

  const ipOf = (request) => prepareIp(request.ip).ip;
  const uaOf = (request) => {
    const raw = request.headers['user-agent'];
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/login —— 唯一不需要已有会话的端点（§4.1 的 CSRF 豁免对象）
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/login',
    {
      preHandler: [panel.loadPanelSession, loginRateLimit],
      schema: { body: LOGIN_BODY_SCHEMA, response: { 200: LOGIN_RESPONSE_SCHEMA } },
    },
    async (request, reply) => {
      const result = await service.login({
        username: request.body.username,
        password: request.body.password,
        ip: ipOf(request),
        ua: uaOf(request),
      });

      setSessionCookie(reply, config, result.sid);
      if (result.totpRequired) {
        // ⛔ 不带 user/roles：此时除 2fa/verify 外全部 403，下发用户资料没有意义
        return { totp_required: true, csrf: result.csrf };
      }
      return { user: result.user, roles: result.roles, csrf: result.csrf, totp_required: false };
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/v1/auth/me —— 恢复登录态 + 取 CSRF（前端启动时调用）
  // -------------------------------------------------------------------------
  app.get(
    '/api/v1/auth/me',
    {
      preHandler: [panel.loadPanelSession, panel.requireSession, panel.rejectIfSetupRequired],
      schema: { response: { 200: ME_RESPONSE_SCHEMA } },
    },
    async (request, reply) => {
      const user = await service.findSessionUser(request.session.userId);
      if (!user) {
        // 会话有效但账号已不存在：销毁会话（而不是留着一个悬空 sid）
        await destroySession(redis, config, request.session.sid);
        clearSessionCookie(reply, config);
        throw new AppError('session_expired');
      }

      return {
        user: toPublicUser(user),
        roles: request.session.roles,
        session: {
          created_at: iso(request.session.createdAt),
          last_seen: iso(request.session.lastSeen),
          ip: request.session.ip,
          ua: request.session.ua,
        },
        csrf: request.session.csrf,
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/logout —— 删当前会话 + 清 Cookie（204）
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/logout',
    { preHandler: [panel.loadPanelSession, panel.requireSession, panel.requireCsrf] },
    async (request, reply) => {
      await service.logout({ userId: request.session.userId, sid: request.session.sid, ip: ipOf(request) });
      clearSessionCookie(reply, config);
      reply.code(204);
      return undefined;
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/logout-all —— 全部下线（含当前会话，✅ §4.1）
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/logout-all',
    { preHandler: [panel.loadPanelSession, panel.requireSession, panel.requireCsrf] },
    async (request, reply) => {
      const destroyed = await service.logoutAll({ userId: request.session.userId, ip: ipOf(request) });
      log.info({ userId: request.session.userId, destroyed }, '面板账号已全部下线');
      clearSessionCookie(reply, config);
      reply.code(204);
      return undefined;
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/password —— 自助改密（轮换 sid + 踢其它会话 + 审计）
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/password',
    {
      preHandler: [panel.loadPanelSession, panel.requireFullSession, panel.requireCsrf],
      schema: { body: PASSWORD_BODY_SCHEMA },
    },
    async (request, reply) => {
      const result = await service.changePassword({
        userId: request.session.userId,
        sid: request.session.sid,
        oldPassword: request.body.old_password,
        newPassword: request.body.new_password,
        ip: ipOf(request),
      });

      if (!result.sid) {
        // 改密过程中会话失效（极罕见）：密码已改成功，但只能要求重新登录
        clearSessionCookie(reply, config);
        throw new AppError('session_expired');
      }
      setSessionCookie(reply, config, result.sid);
      reply.code(204);
      return undefined;
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/2fa/setup —— 生成待确认密钥 + 二维码（⛔ enable 之前不生效）
  // setup_required（强制绑定）与 totp_pending、full 均可达；「已绑定 → 409」在服务层卡
  // （矩阵②虽把 setup 列入 pending 放行，字面实现构成 2FA 绕过，落地收敛见 §4.1.1 ⑧ D7）
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/2fa/setup',
    {
      preHandler: [panel.loadPanelSession, panel.requireSession, panel.requireCsrf],
      schema: { response: { 200: SETUP_RESPONSE_SCHEMA } },
    },
    async (request) => {
      return service.setupTotp({ userId: request.session.userId, ip: ipOf(request) });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/2fa/enable —— 验码正式绑定（返回 10 个一次性恢复码，D1）
  // 成功 = 证明持有 → 会话直接转 full 并轮换 sid；失败 400 invalid_totp
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/2fa/enable',
    {
      preHandler: [panel.loadPanelSession, panel.requireSession, panel.rejectIfTotpPending, panel.requireCsrf],
      schema: { body: TOTP_CODE_BODY_SCHEMA, response: { 200: RECOVERY_CODES_RESPONSE_SCHEMA } },
    },
    async (request, reply) => {
      const result = await service.enableTotp({
        userId: request.session.userId,
        sid: request.session.sid,
        code: request.body.code,
        ip: ipOf(request),
      });
      if (!result.sid) {
        // 轮换时会话失效（极罕见）：绑定已完成，但只能要求重新登录
        clearSessionCookie(reply, config);
        throw new AppError('session_expired');
      }
      setSessionCookie(reply, config, result.sid);
      return { recovery_codes: result.recoveryCodes, remaining_recovery_codes: result.recoveryCodes.length };
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/2fa/disable —— 密码二次确认解绑（D3：require_2fa 时 409；D5：连清恢复码）
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/2fa/disable',
    {
      preHandler: [panel.loadPanelSession, panel.requireFullSession, panel.requireCsrf],
      schema: { body: TOTP_PASSWORD_BODY_SCHEMA },
    },
    async (request, reply) => {
      await service.disableTotp({
        userId: request.session.userId,
        password: request.body.password,
        ip: ipOf(request),
      });
      reply.code(204);
      return undefined;
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/2fa/verify —— 登录第二步（TOTP）；成功轮换 sid → 204
  // 限流与 login 同一桶（`ratelimit:login:<ip>`，§6.2 用例 14）：挂在 requireSession 之前，
  // 让"无会话狂刷 verify"同样被计数
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/2fa/verify',
    {
      preHandler: [panel.loadPanelSession, loginRateLimit, panel.requireSession, panel.requireCsrf],
      schema: { body: TOTP_CODE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const result = await service.verifyTotpLogin({
        userId: request.session.userId,
        sid: request.session.sid,
        code: request.body.code,
        ip: ipOf(request),
      });
      if (!result.sid) {
        clearSessionCookie(reply, config);
        throw new AppError('session_expired');
      }
      setSessionCookie(reply, config, result.sid);
      reply.code(204);
      return undefined;
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/2fa/recovery/verify —— 恢复码过第二步（用后即废；限流同上）
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/2fa/recovery/verify',
    {
      preHandler: [panel.loadPanelSession, loginRateLimit, panel.requireSession, panel.requireCsrf],
      schema: { body: RECOVERY_CODE_BODY_SCHEMA, response: { 200: RECOVERY_VERIFY_RESPONSE_SCHEMA } },
    },
    async (request, reply) => {
      const result = await service.verifyRecoveryLogin({
        userId: request.session.userId,
        sid: request.session.sid,
        code: request.body.code,
        ip: ipOf(request),
      });
      if (!result.sid) {
        clearSessionCookie(reply, config);
        throw new AppError('session_expired');
      }
      setSessionCookie(reply, config, result.sid);
      return { remaining_recovery_codes: result.remaining };
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/2fa/recovery/regenerate —— 整批重发恢复码（旧码立即作废；仅完整态）
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/2fa/recovery/regenerate',
    {
      preHandler: [panel.loadPanelSession, panel.requireFullSession, panel.requireCsrf],
      schema: { response: { 200: RECOVERY_CODES_RESPONSE_SCHEMA } },
    },
    async (request) => {
      const result = await service.regenerateRecoveryCodes({
        userId: request.session.userId,
        ip: ipOf(request),
      });
      return { recovery_codes: result.recoveryCodes, remaining_recovery_codes: result.recoveryCodes.length };
    },
  );
}
