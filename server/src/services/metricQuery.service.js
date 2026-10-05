/**
 * Vantage · 主机历史曲线（`GET /api/v1/hosts/{id}/metrics`）
 *
 * 依据：docs/api.md §4.3（✅ 2026-10-05 定稿）、§1.2 ③、docs/api-status.md §4.8
 *
 * 本模块负责取数前后的三件事，**顺序都是有理由的**：
 *   ① `from`/`to` 先**对齐到档位的桶边界** —— 否则请求从 00:00:07 开始时，
 *      第一个桶（00:00:00–00:01:00）会因为 `bucket < from` 被悄悄丢掉一格；
 *   ② 选档：`step=auto` 时选**最细**的一档使点数不超过目标值，都不满足就用最粗的 5m
 *      （这一条规则恰好复现前端那 5 个预设按钮，见 §4.8 的记录）；
 *   ③ 两道闸门（序列数 ≤ 20、总点数 ≤ 5 万）—— ⛔ 超限一律 400，**绝不截断**：
 *      悄悄少画几条线在图表上完全看不出来，是最难排查的一类错误。
 *
 * ⛔ 不做跨表再聚合（最长 30 天）：档位与源表一一对应，见 `metric.repo.js` 的 `METRIC_STEPS`。
 */

import { AppError } from '../utils/errors.js';
import { METRIC_NAME_MAX_LENGTH, parseMetric, unitOf } from '../utils/metric.js';
import { findAgentStatusById } from '../repositories/agent.repo.js';
import { METRIC_STEPS, listSeriesNamesInRange, selectSeriesPointsInRange } from '../repositories/metric.repo.js';
import { offlineThresholdS } from './offline.service.js';

/** `step` 的合法取值（⛔ 刻意没有 `15s`：上报周期是 30s，见 metric.repo.js 的说明） */
export const METRIC_STEP_VALUES = Object.freeze(['auto', '30s', '1m', '5m']);

/** `agg` 的合法取值。四个都能从**现成的列**里读出来，没有额外计算成本。 */
export const METRIC_AGG_VALUES = Object.freeze(['avg', 'max', 'min', 'last']);
export const METRIC_AGG_DEFAULT = 'avg';

/** `metrics` 参数的**元素个数**上限（逗号分隔），与展开后的条数上限是两回事 */
export const METRIC_MAX_REQUESTED = 20;

/** 闸门 A：基名展开后的序列数上限（= 图上最多几条线） */
export const METRIC_MAX_SERIES = 20;

/**
 * 闸门 B：一次请求的**总点数**上限（序列数 × 桶数）。
 *
 * 🔑 为什么按"总点数"而不是"单条线多少点"：30 天档一条线本身就是 8640 点
 *    （`30 天 ÷ 5 分钟`），单条线的点数是**档位**决定的，根本没有收紧余地。
 *    真正会炸的是"多条线 × 长时间"，所以闸门必须长在总量上。
 *
 * 📊 换算成用户看得见的东西（"这个范围最多能勾几个指标"）：
 *    | 范围   | 一条线 | 5 万点的上限 | 实际（还被闸门 A 卡在 20） |
 *    | 1 小时 | 120    | 416         | 20  |
 *    | 6 小时 | 720    | 69          | 20  |
 *    | 24 小时| 1440   | 34          | 20  |
 *    | 7 天   | 2016   | 24          | 20  |
 *    | 30 天  | 8640   | **5**       | **5** |
 *    ⇒ **只有 30 天那一档会碰到它**，最坏响应约 1MB。
 */
export const METRIC_MAX_TOTAL_POINTS = 50_000;

/** `step=auto` 的选档目标：选最细的档使点数不超过它（都不满足 → 最粗档） */
export const METRIC_AUTO_TARGET_POINTS = 2_000;

/** 任何请求的全局跨度上限（= 系统对外承诺能查多长的历史） */
export const METRIC_GLOBAL_MAX_SPAN_S = 30 * 86400;

