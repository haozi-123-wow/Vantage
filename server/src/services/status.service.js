/**
 * Vantage · 当前状态推导服务（`/api/public/*` 与 `/api/v1/hosts` 的**唯一**实现）
 *
 * 依据：docs/server-status-api.md（本模块的实施方案与全部决策 D1–D8）、
 *       docs/api.md §3.1/§3.2（公开契约）、§4.2（私有契约）、§1.2 ③（`{ items, next_cursor }`）、
 *       docs/frontend.md §4.3（主机表格：相对时间 + `title` 绝对时间、`—` 表示无数据）
 *
 * 🔑 为什么公开与私有必须共用本文件
 *
 *   两边读的是**同一套数据、同一份推导**（在线判定 / snapshot 计算 / 探活计数），只有**可见字段集**不同。
 *   若各写一份，迟早出现「公开页说在线、面板说离线」——那种不一致没有排查起点，因为两处都"看起来对"。
 *   本文件的分工是：**推导一次 → 两种投影**（`toPublicHost()` / `toPanelHost()`）。
 *
 * 🔑 三条硬约束（方案 §6，写代码时最容易踩的三条）
 *
 *  1. **时间一律来自数据库 `now()`**：在线判定在 SQL 里用 `now()`（agent.repo.js），
 *     `updated_at` 也取自同一查询返回的 `server_now`。⛔ 不用 `Date.now()` ——
 *     多实例部署下进程时间不同步会让"同一台机"在不同实例上得出不同的状态。
 *  2. **`null` 就是 `null`**（方案 §2.2）：没有数据 ⛔ 不补 `0`、不补 `""`、不补 `"—"`
 *     （`"—"` 是前端的展示职责）。把"失联"显示成"CPU 0%"是本项目最不能犯的错。
 *  3. **⛔ 绝不 spread 数据行**（方案 §2.6）：公开投影逐字段写入白名单。将来 `agents` 加一列
 *     （比如又一个 IP 变体）时，spread 写法会**静默泄漏**，白名单写法则必须显式加一行。
 *     注意：路由层的 response schema（`additionalProperties: false`）是**第二道防线**，
 *     ⛔ 不能替代这一层——它只保证"响应里没有"，不保证"推导函数没算出来"。
 *
 * ⚠️ 本文件**只读**：⛔ 不写 `agents.status`（那是 `offline.service.js` 的职责）、
 *    ⛔ 不写审计（`audit.repo.js` L7-10：审计只记「异常与人为操作」，正常读不记）。
 */

import {
  countAgentsByEffectiveStatus,
  countFiringAlertsBySeverity,
  findAgentStatusById,
  findAgentStatusBySlug,
  listAgentsForStatus,
  readDbNow,
} from '../repositories/agent.repo.js';
import { listIpChangeEvents, listIpIntervals } from '../repositories/ipTrack.repo.js';
import {
  selectCurrentSeriesForAgent,
  selectLatestProcessSnapshot,
  selectLatestSeriesForAgents,
} from '../repositories/metric.repo.js';
import { countLatestProbeResults, selectLatestProbeRound, selectProbeHistory } from '../repositories/probe.repo.js';
import { isPrivateAddress, normalizeIp } from '../utils/ip.js';
import { parseMetric } from '../utils/metric.js';
import { keys } from '../utils/redisKeys.js';
import { offlineThresholdS } from './offline.service.js';

/**
 * 「当前值」的观测窗口（秒）：5 分钟 = 20 × 30s 上报周期。
 *
 * 🔑 为什么必须有窗口（方案 §2.2）：`metrics_raw` 保留 15 天且按天分区，无窗口的「取最新」
 *    会退化成对所有分区的扫描；窗口让查询只碰最近 1–2 个分区。
 * ⚠️ 窗口**外**的旧序列一律视为"没有数据"（`snapshot` 全 `null`），而不是返回 5 天前的旧数值 ——
 *    「没有数据 ≠ 0」的另一半是「没有数据 ≠ 旧值」。
 */
export const OBSERVATION_WINDOW_S = 300;

/**
 * 公开列表单次返回的主机数上限。
 * 公开端点**不接受查询参数**（docs/api.md §3.2：四个公开端点都无请求参数），
 * 因此这里是一个固定的工程上限而不是分页参数：设计余量「几十台」（frontend.md §10）远小于它。
 */
export const PUBLIC_HOST_LIMIT = 200;

/** 私有列表的分页默认值与上限（✅ docs/api.md §1.2 ③：默认 20 / 上限 200） */
export const PANEL_LIMIT_DEFAULT = 20;
export const PANEL_LIMIT_MAX = 200;

/** 探活历史的窗口默认值与上限（`GET /api/v1/hosts/{id}/probes`） */
export const PROBE_HISTORY_DEFAULT_SPAN_S = 24 * 3600;
export const PROBE_HISTORY_MAX_SPAN_S = 30 * 86400;
/** 每个 probe 最多返回多少个历史点（取**最近**的；可用率仍按整个窗口算，见 probe.repo.js） */
export const PROBE_HISTORY_MAX_POINTS = 500;

/** IP 历史的条数上限（区间与事件各自适用） */
export const IP_HISTORY_DEFAULT_LIMIT = 100;
export const IP_HISTORY_MAX_LIMIT = 500;

/** 公开探活概览的单次条数上限（超出时响应里 `truncated=true`，⛔ 不静默截断） */
export const PUBLIC_PROBE_MAX_ITEMS = 500;

/** 相对时间分级阈值（秒） */
const MINUTE_S = 60;
const HOUR_S = 3600;
const DAY_S = 86400;
const MONTH_S = 2592000; // 30 天

// -----------------------------------------------------------------------------
// 纯函数：投影与计算（全部可单测，⛔ 不依赖 DB/Redis）
// -----------------------------------------------------------------------------

