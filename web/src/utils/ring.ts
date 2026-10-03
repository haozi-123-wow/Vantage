/**
 * 定长环形缓冲。
 *
 * 用途：实时曲线只追加「当前值」的尾部（docs/frontend.md §5.3，建议每序列 300 点）。
 * 重连成功后必须清空（⛔ 不补传，避免把断线期的空洞误连成一条线）。
 */
export class RingBuffer<T> {
  private items: T[] = []

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer 容量必须是正整数：${capacity}`)
    }
  }

  push(item: T): void {
    this.items.push(item)
    const overflow = this.items.length - this.capacity
    if (overflow > 0) this.items.splice(0, overflow)
  }

  /** 返回副本，避免调用方改到内部数组 */
  toArray(): T[] {
    return this.items.slice()
  }

  get size(): number {
    return this.items.length
  }

  get limit(): number {
    return this.capacity
  }

  clear(): void {
    this.items = []
  }
}