/**
 * 各档的跨度上限。
 * ⚠️ 它们是"防止把原始层当降采样层用"的护栏：`30s` 档看 24 小时已是 2880 点，
 *    再长就该落档了（`step=auto` 会自动落）。⛔ 不是数据保留期。
 */
export const METRIC_MAX_SPAN_S = Object.freeze({
  '30s': 24 * 3600,
  '1m': 7 * 86400,
  '5m': 30 * 86400,
});

/** 统一的 Date 归一（PGlite 与 node-postgres 对 timestamptz 返回的都是 Date，这里只做兜底） */
function toDate(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * 按**顶层逗号**切分 `metrics` 参数。
 *
 * 🔑 不能直接 `raw.split(',')`：序列全名的**维度分隔符本身就是逗号**
 *    （`disk.used_pct{device=sda1,mount=/data}`），直接切会把它劈成两条非法名字。
 *    所以只按**花括号之外**的逗号切分 —— 花括号里的逗号属于维度语法；
 *    维度值里若真的需要逗号，按 `docs/database.md` §5.7.2 必须写成 `%2C`。
 *
 * ⚠️ 这是"契约文字"与"命名规范"撞车撞出来的坑：docs/api.md 原先只写了"逗号分隔，
 *    元素可为基名或全名"，而全名自己就带逗号。已在 §4.3 写明本口径。
 *
 * @param {string} raw
 * @returns {string[]} 未去空、未去重的原始片段
 */
export function splitMetricList(raw) {
  const items = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      items.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  items.push(raw.slice(start));
  return items;
}

/**
 * 解析 `metrics` 参数：逗号分隔，元素可为**基名**（展开成该基名下全部维度序列）
 * 或**全名**（`disk.used_pct{mount=/data}`，只要那一条）。
 *
 * ⚠️ 空串按"未提供"处理会掩盖前端 bug —— 本参数是**必填**，所以空串与缺失同样报 400。
 * ⚠️ 元素**去重**（`a,a` 与 `a` 等价），但"基名 + 它下面的某个全名"**不去重**：
 *    那是两个不同的意图（"全部挂载点" vs "只要这一个"），由 SQL 的行级谓词天然合并。
 *
 * @param {unknown} raw
 * @returns {{ elements: string[], fullNames: string[], bases: string[] }}
 * @throws {AppError} `schema_invalid`
 */
export function parseMetricsParam(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw new AppError('schema_invalid', { details: { field: 'metrics', reason: 'required' } });
  }
  if (typeof raw !== 'string') {
    // 重复参数（`?metrics=a&metrics=b`）在 Fastify 里是数组 —— 一并拒绝，避免"取第一个"这种隐式行为
    throw new AppError('schema_invalid', { details: { field: 'metrics', reason: 'single_value_required' } });
  }

  const elements = [
    ...new Set(splitMetricList(raw).map((item) => item.trim()).filter((item) => item !== '')),
  ];
  if (elements.length === 0) {
    throw new AppError('schema_invalid', { details: { field: 'metrics', reason: 'required' } });
  }
  if (elements.length > METRIC_MAX_REQUESTED) {
    throw new AppError('schema_invalid', {
      details: { field: 'metrics', max_items: METRIC_MAX_REQUESTED, items: elements.length },
    });
  }

  const fullNames = [];
  const bases = [];
  for (const element of elements) {
    let parsed;
    try {
      // ⛔ 用与 Agent 侧**同一个**解析器（utils/metric.js）：两端的命名口径只允许有一份实现
      parsed = parseMetric(element);
    } catch {
      throw new AppError('schema_invalid', {
        details: { field: 'metrics', reason: 'invalid_metric_name', max_length: METRIC_NAME_MAX_LENGTH },
      });
    }
    if (parsed.hasDimensions) fullNames.push(parsed.full);
    else bases.push(parsed.base);
  }
  return { elements, fullNames, bases };
}

