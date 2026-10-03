/**
 * Vantage · 面板会话中间件（装载 / 鉴权 / CSRF / 角色）
 *
 * 依据：docs/api.md §4.1（Cookie、会话、CSRF）、§4.1.1 ②（三态矩阵）、§4.9（RBAC 两级）
 *
 * 分工：本模块只负责**HTTP 语义**（Cookie 读写、状态码、请求对象上的会话），
 * 会话的存取在 `services/session.service.js`，业务判断在 `services/auth.service.js`。
 *
 * 🔑 CSRF 的两个关键取舍
 *  1. **无会话时放行**：CSRF 借的是"浏览器会自动带上的环境权限"，没有会话就没有可借的东西
 *     （`/auth/login` 正是这种情形，前端也显式豁免了它，见 docs/api.md §4.1 的豁免说明）。
 *     若在这里对无会话请求也抛 csrf_invalid，登录会在第一步就挂掉——而且原因极难从错误码看出来。
 *  2. **安全方法（GET/HEAD/OPTIONS）不校验**：它们不改状态，加上校验只会让前端为了读数据也去带 CSRF。
 *
 * ⚠️ 落地要求（B4 的 `app.js`）：注册这些 preHandler 之前必须
 *    `app.decorateRequest('session', null)`，让 `request.session` 成为**声明过**的字段
 *    （Fastify 靠装饰器生成隐藏类，运行时动态挂属性会退化成字典模式并拖慢所有请求）。
 *
 * ⛔ **所有 preHandler 都必须是 `async`**（本文件里那五个守卫都声明成 async，哪怕函数体全是同步判断）：
 *    Fastify 对"既不是 async、也不接收 `done` 回调"的 hook 会按**回调式**处理 —— 它一直等 `done()`，
 *    于是请求**永久挂起**（既不返回响应也不报错，连接就这么挂着）。
 *    这个坑在"直接调用该函数"的单元测试里**完全看不出来**，只有走真实 HTTP 栈才会暴露。
 */

import { sessionState, loadSession, SESSION_STATE } from '../services/session.service.js';
import { timingSafeEqualStr } from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';

/** 不改状态的 HTTP 方法（CSRF 只针对状态变更请求） */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Cookie 名（来自 config，默认 `vantage_sid`） */
export function sessionCookieName(config) {
  return config.security.session.cookieName;
}

/**
 * 会话 Cookie 属性（✅ docs/api.md §4.1）。
 * ⛔ 只放不透明 sid：不得在 Cookie 里塞用户资料/角色（那等于把会话内容暴露给页面脚本与日志）。
 */
export function sessionCookieOptions(config, extra = {}) {
  const section = config.security.session;
  return {
    path: '/',
    httpOnly: true,
    sameSite: section.cookieSameSite ?? 'lax',
    secure: section.cookieSecure === true,
    maxAge: section.absoluteTtlS,
    // sid 是不透明随机值、服务端在 Redis 校验；⛔ 不做"签名 cookie"以免出现双重语义
    signed: false,
    ...extra,
  };
}

export function setSessionCookie(reply, config, sid) {
  reply.setCookie(sessionCookieName(config), sid, sessionCookieOptions(config));
}

/** 清 Cookie：属性必须与写入时一致（尤其 path），否则浏览器会留下一个删不掉的旧 Cookie */
export function clearSessionCookie(reply, config) {
  reply.clearCookie(sessionCookieName(config), sessionCookieOptions(config, { maxAge: 0 }));
}

/**
 * 创建面板鉴权中间件集合。
 * @param {{ redis: import('ioredis').Redis, config: object, logger?: object }} deps
 */
