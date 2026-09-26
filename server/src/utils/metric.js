/**
 * Vantage · 指标命名与维度转义
 *
 * 依据：docs/database.md §5.7.2（✅ R5 决策：**维度写进指标名**，主键 (agent_id, metric, ts) 不变）
 *
 *  基名（无维度）：cpu.usage / mem.used_pct / process.count
 *  全名（含维度）：基名{维度=值,维度=值}      例：disk.used_pct{device=sda1,mount=/data}
 *
 * 硬规则（两端必须逐字节一致，Go 侧需同源实现）
 *  - 维度键只允许 `[a-z0-9_]`；基名全小写 `[a-z][a-z0-9_]*(\.[a-z0-9_]+)*`；
 *  - 多维度按**键名字母序升序**拼接，`,` 分隔、无空格，`=` 连接键值
 *    （保证同一序列只有一种写法：`{a=1,b=2}` 与 `{b=2,a=1}` 不得成为两条序列）；
 *  - 以下字符**必须百分号编码**（大写十六进制）：`%`→`%25`、`{`→`%7B`、`}`→`%7D`、
 *    `=`→`%3D`、`,`→`%2C`、空白→其码位（空格 `%20`、制表 `%09`、换行 `%0A`）。
 *    ⚠️ `%` 必须一起转义，否则编码**不是单射**，不同维度会撞成同一序列名；
 *  - 免转义保留原样：`A-Z a-z 0-9 _ / : - . @ +`（其余字符一律编码，宁多编不漏编）；
 *  - 无维度时**不带**花括号（`cpu.usage` 而非 `cpu.usage{}`）；
 *  - 全名长度 ≤ **200** 字符（与库表 CHECK 一致）。
 *
 * ⚠️ 本文件是**唯一生产者**，`vantage_is_valid_metric_name()`（迁移 0001 的 SQL 函数）是**校验器**；
 *    两者用 test/metric.test.js 中的共享向量对齐。⛔ 任何第二处拼装/解析实现都是 bug 来源。
 *
 * 与告警规则引用语义的对应（✅ R8）：
 *  - 规则里写**基名** → 对该基名下每个维度序列**分别判定**；
 *  - 规则里写**全名** → 只判该单一序列。
 *  `classifyMetricRef()` 即 UI「全部维度 / 指定维度」开关的语义映射（不新增 API 字段）。
 */

/** 全名长度上限（与迁移脚本 CHECK 一致） */
export const METRIC_NAME_MAX_LENGTH = 200;

/** 基名：小写字母起头，点分段 */
const BASE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
/** 维度键：小写字母/数字/下划线 */
const LABEL_KEY_RE = /^[a-z0-9_]+$/;
/** 百分号编码后的全名（与 SQL 校验器的形状保持一致，供 JS 侧快速预检） */
const FULL_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\{[a-z0-9_]+=[^{}=,\s]+(,[a-z0-9_]+=[^{}=,\s]+)*\})?$/;

/** 免转义的字符集（其余一律百分号编码） */
const SAFE_CHAR_RE = /^[A-Za-z0-9_/:@.+-]$/;

/** 本模块抛出的指标命名错误（属请求侧问题 → 400 schema_invalid） */
export class MetricNameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MetricNameError';
    this.code = 'schema_invalid';
  }
}

/** 单字符 → 百分号编码（UTF-8 字节逐个编码，保证单射） */
function encodeChar(ch) {
  if (SAFE_CHAR_RE.test(ch)) return ch;
  const bytes = Buffer.from(ch, 'utf8');
  let out = '';
  for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  return out;
}

/** 维度值转义（可读字符保留，其余百分号编码） */
export function escapeLabelValue(value) {
  if (value === undefined || value === null) {
    throw new MetricNameError('维度值不能为空（null/undefined 不允许）');
  }
  const str = typeof value === 'string' ? value : String(value);
  if (str === '') throw new MetricNameError('维度值不能是空字符串（否则会产生 `{k=}` 这种非法全名）');
  let out = '';
  for (const ch of str) out += encodeChar(ch);
  return out;
}

