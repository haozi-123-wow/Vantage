/**
 * Vantage · IP 文本规范化与分类
 *
 * 依据：docs/database.md §5.5（IP 出现区间「私网/回环/虚拟网卡在写入前过滤」）、§5.1（`last_ip`）
 *
 * 为什么单独成模块：规范化与分类被三处使用（IP 追踪、审计日志、将来的公开接口脱敏），
 * 分散实现会各自漏掉 `::ffff:` / zone id 这两种真实世界的写法。
 *
 * ⚠️ 与 §5.5「私网在写入前过滤」的口径差异（已登记为开放项 M-7）
 *   - 本实现过滤的是**语义上无意义**的地址：回环、链路本地、未指定、组播，以及非法地址；
 *   - **保留 RFC1918 / CGNAT / ULA 等私网地址**：设计明确支持「Agent 与中心在同一内网」
 *     （Agent 在主机直跑、中心在局域网），此时上报来源本来就永远是私网地址。
 *     一刀切过滤私网会让这类部署的 IP 历史**整表为空**、Flapping 永不生效 ——
 *     这比"多记几行"严重得多，是典型的静默失效。
 */

import net from 'node:net';

/** 地址分类（`trackable` = 值得记入 IP 历史） */
export const IP_CATEGORY = Object.freeze({
  trackable: 'trackable',
  loopback: 'loopback',
  linkLocal: 'link_local',
  unspecified: 'unspecified',
  multicast: 'multicast',
  invalid: 'invalid',
});

/**
 * 规范化 IP 文本。
 *
 * 🔑 两个真实世界的坑，不处理会让同一个地址在不同批次里「看起来变了」：
 *  1. Node 的双栈监听会把 IPv4 连接报成 **IPv4-mapped IPv6**（`::ffff:10.0.0.5`），
 *     而同一条链路经反代透传后可能又是 `10.0.0.5` → 每次上报都判成 IP 变化；
 *  2. 链路本地地址可能带 zone id（`fe80::1%eth0`），PostgreSQL 的 INET 不接受该写法（22P02）。
 *
 * ⛔ 返回值只做「同源同写法」的归一，**不做** IPv6 缩写/补零（那是 INET 类型在库里的职责，
 *    见 agent.repo.js::lockAgentForReport 的注释）；因此比较 IP 一律走 SQL 的 `IS DISTINCT FROM`。
 *
 * @param {unknown} raw
 * @returns {string|null} 规范化后的地址；空/非法返回 null
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (value === '') return null;

  const zoneAt = value.indexOf('%');
  if (zoneAt !== -1) value = value.slice(0, zoneAt);

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) value = mapped[1];

  return net.isIP(value) === 0 ? null : value;
}

/** 地址分类：决定「是否值得记入 IP 历史」。私网地址归入 `trackable`，理由见文件头。 */
export function classifyIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return IP_CATEGORY.loopback;
    if (a === 0) return IP_CATEGORY.unspecified;
    if (a === 169 && b === 254) return IP_CATEGORY.linkLocal;
    if (a >= 224) return IP_CATEGORY.multicast; // 224–239 组播，240+ 保留/广播
    return IP_CATEGORY.trackable;
  }
  if (version === 6) {
    if (ip === '::1') return IP_CATEGORY.loopback;
    if (ip === '::') return IP_CATEGORY.unspecified;
    if (/^fe[89ab]/.test(ip)) return IP_CATEGORY.linkLocal; // fe80::/10
    if (/^ff/.test(ip)) return IP_CATEGORY.multicast; // ff00::/8
    return IP_CATEGORY.trackable;
  }
  return IP_CATEGORY.invalid;
}

/** 规范 + 判断是否值得入库（失败时返回分类，便于日志解释"为什么没记"） */
export function prepareIp(raw) {
  const ip = normalizeIp(raw);
  const category = ip ? classifyIp(ip) : IP_CATEGORY.invalid;
  return { ip, category, trackable: category === IP_CATEGORY.trackable };
}
