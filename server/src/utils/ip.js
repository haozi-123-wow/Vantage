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

/**
 * 是否是**私网/保留**地址（公开接口脱敏用，见文件头「将来的公开接口脱敏」）。
 *
 * 🔑 公开侧为什么要区分私网与公网（而不是一刀切隐藏所有 IP）：
 *  - 私网地址（RFC1918 / CGNAT / ULA / 回环 / 链路本地）**直接暴露内网拓扑**——`10.0.2.15`
 *    能让人推断出你的网段划分与机器角色，是 `docs/api.md` §3.1 明令禁止的内容；
 *  - 公网地址（如探活目标 `223.5.5.5`、`1.1.1.1`）不含任何内部信息 —— 任何人 DNS 解析一下
 *    域名也能拿到同样的事实，隐藏它只会让公开页失去可读性（"目标：—"）。
 *  ⛔ 所以口径是「私网泛化、公网保留」，而不是"把所有 IP 都抹掉"。
 *
 * ⚠️ 不在此列但同样敏感的：**端口号与路径**（`http://10.0.0.5:8080/admin/health`）。
 *    它们由调用方剥离（见 `services/status.service.js` 的 `desensitizeTarget()`），本函数只管地址。
 *
 * @param {unknown} value 已规范化的地址文本（`normalizeIp()` 的输出）
 * @returns {boolean} 非 IP / 非法地址一律返回 `true`（**默认按敏感处理**，宁可少展示）
 */
export function isPrivateAddress(value) {
  const ip = normalizeIp(value);
  if (ip === null) return true; // 不是 IP（或非法）→ 调用方应按"不确定 = 敏感"处理

  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10（CGNAT）
    if (a === 127 || a === 0) return true; // 回环 / 未指定
    if (a === 169 && b === 254) return true; // 链路本地
    if (a >= 224) return true; // 组播 / 保留
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 链路本地
  if (/^f[cd]/.test(lower)) return true; // fc00::/7（ULA）
  if (/^ff/.test(lower)) return true; // ff00::/8 组播
  return false;
}
