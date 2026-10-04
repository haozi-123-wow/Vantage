/**
 * Vantage · 滑动验证码原语（出题 / 容差与轨迹校验）
 *
 * 依据：docs/slider-captcha-selfbuilt.md §6（算法规范：出题、校验规则、"不泄露答案的写法"）、
 *       docs/api.md §4.1（`captcha/challenge`、`captcha/verify` 的契约）
 *
 * ⛔ 本模块**只做纯函数**：不碰 Redis、不碰 PG、不发请求、不写日志。
 *    "一次性""失败次数上限""过期"都需要跨请求状态，那是调用方的职责
 *    （`services/captcha.service.js` + Redis 键 `captcha:<id>`，见自建方案 §4）；
 *    本模块只回答两件事：**怎么出一道题**、**这次滑动对不对**。
 *
 * 🔑 两个必须说清楚的取舍
 *
 *  1. **答案只以绘制结果体现，且不以"可 grep 的独立属性"出现**。
 *     缺口必须画出来（人得看得见），所以答案在数学上永远能从坐标反推——这是所有滑块方案的
 *     共同边界（自建方案 §2.5：连现成的浏览器内 ONNX 缺口识别都已有开源实现）。
 *     本模块能做、也确实做了的是：把缺口坐标拆成
 *     「组内坐标 = 答案 + 随机偏移」+「外层 transform = −随机偏移」两个数，
 *     于是响应里**不会出现 `x="<答案>"` 这种一眼可读的形态**，要拿到答案得解析 SVG 再做一次减法。
 *     ⛔ 别把它当加密——它只抬高脚本的最短路径，不构成安全边界；安全来自
 *     「服务端唯一判定 + 一次性 + 失败上限 + 失败计数触发的出场策略」。
 *
 *  2. **垂直位置不是秘密**：拼图块的 y 固定画在 `piece_svg` 里（同画布尺寸），
 *     前端只需把它横向平移。于是接口**不必下发 y**（契约里也没有 y），
 *     答案只剩一个横坐标——少一个可被利用的自由度。
 */

import crypto from 'node:crypto';

// -----------------------------------------------------------------------------
// 画布与拼图块
// -----------------------------------------------------------------------------

/** 画布逻辑尺寸。⚠️ 前端可等比缩放显示，但提交的 `x` 必须是**逻辑坐标**。 */
export const SLIDER_WIDTH = 320;
export const SLIDER_HEIGHT = 160;

/** 拼图块本体边长 */
export const PIECE_SIZE = 44;

/** 拼图块右侧凸起半径（与缺口形状必须一致，否则视觉上永远"差一点"） */
export const PIECE_KNOB = 10;

/** 拼图块占位总宽 = 本体 + 凸起 —— 决定横坐标上界（见 X_MAX_RATIO 注释） */
export const PIECE_TOTAL_WIDTH = PIECE_SIZE + PIECE_KNOB;

/**
 * 答案横坐标区间（占画布宽度比例）。
 * 🔑 上界 0.82 而不是 0.85：`x + PIECE_TOTAL_WIDTH ≤ SLIDER_WIDTH`（262 + 54 = 316 ≤ 320），
 *    否则拼图块在最右端会被画出画布——表现为"拖到底也对不上"的幽灵故障。
 *    下界 0.35 给左侧的拼图块轨道留位置（块初始停在 x=0）。
 */
const X_MIN_RATIO = 0.35;
const X_MAX_RATIO = 0.82;

/** 答案纵坐标区间（比例）。⛔ 只有上界受 `y + PIECE_SIZE ≤ height` 约束（0.70*160+44=156 ≤160）。 */
const Y_MIN_RATIO = 0.15;
const Y_MAX_RATIO = 0.7;

// -----------------------------------------------------------------------------
// 轨迹规则（自建方案 §6.2 的表，逐条落地）
// -----------------------------------------------------------------------------

/** 采样点下限：挡"一次事件直接给终点" */
export const TRACK_MIN_POINTS = 8;

/** 采样点上限：请求体防护（路由 schema 亦有 maxItems，双保险） */
export const TRACK_MAX_POINTS = 200;