/**
 * 选档。
 *
 * 🔑 规则只有一句：**选最细的一档，使点数不超过 `METRIC_AUTO_TARGET_POINTS`；都不满足就用最粗档。**
 *    它恰好复现了产品上的 5 个预设按钮（1 小时→30s / 6 小时→30s / 24 小时→1m /
 *    7 天→5m / 30 天→5m），所以接口**不需要**再加 `window=1h` 之类的预设参数：
 *    前端只传 `from`/`to`，服务端回传**实际**用的档位。
 *
 * ⚠️ 目标点数是"目标"不是"硬上限"：7 天档用最粗的 5m 仍有 2016 点（>2000），
 *    因为它已经没得更粗了 —— 真正的硬约束是 `METRIC_MAX_TOTAL_POINTS`。
 */
export function resolveStep(step, spanS) {
  if (step !== 'auto') return step;
  for (const candidate of METRIC_STEP_VALUES) {
    if (candidate === 'auto') continue;
    if (spanS / METRIC_STEPS[candidate].sizeS <= METRIC_AUTO_TARGET_POINTS) return candidate;
  }
  return '5m';
}

/**
 * 把窗口**向外**对齐到档位的桶边界：下界向下取整、上界向上取整。
 *
 * 🔑 两个方向都要向外：向下取整保证"请求的第一秒所在的那个桶"不被丢掉，
 *    向上取整保证"请求的最后一秒所在的那个桶"能被包含（上界是**排他**的）。
 * ⚠️ 对齐后的边界会**原样回传**在响应里，前端画横轴要用它 —— 否则会差一格。
 */
function alignWindow(from, to, sizeS) {
  const sizeMs = sizeS * 1000;
  return {
    from: new Date(Math.floor(from.getTime() / sizeMs) * sizeMs),
    to: new Date(Math.ceil(to.getTime() / sizeMs) * sizeMs),
  };
}

/**
 * `GET /api/v1/hosts/{id}/metrics` 的取数与成形。
 *
 * @param {object} input
 * @param {import('pg').Pool} input.pool
 * @param {object} input.config 只为取离线阈值（判定主机是否存在，与其余单机端点同款）
 * @param {{ warn: Function }} [input.logger]
 * @param {string} input.id 主机 UUID
 * @param {Date} input.from 已解析的时间下界
 * @param {Date} input.to 已解析的时间上界
 * @param {'auto'|'30s'|'1m'|'5m'} [input.step]
 * @param {'avg'|'max'|'min'|'last'} [input.agg]
 * @param {boolean} [input.includeN] 点是否带上桶内样本数（`[ts, value, n]`）
 * @param {string[]} input.fullNames 见 {@link parseMetricsParam}
 * @param {string[]} input.bases
 * @returns {Promise<object|null>} 主机不存在 → `null`；指标没数据 → `series: []`（⛔ 不是 404）
 */
