/**
 * IP 规范化与分类单元测试
 *
 * 依据：docs/database.md §5.5（IP 区间表）、§5.1（`last_ip`/`reported_ip`）、
 *       Vantage-DESIGN-v0.7.md §8（IP 变化与防抖）
 *
 * 这些用例存在的理由：`normalizeIp` 漏掉 IPv4-mapped 前缀时，
 * 同一台机器会在 `::ffff:10.0.0.5` 与 `10.0.0.5` 之间被反复判成"IP 变化"，
 * 于是 10 分钟内必然触发 Flapping 并暂停真实告警 —— 表面症状是"IP 告警不工作了"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { IP_CATEGORY, classifyIp, normalizeIp, prepareIp } from '../src/utils/ip.js';

test('IPv4-mapped IPv6 归一成 IPv4（Node 双栈监听的真实报法）', () => {
  assert.equal(normalizeIp('::ffff:10.0.0.5'), '10.0.0.5');
  assert.equal(normalizeIp('::FFFF:203.0.113.9'), '203.0.113.9');
});

test('zone id 被剥离（fe80::1%eth0 会让 PostgreSQL 的 INET 报 22P02）', () => {
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp('127.0.0.1%lo'), '127.0.0.1');
});

test('大小写归一 + 首尾空白被去掉', () => {
  assert.equal(normalizeIp('  2001:DB8::1  '), '2001:db8::1');
});

test('非法输入返回 null（不抛异常，让调用方决定记不记）', () => {
  for (const bad of ['', '   ', 'not-an-ip', '999.1.1.1', '10.0.0', null, undefined, 42, {}]) {
    assert.equal(normalizeIp(bad), null, `应拒绝 ${String(bad)}`);
  }
});

test('分类：只有语义上无意义的地址被排除，⛔ 私网必须保留', () => {
  assert.equal(classifyIp('127.0.0.1'), IP_CATEGORY.loopback);
  assert.equal(classifyIp('::1'), IP_CATEGORY.loopback);
  assert.equal(classifyIp('169.254.1.1'), IP_CATEGORY.linkLocal);
  assert.equal(classifyIp('fe80::1'), IP_CATEGORY.linkLocal);
  assert.equal(classifyIp('0.0.0.0'), IP_CATEGORY.unspecified);
  assert.equal(classifyIp('::'), IP_CATEGORY.unspecified);
  assert.equal(classifyIp('224.0.0.1'), IP_CATEGORY.multicast);
  assert.equal(classifyIp('ff02::1'), IP_CATEGORY.multicast);
  assert.equal(classifyIp('nope'), IP_CATEGORY.invalid);

  // 私网与公网都是 trackable：设计支持「Agent 与中心同处内网」的部署，
  // 一刀切过滤私网会让这类部署的 IP 历史整表为空（开放项 M-7）
  for (const good of ['10.0.0.5', '172.16.3.4', '192.168.1.10', '100.64.0.1', '203.0.113.9', '2001:db8::1', 'fd00::1']) {
    assert.equal(classifyIp(good), IP_CATEGORY.trackable, `${good} 应可追踪`);
  }
});

test('prepareIp 一次给出「归一值 + 分类 + 是否可入库」', () => {
  assert.deepEqual(prepareIp('::ffff:192.168.1.10'), {
    ip: '192.168.1.10',
    category: IP_CATEGORY.trackable,
    trackable: true,
  });
  assert.deepEqual(prepareIp('127.0.0.1'), {
    ip: '127.0.0.1',
    category: IP_CATEGORY.loopback,
    trackable: false,
  });
  assert.deepEqual(prepareIp(undefined), {
    ip: null,
    category: IP_CATEGORY.invalid,
    trackable: false,
  });
});
