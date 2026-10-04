/**
 * Vantage · 极验 GeeTest v4 纯函数（签名 / 参数拼装 / 响应解析）
 *
 * 依据：docs/geetest-captcha.md §4（协议与算法）、§4.3（sign_token）、§5.2（两种失败必须分开）、
 *       §10.1（单测清单）
 *
 * ⛔ 本文件**零网络、零 Redis、零配置读取**：只做字符串与 JSON 变换。
 *    这样"签名写反了""请求异常的响应被当成校验失败"这类错误能在**纯单测**里被钉死，
 *    而不必（也绝不能）在测试里真连极验。
 *
 * 🔑 极验 v4 只有这一个对外接口，两条铁律：
 *
 *  1. `sign_token = HMAC-SHA256(key = captcha_key, message = lot_number)`
 *     ⛔ 把 key 与 message 写反会 100% 校验失败，而极验返回的 reason 很含糊，
 *     极易白查半天 —— 所以 `signToken` 的参数顺序与注释就是这条约束本身。
 *
 *  2. 响应有**两种完全不同的形状**，必须分开处理：
 *       · `{ result: 'success' | 'fail', reason, captcha_args }`  ← **校验结论**（用户过没过）
 *       · `{ status: 'error', code: '-50005', msg, desc }`        ← **请求本身有问题**（我们/极验的错）
 *     ⛔ 把后者当成 `fail` 会把「极验不可用」记成「用户作弊」，而失败模式（放行 / 拒绝）也随之全错。
 */

import { createHmac } from 'node:crypto';

/**
 * 归一化后的判定结果码（⛔ 与 docs/geetest-captcha.md §6.2 的 `details.reason` 逐字一致）。
 * 自建滑块的 `mismatch` / `track_suspicious` / `too_many_attempts` 在极验下**不存在**，
 * 因此这里只有两个值。
 */
export const GEETEST_REASON = Object.freeze({
  /** 极验明确判定"没通过"：用户失败、pass_token 过期、或前端宕机时伪造的本地 pass_token */
  validateFailed: 'validate_failed',
  /** 极验**不可用**：网络异常 / 超时 / HTTP 非 200 / 响应不是合法 JSON / body 是 error 形状 */
  unavailable: 'unavailable',
});

/** 极验官方默认校验地址（⛔ 只写域名：协议由 buildValidateUrl 固定为 https，路径也由它拼） */
export const GEETEST_DEFAULT_API_SERVER = 'gcaptcha4.geetest.com';

/**
 * `vendor_reason` 的最大留存长度。
 * 极验的 reason 是短句；截断纯粹是为了挡住畸形/被篡改的响应把审计表撑爆。
 */
export const VENDOR_REASON_MAX = 200;

/**
 * 极验 v4 签名：**key = captcha_key（私钥），message = lot_number（流水号）**。
 *
 * @param {string} lotNumber 极验返回的验证流水号（前端 `getValidate().lot_number`）
 * @param {string} captchaKey 极验后台的私钥（⛔ 只存在于服务端，永不进响应/日志）
 * @returns {string} 十六进制小写签名
 */
export function signToken(lotNumber, captchaKey) {
  if (typeof lotNumber !== 'string' || lotNumber === '') {
    throw new Error('signToken 需要 lot_number 字符串');
  }
  if (typeof captchaKey !== 'string' || captchaKey === '') {
    throw new Error('signToken 需要 captcha_key 字符串');
  }
  return createHmac('sha256', captchaKey).update(lotNumber, 'utf8').digest('hex');
}

/**
 * 拼二次校验地址。
 *
 * 🔑 为什么 `captcha_id` 放 **URL query** 而不是 body：官方示例如此，且异常时能在极验侧的
 *    访问日志里按 id 直接定位；body 里只放那 5 个参数。
 * ⚠️ 一律用 **HTTPS**（官方文档示例写的是 `http://`，照抄会把密钥签名路径降级成明文）。
 *
 * @param {{ apiServer?: string, captchaId: string }} input
 */
