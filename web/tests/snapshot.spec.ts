/**
 * 当前快照分组（`GET /api/v1/hosts/{id}` 的 `current_metrics`）：
 * 键是**指标全名**，面板要按 CPU / 内存 / 各分区 / 各网卡 / GPU 分组渲染。
 * 分组规则来自 docs/database.md §5.7.2 的指标清单，⛔ 不在这里发明新指标名。
 */
import { describe, expect, it } from 'vitest'

import { buildCurrentSnapshot } from '@/utils/snapshot'

const CURRENT: Record<string, number | null> = {
  'cpu.usage': 12.5,
  'cpu.load1': 0.5,
  'cpu.core.usage{core=1}': 15,
  'cpu.core.usage{core=0}': 10,
  'mem.used': 1024,
  'mem.total': 4096,
  'swap.used_pct': 0,
  'process.count': 123,
  'disk.used_pct{device=sda1,mount=/data}': 42.5,
  'disk.read_bps{device=sda1,mount=/data}': 1024,
  'disk.used_pct{mount=/}': 61,
  'net.rx_bps{device=eth0}': 1234,
  'net.tx_bps{device=eth0}': 4321,
  'gpu.util{index=0}': 30,
  'gpu.temp{index=0}': 55,
}

describe('buildCurrentSnapshot', () => {
  it('无维度指标进 scalars（键是基名）', () => {
    const view = buildCurrentSnapshot(CURRENT)
    expect(view.scalars['cpu.usage']).toBe(12.5)
    expect(view.scalars['mem.total']).toBe(4096)
    expect(view.scalars['process.count']).toBe(123)
    // ⚠️ 0 是合法读数（Swap 使用率 0%），⛔ 不能被当成"无数据"丢掉
    expect(view.scalars['swap.used_pct']).toBe(0)
  })

  it('每核使用率按核序号数值升序（不是字符串序）', () => {
    const view = buildCurrentSnapshot({
      'cpu.core.usage{core=10}': 1,
      'cpu.core.usage{core=2}': 2,
      'cpu.core.usage{core=1}': 3,
    })
    expect(view.cores.map((core) => core.core)).toEqual(['1', '2', '10'])
  })

  it('同一分区的多个基名归并到一行（挂载点身份 = 维度集合）', () => {
    const view = buildCurrentSnapshot(CURRENT)
    const data = view.disks.find((row) => row.labels.mount === '/data')
    expect(data).toBeDefined()
    expect(data?.values['disk.used_pct']).toBe(42.5)
    expect(data?.values['disk.read_bps']).toBe(1024)
    expect(data?.label).toBe('/data')
  })

  it('没有 mount 的分区按 mount 缺失仍然独立成行（⛔ 不与别的分区合并）', () => {
    const view = buildCurrentSnapshot(CURRENT)
    expect(view.disks).toHaveLength(2)
    expect(view.disks.map((row) => row.label).sort()).toEqual(['/', '/data'])
  })

  it('网卡按 device 归并，GPU 标签统一成 `GPU <index>`', () => {
    const view = buildCurrentSnapshot(CURRENT)
    expect(view.networks).toHaveLength(1)
    expect(view.networks[0]?.label).toBe('eth0')
    expect(view.networks[0]?.values['net.rx_bps']).toBe(1234)
    expect(view.networks[0]?.values['net.tx_bps']).toBe(4321)

    expect(view.gpus).toHaveLength(1)
    expect(view.gpus[0]?.label).toBe('GPU 0')
    expect(view.gpus[0]?.values['gpu.util']).toBe(30)
    expect(view.gpus[0]?.values['gpu.temp']).toBe(55)
  })

  it('指标名不合规时降级为标量，⛔ 不整块丢弃', () => {
    const view = buildCurrentSnapshot({ 'CPU.USAGE': 7 })
    expect(view.scalars['CPU.USAGE']).toBe(7)
  })

  it('缺值 / 空输入都不抛错', () => {
    expect(buildCurrentSnapshot(null).disks).toEqual([])
    const view = buildCurrentSnapshot({ 'disk.used_pct{mount=/data}': null })
    expect(view.disks[0]?.values['disk.used_pct']).toBeNull()
  })
})
