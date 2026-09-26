/**
 * Vantage · 指标服务（结构化上报体 → 时序序列）
 *
 * 依据：docs/database.md §5.7.2（维度写进指标名）、§5.7.3（分区）、
 *       docs/api.md §2.1（metrics 结构）、Vantage-DESIGN-v0.7.md §9.1
 *
 * 职责边界
 *  - 本文件负责「**结构化报文 → 序列全名**」的**唯一一份**映射实现（✅ R5）。
 *    ⛔ 任何第二处拼装（例如在路由里手写 `disk.used_pct{...}`）都是 bug 来源：
 *      拼错转义会让同一挂载点在库里变成两条曲线，而且**不会报错**。
 *  - 落库走 repositories/metric.repo.js；事务编排在 services/ingest.service.js。
 *
 * 派生指标（中心侧计算，⚠️ Agent 不报这三个）
 *  - `mem.used_pct` / `swap.used_pct` / `disk.used_pct`：§2.1 的 metrics 表只给 bytes，
 *    而 §5.7.2 的指标清单里有这三个百分比 —— 由中心用**同一批**的分子分母就地算出，
 *    保证「曲线上的百分比」与「曲线上的字节数」永远自洽（Agent 各算一份必然出现漂移）。
 */

import { AppError } from '../utils/errors.js';
import { MetricNameError, buildMetric } from '../utils/metric.js';
import { insertMetricsRaw, insertProcessSnapshot } from '../repositories/metric.repo.js';

/** 百分比保留 4 位小数：足够画出任何真实曲线，又能让「同一份输入 → 同一份落库值」稳定可比 */
const PCT_SCALE = 10_000;

/**
 * 拼装序列全名；把 MetricNameError 转成对外的 400。
 * 调用方拿到的永远是可解释的 4xx，而不是 500（§1.3）。
 */
function buildName(base, labels) {
  try {
    return buildMetric(base, labels);
  } catch (err) {
    if (err instanceof MetricNameError) {
      throw new AppError('schema_invalid', {
        message: `指标名不合法：${err.message}`,
        details: { base },
        cause: err,
      });
    }
    throw err;
  }
}

/** 派生百分比：分母缺失/为 0 时**不产出序列**（宁缺勿造，⛔ 不要写 0 或 NaN 污染曲线） */
function derivedPct(numerator, denominator) {
  if (typeof numerator !== 'number' || typeof denominator !== 'number') return undefined;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return undefined;
  if (denominator <= 0) return undefined;
  const value = (numerator / denominator) * 100;
  // clamp 到 [0,100]：/proc 的采样时刻差异偶尔会让 used 略大于 total（+0.1%），
  // 若原样落库，告警规则里 `> 100` 这类阈值会出现「永远不触发」的假安全感。
  return Math.round(Math.min(100, Math.max(0, value)) * PCT_SCALE) / PCT_SCALE;
}

/**
 * 把结构化 metrics 展平成时序序列列表。
 *
 * @param {object} metrics 已通过 schema 校验的 metrics 对象
 * @returns {Array<{ metric: string, value: number, labels: Record<string,string> }>}
 * @throws {AppError} `schema_invalid`（指标名不合法 / 批内重复序列）
 */
