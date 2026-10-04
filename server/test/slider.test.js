/**
 * 滑动验证码原语测试（S1）
 *
 * 依据：docs/slider-captcha-selfbuilt.md §6（算法规范）、§10.1（本文件的验收口径）、
 *       docs/api.md §4.1（`captcha/*` 的 `details.reason` 枚举）
 *
 * 为什么是纯离线单测：本模块刻意不碰 Redis/PG/HTTP（见文件头），因此这里**不需要 PGlite、
 * 不需要 buildApp、不需要假 Redis**——与 `test/totp.test.js` 同一取向。
 *
 * ⚠️ 随机性处理：出题要随机，但断言必须可重复 → 一律注入**种子 PRNG**（`seeded()`），
 *    ⛔ 不使用 `Math.random`，也不依赖"跑得快所以不会撞车"的假设。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TOLERANCE_PX,
  PIECE_SIZE,
  PIECE_TOTAL_WIDTH,
  SLIDER_HEIGHT,
  SLIDER_WIDTH,
  SLIDER_REASON,
  TRACK_MAX_POINTS,
  buildChallengeSvg,
  buildHumanLikeTrack,
  generateChallenge,
  toleranceForWidth,
  verifySlider,
} from '../src/utils/slider.js';

/** 确定性 PRNG（mulberry32）——闭区间 [min, max]，与 `crypto.randomInt` 包装同语义 */
function seeded(seed) {
  let a = seed >>> 0;
  return (min, max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return min + (((t ^ (t >>> 14)) >>> 0) % (max - min + 1));
  };
}

/** 边界取值：`low` 时永远取区间下界，`high` 时永远取上界 */
const alwaysMin = () => (min) => min;
const alwaysMax = () => (_min, max) => max;

const X_MIN = Math.ceil(SLIDER_WIDTH * 0.35);
const X_MAX = Math.min(Math.floor(SLIDER_WIDTH * 0.82), SLIDER_WIDTH - PIECE_TOTAL_WIDTH);
const Y_MIN = Math.ceil(SLIDER_HEIGHT * 0.15);
const Y_MAX = Math.min(Math.floor(SLIDER_HEIGHT * 0.7), SLIDER_HEIGHT - PIECE_SIZE);

// -----------------------------------------------------------------------------
// 出题：区间与两条硬不变式
// -----------------------------------------------------------------------------

test('generateChallenge：取区间下界/上界时都落在约定范围内', () => {
  const low = generateChallenge({ randomInt: alwaysMin() });
  const high = generateChallenge({ randomInt: alwaysMax() });

  assert.deepEqual(low, { x: X_MIN, y: Y_MIN });
  assert.deepEqual(high, { x: X_MAX, y: Y_MAX });
});

test('generateChallenge：⛔ 拼图块永远不被画出画布（x+块宽 ≤ 宽、y+块高 ≤ 高）', () => {
  const high = generateChallenge({ randomInt: alwaysMax() });
  assert.ok(high.x + PIECE_TOTAL_WIDTH <= SLIDER_WIDTH, `x=${high.x} 会让块右缘超出画布`);
  assert.ok(high.y + PIECE_SIZE <= SLIDER_HEIGHT, `y=${high.y} 会让块下缘超出画布`);

  // 自定义画布同样成立（防止有人把比例常量改回 0.85/0.75）
  const custom = generateChallenge({ width: 400, height: 200, randomInt: alwaysMax() });
  assert.ok(custom.x + PIECE_TOTAL_WIDTH <= 400);
  assert.ok(custom.y + PIECE_SIZE <= 200);
});

test('generateChallenge：只返回 x/y 两个字段（⛔ 不夹带任何调试信息）', () => {
  const answer = generateChallenge({ randomInt: seeded(1) });
  assert.deepEqual(Object.keys(answer).sort(), ['x', 'y']);
});

test('generateChallenge：200 次真实随机出题覆盖区间且不退化（防"固定缺口"）', () => {
  const seen = new Set();
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < 200; i += 1) {
    const { x, y } = generateChallenge();
    assert.ok(x >= X_MIN && x <= X_MAX, `x=${x} 越界`);
    assert.ok(y >= Y_MIN && y <= Y_MAX, `y=${y} 越界`);
    seen.add(x);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  assert.ok(seen.size > 20, `200 次出题只有 ${seen.size} 种 x，随机性可疑`);
  assert.ok(maxX - minX > (X_MAX - X_MIN) * 0.5, 'x 的覆盖范围过窄');
});

// -----------------------------------------------------------------------------
// SVG 合成：可渲染 + 不泄露答案
// -----------------------------------------------------------------------------