/** 保留 1 位小数（⛔ 不改变"有值/无值"的语义：`null` 进 `null` 出） */
function round1(value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

function toDate(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** RFC3339（UTC，毫秒精度）；空值 → `null` */
function isoOrNull(value) {
  return toDate(value)?.toISOString() ?? null;
}

/**
 * **分钟级取整**后的 RFC3339（公开侧专用）。
 *
 * 🔑 为什么公开侧不精确到秒（方案 §2.3、docs/api.md §3.1）：秒级时间戳 + 轮询可以把公开页
 *    变成「主机上下线行为指纹」分析器（谁几点开机、多久重启一次）。分钟级足够人读，却让
 *    这种分析失去精度。
 * ⚠️ **私有接口不做这个取整**（docs/api.md §4.2 明确 `last_seen_at` 为**精确值**）：
 *    那是运维自己看的排障数据，取整只会让人算不出"到底晚了多少秒"。
 */
function isoFloorToMinute(value) {
  const date = toDate(value);
  if (!date) return null;
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000).toISOString();
}

/** 无数据时的展示值：⛔ 不是 `0`、不是 `"—"`（方案 §2.2） */
function optionalNumber(value) {
  return value === null || value === undefined ? null : round1(value);
}

function optionalText(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 相对化描述（方案 §2.3 的分级规则）。
 *  ⛔ 公开侧与私有侧**共用**本函数：同一台机在两边的文案必须一致。
 *  `disabled` 的机器没有"多久没见"的概念（人工状态），由调用方传 `null`。
 */
export function lastSeenAgo(secondsAgo) {
  if (secondsAgo === null || secondsAgo === undefined) return null;
  const s = Math.max(0, Math.floor(Number(secondsAgo)));
  if (!Number.isFinite(s)) return null;
  if (s < MINUTE_S) return '刚刚';
  if (s < HOUR_S) return `${Math.floor(s / MINUTE_S)} 分钟前`;
  if (s < DAY_S) return `${Math.floor(s / HOUR_S)} 小时前`;
  if (s < MONTH_S) return `${Math.floor(s / DAY_S)} 天前`;
  return '超过 30 天';
}

/** 距上次上报的秒数（用**数据库时钟**，见文件头约束 1） */
function secondsSince(lastSeenAt, nowMs) {
  const date = toDate(lastSeenAt);
  if (!date) return null;
  return Math.floor((nowMs - date.getTime()) / 1000);
}

/** `host_info.boot_time` → 运行时长（秒）；缺失/非法/未来时间 → `null`（方案 §3.1：字段缺省） */
function uptimeSeconds(hostInfo, nowMs) {
  const boot = hostInfo?.boot_time;
  if (typeof boot !== 'number' || !Number.isFinite(boot) || boot <= 0) return null;
  const seconds = Math.floor(nowMs / 1000) - boot;
  return seconds >= 0 ? seconds : null;
}

/**
 * 由「每序列最新值」构造 `snapshot`（方案 §2.2 逐字段口径）。
 *
 * @param {Array<{ slot: string, value: number }>} series 同一台主机的全部序列（含维度展开）
 */
export function buildSnapshot(series) {
  /** slot → number[]（同一槽位可能有多行：磁盘各挂载点、各网卡、多张 GPU） */
  const buckets = new Map();
  for (const point of series ?? []) {
    const value = Number(point?.value);
    // NaN / ±Infinity 已被迁移 0004 的 CHECK 拒绝；真出现时按"没有数据"处理，
    // ⛔ 不让一个坏点把整台机的 snapshot 变成 null（其余槽位仍然有效）。
    if (!Number.isFinite(value) || typeof point?.slot !== 'string') continue;
    const list = buckets.get(point.slot);
    if (list) list.push(value);
    else buckets.set(point.slot, [value]);
  }

  const pick = (slot, reduce) => {
    const list = buckets.get(slot);
    if (!list || list.length === 0) return null;
    return round1(list.reduce(reduce));
  };
  const maxOf = (slot) => pick(slot, (a, b) => Math.max(a, b));
  const sumOf = (slot) => pick(slot, (a, b) => a + b);

  // mem_pct：优先中心已算好的 mem.used_pct；缺失时用 mem.used / mem.total 兜底
  let memPct = maxOf('mem_pct');
  if (memPct === null) {
    const used = buckets.get('mem_used')?.[0];
    const total = buckets.get('mem_total')?.[0];
    if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
      memPct = round1((used / total) * 100);
    }
  }

  const snapshot = {
    cpu_pct: maxOf('cpu_pct'),
    mem_pct: memPct,
    disk_pct: maxOf('disk_pct'), // MAX = 「磁盘最高占用%」（与面板列名一致）
    net_rx_bps: sumOf('net_rx_bps'), // SUM = 各网卡合计（单看一块网卡会系统性低估）
    net_tx_bps: sumOf('net_tx_bps'),
  };
  // ⚠️ GPU：**无序列时整个字段缺省**（不是 `null`）—— 设计稿要求"capabilities.gpu=false ⇒ GPU 图整块隐藏"
  if (buckets.has('gpu_pct')) snapshot.gpu_pct = maxOf('gpu_pct');
  return snapshot;
}

/** 显示名：`COALESCE(NULLIF(display_name,''), name)`（决策 #21；⛔ 空串不算"有显示名"） */
export function displayNameOf(row) {
  const display = typeof row?.display_name === 'string' ? row.display_name.trim() : '';
  return display.length > 0 ? display : String(row?.name ?? '');
}

/**
 * 公开投影：**白名单**逐字段写入（方案 §2.6）。
 * ⛔ 每新增一个字段都必须是"有意为之"，并在 `test/status.service.test.js` 的
 *    「全字段填满的 agent」用例里确认没有漏出 IP / UUID / 设备名。
 */
export function toPublicHost(row, { snapshot, probes, nowMs }) {
  const host = {
    slug: row.public_slug, // ⛔ 不是内部 UUID（库约束保证 UUID 不可能满足 slug 格式）
    name: displayNameOf(row),
    status: row.effective_status,
    snapshot,
    probes,
    last_seen_ago: row.effective_status === 'disabled' ? null : lastSeenAgo(secondsSince(row.last_seen_at, nowMs)),
    last_seen_at: isoFloorToMinute(row.last_seen_at),
  };

  // 缺失即**字段缺省**（方案 §6.5）：与 `PublicHost.os?` / `uptime?` 的 TS 可选标记一致
  const os = optionalText(row.host_info?.os);
  if (os !== null) host.os = os;
  const uptime = uptimeSeconds(row.host_info, nowMs);
  if (uptime !== null) host.uptime = uptime;
  return host;
}

/**
 * 私有投影：公开字段的**超集** + 运维字段（docs/api.md §4.2）。
 * ⚠️ `last_seen_at` 在这里是**精确值**（见 `isoFloorToMinute` 的说明）；
 *    `os`/`arch`/`uptime` 用显式 `null` 而不是"缺省"——私有契约允许 null，
 *    且面板表格需要稳定的列集合（§6.5 的"缺省"要求只针对公开侧）。
 */
export function toPanelHost(row, { snapshot, probes, nowMs }) {
  return {
    // --- 公开字段（同一套名字与语义，便于两边复用同一张 HostTable）---
    slug: row.public_slug,
    name: displayNameOf(row),
    status: row.effective_status,
    os: optionalText(row.host_info?.os),
    uptime: uptimeSeconds(row.host_info, nowMs),
    snapshot,
    probes,
    last_seen_ago: row.effective_status === 'disabled' ? null : lastSeenAgo(secondsSince(row.last_seen_at, nowMs)),
    last_seen_at: isoOrNull(row.last_seen_at),
    // --- 仅私有可见 ---
    id: row.id,
    display_name: optionalText(row.display_name),
    tags: Array.isArray(row.tags) ? row.tags : [],
    arch: optionalText(row.host_info?.arch),
    last_ip: optionalText(row.last_ip),
    reported_ip: optionalText(row.reported_ip),
    // 符号口径：**负值 = Agent 慢**（docs/api.md §4.2、heartbeat.service.js）
    clock_drift_ms: optionalNumber(row.clock_drift_ms),
    ip_flapping: row.ip_flapping === true,
    flapping_since: isoOrNull(row.flapping_since),
    active_alerts: Number(row.active_alerts) || 0,
  };
}

// -----------------------------------------------------------------------------
// 取数与组装
// -----------------------------------------------------------------------------

/**
 * 响应级缓存（✅ 方案 §2.4 / 决策 D4）。
 *
 * 🔑 三条口径与 `services/settings.service.js` 完全一致（⛔ 不要在这里另立一套）：
 *  - 缓存**读失败** → 按未命中处理，直接查库（缓存挂掉不得让公开页 500）；
 *  - 缓存**写失败** → 只 warn，响应照常返回（缓存是优化，不是依赖）；
 *  - 缓存内容**损坏** → 按未命中处理。
 * ⚠️ `ttlS <= 0` = 关闭缓存（`PUBLIC_CACHE_TTL_S=0`），此时一条 Redis 命令都不发。
 */
async function withResponseCache(redis, key, ttlS, logger, produce) {
  if (!(ttlS > 0)) return produce();

  const cached = await redis.get(key).catch((err) => {
    logger?.warn?.({ err, key }, '公开状态缓存读取失败（按未命中处理，直接查库）');
    return null;
  });
  if (typeof cached === 'string' && cached.length > 0) {
    try {
      return JSON.parse(cached);
    } catch (err) {
      logger?.warn?.({ err, key }, '公开状态缓存内容损坏（按未命中处理）');
    }
  }

  const value = await produce();
  await redis
    .set(key, JSON.stringify(value), 'EX', ttlS)
    .catch((err) => logger?.warn?.({ err, key }, '公开状态缓存写入失败（下次再试）'));
  return value;
}

/**
 * 一次取回「主机行 + snapshot + 探活计数」，并把结果按 `agent_id` 归并。
 *
 * ⚠️ 三条 SQL（agents / metrics / probes）都是**整页一次**，⛔ 绝不按主机循环（方案 §4.2 的 N+1 禁令）。
 * ⚠️ 空页时**不发**后两条查询（`agentIds.length === 0`），并单独取一次 DB 时钟 —— 这种情形只出现在
 *    "一台主机都没有"的初始部署上，代价可以忽略。
 */
async function loadStatusRows(pool, { thresholdS, filters = {}, logger }) {
  const rows = await listAgentsForStatus(pool, { thresholdS, ...filters });
  const serverNow = toDate(rows[0]?.server_now) ?? toDate(await readDbNow(pool)) ?? new Date();
  const nowMs = serverNow.getTime();

  const agentIds = rows.map((row) => row.id);
  let snapshotSeries = [];
  let probeRows = [];
  if (agentIds.length > 0) {
    const since = new Date(nowMs - OBSERVATION_WINDOW_S * 1000);
    [snapshotSeries, probeRows] = await Promise.all([
      selectLatestSeriesForAgents(pool, { agentIds, since }),
      countLatestProbeResults(pool, { agentIds, since }),
    ]);
  }

  const seriesByAgent = new Map();
  for (const point of snapshotSeries) {
    const list = seriesByAgent.get(point.agent_id);
    if (list) list.push(point);
    else seriesByAgent.set(point.agent_id, [point]);
  }
  const probesByAgent = new Map(probeRows.map((row) => [row.agent_id, { up: Number(row.up) || 0, down: Number(row.down) || 0 }]));

  logger?.debug?.({ agents: agentIds.length, series: snapshotSeries.length }, '状态接口取数完成');

  return {
    serverNow,
    rows: rows.map((row) => ({
      row,
      nowMs,
      snapshot: buildSnapshot(seriesByAgent.get(row.id) ?? []),
      // 从未探活 / 窗口外 → `{ up: 0, down: 0 }`（⛔ 不是 null）
      probes: probesByAgent.get(row.id) ?? { up: 0, down: 0 },
    })),
  };
}

/**
 * `GET /api/public/hosts` —— 公开主机列表（免登录、按 IP 限流、可被 `public_view.enabled` 关闭）。
 *
 * ⚠️ 顺序由路由层保证：`publicRateLimit` → `publicViewGuard` → 本函数（缓存 → 查询）。
 * @returns {Promise<{ items: object[], next_cursor: null, updated_at: string }>}
 */
export async function listPublicHosts({ pool, redis, config, logger }) {
  const ttlS = config.rateLimit.publicCacheTtlS;
  return withResponseCache(redis, keys.snapshotPublicHosts, ttlS, logger, async () => {
    const { rows, serverNow } = await loadStatusRows(pool, {
      thresholdS: offlineThresholdS(config),
      // ⛔ 公开列表**不出现** `disabled`（D-禁：人工禁用是内部运营信息）；
      //    `summary.disabled` 仍然计数，保证 total = online + offline + disabled。
      filters: { includeDisabled: false, limit: PUBLIC_HOST_LIMIT },
      logger,
    });

    return {
      items: rows.map(({ row, snapshot, probes, nowMs }) => toPublicHost(row, { snapshot, probes, nowMs })),
      // ✅ 形状合规（docs/api.md §1.2 ③）但**恒为 null**：本接口没有下一页（方案 §2.8）。
      // ⛔ 绝不返回假游标——那会让前端以为要翻页，进而用错参数反复请求。
      next_cursor: null,
      updated_at: serverNow.toISOString(),
    };
  });
}

/**
 * `GET /api/public/summary` —— 公开汇总计数。
 *
 * 🔑 与 `/hosts` **同一个交付块、同一份推导**：它读的 `countAgentsByEffectiveStatus()`
 *    与列表共用 `EFFECTIVE_STATUS_SQL`，所以"列表 3 台在线、顶栏说 4 台"不可能发生。
 * @returns {Promise<{ total: number, online: number, offline: number, disabled: number, alerts: object, updated_at: string }>}
 */
export async function getPublicSummary({ pool, redis, config, logger }) {
  const ttlS = config.rateLimit.publicCacheTtlS;
  return withResponseCache(redis, keys.snapshotPublicSummary, ttlS, logger, async () => {
    // ✅ 与私有 `/api/v1/summary` 共用 `computeSummary()`：两个页面的数字不可能不一致
    const { at, ...rest } = await computeSummary(pool, offlineThresholdS(config));
    return { ...rest, updated_at: at.toISOString() };
  });
}

/**
 * `GET /api/v1/hosts` —— 私有主机列表（面板会话，三态受限由中间件负责）。
 *
 * ⚠️ **不做响应缓存**（D4 只给公开侧）：私有响应含 IP 与内部 UUID，
 *    缓存它会把"谁能看"的边界从"每个请求的会话"挪到"缓存键"，得不偿失。
 *
 * @param {object} input
 * @param {string|null} input.status 已校验的派生状态过滤
 * @param {string|null} input.tag
 * @param {string|null} input.q **原样**搜索文本（LIKE 转义由 agent.repo.js 负责，⛔ 调用方不要自己转）
 * @param {number} input.limit 已夹取到 `[1, PANEL_LIMIT_MAX]`
 */
export async function listPanelHosts({ pool, config, logger, status = null, tag = null, q = null, limit = PANEL_LIMIT_DEFAULT }) {
  const { rows, serverNow } = await loadStatusRows(pool, {
    thresholdS: offlineThresholdS(config),
    filters: { status, tag, q, limit, includeDisabled: true },
    logger,
  });

  return {
    items: rows.map(({ row, snapshot, probes, nowMs }) => toPanelHost(row, { snapshot, probes, nowMs })),
    next_cursor: null, // 同 §2.8：本期不做真游标（排序键是派生值，不满足 keyset 前提）
    updated_at: serverNow.toISOString(),
  };
}

// -----------------------------------------------------------------------------
// 公开：单机快照展开（`GET /api/public/hosts/{slug}/now`）
//
// 🔑 这一节的全部工作只有一件：**把维度取值泛化掉**。
//    `disk.used_pct{device=nvme0n1p2,mount=/data}` 里的 `nvme0n1p2` 与 `/data` 是**内部信息**
//    （能推断出你的磁盘型号与目录规划），而公开页只需要"磁盘 1 用了 61%"。
//    所以公开侧**一个指标名都不发**，改发带展示标签的数组 ——
//    这样即使将来有人给 `metrics_raw` 加了新维度（docker 容器名、挂载来源…），
//    它也不可能顺着"原样返回指标名"的路径漏出去（白名单式构造，方案 §2.6）。
// -----------------------------------------------------------------------------

/** 磁盘维度 → 公开字段名（基名白名单；⛔ 不在表内的基名一律不进响应） */
const DISK_FIELD_BY_BASE = Object.freeze({
  'disk.total': 'total_bytes',
  'disk.used': 'used_bytes',
  'disk.used_pct': 'used_pct',
  'disk.inode_used_pct': 'inode_used_pct',
  'disk.read_bps': 'read_bps',
  'disk.write_bps': 'write_bps',
  'disk.read_iops': 'read_iops',
  'disk.write_iops': 'write_iops',
  'disk.latency_ms': 'latency_ms',
});

const NET_FIELD_BY_BASE = Object.freeze({
  'net.rx_bps': 'rx_bps',
  'net.tx_bps': 'tx_bps',
  'net.rx_total': 'rx_total_bytes',
  'net.tx_total': 'tx_total_bytes',
  'net.conn_count': 'conn_count',
  'net.err': 'err',
  'net.drop': 'drop',
});

const GPU_FIELD_BY_BASE = Object.freeze({
  'gpu.util': 'util_pct',
  'gpu.mem_used': 'mem_used_bytes',
  'gpu.mem_total': 'mem_total_bytes',
  'gpu.temp': 'temp_c',
  'gpu.power': 'power_w',
});

/** CPU / 内存是**单序列**（无维度），直接一对一映射 */
const CPU_FIELD_BY_BASE = Object.freeze({
  'cpu.usage': 'usage_pct',
  'cpu.load1': 'load1',
  'cpu.load5': 'load5',
  'cpu.load15': 'load15',
  'cpu.ctx_switch': 'ctx_switch',
});

const MEM_FIELD_BY_BASE = Object.freeze({
  'mem.total': 'total_bytes',
  'mem.used': 'used_bytes',
  'mem.used_pct': 'used_pct',
  'mem.available': 'available_bytes',
  'mem.cached': 'cached_bytes',
  'mem.buffers': 'buffers_bytes',
});

/** 全 null 的记录（⛔ 不补 0：面板要靠 `null` 显示 `—`，而不是画一根贴地的线） */
function emptyRecord(fields) {
  const out = {};
  for (const field of fields) out[field] = null;
  return out;
}

/**
 * 把一组维度取值映射成**稳定**的展示标签（`磁盘 1` / `网卡 2`）。
 * 排序用**字典序**（不是 `localeCompare`）：同一批数据在任意实例、任意进程上都必须得到同一个编号，
 * 否则两台负载均衡后的机器会显示不同的"磁盘 1"。
 */
function labelIndexOf(values) {
  const sorted = [...new Set(values)].sort();
  return new Map(sorted.map((value, index) => [value, index + 1]));
}

/**
 * 由「该机全部序列的当前值」构造公开展开块（分区 / 网卡 / GPU 数组 + CPU / 内存汇总）。
 *
 * @param {Array<{ metric: string, value: number }>} series
 * @returns {{ cpu: object, memory: object, disks: object[], networks: object[], gpus: object[] }}
 */
export function buildPublicDetail(series) {
  const parsed = [];
  for (const point of series ?? []) {
    const value = Number(point?.value);
    if (typeof point?.metric !== 'string') continue;
    let meta;
    try {
      meta = parseMetric(point.metric);
    } catch {
      continue; // 名字不合规的序列直接跳过（⛔ 不把可疑字符串回显给公开页）
    }
    parsed.push({ meta, value: Number.isFinite(value) ? round1(value) : null });
  }

  // 第一遍：收集维度取值，建立"稳定编号"（必须在填值之前，否则编号依赖行序）
  const diskKeys = new Set();
  const netKeys = new Set();
  const gpuIndexes = new Set();
  for (const { meta } of parsed) {
    if (!meta.hasDimensions) continue;
    if (meta.base.startsWith('gpu.') && meta.labels.index !== undefined) {
      const index = Number(meta.labels.index);
      if (Number.isInteger(index) && index >= 0) gpuIndexes.add(index);
      continue;
    }
    const key = meta.labels.mount ?? meta.labels.device;
    if (key === undefined) continue;
    if (meta.base.startsWith('disk.')) diskKeys.add(key);
    else if (meta.base.startsWith('net.')) netKeys.add(key);
  }

  const diskIndex = labelIndexOf(diskKeys);
  const netIndex = labelIndexOf(netKeys);

  // 预建"空壳"：既固定字段顺序，也让编号顺序 = Map 顺序（前端拿到的数组天然有序）
  const disks = new Map();
  for (const key of [...diskKeys].sort()) {
    const index = diskIndex.get(key);
    disks.set(key, { label: `磁盘 ${index}`, ...emptyRecord(Object.values(DISK_FIELD_BY_BASE)) });
  }
  const networks = new Map();
  for (const key of [...netKeys].sort()) {
    const index = netIndex.get(key);
    networks.set(key, { label: `网卡 ${index}`, ...emptyRecord(Object.values(NET_FIELD_BY_BASE)) });
  }
  const gpus = new Map();
  for (const index of [...gpuIndexes].sort((a, b) => a - b)) {
    // GPU 序号本身就是稳定序号（`gpu.util{index=0}`），⛔ 不需要重排，只做 0-based → 1-based 展示
    gpus.set(index, { label: `GPU ${index + 1}`, ...emptyRecord(Object.values(GPU_FIELD_BY_BASE)) });
  }

  const cpu = emptyRecord(Object.values(CPU_FIELD_BY_BASE));
  const memory = emptyRecord(Object.values(MEM_FIELD_BY_BASE));

  // 第二遍：填值
  for (const { meta, value } of parsed) {
    if (!meta.hasDimensions) {
      const cpuField = CPU_FIELD_BY_BASE[meta.base];
      if (cpuField !== undefined) {
        cpu[cpuField] = value;
        continue;
      }
      const memField = MEM_FIELD_BY_BASE[meta.base];
      if (memField !== undefined) memory[memField] = value;
      continue;
    }

    if (meta.base.startsWith('gpu.')) {
      const field = GPU_FIELD_BY_BASE[meta.base];
      const entry = gpus.get(Number(meta.labels.index));
      if (field !== undefined && entry) entry[field] = value;
      continue;
    }

    const key = meta.labels.mount ?? meta.labels.device;
    if (key === undefined) continue;
    if (meta.base.startsWith('disk.')) {
      const field = DISK_FIELD_BY_BASE[meta.base];
      const entry = disks.get(key);
      if (field !== undefined && entry) entry[field] = value;
      continue;
    }
    if (meta.base.startsWith('net.')) {
      const field = NET_FIELD_BY_BASE[meta.base];
      const entry = networks.get(key);
      if (field !== undefined && entry) entry[field] = value;
    }
  }

  return {
    cpu,
    memory,
    disks: [...disks.values()],
    networks: [...networks.values()],
    gpus: [...gpus.values()],
  };
}

/**
 * 探活目标的**公开脱敏**（`docs/api.md` §3.2：`target_host` 只给域名或泛化形式）。
 *
 * 口径（逐条都有理由，⛔ 不要"顺手放宽"）：
 *  - URL（`http://…/admin/health?x=1`）→ **只留主机名**：路径与查询串会暴露内网服务结构；
 *  - `host:port` / `[v6]:port` → 去掉端口：端口是内网资产画像的一部分；
 *  - 域名 → 原样（公开页说的是"官网/网关通不通"，域名本身不是秘密）；
 *  - **私网/保留 IP → 固定文案 `内网地址`**：`10.0.2.15` 直接暴露网段划分；
 *  - 公网 IP → 原样（解析域名同样能得到，隐藏只会让公开页变成一排"—"）；
 *  - 解析不出来 → `null`（**默认不展示**，⛔ 不返回原串）。
 *
 * ⚠️ `内网地址` 是**哨兵值**（与 `last_seen_ago` 的中文文案同类），前端可直接展示或换成图标。
 *
 * @param {unknown} target
 * @returns {string|null}
 */
export function desensitizeTarget(target) {
  if (typeof target !== 'string') return null;
  const text = target.trim();
  if (text === '') return null;

  let hostPart = text;
  if (text.includes('://')) {
    try {
      hostPart = new URL(text).hostname;
    } catch {
      return null;
    }
  } else if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end === -1) return null;
    hostPart = text.slice(1, end);
  } else {
    const firstColon = text.indexOf(':');
    // ⛔ 只在"恰好一个冒号"时按 host:port 处理：多个冒号是裸 IPv6，不能切
    if (firstColon !== -1 && firstColon === text.lastIndexOf(':')) hostPart = text.slice(0, firstColon);
  }

  const normalized = hostPart.trim().toLowerCase();
  if (normalized === '') return null;

  const ip = normalizeIp(normalized);
  if (ip === null) {
    return /^[a-z0-9._-]+$/.test(normalized) ? normalized : null;
  }
  return isPrivateAddress(ip) ? '内网地址' : ip;
}

