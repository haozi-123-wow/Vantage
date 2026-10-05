/**
 * realtime store：快照替换 / 增量合并 / 重连清空缓冲（docs/frontend.md §11 单元测试口径）
 * 与环形缓冲的键必须是序列全名（F10）。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { SERIES_BUFFER_LIMIT, useRealtimeStore } from '@/store/realtime'
import type {
  PublicHost,
  RealtimeHost,
  WsDeltaMessage,
  WsPublicDeltaMessage,
  WsSnapshotMessage,
} from '@/types/domain'
import { RingBuffer } from '@/utils/ring'

function host(id: string, status: RealtimeHost['status'] = 'online'): RealtimeHost {
  return { id, status, snapshot: { 'cpu.usage': 1 } }
}

/** 公开侧条目：只有 `slug`，⛔ 无内部 UUID（docs/api.md §5.2） */
function publicHost(slug: string, status: PublicHost['status'] = 'online'): PublicHost {
  return {
    slug,
    name: `host-${slug}`,
    status,
    snapshot: { cpu_pct: 1, mem_pct: 2, disk_pct: 3, net_rx_bps: 4, net_tx_bps: 5 },
    probes: { up: 1, down: 0 },
    last_seen_ago: null,
    last_seen_at: null,
  }
}

function snapshot(hosts: Array<RealtimeHost | PublicHost>, ts = 1_000): WsSnapshotMessage {
  return {
    type: 'snapshot',
    ts,
    hosts,
    summary: { total: hosts.length, online: hosts.length, offline: 0, alerts: { critical: 0, warn: 0, info: 0 } },
  }
}

function delta(partial: Omit<WsDeltaMessage, 'type'>): WsDeltaMessage {
  return { type: 'delta', ...partial }
}

