/**
 * 结构化上报体 → 时序序列（`flattenMetrics`）单元测试
 *
 * 依据：docs/database.md §5.7.2（指标清单、维度写进名字、转义规则）、
 *       docs/api.md §2.1（metrics 结构）
 *
 * 为什么这些用例值得单独写：`flattenMetrics` 是**唯一**一处把"报文里的 disk[]/net[]/gpu[]"
 * 变成"库里的序列名"的地方。拼错一次不会报错，只会让同一条曲线在库里变成两条 ——
 * 这类问题在面板上表现为"曲线断成两截"，排查成本极高。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { flattenMetrics } from '../src/services/metrics.service.js';
import { parseMetric } from '../src/utils/metric.js';

/** 取序列名清单 */
const names = (metrics) => flattenMetrics(metrics).map((point) => point.metric);
/** 取某个序列的值 */
const valueOf = (metrics, name) => flattenMetrics(metrics).find((p) => p.metric === name)?.value;

test('CPU：整体使用率、每核（维度 core）、三档负载、上下文切换', () => {
  const got = names({
    cpu: { usage: 12.5, cores: [10, 20, 30], load: [0.5, 1.5, 2.5], ctx_switch: 999 },
    mem: { total: 100 },
  });

  assert.deepEqual(got, [
    'cpu.usage',
    'cpu.core.usage{core=0}',
    'cpu.core.usage{core=1}',
    'cpu.core.usage{core=2}',
    'cpu.load1',
    'cpu.load5',
    'cpu.load15',
    'cpu.ctx_switch',
    'mem.total',
  ]);
  // ⛔ 已废弃的写法（把序号写进名字）绝不能再出现
  assert.equal(got.some((name) => /^cpu\.core\.\d+\.usage$/.test(name)), false);
});

test('内存：派生 used_pct 用同一批的分子分母，分母为 0 或缺失时不产出', () => {
  assert.equal(valueOf({ mem: { total: 1000, used: 250 } }, 'mem.used_pct'), 25);

  // denominator = 0 → 不产出（⛔ 不要写 0 或 NaN，那会污染曲线与阈值判定）
  assert.equal(names({ mem: { total: 0, used: 0 } }).includes('mem.used_pct'), false);
  // 只有 total，没有 used → 不产出
  assert.equal(names({ mem: { total: 1000 } }).includes('mem.used_pct'), false);
});

test('内存：used > total（采样时刻差异）时百分比被 clamp 到 100，不产生 >100 的假数据', () => {
  assert.equal(valueOf({ mem: { total: 1000, used: 1001 } }, 'mem.used_pct'), 100);
});

test('Swap：报文路径是 mem.swap.*，指标名却是顶层 swap.*（⚠️ 设计有意为之）', () => {
  const got = names({ mem: { total: 1, swap: { total: 2048, used: 512 } } });
  assert.ok(got.includes('swap.total'));
  assert.ok(got.includes('swap.used'));
  assert.ok(got.includes('swap.used_pct'));
  assert.equal(valueOf({ mem: { total: 1, swap: { total: 2048, used: 512 } } }, 'swap.used_pct'), 25);
  // ⛔ 不得出现 mem.swap.* 这种名字
  assert.equal(got.some((name) => name.startsWith('mem.swap')), false);
});

test('磁盘：device 存在时两个维度都在名字里，且按**键名字母序**（device 在 mount 前）', () => {
  const got = names({
    mem: { total: 1 },
    disk: [{ device: 'sda1', mount: '/data', total: 100, used: 40 }],
  });
  assert.ok(got.includes('disk.used_pct{device=sda1,mount=/data}'), got.join('\n'));
  // 与文档 §5.7.2 的示例逐字一致
  assert.equal(got.includes('disk.used_pct{device=sda1,mount=/data}'), true);
});

test('磁盘：device 缺失时只带 mount 维度（§2.1 的字段表未列 device）', () => {
  const got = names({ mem: { total: 1 }, disk: [{ mount: '/', total: 100, used: 40 }] });
  assert.ok(got.includes('disk.used_pct{mount=/}'));
  assert.equal(got.some((name) => name.includes('device=')), false);
});

test('磁盘：维度值里的 , = 空白 会被百分号编码（否则会把一条序列切成两条）', () => {
  const got = names({ mem: { total: 1 }, disk: [{ device: 'mapper/a=b', mount: '/data,old', total: 1, used: 1 }] });
  const name = got.find((item) => item.startsWith('disk.used{'));
  assert.equal(name, 'disk.used{device=mapper/a%3Db,mount=/data%2Cold}');
  // 编码是可逆的：反解回来必须与原值一致
  assert.deepEqual(parseMetric(name).labels, { device: 'mapper/a=b', mount: '/data,old' });
});