test('buildChallengeSvg：两张图都是合法 SVG 片段，且 piece 以画布尺寸画在左侧', () => {
  const randomInt = seeded(7);
  const answer = generateChallenge({ randomInt });
  const { bgSvg, pieceSvg } = buildChallengeSvg({ ...answer, randomInt });

  for (const svg of [bgSvg, pieceSvg]) {
    assert.ok(svg.startsWith('<svg'), 'SVG 必须以 <svg 开头');
    assert.ok(svg.endsWith('</svg>'), 'SVG 必须闭合');
    assert.ok(svg.includes(`viewBox="0 0 ${SLIDER_WIDTH} ${SLIDER_HEIGHT}"`), 'viewBox 应为画布尺寸');
  }
  // ⛔ 拼图块的 y 在 piece 里（这是公开信息：块就画在那儿），横向起点固定为 0
  assert.ok(pieceSvg.includes('transform="translate(0 '), 'piece 的横坐标起点必须固定在 0');
  assert.ok(bgSvg.length < 20_000, `bgSvg 体积 ${bgSvg.length} 字节，超出预期（应 ~10–20KB 内）`);
});

test('buildChallengeSvg：⛔ 答案不以可 grep 的独立属性出现，但渲染位置可精确复原', () => {
  const randomInt = seeded(11);
  const answer = generateChallenge({ randomInt });
  const { bgSvg } = buildChallengeSvg({ ...answer, randomInt });

  // ① 不能出现 `x="<答案>"` 或自定义 data 属性（那才是"一眼可读"的泄露形态）
  assert.equal(bgSvg.includes(`x="${answer.x}"`), false, '缺口横坐标不得作为独立属性出现');
  assert.equal(bgSvg.includes('data-x'), false, '⛔ 不得用 data-* 夹带答案');

  // ② 缺口位置 = 组内坐标 + 外层偏移（两个数之差），因此渲染结果仍然精确
  const outer = /transform="translate\(-(\d+(?:\.\d+)?) -(\d+(?:\.\d+)?)\)"/.exec(bgSvg);
  const inner = /transform="translate\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)\)"/.exec(bgSvg);
  assert.ok(outer, '缺少外层偏移 transform');
  assert.ok(inner, '缺少缺口 transform');
  assert.equal(Number(inner[1]) + Number(outer[1]), answer.x, '复原出的横坐标必须等于答案');
  assert.equal(Number(inner[2]) + Number(outer[2]), answer.y, '复原出的纵坐标必须等于答案');
});

test('buildChallengeSvg：同一答案两次合成结果不同（偏移与装饰随机）', () => {
  const first = buildChallengeSvg({ x: 150, y: 60, randomInt: seeded(21) });
  const second = buildChallengeSvg({ x: 150, y: 60, randomInt: seeded(22) });
  assert.notEqual(first.bgSvg, second.bgSvg, '同答案同图会让"按图缓存"绕过一次性');
});

// -----------------------------------------------------------------------------
// 校验：通过路径
// -----------------------------------------------------------------------------

test('verifySlider：类人轨迹 + 位对准 → ok（且返回值只有 ok 一个键）', () => {
  const result = verifySlider({
    answer: { x: 180 },
    submittedX: 180,
    track: buildHumanLikeTrack({ to: 180 }),
  });
  assert.deepEqual(result, { ok: true });
});

test('verifySlider：容差边界——等于容差放行，超 1px 拒绝并给出 deltaPx', () => {
  const track = buildHumanLikeTrack({ to: 185 });
  const onEdge = verifySlider({ answer: { x: 180 }, submittedX: 185, track, tolerancePx: 5 });
  assert.deepEqual(onEdge, { ok: true }, '差值恰好等于容差应放行');

  const over = verifySlider({ answer: { x: 180 }, submittedX: 186, track: buildHumanLikeTrack({ to: 186 }), tolerancePx: 5 });
  assert.equal(over.ok, false);
  assert.equal(over.reason, SLIDER_REASON.mismatch);
  assert.equal(over.deltaPx, 6);
});

test('verifySlider：默认容差 = DEFAULT_TOLERANCE_PX', () => {
  const ok = verifySlider({
    answer: { x: 100 },
    submittedX: 100 + DEFAULT_TOLERANCE_PX,
    track: buildHumanLikeTrack({ to: 100 + DEFAULT_TOLERANCE_PX }),
  });
  assert.deepEqual(ok, { ok: true });
});

// -----------------------------------------------------------------------------
// 校验：轨迹规则逐条（⛔ 每条都要有反例，否则规则等于没写）
// -----------------------------------------------------------------------------

test('verifySlider：采样点少于 8 → track_suspicious', () => {
  const track = buildHumanLikeTrack({ to: 180, points: 5 });
  const result = verifySlider({ answer: { x: 180 }, submittedX: 180, track });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SLIDER_REASON.trackSuspicious);
});