/** 总时长区间（毫秒）：挡瞬移与挂机不动 */
export const TRACK_MIN_MS = 300;
export const TRACK_MAX_MS = 15_000;

/** 允许的"回退"次数与幅度：真实拖动有抖动，脚本常是完美单调 */
export const TRACK_MAX_BACKTRACKS = 2;
export const TRACK_BACKTRACK_PX = 3;

/** 末点与提交 x 的最大差值：挡"轨迹与提交值不一致"的伪造 */
export const TRACK_LAST_POINT_PX = 2;

/**
 * 速度差阈值（px/ms）。真实拖动必然有加减速；`max - min < 该值` 视为匀速机器滑动。
 * ⚠️ 取 0.02 是"宽松挡一下"：真人匀速画直线的概率极低，但也别把慢速精细拖动误杀。
 */
export const SPEED_EPSILON = 0.02;

/** 默认容差（px）；运行时由 `config.security.captcha.tolerancePx` 覆盖 */
export const DEFAULT_TOLERANCE_PX = 5;

/** 出题/校验的失败原因（⛔ 与 docs/api.md §4.1 的 `details.reason` 枚举逐字对应） */
export const SLIDER_REASON = Object.freeze({
  mismatch: 'mismatch',
  trackSuspicious: 'track_suspicious',
});

// -----------------------------------------------------------------------------
// 工具
// -----------------------------------------------------------------------------

/** `crypto.randomInt` 的闭区间包装（Node 的 randomInt(min,max) 上界是开区间） */
function defaultRandomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

/** 收敛浮点噪声：坐标写进 SVG 前保留 2 位，避免 `123.00000000000001` 这类脏串 */
function num(value) {
  return Number(Number(value).toFixed(2));
}

/** 随机色（HSL，低饱和背景更适合辨认缺口） */
function hsl(randomInt, lightness) {
  const hue = randomInt(0, 359);
  const sat = randomInt(18, 52);
  return `hsl(${hue} ${sat}% ${lightness}%)`;
}

// -----------------------------------------------------------------------------
// 出题
// -----------------------------------------------------------------------------

/**
 * 生成一道题的答案（缺口位置）。答案的横坐标即"正确滑动距离"。
 *
 * @param {{ width?: number, height?: number, randomInt?: (min: number, max: number) => number }} [options]
 *   `randomInt` 可注入 → 测试**无需真实随机**即可断言边界（与 `utils/totp.js` 注入 `time` 同一取向）
 * @returns {{ x: number, y: number }} 逻辑坐标（缺口左上角）
 */
export function generateChallenge(options = {}) {
  const width = options.width ?? SLIDER_WIDTH;
  const height = options.height ?? SLIDER_HEIGHT;
  const randomInt = options.randomInt ?? defaultRandomInt;

  const xMin = Math.ceil(width * X_MIN_RATIO);
  // ⛔ 上界同时受"块不能被画出画布"约束（见 X_MAX_RATIO 注释）
  const xMax = Math.min(Math.floor(width * X_MAX_RATIO), width - PIECE_TOTAL_WIDTH);
  const yMin = Math.ceil(height * Y_MIN_RATIO);
  const yMax = Math.min(Math.floor(height * Y_MAX_RATIO), height - PIECE_SIZE);

  return { x: randomInt(xMin, xMax), y: randomInt(yMin, yMax) };
}

/** 拼图块形状（本体圆角矩形 + 右侧凸起）——缺口与拼图块共用，保证形状完全一致 */
function pieceShape(size, fill, stroke) {
  const radius = Math.round(size * 0.2);
  const knob = Math.round(size * (PIECE_KNOB / PIECE_SIZE));
  const strokeAttr = stroke ? ` stroke="${stroke}" stroke-width="1"` : '';
  // ⚠️ 凸起画在 (size, size/2)：与 pieceShape 的调用方约定同一局部坐标系
  return (
    `<rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${fill}"${strokeAttr}/>` +
    `<circle cx="${size}" cy="${size / 2}" r="${knob}" fill="${fill}"${strokeAttr}/>`
  );
}