/** 公开单机条目 = 列表条目（白名单）+ 展开块 */
export function toPublicHostNow(row, { snapshot, probes, nowMs, detail }) {
  return { ...toPublicHost(row, { snapshot, probes, nowMs }), ...detail };
}

/**
 * `GET /api/public/hosts/{slug}/now` —— 公开单机当前快照（公开页"就地展开"用）。
 * ⚠️ 受总开关约束（路由层的 guard），且缓存与列表同一 TTL。
 * @returns {Promise<object|null>} slug 不存在**或**该机已禁用 → `null`（路由层转 404）
 */
export async function getPublicHostNow({ pool, redis, config, logger, slug }) {
  const ttlS = config.rateLimit.publicCacheTtlS;
  return withResponseCache(redis, keys.snapshotPublicHostNow(slug), ttlS, logger, async () => {
    const thresholdS = offlineThresholdS(config);
    const row = await findAgentStatusBySlug(pool, { slug, thresholdS });
    if (row === null) return null;

    const nowMs = (toDate(row.server_now) ?? new Date()).getTime();
    const since = new Date(nowMs - OBSERVATION_WINDOW_S * 1000);
    const [series, probeRows] = await Promise.all([
      selectCurrentSeriesForAgent(pool, { agentId: row.id, since }),
      countLatestProbeResults(pool, { agentIds: [row.id], since }),
    ]);

    const probes = probeRows[0]
      ? { up: Number(probeRows[0].up) || 0, down: Number(probeRows[0].down) || 0 }
      : { up: 0, down: 0 };

    return {
      ...toPublicHostNow(row, {
        snapshot: buildSnapshot(series.map((point) => ({ slot: slotOfMetric(point.metric), value: point.value }))),
        probes,
        nowMs,
        detail: buildPublicDetail(series),
      }),
      // ⚠️ 必须有：单机接口的"快照生成时刻"（缓存命中时 = 缓存生成时刻，与列表同一口径）。
      //    ⛔ 少了它响应 schema 会直接 500（`required` 里写着呢）—— 这是本端点的第一个 bug。
      updated_at: new Date(nowMs).toISOString(),
    };
  });
}