export async function getPanelMetricSeries(input) {
  const { pool, config, logger, id, from, to, fullNames, bases } = input;
  const step = input.step ?? 'auto';
  const agg = input.agg ?? METRIC_AGG_DEFAULT;
  const includeN = input.includeN === true;

  if (!(from instanceof Date) || !(to instanceof Date)) {
    throw new AppError('schema_invalid', { details: { field: 'from', reason: 'time_required' } });
  }

  const spanS = (to.getTime() - from.getTime()) / 1000;
  if (spanS <= 0) {
    throw new AppError('schema_invalid', { details: { field: 'from', reason: 'from_after_to' } });
  }
  if (spanS > METRIC_GLOBAL_MAX_SPAN_S) {
    throw new AppError('range_too_large', {
      details: { max_span_s: METRIC_GLOBAL_MAX_SPAN_S, span_s: Math.round(spanS) },
    });
  }

  const resolvedStep = resolveStep(step, spanS);
  const tier = METRIC_STEPS[resolvedStep];
  if (!tier) {
    throw new AppError('schema_invalid', { details: { field: 'step', allowed: METRIC_STEP_VALUES } });
  }
  const maxSpanS = METRIC_MAX_SPAN_S[resolvedStep];
  if (spanS > maxSpanS) {
    throw new AppError('range_too_large', {
      details: {
        step: resolvedStep,
        max_span_s: maxSpanS,
        span_s: Math.round(spanS),
        hint: '缩小 from/to，或改用 step=auto 让服务端自动降档',
      },
    });
  }

  const window = alignWindow(from, to, tier.sizeS);
  const buckets = Math.round((window.to.getTime() - window.from.getTime()) / (tier.sizeS * 1000));
  const target = { agentId: id, from: window.from, to: window.to, step: resolvedStep, fullNames, bases };

  const row = await findAgentStatusById(pool, { id, thresholdS: offlineThresholdS(config) });
  if (row === null) return null;
  const updatedAt = (toDate(row.server_now) ?? new Date()).toISOString();

  // --- 闸门 A：先只取"展开后的序列名"（多取一条用来判断是否超限）---------------------
  // ⛔ 顺序不能反：等把点全拉回来再判，DB 和内存已经白烧了
  const names = await listSeriesNamesInRange(pool, { ...target, limit: METRIC_MAX_SERIES + 1 });
  if (names.length > METRIC_MAX_SERIES) {
    logger?.warn?.({ id, step: resolvedStep, series: names.length }, '时序查询被拒绝：展开后序列数超限');
    throw new AppError('too_many_series', {
      details: {
        reason: 'series_limit',
        step: resolvedStep,
        max_series: METRIC_MAX_SERIES,
        // ⚠️ 是**下界**：查询只取到 `上限 + 1` 条就停了，真实条数可能更多
        expanded_series_at_least: names.length,
        hint: `改用具体的序列全名（如 disk.used_pct{mount=/data}）收窄维度，别用基名展开`,
      },
    });
  }

  // --- 闸门 B：序列数 × 桶数（这道闸门只会在长范围 + 多条线时触发）--------------------
  const totalPoints = names.length * buckets;
  if (totalPoints > METRIC_MAX_TOTAL_POINTS) {
    const maxSeriesAtThisRange = Math.floor(METRIC_MAX_TOTAL_POINTS / buckets);
    logger?.warn?.({ id, step: resolvedStep, series: names.length, buckets }, '时序查询被拒绝：总点数超限');
    throw new AppError('too_many_series', {
      details: {
        reason: 'point_budget',
        step: resolvedStep,
        max_total_points: METRIC_MAX_TOTAL_POINTS,
        requested_points: totalPoints,
        series: names.length,
        points_per_series: buckets,
        // 前端拿这个数去限制勾选框（也用于拼人话提示："这个范围最多同时看 5 条"）
        max_series_at_this_range: maxSeriesAtThisRange,
        hint: '缩短时间范围，或减少同时显示的指标数',
      },
    });
  }

  const base = {
    host_id: id,
    step: resolvedStep,
    agg,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    updated_at: updatedAt,
  };
  // 指标名合法、但这台机在窗口内一条数据都没有 ⇒ 200 + 空数组
  // （"这台机没有 GPU"不是客户端的错，⛔ 不能报 404/400）
  if (names.length === 0) return { ...base, series: [] };

  const rows = await selectSeriesPointsInRange(pool, { ...target, agg });

  /** metric → 点数组（保持 SQL 的 `ORDER BY metric, bucket` 顺序，前端无需再排） */
  const pointsByMetric = new Map();
  for (const point of rows) {
    const ts = toDate(point.bucket).getTime();
    const item = includeN ? [ts, point.value, point.n] : [ts, point.value];
    const list = pointsByMetric.get(point.metric);
    if (list) list.push(item);
    else pointsByMetric.set(point.metric, [item]);
  }

  // ⚠️ 用闸门 A 查到的**名字列表**驱动输出：窗口内有采集但被 agg/窗口滤空的序列，
  //    仍然会出现（`points: []`），而不是凭空消失 —— 前端可以据此显示"该序列无数据"
  const series = names.map((name) => {
    const parsed = parseMetric(name);
    return {
      metric: name,
      base: parsed.base,
      labels: parsed.labels,
      unit: unitOf(parsed.base) || null,
      points: pointsByMetric.get(name) ?? [],
    };
  });

  return { ...base, series };
}