test('磁盘：inode_used 落 disk.inode_used_pct（字段名沿用 §2.1，语义是百分比）', () => {
  const got = names({ mem: { total: 1 }, disk: [{ mount: '/', inode_used: 7.5 }] });
  assert.ok(got.includes('disk.inode_used_pct{mount=/}'));
});

test('磁盘：iops 拆成 read_iops / write_iops（与 §5.7.2 的指标清单对应）', () => {
  const got = names({ mem: { total: 1 }, disk: [{ mount: '/', read_iops: 3, write_iops: 5 }] });
  assert.ok(got.includes('disk.read_iops{mount=/}'));
  assert.ok(got.includes('disk.write_iops{mount=/}'));
});

test('网卡：device 维度 + 7 个指标，缺失的字段不产出空点', () => {
  const got = names({ mem: { total: 1 }, net: [{ device: 'eth0', rx_bps: 1, tx_bps: 2 }] });
  assert.deepEqual(got.filter((name) => name.startsWith('net.')), [
    'net.rx_bps{device=eth0}',
    'net.tx_bps{device=eth0}',
  ]);
});

test('GPU：维度是 index，且 index=0 也必须保留（⛔ 不能当假值丢掉）', () => {
  const got = names({ mem: { total: 1 }, gpu: [{ index: 0, util: 30, temp: 55 }] });
  assert.deepEqual(got.filter((name) => name.startsWith('gpu.')), [
    'gpu.util{index=0}',
    'gpu.temp{index=0}',
  ]);
});

test('进程：只有总数进时序，Top-N 明细不进（明细落 process_snapshots）', () => {
  const got = names({ mem: { total: 1 }, process: { count: 210, top: [{ pid: 1, name: 'x', cpu: 1, mem: 2 }] } });
  assert.deepEqual(got.filter((name) => name.startsWith('process')), ['process.count']);
});

test('docker 固定 null：不产出任何序列（本期预留位）', () => {
  const got = names({ mem: { total: 1 }, docker: null });
  assert.equal(got.some((name) => name.startsWith('docker')), false);
});

test('同一批次内出现重复序列名 → 抛 schema_invalid（⛔ 不能靠 ON CONFLICT 静默覆盖）', () => {
  assert.throws(
    () => flattenMetrics({ mem: { total: 1 }, disk: [{ mount: '/', total: 1 }, { mount: '/', total: 2 }] }),
    (err) => err.code === 'schema_invalid' && /重复的序列名/.test(err.message),
  );
  assert.throws(
    () => flattenMetrics({ mem: { total: 1 }, gpu: [{ index: 0, util: 1 }, { index: 0, util: 2 }] }),
    (err) => err.code === 'schema_invalid',
  );
  // device 不同 → 是不同的序列，必须允许
  assert.equal(
    names({ mem: { total: 1 }, disk: [{ device: 'sda', mount: '/' }, { device: 'sdb', mount: '/' }] }).length > 0,
    true,
  );
});

test('非有限数值一律拒绝（NaN / Infinity 会污染 1m/5m 的聚合）', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => flattenMetrics({ mem: { total: 1 }, cpu: { usage: bad } }),
      (err) => err.code === 'schema_invalid',
      `应拒绝 ${bad}`,
    );
  }
});

test('非法基名不会漏成 500：一律 400 schema_invalid', () => {
  // 挂载点异常长 → 全名超 200 上限（否则会撑爆索引/前端标签）
  assert.throws(
    () => flattenMetrics({ mem: { total: 1 }, disk: [{ mount: `/${'x'.repeat(300)}`, total: 1 }] }),
    (err) => err.code === 'schema_invalid' && /超长/.test(err.message),
  );
});

test('维度值缺失时**不构造序列名**，因此异常长的挂载点若没数据也不会误报 400', () => {
  // 一条只有 mount、没有任何数值的 disk 条目：合法且应当是 no-op（Agent 采不到的挂载点很常见）
  assert.deepEqual(names({ mem: { total: 1 }, disk: [{ mount: `/${'x'.repeat(300)}` }] }), ['mem.total']);
});

test('labels 与序列全名一致（labels 是"由全名反解的便利副本"，⛔ 非权威）', () => {
  const series = flattenMetrics({
    mem: { total: 1 },
    disk: [{ device: 'sda1', mount: '/data', used: 1 }],
    net: [{ device: 'eth0', rx_bps: 1 }],
  });
  for (const point of series) {
    assert.deepEqual(parseMetric(point.metric).labels, point.labels, point.metric);
  }
});