/** 把序列全名映射回列表页用的 6 个槽位之一（用于公开单机页里复用同一套 `snapshot`） */
function slotOfMetric(metric) {
  const base = typeof metric === 'string' ? metric.split('{')[0] : '';
  for (const entry of CURRENT_VALUE_SLOT_BY_BASE) {
    if (entry.base === base) return entry.slot;
  }
  return '__ignored__'; // ⛔ 不是 `null`：buildSnapshot 会跳过未知 slot
}

/** `{ 基名 → 槽位 }`（与 metric.repo.js 的 CURRENT_VALUE_SERIES 同源，仅用于上面那个反向映射） */
const CURRENT_VALUE_SLOT_BY_BASE = Object.freeze([
  { base: 'cpu.usage', slot: 'cpu_pct' },
  { base: 'mem.used_pct', slot: 'mem_pct' },
  { base: 'mem.used', slot: 'mem_used' },
  { base: 'mem.total', slot: 'mem_total' },
  { base: 'disk.used_pct', slot: 'disk_pct' },
  { base: 'net.rx_bps', slot: 'net_rx_bps' },
  { base: 'net.tx_bps', slot: 'net_tx_bps' },
  { base: 'gpu.util', slot: 'gpu_pct' },
]);

/**
 * `GET /api/public/probes` —— 公开探活概览（**最近一轮**，目标已脱敏）。
 *
 * ⚠️ 只列**非禁用**主机（与列表同一可见集合）；`truncated=true` 表示条数被
 * `PUBLIC_PROBE_MAX_ITEMS` 截断（⛔ 不静默丢数据 —— 前端可以提示"仅显示前 N 条"）。
 * @returns {Promise<{ items: object[], next_cursor: null, truncated: boolean, updated_at: string }>}
 */