/**
 * 合成背景图（含缺口）与拼图块两个 SVG。
 *
 * @param {{ x: number, y: number, width?: number, height?: number, randomInt?: Function }} input
 * @returns {{ bgSvg: string, pieceSvg: string }}
 *   - `bgSvg`：画布尺寸，缺口画在 `(x, y)`
 *   - `pieceSvg`：**同样是画布尺寸**，拼图块画在 `(0, y)`；前端只需整体横向平移它
 *     （于是接口⛔ 不需要下发 y，答案只剩横坐标）
 */
export function buildChallengeSvg(input) {
  const width = input.width ?? SLIDER_WIDTH;
  const height = input.height ?? SLIDER_HEIGHT;
  const randomInt = input.randomInt ?? defaultRandomInt;

  const id = `r${randomInt(0x10000, 0xfffff).toString(16)}`;
  const { x, y } = input;

  // 🔑 反 grep 的随机偏移：缺口在组内坐标是 (x + dx, y + dy)，外层再平移 (-dx, -dy)。
  //    渲染结果仍然精确落在 (x, y)，但响应里**不存在**等于答案的独立数值。
  const dx = randomInt(1000, 9000);
  const dy = randomInt(1000, 9000);

  // 背景装饰（程序化，零素材、零依赖、离线可用）
  let decor = '';
  const shapes = randomInt(4, 7);
  for (let i = 0; i < shapes; i += 1) {
    const kind = randomInt(0, 1);
    if (kind === 0) {
      decor += `<circle cx="${randomInt(0, width)}" cy="${randomInt(0, height)}" r="${randomInt(12, 46)}" fill="${hsl(randomInt, randomInt(40, 68))}" opacity="0.5"/>`;
    } else {
      const w = randomInt(28, 96);
      const h = randomInt(20, 64);
      decor += `<rect x="${randomInt(0, width - w)}" y="${randomInt(0, height - h)}" width="${w}" height="${h}" rx="6" fill="${hsl(randomInt, randomInt(38, 66))}" opacity="0.42"/>`;
    }
  }

  const bgSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `<defs><linearGradient id="bg${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${hsl(randomInt, 46)}"/><stop offset="1" stop-color="${hsl(randomInt, 30)}"/>` +
    `</linearGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#bg${id})"/>` +
    decor +
    // 缺口：深色 + 内阴影感（与拼图块同形状）
    `<g transform="translate(-${dx} -${dy})">` +
    `<g transform="translate(${num(x + dx)} ${num(y + dy)})">` +
    pieceShape(PIECE_SIZE, 'rgba(14,18,26,0.78)', 'rgba(8,10,16,0.85)') +
    `</g></g>` +
    `</svg>`;

  const pieceSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `<g transform="translate(0 ${num(y)})">` +
    pieceShape(PIECE_SIZE, 'rgba(255,255,255,0.88)', 'rgba(255,255,255,0.98)') +
    `</g>` +
    `</svg>`;

  return { bgSvg, pieceSvg };
}

// -----------------------------------------------------------------------------
// 校验
// -----------------------------------------------------------------------------

/** 轨迹规范化：⛔ 任何非有限数/非二元组一律判非法（⛔ 不"猜"用户意图） */
function normalizeTrack(track) {
  if (!Array.isArray(track) || track.length === 0 || track.length > TRACK_MAX_POINTS) return null;
  const points = [];
  for (const point of track) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const t = Number(point[0]);
    const x = Number(point[1]);
    if (!Number.isFinite(t) || !Number.isFinite(x)) return null;
    points.push([t, x]);
  }
  return points;
}