test('verifySlider：总时长过短（瞬移）或过长（挂机）→ track_suspicious', () => {
  const fast = verifySlider({ answer: { x: 180 }, submittedX: 180, track: buildHumanLikeTrack({ to: 180, durationMs: 120 }) });
  assert.equal(fast.reason, SLIDER_REASON.trackSuspicious);

  const slow = verifySlider({ answer: { x: 180 }, submittedX: 180, track: buildHumanLikeTrack({ to: 180, durationMs: 30_000 }) });
  assert.equal(slow.reason, SLIDER_REASON.trackSuspicious);
});

test('verifySlider：回退超限（次数或幅度）→ track_suspicious', () => {
  const base = buildHumanLikeTrack({ to: 180 });
  // 构造 4 次小幅回退（超过 TRACK_MAX_BACKTRACKS = 2）
  const manyBacktracks = base.map((point, i) => (i > 4 && i < 9 && i % 2 === 0 ? [point[0], point[1] - 1] : point));
  const r1 = verifySlider({ answer: { x: 180 }, submittedX: 180, track: manyBacktracks });
  assert.equal(r1.reason, SLIDER_REASON.trackSuspicious);

  // 单次大幅回退（> TRACK_BACKTRACK_PX = 3）
  const bigDrop = base.map((point, i) => (i === 6 ? [point[0], point[1] - 9] : point));
  const r2 = verifySlider({ answer: { x: 180 }, submittedX: 180, track: bigDrop });
  assert.equal(r2.reason, SLIDER_REASON.trackSuspicious);
});

test('verifySlider：完美匀速直线 → track_suspicious（脚本特征）', () => {
  const uniform = [];
  for (let i = 0; i <= 20; i += 1) uniform.push([i * 50, (i * 180) / 20]);
  const result = verifySlider({ answer: { x: 180 }, submittedX: 180, track: uniform });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SLIDER_REASON.trackSuspicious);
});

test('verifySlider：末点与提交值不一致 → track_suspicious（轨迹一套、提交另一套）', () => {
  const result = verifySlider({ answer: { x: 180 }, submittedX: 190, track: buildHumanLikeTrack({ to: 180 }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SLIDER_REASON.trackSuspicious);
});

test('verifySlider：脏输入（非二元组 / NaN / 空 / 超上限 / 非有限提交值）一律 track_suspicious', () => {
  const answer = { x: 180 };
  const good = buildHumanLikeTrack({ to: 180 });
  const bad = [
    null,
    [],
    'not-a-track',
    [[0, 0], [100, 50], 'x'],
    [[0, 0], [100, Number.NaN]],
    [[0, 0], [100, 50], [200, 100], [300, 150], [400, 180], [500, 180], [600, 180], [700, 180], [800, 180]],
    Array.from({ length: TRACK_MAX_POINTS + 1 }, (_, i) => [i * 10, i]),
  ];
  for (const track of bad) {
    const result = verifySlider({ answer, submittedX: 180, track });
    assert.equal(result.ok, false, `以下轨迹应被拒绝：${JSON.stringify(track)?.slice(0, 40)}`);
    assert.equal(result.reason, SLIDER_REASON.trackSuspicious);
  }
  // 提交值非有限数同样是轨迹问题（⛔ 不抛异常、不 500）
  assert.equal(verifySlider({ answer, submittedX: Number.NaN, track: good }).reason, SLIDER_REASON.trackSuspicious);
  assert.equal(verifySlider({ answer, submittedX: '180', track: good }).reason, SLIDER_REASON.trackSuspicious);
});

test('verifySlider：缺 answer 时判 track_suspicious（⛔ 不静默放行）', () => {
  const result = verifySlider({ submittedX: 180, track: buildHumanLikeTrack({ to: 180 }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SLIDER_REASON.trackSuspicious);
});

// -----------------------------------------------------------------------------
// 容差换算与测试辅助
// -----------------------------------------------------------------------------

test('toleranceForWidth：取「配置值」与「宽度 0.8%」的较大者', () => {
  assert.equal(toleranceForWidth(5, 320), 5, '宽 320 时 0.8% ≈ 3px，取配置值 5');
  assert.equal(toleranceForWidth(2, 320), 3, '配置值过小时按宽度下限兜底');
  assert.equal(toleranceForWidth(20, 320), 20, '配置值更大时以配置为准');
  assert.equal(toleranceForWidth(undefined, 320), DEFAULT_TOLERANCE_PX);
  assert.equal(toleranceForWidth(5, 1000), 8, '宽 1000 时 0.8% = 8px');
});

test('buildHumanLikeTrack：末点等于目标值、点数可控、且能通过校验（工具自身可用）', () => {
  const track = buildHumanLikeTrack({ to: 222, points: 30, durationMs: 1200 });
  assert.equal(track.length, 31);
  assert.equal(track.at(-1)[1], 222);
  assert.equal(track.at(-1)[0], 1200);
  assert.deepEqual(verifySlider({ answer: { x: 222 }, submittedX: 222, track }), { ok: true });
});