export async function listPublicProbes({ pool, redis, config, logger }) {
  const ttlS = config.rateLimit.publicCacheTtlS;
  return withResponseCache(redis, keys.snapshotPublicProbes, ttlS, logger, async () => {
    const thresholdS = offlineThresholdS(config);
    const rows = await listAgentsForStatus(pool, { thresholdS, includeDisabled: false, limit: PUBLIC_HOST_LIMIT });
    const serverNow = toDate(rows[0]?.server_now) ?? toDate(await readDbNow(pool)) ?? new Date();
    const agentIds = rows.map((row) => row.id);

    const byId = new Map(rows.map((row) => [row.id, row]));
    const since = new Date(serverNow.getTime() - OBSERVATION_WINDOW_S * 1000);
    const probeRows = await selectLatestProbeRound(pool, {
      agentIds,
      since,
      limit: PUBLIC_PROBE_MAX_ITEMS + 1, // 多取一条用于判断"是否被截断"
    });
    const truncated = probeRows.length > PUBLIC_PROBE_MAX_ITEMS;

    return {
      items: probeRows.slice(0, PUBLIC_PROBE_MAX_ITEMS).map((probe) => {
        const host = byId.get(probe.agent_id);
        return {
          slug: host?.public_slug ?? null,
          host_name: host ? displayNameOf(host) : null,
          name: probe.probe_name,
          target_host: desensitizeTarget(probe.target),
          type: probe.probe_type,
          up: probe.up === true,
          latency_ms: optionalNumber(probe.latency_ms),
          checked_at: isoOrNull(probe.checked_at),
        };
      }),
      next_cursor: null,
      truncated,
      updated_at: serverNow.toISOString(),
    };
  });
}

