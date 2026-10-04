/**
 * Vantage · 统一错误模型
 *
 * 依据：docs/api.md §1.3（统一错误模型 + HTTP 状态码使用规则）、§5.2（默认拒绝）、§10.1（响应体极简）
 *
 * 约定
 *  - 对外响应体固定为 { error: { code, message, details?, request_id } }；
 *  - message 是**中文、人类可读**，但⛔ 不得回显 Agent 配置、阈值、内部路径、脚本或可执行内容；
 *  - 未识别的异常一律折叠为 500 internal_error（细节只进日志，不进响应）；
 *  - PG/Redis 的连接类故障映射为 503 upstream_unavailable，便于反代与前端区分「服务挂了」和「请求错了」。
 */

/**
 * 错误码登记表（code → HTTP 状态 + 默认中文消息）。
 * ✅ 2026-10-04：`nonce_reused` 的口径已统一为 **409**——docs/api.md §1.3 的总表已按 §2.1 与 §6 验收用例
 *    第 4 条校正，本表与文档现已逐条一致，无遗留分歧（旧注释里「待 Owner 拍板后统一文档」已作废）。
 */
export const ERROR_CODES = Object.freeze({
  // 400
  invalid_request: { status: 400, message: '请求不可解析或缺少必需字段' },
  schema_invalid: { status: 400, message: '字段校验失败（白名单外字段 / 数值超范围 / 数组超长）' },
  range_too_large: { status: 400, message: '查询范围超出该精度档允许的最大跨度' },
  expr_not_allowed: { status: 400, message: '本期不接受表达式（expr 必须为 null，零 RCE 约束）' },
  unknown_setting: { status: 400, message: '未知的设置项 key（不在白名单内）' },
  invalid_setting_value: { status: 400, message: '设置项的值类型不符合该 key 的定义' },
  // TOTP 验证码错误（docs/api.md §4.1 的 `2fa/enable` 明确要求 400 + 该 code）
  invalid_totp: { status: 400, message: '验证码不正确，请重新输入' },
  // 人机验证（滑动验证码）：docs/api.md §4.1、docs/slider-captcha-selfbuilt.md §5.4
  // ⛔ 与 401 分开是有意的：前端必须能区分"该过人机验证"与"密码错"，否则没法就地弹滑块
  captcha_required: { status: 400, message: '请先完成人机验证' },
  captcha_invalid: { status: 400, message: '人机验证未通过，请重新尝试' },
  /**
   * 外部人机验证服务（极验）不可用 **且** `GEETEST_FAIL_MODE=closed`（docs/geetest-captcha.md §9）。
   * ⚠️ 503 的 message 会被 `buildErrorBody` 折叠成通用文案（`expose` 只对 <500 为真）——
   *    前端必须按 **`error.code`** 匹配文案，⛔ 不要依赖 message。
   */
  captcha_unavailable: { status: 503, message: '人机验证服务暂时不可用，请稍后重试' },

  // 401
  signature_invalid: { status: 401, message: '签名校验失败' },
  timestamp_skew: { status: 401, message: '请求时间戳超出允许窗口' },
  agent_unknown_or_disabled: { status: 401, message: 'Agent 不存在或已被禁用' },
  session_expired: { status: 401, message: '会话已失效，请重新登录' },
  invalid_credentials: { status: 401, message: '用户名或密码不正确' },

  // 403
  role_denied: { status: 403, message: '当前账号无权执行该操作' },
  totp_required: { status: 403, message: '需要完成二次验证（TOTP）' },
  // 强制绑定策略下的受限态（docs/api.md §4.1.1 ②③）：未绑定 TOTP 且 require_2fa=true
  totp_setup_required: { status: 403, message: '按安全策略要求，请先绑定二次验证（TOTP）' },
  csrf_invalid: { status: 403, message: 'CSRF 校验失败' },

  // 404
  not_found: { status: 404, message: '资源不存在' },

  // 409
  conflict: { status: 409, message: '与当前状态冲突' },
  already_exists: { status: 409, message: '资源已存在' },
  channel_in_use: { status: 409, message: '该通知通道仍被告警规则引用，请先解绑' },
  nonce_reused: { status: 409, message: 'nonce 已被使用（防重放）' },

  // 413 / 415
  payload_too_large: { status: 413, message: '请求体超过体积上限' },
  unsupported_content_encoding: { status: 415, message: '不支持的 Content-Encoding（仅接受 gzip）' },

  // 429
  rate_limited: { status: 429, message: '请求过于频繁，请稍后重试' },

  // 5xx
  internal_error: { status: 500, message: '服务内部错误' },
  upstream_unavailable: { status: 503, message: '依赖的存储服务暂时不可用（PostgreSQL / Redis）' },
});