export function flattenMetrics(metrics) {
  const series = [];
  const seen = new Set();

  const add = (base, value, labels) => {
    if (value === undefined || value === null) return; // 该维度本批没采到 → 不产出空点
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AppError('schema_invalid', {
        message: `指标 ${base} 的值必须是有限数字（NaN/Infinity 一律拒绝，否则会污染聚合与图表）`,
        details: { metric: base },
      });
    }
    const full = buildName(base, labels);
    if (seen.has(full)) {
      // 典型成因：disk[] 里两条挂载点重复、或 gpu.index 重复。⛔ 不能靠 ON CONFLICT 静默覆盖 ——
      // 那会让「Agent 采到两份不同数值」变成「随机留一份」，排查时完全看不出。
      throw new AppError('schema_invalid', {
        message: `同一批次内出现重复的序列名：${full}（请检查 disk/net/gpu 数组里是否有重复的维度取值）`,
        details: { metric: full },
      });
    }
    seen.add(full);
    series.push({ metric: full, value, labels: labels ?? {} });
  };

  const addPct = (base, numerator, denominator, labels) =>
    add(base, derivedPct(numerator, denominator), labels);

  // --- CPU -------------------------------------------------------------------
  const cpu = metrics.cpu ?? {};
  add('cpu.usage', cpu.usage);
  // ⚠️ 每核的维度键是 `core`（✅ §5.7.2；⛔ 已废弃 `cpu.core.<n>.usage` 那种把序号写进名字的写法）
  if (Array.isArray(cpu.cores)) {
    cpu.cores.forEach((value, index) => add('cpu.core.usage', value, { core: String(index) }));
  }
  if (Array.isArray(cpu.load)) {
    add('cpu.load1', cpu.load[0]);
    add('cpu.load5', cpu.load[1]);
    add('cpu.load15', cpu.load[2]);
  }
  add('cpu.ctx_switch', cpu.ctx_switch);

  // --- 内存 / Swap -----------------------------------------------------------
  const mem = metrics.mem ?? {};
  add('mem.total', mem.total);
  add('mem.used', mem.used);
  add('mem.available', mem.available);
  add('mem.cached', mem.cached);
  add('mem.buffers', mem.buffers);
  addPct('mem.used_pct', mem.used, mem.total);

  if (mem.swap) {
    // ⚠️ 报文里的路径是 mem.swap.*，指标名却是 swap.*（§5.7.2 的顶层命名）—— 这是设计有意为之，别"顺手统一"
    add('swap.total', mem.swap.total);
    add('swap.used', mem.swap.used);
    addPct('swap.used_pct', mem.swap.used, mem.swap.total);
  }

  // --- 磁盘（每挂载点一组维度）-----------------------------------------------
  for (const disk of metrics.disk ?? []) {
    // `device` 可选（§2.1 的字段表未列，但 §5.7.2 的维度名含它）：缺失时只带 mount 维度。
    // ⛔ 不要用 mount 冒充 device —— 那会让「按设备聚合」在面板上给出两套含义。
    const labels = disk.device ? { device: disk.device, mount: disk.mount } : { mount: disk.mount };
    add('disk.total', disk.total, labels);
    add('disk.used', disk.used, labels);
    addPct('disk.used_pct', disk.used, disk.total, labels);
    add('disk.inode_used_pct', disk.inode_used, labels);
    add('disk.read_bps', disk.read_bps, labels);
    add('disk.write_bps', disk.write_bps, labels);
    add('disk.read_iops', disk.read_iops, labels);
    add('disk.write_iops', disk.write_iops, labels);
    add('disk.latency_ms', disk.latency_ms, labels);
  }

  // --- 网卡 ------------------------------------------------------------------
  for (const net of metrics.net ?? []) {
    const labels = { device: net.device };
    add('net.rx_bps', net.rx_bps, labels);
    add('net.tx_bps', net.tx_bps, labels);
    add('net.rx_total', net.rx_total, labels);
    add('net.tx_total', net.tx_total, labels);
    add('net.conn_count', net.conn_count, labels);
    add('net.err', net.err, labels);
    add('net.drop', net.drop, labels);
  }

  // --- GPU -------------------------------------------------------------------
  for (const gpu of metrics.gpu ?? []) {
    const labels = { index: String(gpu.index) };
    add('gpu.util', gpu.util, labels);
    add('gpu.mem_used', gpu.mem_used, labels);
    add('gpu.mem_total', gpu.mem_total, labels);
    add('gpu.temp', gpu.temp, labels);
    add('gpu.power', gpu.power, labels);
  }

  // --- 进程 ------------------------------------------------------------------
  // ⚠️ 只有**总数**进时序；Top-N 明细落 process_snapshots（见 storeProcessSnapshot）
  if (metrics.process) add('process.count', metrics.process.count);

  return series;
}

/**
 * 批量落 metrics_raw。
 * @param {import('pg').PoolClient} client 事务内客户端
 * @param {{ agentId: string, serverTs: Date, series: Array<object>, logger?: object }} input
 */
export async function storeMetrics(client, input) {
  const rows = await insertMetricsRaw(client, {
    agentId: input.agentId,
    serverTs: input.serverTs,
    series: input.series,
  });
  input.logger?.debug?.({ agentId: input.agentId, series: input.series.length, rows }, '原始指标已落库');
  return rows;
}

/**
 * 落进程快照（含 Top-N 明细）。
 * @param {import('pg').PoolClient} client
 * @param {{ agentId: string, serverTs: Date, process: { count: number, top?: Array<object> }, logger?: object }} input
 */
export async function storeProcessSnapshot(client, input) {
  const id = await insertProcessSnapshot(client, {
    agentId: input.agentId,
    serverTs: input.serverTs,
    total: input.process.count ?? 0,
    top: input.process.top ?? [],
  });
  input.logger?.debug?.(
    { agentId: input.agentId, id, top: (input.process.top ?? []).length },
    '进程快照已落库',
  );
  return id;
}