/** 轨迹规则（自建方案 §6.2 表的前 6 条）；返回 null = 通过，否则返回失败原因 */
function checkTrack(points, submittedX) {
  if (points.length < TRACK_MIN_POINTS) return SLIDER_REASON.trackSuspicious;

  const first = points[0];
  const last = points[points.length - 1];
  const duration = last[0] - first[0];
  if (!(duration >= TRACK_MIN_MS && duration <= TRACK_MAX_MS)) return SLIDER_REASON.trackSuspicious;

  // 单调性（允许极小回退，但次数与幅度都受限）
  let backtracks = 0;
  const speeds = [];
  for (let i = 1; i < points.length; i += 1) {
    const [t0, x0] = points[i - 1];
    const [t1, x1] = points[i];
    const drop = x0 - x1;
    if (drop > 0) {
      backtracks += 1;
      if (drop > TRACK_BACKTRACK_PX || backtracks > TRACK_MAX_BACKTRACKS) return SLIDER_REASON.trackSuspicious;
    }
    const dt = t1 - t0;
    if (dt > 0) speeds.push((x1 - x0) / dt);
  }

  // 末点与提交值一致（⛔ 挡"轨迹一套、提交值另一套"）
  if (Math.abs(last[1] - submittedX) > TRACK_LAST_POINT_PX) return SLIDER_REASON.trackSuspicious;

  // 必须存在加减速（⛔ 匀速直线是脚本特征）
  if (speeds.length < 2) return SLIDER_REASON.trackSuspicious;
  const max = Math.max(...speeds);
  const min = Math.min(...speeds);
  if (max - min < SPEED_EPSILON) return SLIDER_REASON.trackSuspicious;

  return null;
}

/**
 * 判定一次滑动。**服务端唯一判定点**。
 *
 * 判定顺序（刻意固定）：先**轨迹规则**、后**容差**。
 * 理由：轨迹是"这次交互像不像人"，与答案无关，先判它可以让"位置对但轨迹假"的脚本提前出局；
 * 两者的原因都会通过 `details.reason` 返回（契约见 docs/api.md §4.1）。
 *
 * @param {{ answer: { x: number }, submittedX: number, track: Array, tolerancePx?: number }} input
 * @returns {{ ok: true } | { ok: false, reason: string, deltaPx?: number }}
 *   `deltaPx` 只用于**审计调参**，⛔ 不含答案原值（服务层负责不把它写进日志）
 */
export function verifySlider(input) {
  const tolerancePx = input.tolerancePx ?? DEFAULT_TOLERANCE_PX;
  const submittedX = Number(input.submittedX);
  if (!Number.isFinite(submittedX)) return { ok: false, reason: SLIDER_REASON.trackSuspicious };

  const points = normalizeTrack(input.track);
  if (!points) return { ok: false, reason: SLIDER_REASON.trackSuspicious };

  const trackReason = checkTrack(points, submittedX);
  if (trackReason) return { ok: false, reason: trackReason };

  const deltaPx = Math.abs(submittedX - Number(input.answer?.x));
  if (!Number.isFinite(deltaPx)) return { ok: false, reason: SLIDER_REASON.trackSuspicious };
  if (deltaPx > tolerancePx) {
    return { ok: false, reason: SLIDER_REASON.mismatch, deltaPx: round2(deltaPx) };
  }
  return { ok: true };
}

function round2(value) {
  return Number(Number(value).toFixed(2));
}

/** 容差计算（自建方案 §6.2：`max(配置值, 宽度 * 0.008)`） */
export function toleranceForWidth(configTolerancePx, width = SLIDER_WIDTH) {
  return Math.max(Number(configTolerancePx) || DEFAULT_TOLERANCE_PX, Math.round(width * 0.008));
}

/**
 * 构造一条"合理的"人类轨迹（**仅供测试与排障**）。
 * ⛔ 绝不在响应里回显任何轨迹示例——那等于教脚本怎么绕过。
 */
export function buildHumanLikeTrack({ from = 0, to, durationMs = 900, points = 24 } = {}) {
  const track = [];
  for (let i = 0; i <= points; i += 1) {
    const ratio = i / points;
    // 先加速后减速（缓入缓出）——与真人一致，也满足"存在加减速"的规则
    const eased = ratio < 0.5 ? 2 * ratio * ratio : 1 - 2 * (1 - ratio) * (1 - ratio);
    track.push([Math.round(durationMs * ratio), round2(from + (to - from) * eased)]);
  }
  return track;
}
