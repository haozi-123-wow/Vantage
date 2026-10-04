/**
 * Vantage · 时间参数的解析与范围校验（**HTTP 入参**专用）
 *
 * 依据：docs/api.md §1.2 ③（「请求 `from`/`to` 接受 RFC3339（含时区）或 unix 毫秒整数」）、
 *       §4.3（时序查询的档位与最大范围）、§4.2（探活历史 / IP 历史的时间窗口）
 *
 * 🔑 为什么单独成模块：`from`/`to` 会被**每个**历史类端点用到（探活历史、IP 历史、时序查询、
 *    告警事件、审计日志…）。三处各写一遍解析，就会有三套边界口径（`to` 缺省是"现在"还是"不限制"？
 *    非法值报 400 还是静默忽略？）——那是典型的"同一个人在三个页面上看到三种行为"。
 *
 * ⛔ 本模块**不做**任何时区转换：返回值是 `Date`（= UTC 瞬间），
 *    本地化一律在前端（docs/api.md §1.2：服务端一律 UTC）。
 */

import { AppError } from './errors.js';

/** unix 秒 / 毫秒的判定阈值：小于它按**秒**解释（10^11 s ≈ 公元 5138 年，远超任何毫秒时间戳） */
const SECOND_TIMESTAMP_MAX = 1e11;

/**
 * 解析一个时间参数。
 *
 * 接受的写法（与 `docs/api.md` §1.2 一致）：
 *  - RFC3339 / ISO8601 字符串（**必须带时区或 `Z`**）——`2026-10-04T12:00:00Z`、`+08:00` 均可；
 *  - unix 毫秒整数（数字或纯数字字符串）；
 *  - unix 秒整数（`< 1e11` 的数字按秒解释——**这是刻意的宽容**：
 *    `curl`/`jq` 里手写时间戳时经常给秒，而"把秒当毫秒"会把时间缩到 1970 年、
 *    表现为"查询结果永远是空的"，比报错难查得多）。
 *
 * ⛔ 不带时区的裸时间串（`2026-10-04 12:00:00`）**一律拒绝**：服务端无法知道那是不是 UTC，
 *    猜错的后果是整整 8 小时的数据错位（而它看起来"有数据"）。
 *
 * @param {unknown} raw 原始参数值
 * @param {string} field 字段名（用于错误 details）
 * @returns {Date|null} `null`/`undefined`/空串 → `null`（= 调用方使用默认值）
 * @throws {AppError} `schema_invalid`
 */
export function parseTimeParam(raw, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new AppError('schema_invalid', { details: { field, reason: 'time_required' } });
  }

  const text = String(raw).trim();

  // 纯数字（含负号）→ 按 unix 时间戳解释
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      throw new AppError('schema_invalid', { details: { field, reason: 'invalid_time' } });
    }
    const ms = Math.abs(n) < SECOND_TIMESTAMP_MAX ? n * 1000 : n;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) {
      throw new AppError('schema_invalid', { details: { field, reason: 'invalid_time' } });
    }
    return date;
  }

  // ⛔ 裸时间串（无时区）拒绝：见函数头
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    throw new AppError('schema_invalid', {
      details: { field, reason: 'timezone_required', hint: 'RFC3339（含 Z 或 ±HH:MM）或 unix 毫秒' },
    });
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new AppError('schema_invalid', { details: { field, reason: 'invalid_time' } });
  }
  return date;
}

/**
 * 归一化 `[from, to]` 窗口并做跨度校验。
 *
 * ⚠️ `to` 缺省 = **数据库当前时刻之后**（用 `null` 表示"不设上界"，由 SQL 的 `now()` 兜）——
 *    不在这里取 `Date.now()`：文件头已说明服务端时间一律以 DB 为准（多实例下进程时钟会漂）。
 *
 * @param {object} input
 * @param {unknown} input.from
 * @param {unknown} input.to
 * @param {Date} input.defaultFrom `from` 缺省时使用（如"最近 24 小时"）
 * @param {number} input.maxSpanS 允许的最大跨度（秒）
 * @param {object} [input.now] 参考时刻（`to` 缺省时不用于查询，只用于跨度判断）
 * @throws {AppError} `schema_invalid`（非法时间 / `from > to`）、`range_too_large`（跨度超限）
 * @returns {{ from: Date, to: Date|null }}
 */
export function parseTimeWindow(input) {
  const { from: rawFrom, to: rawTo, defaultFrom, maxSpanS, now } = input;
  const from = parseTimeParam(rawFrom, 'from') ?? defaultFrom;
  const to = parseTimeParam(rawTo, 'to');
  const reference = to ?? now ?? new Date();

  if (to && from.getTime() > to.getTime()) {
    throw new AppError('schema_invalid', { details: { field: 'from', reason: 'from_after_to' } });
  }
  const spanS = (reference.getTime() - from.getTime()) / 1000;
  if (spanS > maxSpanS) {
    throw new AppError('range_too_large', {
      details: { max_span_s: maxSpanS, span_s: Math.round(spanS), hint: '缩小 from/to 或改用更粗的档位' },
    });
  }
  return { from, to };
}
