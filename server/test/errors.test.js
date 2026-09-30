/**
 * 统一错误模型测试 —— 对齐 docs/api.md §1.3（错误信封与状态码规则）
 *
 * ⚠️ 关键安全断言：任何 5xx 都**不得**把内部细节（SQL、约束名、连接串）回显给调用方。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppError,
  ERROR_CODES,
  appError,
  buildErrorBody,
  isAppError,
  normalizeError,
} from '../src/utils/errors.js';

test('错误码登记表：状态码与文档 §1.3 一致', () => {
  const expected = {
    invalid_request: 400,
    schema_invalid: 400,
    range_too_large: 400,
    expr_not_allowed: 400,
    unknown_setting: 400,
    invalid_setting_value: 400,
    signature_invalid: 401,
    timestamp_skew: 401,
    agent_unknown_or_disabled: 401,
    session_expired: 401,
    invalid_credentials: 401,
    role_denied: 403,
    totp_required: 403,
    csrf_invalid: 403,
    not_found: 404,
    conflict: 409,
    already_exists: 409,
    channel_in_use: 409,
    // ⚠️ §1.3 原列 401，但 §2.1 错误表与 §6 验收用例写 409 → 以更具体者为准（见 migrations/README.md M-1）
    nonce_reused: 409,
    payload_too_large: 413,
    unsupported_content_encoding: 415,
    rate_limited: 429,
    internal_error: 500,
    upstream_unavailable: 503,
  };
  for (const [code, status] of Object.entries(expected)) {
    assert.equal(ERROR_CODES[code]?.status, status, `${code} 状态码`);
  }
});

test('AppError：携带 code/statusCode/details/retryAfterS，且 5xx 默认不外露', () => {
  const err = appError('rate_limited', { retryAfterS: 30, details: { scope: 'agent' } });
  assert.ok(err instanceof AppError);
  assert.ok(isAppError(err));
  assert.equal(err.statusCode, 429);
  assert.equal(err.retryAfterS, 30);
  assert.equal(err.expose, true);
  assert.equal(err.message, ERROR_CODES.rate_limited.message); // 默认中文消息

  assert.equal(appError('internal_error').expose, false);
  assert.throws(() => appError('not_a_real_code'));
});

test('buildErrorBody：符合 §1.3 信封，且 5xx 折叠为通用消息、不携带 details', () => {
  const notFound = buildErrorBody(appError('not_found', { details: { id: 'x' } }), 'req-1');
  assert.deepEqual(notFound, {
    error: { code: 'not_found', message: '资源不存在', details: { id: 'x' }, request_id: 'req-1' },
  });

  const boom = new AppError('internal_error', {
    message: '连接 postgres://user:pw@host/db 失败：relation "agents" does not exist',
    details: { sql: 'SELECT * FROM agents' },
  });
  const body = buildErrorBody(boom, 'req-2');
  assert.equal(body.error.code, 'internal_error');
  assert.equal(body.error.message, ERROR_CODES.internal_error.message);
  assert.equal(body.error.details, undefined);
  assert.equal(body.error.request_id, 'req-2');
  assert.ok(!JSON.stringify(body).includes('postgres://'), '5xx 响应不得泄露连接串');
  assert.ok(!JSON.stringify(body).includes('agents'), '5xx 响应不得泄露库内结构');
});

test('normalizeError：已识别的 AppError 原样透传', () => {
  const original = appError('schema_invalid', { details: { field: 'metrics.cpu.cores' } });
  assert.equal(normalizeError(original), original);
});

test('normalizeError：PostgreSQL 错误按 SQLSTATE 映射', () => {
  const cases = [
    [{ code: '23505', detail: 'Key (name)=(a) already exists.' }, 'already_exists', 409],
    [{ code: '23503' }, 'conflict', 409],
    [{ code: '23514' }, 'schema_invalid', 400],
    [{ code: '23502' }, 'invalid_request', 400],
    [{ code: '22P02' }, 'invalid_request', 400],
    [{ code: '40001' }, 'conflict', 409], // 序列化失败：可重试
    [{ code: '40P01' }, 'conflict', 409], // 死锁：可重试
    [{ code: '53300' }, 'upstream_unavailable', 503],
    [{ code: '57014' }, 'internal_error', 500], // statement_timeout
    [{ code: '08006' }, 'upstream_unavailable', 503], // connection_failure
    [{ code: '08003' }, 'upstream_unavailable', 503],
    [{ code: '57P01' }, 'upstream_unavailable', 503], // admin_shutdown
  ];
  for (const [input, code, status] of cases) {
    const mapped = normalizeError(Object.assign(new Error('pg'), input));
    assert.equal(mapped.code, code, JSON.stringify(input));
    assert.equal(mapped.statusCode, status, JSON.stringify(input));
  }
});

test('normalizeError：Redis 与网络类错误 → 503', () => {
  for (const input of [
    Object.assign(new Error('Connection is closed.'), { name: 'MaxRetriesPerRequestError' }),
    new Error('connect ECONNREFUSED 127.0.0.1:6379'),
    new Error("Stream isn't writeable and enableOfflineQueue options is false"),
    new Error('getaddrinfo ENOTFOUND redis'),
  ]) {
    assert.equal(normalizeError(input).code, 'upstream_unavailable', input.message);
  }
});

test('normalizeError：Fastify 内置错误映射', () => {
  assert.equal(normalizeError({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' }).code, 'payload_too_large');
  assert.equal(normalizeError({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' }).code, 'invalid_request');
  assert.equal(normalizeError({ code: 'FST_ERR_CTP_EMPTY_JSON_BODY' }).code, 'invalid_request');
  assert.equal(normalizeError({ code: 'FST_ERR_VALIDATION', validation: [] }).code, 'schema_invalid');
  assert.equal(normalizeError({ statusCode: 404 }).code, 'not_found');
  assert.equal(normalizeError({ statusCode: 429 }).code, 'rate_limited');
});

test('normalizeError：未知异常 → 500，且把原始异常交给 logger（只进日志）', () => {
  const logged = [];
  const mapped = normalizeError(new Error('boom: 内部路径 /srv/app/src/x.js'), {
    logger: { error: (...args) => logged.push(args) },
  });
  assert.equal(mapped.code, 'internal_error');
  assert.equal(mapped.statusCode, 500);
  assert.equal(logged.length, 1, '原始异常必须进日志，否则无从排障');
});