// -----------------------------------------------------------------------------
// 私有：汇总与单机纵深（`GET /api/v1/summary`、`/api/v1/hosts/{id}[…]`）
//
// ⚠️ 时间口径（与公开侧一致，但有一处刻意的例外）：
//   - **状态判定**一律用 DB `now()`（见 `agent.repo.js` 的 `EFFECTIVE_STATUS_SQL`）；
//   - **查询窗口的默认值**（"最近 24 小时"这类）用**进程时钟** —— 窗口是 24h 级别，
//     多实例之间几秒的进程时钟差对结果无意义，而为此多发一次 `SELECT now()` 只是浪费。
//     ⛔ 这个例外**仅限窗口默认值**，不得扩散到任何状态判定。
// -----------------------------------------------------------------------------

/** 汇总计数的唯一实现（公开 `/api/public/summary` 与私有 `/api/v1/summary` 共用） */
async function computeSummary(pool, thresholdS) {
  const [counts, alerts, serverNow] = await Promise.all([
    countAgentsByEffectiveStatus(pool, { thresholdS }),
    // ⚠️ 本期恒为 0（告警引擎在 M3，方案 §2.7）：照契约查询而不是硬编码 0，
    //    这样 M3 落地后本字段**自动**变正确，两个汇总接口都无需回头改。
    countFiringAlertsBySeverity(pool),
    readDbNow(pool),
  ]);
  return { ...counts, alerts, at: toDate(serverNow) ?? new Date() };
}

