/**
 * 指标命名与维度转义测试 —— 对齐 docs/database.md §5.7.2（✅ R5 决策）
 *
 * 除常规单测外，本文件还包含一个**SQL 校验器的 JS 镜像**：
 * 迁移 `0001_helpers.sql` 的 `vantage_is_valid_metric_name()` 是库层校验器，
 * 必须接受 `buildMetric()` 的**全部**产出（否则合法上报会被库拒绝）。
 * ⚠️ 改动任一侧都要同步改这里并跑测试。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  KNOWN_BASE_METRICS,
  METRIC_NAME_MAX_LENGTH,
  MetricNameError,
  buildMetric,
  classifyMetricRef,
  escapeLabelValue,
  isKnownBaseMetric,
  isValidMetricName,
  metricRefMatches,
  parseMetric,
  unescapeLabelValue,
  unitOf,
} from '../src/utils/metric.js';

/**
 * `vantage_is_valid_metric_name()` 的 JS 镜像（POSIX `[:space:]` → JS `\s`）。
 * 与迁移 0001 中的正则**严格对应**。注意 JS `\s` 比 POSIX `[:space:]` 更宽，
 * 因而是更严格的校验——只要它能过，库层一定能过。
 */
const SQL_VALIDATOR_MIRROR =
  /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\{[a-z0-9_]+=[^{}=,\s]+(,[a-z0-9_]+=[^{}=,\s]+)*\})?$/;

function sqlAccepts(name) {
  return (
    typeof name === 'string' &&
    name.length >= 1 &&
    name.length <= METRIC_NAME_MAX_LENGTH &&
    SQL_VALIDATOR_MIRROR.test(name)
  );
}

test('文档 §5.7.2 的示例必须逐字成立', () => {
  assert.equal(buildMetric('disk.used_pct', { mount: '/' }), 'disk.used_pct{mount=/}');
  assert.equal(
    buildMetric('disk.used_pct', { device: 'sda1', mount: '/data' }),
    'disk.used_pct{device=sda1,mount=/data}',
  );
  assert.equal(buildMetric('net.rx_bps', { device: 'eth0' }), 'net.rx_bps{device=eth0}');
  assert.equal(buildMetric('gpu.util', { index: 0 }), 'gpu.util{index=0}');
  assert.equal(buildMetric('cpu.core.usage', { core: 3 }), 'cpu.core.usage{core=3}');
  // ✅ R5：GPU 序号必须是**维度**而不是基名里的点号段（`gpu.0.util` 丢失维度语义、且没法按维度过滤）
  assert.equal(buildMetric('gpu.util', { index: 0 }), 'gpu.util{index=0}');
  assert.equal(parseMetric('gpu.util{index=0}').labels.index, '0');
});

test('无维度时不得带花括号', () => {
  assert.equal(buildMetric('cpu.usage'), 'cpu.usage');
  assert.equal(buildMetric('cpu.usage', {}), 'cpu.usage');
  assert.equal(isValidMetricName('cpu.usage{}'), false);
});

test('维度按**键名字母序**升序拼接：入参顺序不影响全名（保证一序列一写法）', () => {
  const a = buildMetric('disk.used_pct', { mount: '/data', device: 'sda1' });
  const b = buildMetric('disk.used_pct', { device: 'sda1', mount: '/data' });
  assert.equal(a, b);
  assert.equal(a, 'disk.used_pct{device=sda1,mount=/data}');

  assert.equal(buildMetric('x.y', { b: '2', a: '1' }), 'x.y{a=1,b=2}');
  // 维度键只允许小写，`C` 必须被拒绝
  assert.throws(() => buildMetric('x.y', { C: '3' }), MetricNameError);
});

test('转义：% { } = , 与空白必须百分号编码（% 一起编码才保证单射）', () => {
  assert.equal(escapeLabelValue('a,b'), 'a%2Cb');
  assert.equal(escapeLabelValue('a=b'), 'a%3Db');
  assert.equal(escapeLabelValue('{x}'), '%7Bx%7D');
  assert.equal(escapeLabelValue('50%'), '50%25');
  assert.equal(escapeLabelValue('/data disk'), '/data%20disk');
  assert.equal(escapeLabelValue('a\tb'), 'a%09b');
  assert.equal(escapeLabelValue('a\nb'), 'a%0Ab');

  // ⚠️ 单射性验证：`%` 不转义时这两组会撞成同一条序列名
  const raw = buildMetric('disk.used_pct', { mount: 'a,b' });
  const looksEncoded = buildMetric('disk.used_pct', { mount: 'a%2Cb' });
  assert.equal(raw, 'disk.used_pct{mount=a%2Cb}');
  assert.equal(looksEncoded, 'disk.used_pct{mount=a%252Cb}');
  assert.notEqual(raw, looksEncoded);
});

