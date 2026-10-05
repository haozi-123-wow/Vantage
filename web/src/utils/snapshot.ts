/**
 * 当前快照的**视图模型**（`GET /api/v1/hosts/{id}` 的 `current_metrics`）。
 *
 * 为什么需要它：`current_metrics` 的键是**指标全名**（含维度，如 `disk.used_pct{mount=/data}`），
 * 值是该序列的当前值 —— 面板要按「CPU / 内存 / 各分区 / 各网卡 / GPU」分组渲染，
 * 分组规则属于契约（docs/database.md §5.7.2 的指标清单），必须有单测钉住。
 *
 * ⚠️ 与公开侧的 `PublicHostNow` **不同**：那是服务端泛化后的 `label`（「磁盘 1」），
 *    私有域这里是真实 `mount`/`device`/`index`（运维排障要用），⛔ 两边不要互相套用。
 * ⚠️ `current_metrics` 只含**观测窗口**（5 分钟内有过写入）的序列 —— 窗口外的旧序列不返回，
 *    所以"这一块没有数据"和"字段为 null"必须用同一种渲染（`—`），⛔ 都不补 0。
 */
import type { MetricLabels } from '@/types/domain'
import { parseMetric } from '@/utils/metrics'

/** 每核使用率的基名（核序号是维度：`cpu.core.usage{core=3}`） */
export const CPU_CORE_BASE = 'cpu.core.usage'

const DISK_BASES = new Set([
  'disk.total',
  'disk.used',
  'disk.used_pct',
  'disk.inode_used_pct',
  'disk.read_bps',
  'disk.write_bps',
  'disk.read_iops',
  'disk.write_iops',
  'disk.latency_ms',
])

const NET_BASES = new Set([
  'net.rx_bps',
  'net.tx_bps',
  'net.rx_total',
  'net.tx_total',
  'net.conn_count',
  'net.err',
  'net.drop',
])

const GPU_BASES = new Set(['gpu.util', 'gpu.mem_used', 'gpu.mem_total', 'gpu.temp', 'gpu.power'])

/** 一台设备（一个分区 / 一张网卡 / 一块 GPU）的当前值集合 */
export interface SnapshotDeviceRow {
  /** 稳定键（由维度值拼成，用于 `v-for` 的 key） */
  key: string
  /** 展示标签：磁盘优先 `mount`、网卡用 `device`、GPU 用 `GPU <index>` */
  label: string
  labels: MetricLabels
  /** 基名 → 当前值（缺的基名不出现，⛔ 不补 0） */
  values: Record<string, number | null>
}

export interface CurrentSnapshotView {
  /** 无维度标量：基名 → 当前值（`cpu.usage` / `mem.*` / `swap.*` / `process.count` …） */
  scalars: Record<string, number | null>
  /** 每核使用率，按核序号数值升序 */
  cores: Array<{ core: string; value: number | null }>
  disks: SnapshotDeviceRow[]
  networks: SnapshotDeviceRow[]
  gpus: SnapshotDeviceRow[]
}

function numericLabelSort(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b)
}

function deviceLabel(labels: MetricLabels, fallback: string): string {
  return labels.mount ?? labels.device ?? labels.index ?? fallback
}

/** 分组：把全名按"设备身份"归并（同一分区的 `used_pct` 与 `read_bps` 要在同一行） */
function deviceKey(labels: MetricLabels, base: string): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(',') || base
}

export function buildCurrentSnapshot(
  current: Record<string, number | null> | null | undefined,
): CurrentSnapshotView {
  const view: CurrentSnapshotView = { scalars: {}, cores: [], disks: [], networks: [], gpus: [] }
  if (!current) return view

  const diskRows = new Map<string, SnapshotDeviceRow>()
  const netRows = new Map<string, SnapshotDeviceRow>()
  const gpuRows = new Map<string, SnapshotDeviceRow>()

  for (const [metric, value] of Object.entries(current)) {
    let base = metric
    let labels: MetricLabels = {}
    try {
      const parsed = parseMetric(metric)
      base = parsed.base
      labels = parsed.labels
    } catch {
      // 服务端给了不合规的序列名：降级为"基名 = 原名、无维度"，⛔ 不能因此丢掉这个数值
      labels = {}
    }

    if (base === CPU_CORE_BASE) {
      view.cores.push({ core: labels.core ?? String(view.cores.length), value })
      continue
    }

    const target = DISK_BASES.has(base) ? diskRows : NET_BASES.has(base) ? netRows : GPU_BASES.has(base) ? gpuRows : null
    if (!target) {
      view.scalars[base] = value
      continue
    }

    const key = deviceKey(labels, base)
    let row = target.get(key)
    if (!row) {
      row = { key, label: deviceLabel(labels, key), labels, values: {} }
      target.set(key, row)
    }
    row.values[base] = value
  }

  view.cores.sort((a, b) => numericLabelSort(a.core, b.core))
  view.disks = [...diskRows.values()].sort((a, b) => a.label.localeCompare(b.label))
  view.networks = [...netRows.values()].sort((a, b) => a.label.localeCompare(b.label))
  view.gpus = [...gpuRows.values()]
    .map((row) => ({ ...row, label: row.labels.index ? `GPU ${row.labels.index}` : row.label }))
    .sort((a, b) => numericLabelSort(a.labels.index ?? a.label, b.labels.index ?? b.label))

  return view
}