/**
 * `GET /api/v1/summary` —— 面板汇总计数（➕ 2026-10-04 新增，公开侧有同形接口）。
 *
 * 🔑 为什么面板需要它：列表页顶部要显示「在线 X / 离线 Y / 告警 Z」，而用列表自己数**是错的** ——
 *    `limit` 一旦截断（默认 20），数出来的永远是"这一页里有几台"，而不是全量。
 *    与公开汇总共用 `computeSummary()`，所以两个页面的数字不可能不一致。
 * ⚠️ **不做响应缓存**（D4 只给公开侧）：私有响应的可见性绑在会话上，缓存会把边界挪到缓存键上。
 */
export async function getPanelSummary({ pool, config }) {
  const { at, ...rest } = await computeSummary(pool, offlineThresholdS(config));
  return { ...rest, updated_at: at.toISOString() };
}

/**
 * `GET /api/v1/hosts/{id}` —— 单机详情。
 *
 * 返回值 = **列表条目（同一套白名单投影）** + 四个纵深字段：
 * | 字段 | 用途 |
 * |---|---|
 * | `host_info` | 原始 host 快照（os/kernel/arch/boot_time/hostname）—— 私有域允许给，排障要用 |
 * | `capabilities` | 能力声明（决定面板展示哪些图表） |
 * | `current_metrics` | **全部序列当前值**（键 = 指标全名，如 `disk.used_pct{mount=/data}`） |
 * | `updated_at` | 快照生成时刻（DB 时钟） |
 *
 * ⚠️ `current_metrics` 给的是**原始指标全名**（含 `mount=/data`）—— 这是私有接口，
 *    运维正需要这些名字；⛔ 公开侧走的是 `buildPublicDetail()` 的泛化标签，两条路径不共用。
 * ⚠️ 同一次上报里的 `host_info` 与 `capabilities` 都来自 `agents` 行，因此二者天然同批。
 * @returns {Promise<object|null>} 不存在 → `null`（路由层转 404）
 */
export async function getPanelHostDetail({ pool, config, logger, id }) {
  const thresholdS = offlineThresholdS(config);
  const row = await findAgentStatusById(pool, { id, thresholdS });
  if (row === null) return null;

  const nowMs = (toDate(row.server_now) ?? new Date()).getTime();
  const since = new Date(nowMs - OBSERVATION_WINDOW_S * 1000);
  const [series, probeRows] = await Promise.all([
    selectCurrentSeriesForAgent(pool, { agentId: id, since }),
    countLatestProbeResults(pool, { agentIds: [id], since }),
  ]);

  logger?.debug?.({ agentId: id, series: series.length }, '主机详情取数完成');

  const probes = probeRows[0]
    ? { up: Number(probeRows[0].up) || 0, down: Number(probeRows[0].down) || 0 }
    : { up: 0, down: 0 };

  const currentMetrics = {};
  for (const point of series) {
    const value = Number(point.value);
    currentMetrics[point.metric] = Number.isFinite(value) ? round1(value) : null;
  }

  return {
    ...toPanelHost(row, {
      snapshot: buildSnapshot(series.map((point) => ({ slot: slotOfMetric(point.metric), value: point.value }))),
      probes,
      nowMs,
    }),
    host_info: row.host_info ?? null,
    capabilities: row.capabilities ?? null,
    current_metrics: currentMetrics,
    updated_at: new Date(nowMs).toISOString(),
  };
}

/**
 * `GET /api/v1/hosts/{id}/probes` —— 探活历史（时间条 + 可用率 + 最近延迟）。
 *
 * @param {object} input
 * @param {Date} input.from 窗口下界（调用方已做跨度校验）
 * @param {Date|null} input.to 窗口上界；`null` = 不设上界（SQL 侧按 DB 当前时刻兜）
 * @returns {Promise<object|null>} 主机不存在 → `null`
 */