/** 业务异常基类：携带错误码、HTTP 状态与可选 details */
export class AppError extends Error {
  /**
   * @param {keyof ERROR_CODES} code
   * @param {{ message?: string, details?: unknown, cause?: Error, retryAfterS?: number }} [options]
   */
  constructor(code, options = {}) {
    const spec = ERROR_CODES[code];
    if (!spec) throw new Error(`未登记的错误码：${code}`);
    super(options.message || spec.message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = spec.status;
    this.details = options.details;
    /** 429 响应头 Retry-After（秒） */
    this.retryAfterS = options.retryAfterS;
  }

  /** 是否可安全把 message/details 暴露给调用方 */
  get expose() {
    return this.statusCode < 500;
  }
}

/** 便捷工厂：`throw appError('not_found', { details: { id } })` */
export function appError(code, options) {
  return new AppError(code, options);
}

export function isAppError(err) {
  return err instanceof AppError;
}

// -----------------------------------------------------------------------------
// 外部异常 → 统一错误
// -----------------------------------------------------------------------------

/** PostgreSQL SQLSTATE → 错误码 */
const PG_STATE_MAP = {
  '23505': 'already_exists', // unique_violation
  '23503': 'conflict', // foreign_key_violation
  '23514': 'schema_invalid', // check_violation
  '23502': 'invalid_request', // not_null_violation
  '22P02': 'invalid_request', // invalid_text_representation（如 UUID/INET 格式错）
  '22007': 'invalid_request', // invalid_datetime_format
  '22003': 'schema_invalid', // numeric_value_out_of_range
  '40001': 'conflict', // serialization_failure（可重试）
  '40P01': 'conflict', // deadlock_detected（可重试）
  '53300': 'upstream_unavailable', // too_many_connections
  '57014': 'internal_error', // query_canceled（statement_timeout）
};

/** 连接类 SQLSTATE：08xxx（connection_exception） */
function isPgConnectionState(state) {
  return typeof state === 'string' && state.startsWith('08');
}

/**
 * 把任意异常折叠为 AppError。
 * @param {unknown} err
 * @param {{ logger?: { error: Function } }} [context]
 */
export function normalizeError(err, context = {}) {
  if (isAppError(err)) return err;

  // Fastify 自带错误（如 404 路由未命中、FST_ERR_CTP_INVALID_MEDIA_TYPE）
  const fastifyCode = typeof err?.code === 'string' ? err.code : '';
  if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return new AppError('payload_too_large', { cause: err });
  }
  if (fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || fastifyCode === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
    return new AppError('invalid_request', { message: '请求体不是合法的 JSON', cause: err });
  }
  if (fastifyCode === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH') {
    return new AppError('invalid_request', { cause: err });
  }
  // @fastify/compress 的错误码（本服务的 Agent 路径自己解压，故正常不该出现；
  // 但 compress 的**响应**侧配置若被误开请求解压就会冒出这两个码 —— 显式映射，避免退化成 500）
  if (fastifyCode === 'FST_CP_ERR_INVALID_CONTENT_ENCODING') {
    return new AppError('unsupported_content_encoding', { cause: err });
  }
  if (fastifyCode === 'FST_CP_ERR_INVALID_CONTENT') {
    return new AppError('invalid_request', { message: '请求体解压失败（数据不是合法的压缩流）', cause: err });
  }
  if (fastifyCode === 'FST_ERR_VALIDATION') {
    return new AppError('schema_invalid', { details: err.validation, cause: err });
  }
  if (err?.statusCode === 404) {
    return new AppError('not_found', { cause: err });
  }
  if (err?.statusCode === 429) {
    return new AppError('rate_limited', { cause: err });
  }

  // 领域层抛出的「请求侧」异常：它们自带本表登记的错误码（如 utils/metric.js 的
  // MetricNameError.code = 'schema_invalid'），但不是 AppError 实例。
  // ⛔ 少了这一条，任何一处漏 catch 的 buildMetric() 都会退化成 500 —— 明明是可解释的 400。
  //    （约束：本表登记的 code 都是 snake_case 自定义串，不会与库/驱动的错误码撞车。）
  if (typeof err?.code === 'string' && Object.hasOwn(ERROR_CODES, err.code)) {
    return new AppError(err.code, { message: err.message, cause: err });
  }

  // PostgreSQL
  const pgState = err?.code;
  if (typeof pgState === 'string' && /^[0-9A-Z]{5}$/.test(pgState)) {
    if (isPgConnectionState(pgState) || pgState === '57P01' /* admin_shutdown */) {
      return new AppError('upstream_unavailable', { cause: err });
    }
    const mapped = PG_STATE_MAP[pgState];
    if (mapped) {
      // ⛔ 不回显 constraint / table 名等库内结构；排障请查日志（err.detail 已由日志记录）
      return new AppError(mapped, { cause: err });
    }
  }

  // Redis（ioredis）：连接/超时类
  if (
    err?.name === 'MaxRetriesPerRequestError' ||
    err?.name === 'ReplyError' ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Connection is closed|Stream isn't writeable/i.test(
      err?.message || '',
    )
  ) {
    return new AppError('upstream_unavailable', { cause: err });
  }

  // 兜底：500（细节只进日志）
  context.logger?.error({ err }, '未识别的服务端异常');
  return new AppError('internal_error', { cause: err });
}

/**
 * 构造符合 docs/api.md §1.3 的响应体。
 * @param {AppError} appErr
 * @param {string} requestId
 */
export function buildErrorBody(appErr, requestId) {
  const error = {
    code: appErr.code,
    message: appErr.expose ? appErr.message : ERROR_CODES.internal_error.message,
    request_id: requestId,
  };
  if (appErr.expose && appErr.details !== undefined) error.details = appErr.details;
  return { error };
}