export function buildValidateUrl({ apiServer = GEETEST_DEFAULT_API_SERVER, captchaId }) {
  if (typeof captchaId !== 'string' || captchaId === '') {
    throw new Error('buildValidateUrl 需要 captcha_id');
  }
  if (typeof apiServer !== 'string' || apiServer === '') {
    throw new Error('buildValidateUrl 需要 apiServer');
  }
  return `https://${apiServer}/validate?captcha_id=${encodeURIComponent(captchaId)}`;
}

/**
 * 拼二次校验的请求体（`application/x-www-form-urlencoded`）。
 * ⛔ 返回值含 `sign_token`，即"用私钥算出来的东西"——不得进日志、不得进响应。
 *
 * @param {{ lotNumber: string, captchaOutput: string, passToken: string, genTime: string, captchaKey: string }} input
 * @returns {string} urlencoded 请求体
 */
export function buildValidateBody({ lotNumber, captchaOutput, passToken, genTime, captchaKey }) {
  const params = new URLSearchParams({
    lot_number: String(lotNumber),
    captcha_output: String(captchaOutput),
    pass_token: String(passToken),
    gen_time: String(genTime),
    sign_token: signToken(String(lotNumber), captchaKey),
  });
  return params.toString();
}

/**
 * 解析二次校验响应 —— **本模块最重要的一个函数**。
 *
 * @param {{ httpStatus: number|null, body: unknown }} input `body` 允许是原始文本（推荐）或已解析对象
 * @returns {(
 *   { ok: true } |
 *   { ok: false, reason: string, unavailable: true, httpStatus: number|null, vendorCode?: string|null } |
 *   { ok: false, reason: string, vendorReason: string|null, unavailable?: undefined }
 * )} 归一化结果。⛔ `unavailable` 与"校验失败"必须能被调用方区分开（见文件头第 2 条）。
 */
export function parseValidateResponse({ httpStatus = null, body } = {}) {
  // ① HTTP 非 200：连"校验结论"都没拿到 → 不可用
  if (httpStatus !== 200) {
    return { ok: false, reason: GEETEST_REASON.unavailable, unavailable: true, httpStatus };
  }

  // ② 非 JSON / 空 body：同上，⛔ 不猜
  let parsed = null;
  if (body !== null && typeof body === 'object') {
    parsed = body;
  } else if (typeof body === 'string' && body.trim() !== '') {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: GEETEST_REASON.unavailable, unavailable: true, httpStatus };
  }

  // ③ 请求层异常（形状与校验结论完全不同）
  if (parsed.status === 'error') {
    return {
      ok: false,
      reason: GEETEST_REASON.unavailable,
      unavailable: true,
      httpStatus,
      vendorCode: typeof parsed.code === 'string' ? parsed.code : null,
    };
  }

  // ④ 校验结论
  if (parsed.result === 'success') return { ok: true };
  if (parsed.result === 'fail') {
    return { ok: false, reason: GEETEST_REASON.validateFailed, vendorReason: sanitizeReason(parsed.reason) };
  }

  // ⑤ result 缺失或取值不认识：既不能当"通过"（那就是静默放行），也不能当"用户没通过"（冤枉人）
  return { ok: false, reason: GEETEST_REASON.unavailable, unavailable: true, httpStatus };
}

/**
 * 清洗极验返回的 `reason`：去掉控制字符（防日志注入/换行伪造）、限长。
 * @returns {string|null} 清洗后为空则返回 null（⛔ 不用空串，避免审计里出现 `vendor_reason: ""`）
 */
export function sanitizeReason(reason) {
  if (typeof reason !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- 这里就是要匹配控制字符
  const cleaned = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (cleaned === '') return null;
  return cleaned.length > VENDOR_REASON_MAX ? `${cleaned.slice(0, VENDOR_REASON_MAX)}…` : cleaned;
}