function publicDelta(host: PublicHost, ts = 2_000): WsPublicDeltaMessage {
  return { type: 'delta', channel: 'status', ts, host }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('snapshot：整表替换', () => {
  it('新快照替换旧表，而不是合并', () => {
    const store = useRealtimeStore()
    store.applySnapshot(snapshot([host('a1'), host('a2')]))
    expect(store.hostList).toHaveLength(2)

    store.applySnapshot(snapshot([host('a2')], 2_000))
    expect(store.hostList).toHaveLength(1)
    expect((store.hostList[0] as RealtimeHost).id).toBe('a2')
    expect(store.summary?.total).toBe(1)
    expect(store.lastMessageAt).toBe(2_000)
  })
})

describe('delta：按序列全名就地更新', () => {
  it('更新当前值并推入该序列的环形缓冲', () => {
    const store = useRealtimeStore()
    store.trackAgent('a1')
    store.applySnapshot(snapshot([host('a1')]))

    store.applyDelta(delta({ ts: 3_000, channel: 'metrics', agent_id: 'a1', metrics: { 'cpu.usage': 12.4 } }))

    expect((store.hosts.a1 as RealtimeHost).snapshot?.['cpu.usage']).toBe(12.4)
    expect(store.series['cpu.usage']?.points).toEqual([[3_000, 12.4]])
  })

  it('带维度的序列各自成键（⛔ 用基名做键会把多个挂载点混成一条线）', () => {
    const store = useRealtimeStore()
    store.trackAgent('a1')
    store.applySnapshot(snapshot([host('a1')]))

    store.applyDelta(
      delta({
        ts: 3_000,
        channel: 'metrics',
        agent_id: 'a1',
        metrics: { 'disk.used_pct{mount=/}': 61, 'disk.used_pct{mount=/data}': 88 },
      }),
    )

    // 注意排序：`d`(0x64) < `}`(0x7D)，所以 `{mount=/data}` 排在 `{mount=/}` 前面
    expect(Object.keys(store.series).sort()).toEqual([
      'disk.used_pct{mount=/data}',
      'disk.used_pct{mount=/}',
    ])
    expect(store.series['disk.used_pct{mount=/data}']?.base).toBe('disk.used_pct')
    expect(store.series['disk.used_pct{mount=/data}']?.labels).toEqual({ mount: '/data' })
  })

  it('只缓冲被跟踪主机（详情页）的指标', () => {
    const store = useRealtimeStore()
    store.trackAgent('a1')
    store.applySnapshot(snapshot([host('a1'), host('a2')]))

    store.applyDelta(delta({ ts: 3_000, channel: 'metrics', agent_id: 'a2', metrics: { 'cpu.usage': 99 } }))

    expect((store.hosts.a2 as RealtimeHost).snapshot?.['cpu.usage']).toBe(99) // 当前值照常更新
    expect(store.series).toEqual({}) // 但不进曲线缓冲
  })

  it('status / probes / alerts 频道各自落位', () => {
    const store = useRealtimeStore()
    store.applySnapshot(snapshot([host('a1')]))

    store.applyDelta(delta({ ts: 3_000, channel: 'status', agent_id: 'a1', status: 'offline' }))
    store.applyDelta(
      delta({ ts: 3_100, channel: 'probes', agent_id: 'a1', probe: { name: 'site-health', up: false } }),
    )
    store.applyDelta(
      delta({
        ts: 3_200,
        channel: 'alerts',
        agent_id: 'a1',
        event: { id: 7, severity: 'warn', status: 'firing' },
      }),
    )

    expect(store.hosts.a1?.status).toBe('offline')
    expect(store.probeStates.a1?.['site-health']).toBe(false)
    expect(store.recentAlerts[0]).toMatchObject({ id: 7, agentId: 'a1', severity: 'warn' })
  })
})

describe('断线 / 重连：空洞不可续', () => {
  it('新快照清空环形缓冲', () => {
    const store = useRealtimeStore()
    store.trackAgent('a1')
    store.applySnapshot(snapshot([host('a1')], 1_000))
    store.applyDelta(delta({ ts: 2_000, channel: 'metrics', agent_id: 'a1', metrics: { 'cpu.usage': 12 } }))
    expect(Object.keys(store.series)).toHaveLength(1)

    store.applySnapshot(snapshot([host('a1')], 9_000))
    expect(store.series).toEqual({})
  })

  it('切换被跟踪主机时旧缓冲作废', () => {
    const store = useRealtimeStore()
    store.trackAgent('a1')
    store.applySnapshot(snapshot([host('a1'), host('a2')]))
    store.applyDelta(delta({ ts: 2_000, channel: 'metrics', agent_id: 'a1', metrics: { 'cpu.usage': 12 } }))

    store.trackAgent('a2')
    expect(store.series).toEqual({})
  })
})

describe('公开频道（/ws/public，形状与面板不同）', () => {
  it('快照按 slug 建键（⛔ 公开侧没有内部 UUID）', () => {
    const store = useRealtimeStore()
    store.applySnapshot(snapshot([publicHost('abc12345')]))

    expect(store.hostList).toHaveLength(1)
    expect(Object.keys(store.hosts)).toEqual(['abc12345'])
  })

  it('公开 delta 是"整条脱敏条目替换"，不是 agent_id 增量', () => {
    const store = useRealtimeStore()
    store.applySnapshot(snapshot([publicHost('abc12345')]))
    store.applyDelta(publicDelta(publicHost('abc12345', 'offline')))

    expect((store.hosts.abc12345 as PublicHost).status).toBe('offline')
    expect(store.lastMessageAt).toBe(2_000)
  })

  it('summary 与 REST 同形：alerts 是三个严重级的对象', () => {
    const store = useRealtimeStore()
    store.applySnapshot(snapshot([publicHost('abc12345')]))

    expect(store.summary?.alerts).toEqual({ critical: 0, warn: 0, info: 0 })
  })
})

describe('RingBuffer', () => {
  it('超过容量后丢弃最旧的点', () => {
    const buffer = new RingBuffer<number>(SERIES_BUFFER_LIMIT)
    for (let i = 0; i < SERIES_BUFFER_LIMIT + 5; i += 1) buffer.push(i)

    expect(buffer.size).toBe(SERIES_BUFFER_LIMIT)
    expect(buffer.toArray()[0]).toBe(5)
    expect(buffer.toArray().at(-1)).toBe(SERIES_BUFFER_LIMIT + 4)
  })

  it('容量必须是正整数', () => {
    expect(() => new RingBuffer<number>(0)).toThrow()
    expect(() => new RingBuffer<number>(-1)).toThrow()
    expect(() => new RingBuffer<number>(1.5)).toThrow()
  })
})