test('免转义字符保留原样（可读性）', () => {
  assert.equal(buildMetric('net.rx_bps', { device: 'eth0.100' }), 'net.rx_bps{device=eth0.100}');
  assert.equal(buildMetric('disk.used_pct', { mount: '/mnt/data-1' }), 'disk.used_pct{mount=/mnt/data-1}');
  assert.equal(buildMetric('x.y', { v: 'a@b+c:d_e' }), 'x.y{v=a@b+c:d_e}');
});

test('转义/反转义往返一致（含非 ASCII）', () => {
  for (const value of ['/', '/data', 'a,b=c{d}%e f', '数据盘', '/挂载 点/1', 'a\tb']) {
    assert.equal(unescapeLabelValue(escapeLabelValue(value)), value, value);
  }
});

test('parseMetric 反解基名与维度', () => {
  assert.deepEqual(parseMetric('cpu.usage'), {
    base: 'cpu.usage',
    labels: {},
    full: 'cpu.usage',
    hasDimensions: false,
  });
  assert.deepEqual(parseMetric('disk.used_pct{device=sda1,mount=/data}'), {
    base: 'disk.used_pct',
    labels: { device: 'sda1', mount: '/data' },
    full: 'disk.used_pct{device=sda1,mount=/data}',
    hasDimensions: true,
  });
  // 往返
  const full = buildMetric('disk.used_pct', { mount: '/data 盘', device: 'sda1' });
  assert.deepEqual(parseMetric(full).labels, { mount: '/data 盘', device: 'sda1' });
});

test('非法输入被拒绝', () => {
  for (const bad of [
    () => buildMetric('', {}),
    () => buildMetric('CPU.usage', {}),
    () => buildMetric('cpu usage', {}),
    () => buildMetric('cpu..usage', {}),
    () => buildMetric('cpu.usage', { Mount: '/' }), // 维度键必须小写
    () => buildMetric('cpu.usage', { mount: '' }), // 空值会产生 `{k=}`
    () => buildMetric('cpu.usage', { mount: null }),
    () => buildMetric('cpu.usage', ['/']), // labels 必须是对象
    () => buildMetric('cpu.usage', { base: '/' }), // 保留键
    () => parseMetric(''),
    () => parseMetric('cpu.usage{}'),
    () => parseMetric('CPU.usage'),
    () => parseMetric('cpu.usage{mount=/},{'),
  ]) {
    assert.throws(bad, MetricNameError);
  }
});

test(`全名长度上限 ${METRIC_NAME_MAX_LENGTH}：超限必须拒绝（防异常挂载点撑爆索引）`, () => {
  const longMount = `/${'x'.repeat(190)}`;
  assert.throws(() => buildMetric('disk.used_pct', { mount: longMount }), MetricNameError);

  // 恰好 200 字符应通过
  const base = 'disk.used_pct';
  const fill = 200 - base.length - '{mount=}'.length;
  const exact = buildMetric(base, { mount: 'y'.repeat(fill) });
  assert.equal(exact.length, 200);
  assert.equal(isValidMetricName(exact), true);
});

test('buildMetric 的产出必须被库层校验器接受（SQL 镜像）', () => {
  const cases = [
    buildMetric('cpu.usage'),
    buildMetric('cpu.core.usage', { core: 0 }),
    buildMetric('mem.used_pct'),
    buildMetric('disk.used_pct', { mount: '/' }),
    buildMetric('disk.used_pct', { device: 'sda1', mount: '/data' }),
    buildMetric('disk.latency_ms', { device: 'nvme0n1p1', mount: '/var/lib/docker' }),
    buildMetric('net.rx_bps', { device: 'eth0' }),
    buildMetric('net.err', { device: 'br-1a2b3c' }),
    buildMetric('gpu.util', { index: 0 }),
    buildMetric('process.count'),
    // 含转义字符的维度值
    buildMetric('disk.used_pct', { mount: '/data,a=b' }),
    buildMetric('disk.used_pct', { mount: '/data 空间' }),
    buildMetric('x.y', { v: '50%used' }),
    buildMetric('x.y', { v: '/mnt/数据' }),
  ];
  for (const name of cases) {
    assert.ok(sqlAccepts(name), `SQL 校验器拒绝了 buildMetric 的产出：${name}`);
  }

  // 反向：镜像也必须拒绝明显畸形名（说明镜像本身有效）
  for (const bad of ['CPU.usage', 'cpu.usage{}', 'cpu.usage{mount=}', 'cpu usage', '', 'cpu.usage{a=1,}']) {
    assert.equal(sqlAccepts(bad), false, `镜像不应接受：${bad}`);
  }
});