export async function getPanelProbeHistory({ pool, config, logger, id, from, to = null, name = null, type = null, now }) {
  const row = await findAgentStatusById(pool, { id, thresholdS: offlineThresholdS(config) });
  if (row === null) return null;

  const rows = await selectProbeHistory(pool, {
    agentId: id,
    from,
    to,
    name,
    type,
    perProbeLimit: PROBE_HISTORY_MAX_POINTS,
  });

  /** probe_name → 聚合条目（保持 Map 顺序 = SQL 的 `ORDER BY probe_name`，前端无需再排） */
  const grouped = new Map();
  for (const item of rows) {
    let entry = grouped.get(item.probe_name);
    if (!entry) {
      entry = {
        name: item.probe_name,
        type: item.probe_type,
        target: item.target,
        availability: {
          // ⚠️ 这两个数是**整个窗口**的（SQL 窗口函数），不是"返回的这几个点"的
          total: Number(item.total_in_window) || 0,
          up: Number(item.up_in_window) || 0,
          down: (Number(item.total_in_window) || 0) - (Number(item.up_in_window) || 0),
          window_from: isoOrNull(item.first_in_window),
          window_to: isoOrNull(item.last_in_window),
        },
        latest: null,
        results: [],
      };
      grouped.set(item.probe_name, entry);
    }
    const point = {
      checked_at: isoOrNull(item.checked_at),
      up: item.up === true,
      latency_ms: optionalNumber(item.latency_ms),
      status_code: item.status_code === null || item.status_code === undefined ? null : Number(item.status_code),
      error: optionalText(item.error),
    };
    // SQL 按 checked_at DESC 返回 ⇒ 第一条就是"最近一次"
    if (entry.latest === null) entry.latest = point;
    entry.results.push(point);
  }

  const items = [...grouped.values()].map((entry) => ({
    ...entry,
    availability: {
      ...entry.availability,
      ratio:
        entry.availability.total > 0
          ? Math.round((entry.availability.up / entry.availability.total) * 10000) / 10000
          : null, // 窗口内没有任何探活 ⇒ `null`（⛔ 不是 100%，那会谎报"一直可用"）
    },
    truncated: entry.availability.total > PROBE_HISTORY_MAX_POINTS,
  }));

  return {
    host_id: id,
    from: from.toISOString(),
    to: (to ?? now ?? new Date()).toISOString(),
    // ⚠️ 只要有一个 probe 被截断就为真：前端据此提示"仅显示最近 N 次"
    truncated: items.some((item) => item.truncated),
    items,
    updated_at: (toDate(row.server_now) ?? new Date()).toISOString(),
  };
}

/**
 * `GET /api/v1/hosts/{id}/ip-history` —— IP 变更时间线。
 *
 * ⚠️ `intervals`（出现区间）与 `events`（变化/Flapping 事件）是**两张表、两种语义**：
 *    前者回答"这台机用过哪些 IP"，后者回答"它什么时候换的、是不是在抖"。
 *    前端把它们画成一条时间线，但 ⛔ 不要试图让两者行数对齐（区间是聚合的，事件是逐次的）。
 * @returns {Promise<object|null>} 主机不存在 → `null`
 */
export async function getPanelIpHistory({ pool, config, id, limit = IP_HISTORY_DEFAULT_LIMIT }) {
  const row = await findAgentStatusById(pool, { id, thresholdS: offlineThresholdS(config) });
  if (row === null) return null;

  const [intervals, events] = await Promise.all([
    listIpIntervals(pool, { agentId: id, limit }),
    listIpChangeEvents(pool, { agentId: id, limit }),
  ]);

  return {
    host_id: id,
    // 当前值取自 `agents` 行（与列表页同一来源），⛔ 不从区间表"推"一个出来
    current_ip: optionalText(row.last_ip),
    reported_ip: optionalText(row.reported_ip),
    ip_flapping: row.ip_flapping === true,
    flapping_since: isoOrNull(row.flapping_since),
    intervals: intervals.map((item) => ({
      ip: item.ip,
      source: item.source,
      first_seen: isoOrNull(item.first_seen),
      last_seen: isoOrNull(item.last_seen),
    })),
    events: events.map((item) => ({
      old_ip: optionalText(item.old_ip),
      new_ip: item.new_ip,
      same_subnet: item.same_subnet === null || item.same_subnet === undefined ? null : item.same_subnet === true,
      changed_at: isoOrNull(item.changed_at),
      source: optionalText(item.source),
      kind: item.kind,
      change_count: item.change_count === null || item.change_count === undefined ? null : Number(item.change_count),
      subnet_prev: optionalText(item.subnet_prev),
      subnet_next: optionalText(item.subnet_next),
    })),
    updated_at: (toDate(row.server_now) ?? new Date()).toISOString(),
  };
}

/**
 * `GET /api/v1/hosts/{id}/processes` —— 进程总数 + Top-N。
 *
 * ⚠️ 没有快照时三个字段**同时为 `null`**（`at`/`total`/`top`），而不是 `total: 0 / top: []`：
 *    "没有采集到"与"那一刻确实没有进程"在 UI 上必须是两件事（`process_snapshots` 只留 30 天，
 *    查更早的时间点必然走这条路径）。
 * @returns {Promise<object|null>} 主机不存在 → `null`
 */
export async function getPanelProcessSnapshot({ pool, config, id, at = null }) {
  const row = await findAgentStatusById(pool, { id, thresholdS: offlineThresholdS(config) });
  if (row === null) return null;

  const snapshot = await selectLatestProcessSnapshot(pool, { agentId: id, at });
  return {
    host_id: id,
    at: snapshot ? isoOrNull(snapshot.ts) : null,
    total: snapshot ? Number(snapshot.total) : null,
    top: snapshot ? (Array.isArray(snapshot.top) ? snapshot.top : []) : null,
    updated_at: (toDate(row.server_now) ?? new Date()).toISOString(),
  };
}