export function createPanelAuth({ redis, config, logger }) {
  /**
   * 装载会话（**不拦截**）：有效则挂到 `request.session`；无效则顺手清掉那个死 Cookie。
   * 放在所有 `/api/v1/*` 路由的最前面，让"要不要拒绝"由后面按端点决定
   * （`me` 与 2FA 绑定接口在受限态下必须仍然可达）。
   */
  async function loadPanelSession(request, reply) {
    const sid = request.cookies?.[sessionCookieName(config)];
    if (!sid) return;

    const session = await loadSession(redis, config, sid, { logger });
    if (session) {
      request.session = session;
      return;
    }
    // 过期/伪造/结构损坏的 sid：清 Cookie，避免前端每次请求都带着一个必然失败的标识
    clearSessionCookie(reply, config);
  }

  /** 必须已登录（401 `session_expired`）。⚠️ 必须 async，理由见文件头；下同 */
  async function requireSession(request) {
    if (!request.session) throw new AppError('session_expired');
  }

  /**
   * 必须是**完整态**会话（docs/api.md §4.1.1 ②）。
   *  - `setup_required`（策略要求绑定 2FA 但未绑定）→ 403 `totp_setup_required`
   *  - `totp_pending`（已绑定但未过第二步）→ 403 `totp_required`
   */
  async function requireFullSession(request) {
    if (!request.session) throw new AppError('session_expired');
    const state = sessionState(request.session);
    if (state === SESSION_STATE.setupRequired) throw new AppError('totp_setup_required');
    if (state === SESSION_STATE.totpPending) throw new AppError('totp_required');
  }

  /**
   * `GET /auth/me` 专用：受限态里的 `setup_required` **必须显式返回 403**。
   *
   * 🔑 为什么不能只靠 `requireFullSession`：`me` 在受限态下是"唯一还能问的接口"，
   *    面板正是靠它拿到 403 `totp_setup_required` 才知道要跳去绑定页
   *    （`web/src/store/auth.ts` 的 `refreshMe()` 就是这么判的）。
   *    若这里给 200，前端会认为自己已登录并进入面板 —— 然后每个请求都 403，用户看到一片"加载失败"。
   *    ⚠️ `totp_pending` 不在此列（`me` 按 §4.1 放行），前端此时由各接口的 403 `totp_required` 引导回第二步。
   */
  async function rejectIfSetupRequired(request) {
    if (request.session && sessionState(request.session) === SESSION_STATE.setupRequired) {
      throw new AppError('totp_setup_required');
    }
  }

  /**
   * `POST /auth/2fa/enable` 专用：`totp_pending` 态**禁止重复绑定**（docs/api.md §4.1.1 ②矩阵）。
   *
   * 🔑 为什么这个态不放开 enable：pending 意味着「已绑定、只差第二步」。此时放 enable 只会出现两种情形——
   *    ① 种子还没通过验证就想再绑一次（无意义）；② 「丢失设备」想换绑——但换绑后再用新种子自验
   *    等于让**只持密码的人**替换第二因子，这是 2FA 要防的本体（self-recovery 必须走恢复码或管理员重置）。
   *    setup 端点在服务层同样卡「已绑定 → 409」（见 services/auth.service.js setupTotp），两层互为备份。
   */
  async function rejectIfTotpPending(request) {
    if (request.session && sessionState(request.session) === SESSION_STATE.totpPending) {
      throw new AppError('totp_required');
    }
  }

  /** CSRF 双提交校验（详见文件头两条取舍） */
  async function requireCsrf(request) {
    if (!request.session) return;
    if (SAFE_METHODS.has(request.method)) return;
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || !timingSafeEqualStr(token, request.session.csrf)) {
      throw new AppError('csrf_invalid');
    }
  }

  /** RBAC（暂时两级，✅ 决策：`user` 纯只读、所有写操作仅 `admin`） */
  function requireRole(role) {
    return async function roleGuard(request) {
      if (!request.session) throw new AppError('session_expired');
      if (!Array.isArray(request.session.roles) || !request.session.roles.includes(role)) {
        throw new AppError('role_denied');
      }
    };
  }

  return {
    loadPanelSession,
    requireSession,
    requireFullSession,
    rejectIfSetupRequired,
    rejectIfTotpPending,
    requireCsrf,
    requireRole,
  };
}