/** 维度值反转义（`%XX` 序列还原为 UTF-8 字符；非法百分号序列原样保留，交由校验拒绝） */
export function unescapeLabelValue(escaped) {
  const bytes = [];
  for (let i = 0; i < escaped.length; i += 1) {
    const ch = escaped[i];
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(escaped.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(escaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(ch, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 拼装序列全名。
 * @param {string} base 基名（如 `disk.used_pct`）
 * @param {Record<string, string|number>} [labels] 维度（如 `{ device: 'sda1', mount: '/data' }`）
 * @returns {string} 全名（无维度时就是基名本身）
 */
export function buildMetric(base, labels = {}) {
  if (typeof base !== 'string' || base === '') {
    throw new MetricNameError('指标基名不能为空');
  }
  if (!BASE_RE.test(base)) {
    throw new MetricNameError(
      `指标基名非法：${base}（要求全小写，形如 cpu.usage / disk.used_pct；维度请放 labels，不要写进基名）`,
    );
  }

  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new MetricNameError('labels 必须是对象（{ key: value }）');
  }

  const keys = Object.keys(labels);
  if (keys.length === 0) {
    if (base.length > METRIC_NAME_MAX_LENGTH) {
      throw new MetricNameError(`指标全名超长（${base.length} > ${METRIC_NAME_MAX_LENGTH}）：${base}`);
    }
    return base;
  }

  const parts = [];
  for (const key of [...keys].sort()) {
    if (!LABEL_KEY_RE.test(key)) {
      throw new MetricNameError(`维度键非法：${key}（只允许小写字母、数字、下划线）`);
    }
    if (key === 'base') {
      // 保留键：避免与「基名」概念混淆，也让未来可能的扩展不被占用
      throw new MetricNameError('维度键不允许使用保留名 base');
    }
    parts.push(`${key}=${escapeLabelValue(labels[key])}`);
  }

  const full = `${base}{${parts.join(',')}}`;
  if (full.length > METRIC_NAME_MAX_LENGTH) {
    throw new MetricNameError(
      `指标全名超长（${full.length} > ${METRIC_NAME_MAX_LENGTH}）：${full}。` +
        '常见原因：挂载点/设备名异常长，请在 Agent 侧做长度截断或改用短别名。',
    );
  }
  return full;
}

/**
 * 解析序列全名。
 * @param {string} full
 * @returns {{ base: string, labels: Record<string,string>, full: string, hasDimensions: boolean }}
 */
export function parseMetric(full) {
  if (typeof full !== 'string' || full === '') {
    throw new MetricNameError('指标全名不能为空');
  }
  if (full.length > METRIC_NAME_MAX_LENGTH) {
    throw new MetricNameError(`指标全名超长（${full.length} > ${METRIC_NAME_MAX_LENGTH}）`);
  }
  if (!FULL_RE.test(full)) {
    throw new MetricNameError(`指标全名不符合 §5.7.2 规范：${full}`);
  }

  const braceAt = full.indexOf('{');
  if (braceAt === -1) {
    return { base: full, labels: {}, full, hasDimensions: false };
  }

  const base = full.slice(0, braceAt);
  const inner = full.slice(braceAt + 1, -1);
  const labels = {};
  for (const pair of inner.split(',')) {
    const eq = pair.indexOf('=');
    const key = pair.slice(0, eq);
    labels[key] = unescapeLabelValue(pair.slice(eq + 1));
  }
  return { base, labels, full, hasDimensions: true };
}

/** 是否是合法的序列全名（不抛异常的版本） */
export function isValidMetricName(full) {
  try {
    parseMetric(full);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断告警规则里写的 `metric` 是基名还是全名。
 * @returns {'base'|'exact'} —— 直接对应 `alert_rules.metric_match` 派生列与 UI 的「全部维度/指定维度」
 */
export function classifyMetricRef(ref) {
  if (typeof ref !== 'string' || ref === '') throw new MetricNameError('规则 metric 不能为空');
  if (ref.includes('{') || ref.includes('}')) {
    parseMetric(ref); // 全名必须合法
    return 'exact';
  }
  if (!BASE_RE.test(ref)) throw new MetricNameError(`规则 metric 基名非法：${ref}`);
  return 'base';
}

/**
 * 该基名下的序列是否被规则引用（✅ R8 核心语义）。
 * @param {string} ruleMetric 规则里写的 metric（基名或全名）
 * @param {string} seriesFull 实际上报的序列全名
 */
export function metricRefMatches(ruleMetric, seriesFull) {
  return classifyMetricRef(ruleMetric) === 'base'
    ? parseMetric(seriesFull).base === ruleMetric
    : ruleMetric === seriesFull;
}

/**
 * 已知基名与单位（摘自 docs/database.md §5.7.2「指标清单与单位」）。
 * ➕ 用途：上报 schema 白名单校验、前端图表单位与轴标签。
 * ⚠️ 新增指标必须先改文档再改这里；含维度的指标在表中以 `{...}` 占位标注。
 */
export const KNOWN_BASE_METRICS = Object.freeze({
  'cpu.usage': { unit: '%', dims: [] },
  'cpu.core.usage': { unit: '%', dims: ['core'] },
  'cpu.load1': { unit: '', dims: [] },
  'cpu.load5': { unit: '', dims: [] },
  'cpu.load15': { unit: '', dims: [] },
  'cpu.ctx_switch': { unit: '次/s', dims: [] },
  'mem.total': { unit: 'bytes', dims: [] },
  'mem.used': { unit: 'bytes', dims: [] },
  'mem.available': { unit: 'bytes', dims: [] },
  'mem.cached': { unit: 'bytes', dims: [] },
  'mem.buffers': { unit: 'bytes', dims: [] },
  'mem.used_pct': { unit: '%', dims: [] },
  'swap.total': { unit: 'bytes', dims: [] },
  'swap.used': { unit: 'bytes', dims: [] },
  'swap.used_pct': { unit: '%', dims: [] },
  'disk.total': { unit: 'bytes', dims: ['device', 'mount'] },
  'disk.used': { unit: 'bytes', dims: ['device', 'mount'] },
  'disk.used_pct': { unit: '%', dims: ['device', 'mount'] },
  'disk.inode_used_pct': { unit: '%', dims: ['device', 'mount'] },
  'disk.read_bps': { unit: 'bytes/s', dims: ['device', 'mount'] },
  'disk.write_bps': { unit: 'bytes/s', dims: ['device', 'mount'] },
  'disk.read_iops': { unit: '次/s', dims: ['device', 'mount'] },
  'disk.write_iops': { unit: '次/s', dims: ['device', 'mount'] },
  'disk.latency_ms': { unit: 'ms', dims: ['device', 'mount'] },
  'net.rx_bps': { unit: 'bytes/s', dims: ['device'] },
  'net.tx_bps': { unit: 'bytes/s', dims: ['device'] },
  'net.rx_total': { unit: 'bytes', dims: ['device'] },
  'net.tx_total': { unit: 'bytes', dims: ['device'] },
  'net.conn_count': { unit: '个', dims: ['device'] },
  'net.err': { unit: '次/s', dims: ['device'] },
  'net.drop': { unit: '次/s', dims: ['device'] },
  'gpu.util': { unit: '%', dims: ['index'] },
  'gpu.mem_used': { unit: 'bytes', dims: ['index'] },
  'gpu.mem_total': { unit: 'bytes', dims: ['index'] },
  'gpu.temp': { unit: '℃', dims: ['index'] },
  'gpu.power': { unit: 'W', dims: ['index'] },
  'process.count': { unit: '个', dims: [] },
});

/** 基名是否在文档登记清单内 */
export function isKnownBaseMetric(base) {
  return Object.hasOwn(KNOWN_BASE_METRICS, base);
}

/** 取单位（未知基名返回空串，⛔ 不抛异常：新指标不应打断既有链路） */
export function unitOf(base) {
  return KNOWN_BASE_METRICS[base]?.unit ?? '';
}