test('已知指标清单与文档 §5.7.2 表格一致且自洽', () => {
  for (const [base, meta] of Object.entries(KNOWN_BASE_METRICS)) {
    assert.ok(isKnownBaseMetric(base));
    assert.equal(typeof meta.unit, 'string');
    assert.ok(Array.isArray(meta.dims));
    // 基名本身合法，且带维度时能拼出合法全名
    assert.ok(isValidMetricName(base), base);
    const labels = Object.fromEntries(meta.dims.map((d, i) => [d, i === 0 ? '/' : `v${i}`]));
    assert.ok(isValidMetricName(buildMetric(base, labels)), base);
  }
  assert.equal(unitOf('disk.used_pct'), '%');
  assert.equal(unitOf('net.rx_bps'), 'bytes/s');
  assert.equal(unitOf('未登记的指标'), ''); // ⛔ 不抛异常：新指标不应打断既有链路
});

test('✅ R8：规则的基名/全名两种引用语义', () => {
  assert.equal(classifyMetricRef('disk.used_pct'), 'base');
  assert.equal(classifyMetricRef('disk.used_pct{mount=/data}'), 'exact');
  assert.throws(() => classifyMetricRef('Disk.Used_Pct'), MetricNameError);
  assert.throws(() => classifyMetricRef('disk.used_pct{}'), MetricNameError);

  const series = [
    buildMetric('disk.used_pct', { mount: '/' }),
    buildMetric('disk.used_pct', { mount: '/data' }),
    buildMetric('mem.used_pct'),
  ];

  // 基名 → 逐维度序列分别判定
  assert.deepEqual(
    series.filter((s) => metricRefMatches('disk.used_pct', s)),
    ['disk.used_pct{mount=/}', 'disk.used_pct{mount=/data}'],
  );
  // 全名 → 只判该单序列
  assert.deepEqual(
    series.filter((s) => metricRefMatches('disk.used_pct{mount=/data}', s)),
    ['disk.used_pct{mount=/data}'],
  );
  assert.deepEqual(series.filter((s) => metricRefMatches('mem.used_pct', s)), ['mem.used_pct']);
});

// ---------------------------------------------------------------------------
// 共享向量：与 Agent(Go) 的 internal/metric/metric_test.go 消费**同一份文件**
//
// docs/database.md §5.7.2 要求「两端各提供 buildMetric/parseMetric，必须同源实现 + 共用测试向量」。
// 单侧自测证明不了「两端拼法一致」——只有共用向量能证明。
// 文件放在仓库根的 contracts/：它是**接口定义**而不是测试代码，两端测试读同一份（见 contracts/README.md）。
// ---------------------------------------------------------------------------

const SHARED_VECTORS = JSON.parse(
  readFileSync(new URL('../../contracts/metric-names.json', import.meta.url), 'utf8'),
);

/**
 * 向量里的维度值有两种写法：字符串，或 `{ repeat, count }`。
 * 后者用于**精确**构造长度边界（手写 179 个字符一定会数错）。
 */
function materializeLabels(labels) {
  const out = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    out[key] = typeof value === 'string' ? value : value.repeat.repeat(value.count);
  }
  return out;
}

test('共享向量：Go(Agent) 与 Node(中心) 必须拼出同一份全名', () => {
  assert.ok(Array.isArray(SHARED_VECTORS.cases) && SHARED_VECTORS.cases.length > 0, '向量文件为空');

  for (const c of SHARED_VECTORS.cases) {
    const got = buildMetric(c.base, materializeLabels(c.labels));
    if (c.full !== undefined) {
      assert.equal(got, c.full, `用例 ${c.name}：全名不一致`);
    }
    if (c.expectFullLength !== undefined) {
      assert.equal(got.length, c.expectFullLength, `用例 ${c.name}：全名长度不一致`);
    }
    assert.ok(got.length <= METRIC_NAME_MAX_LENGTH, `用例 ${c.name}：超过长度上限`);
  }
});

test('共享向量：非法用例两侧都必须拒绝', () => {
  assert.ok(Array.isArray(SHARED_VECTORS.invalid) && SHARED_VECTORS.invalid.length > 0, '向量文件为空');

  for (const c of SHARED_VECTORS.invalid) {
    assert.throws(
      () => buildMetric(c.base, materializeLabels(c.labels)),
      MetricNameError,
      `用例 ${c.name}：必须被拒绝`,
    );
  }
});
