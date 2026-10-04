/**
 * Vantage · 公开只读状态路由（`/api/public/*`，免登录）
 *
 * 依据：docs/api.md §3（公开视图：免登录、只读、只返回当前快照、严格限流、严格脱敏）、
 *       docs/server-status-api.md §3.1/§3.2（本块交付的两个端点与字段口径）
 *
 * 本文件只做 **HTTP 语义**（路由、限流/开关挂载、响应 schema），推导全在
 * `services/status.service.js` —— ⛔ 本文件里不得出现任何 SQL 或状态判定。
 *
 * 🔑 前置闸门顺序**固定**为 `publicRateLimit` → `publicViewGuard`（方案 §3.1）：
 *    限流在前，所以"被关闭期间的扫描请求"照样计数，不会被用来免费探测端点是否存在。
 *
 * 🔑 为什么响应 schema 写成 `additionalProperties: false` 的白名单（方案 §2.6）：
 *    它是"公开响应零内部标识"的**第二道防线**——即使 `toPublicHost()` 将来被人加错了字段，
 *    序列化器也不会把它发出去。⚠️ 但它**静默丢弃**多出来的字段（不报错），
 *    所以 ⛔ 绝不能只靠它：真正的防线是 `status.service.js` 的白名单投影 +
 *    `test/status.service.test.js` 里"字段全填满的 agent"用例。
 *
 * ⚠️ 新增任何 `/api/public/*` 路由都**必须**挂 `publicViewGuard`（方案 §2.5 的强制要求），
 *    review 时按"有没有挂 guard"逐条核。
 */

import { createPublicViewGuard } from '../middleware/publicView.js';
import { createPublicRateLimiter } from '../middleware/rateLimit.js';
import { getPublicHostNow, getPublicSummary, listPublicHosts, listPublicProbes } from '../services/status.service.js';
import { AppError } from '../utils/errors.js';

/** 公开快照：六键，`gpu_pct` 视有无 GPU 序列而缺省（方案 §2.2） */
const PUBLIC_SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cpu_pct', 'mem_pct', 'disk_pct', 'net_rx_bps', 'net_tx_bps'],
  properties: {
    cpu_pct: { type: ['number', 'null'] },
    mem_pct: { type: ['number', 'null'] },
    disk_pct: { type: ['number', 'null'] },
    net_rx_bps: { type: ['number', 'null'] },
    net_tx_bps: { type: ['number', 'null'] },
    gpu_pct: { type: ['number', 'null'] },
  },
};

/**
 * 公开主机条目（方案 §3.1 的字段表）。
 * ⛔ `id` / `last_ip` / `reported_ip` / `tags` / `clock_drift_ms` / `ip_flapping` / `active_alerts`
 *    一律**不在**这里 —— 它们只允许出现在私有响应中。
 */
const PUBLIC_HOST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'name', 'status', 'snapshot', 'probes', 'last_seen_ago', 'last_seen_at'],
  properties: {
    slug: { type: 'string' },
    name: { type: 'string' },
    // 公开列表⛔ 不出现 `disabled`（D-禁）——它只可能是这两种之一
    status: { type: 'string', enum: ['online', 'offline'] },
    // ⚠️ `os` / `uptime` 缺失时**字段缺省**（不是 null），故不进 required
    os: { type: 'string' },
    uptime: { type: 'number' },
    snapshot: PUBLIC_SNAPSHOT_SCHEMA,
    probes: {
      type: 'object',
      additionalProperties: false,
      required: ['up', 'down'],
      properties: { up: { type: 'integer' }, down: { type: 'integer' } },
    },
    last_seen_ago: { type: ['string', 'null'] },
    last_seen_at: { type: ['string', 'null'] },
  },
};

const PUBLIC_HOSTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'next_cursor', 'updated_at'],
  properties: {
    items: { type: 'array', items: PUBLIC_HOST_SCHEMA },
    // 本期恒为 null（方案 §2.8）；保留可空字符串类型，将来真做游标时前端无需改判定
    next_cursor: { type: ['string', 'null'] },
    updated_at: { type: 'string' },
  },
};

const PUBLIC_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['total', 'online', 'offline', 'disabled', 'alerts', 'updated_at'],
  properties: {
    total: { type: 'integer' },
    online: { type: 'integer' },
    offline: { type: 'integer' },
    // ➕ 方案新增字段（docs/api.md §3.2 的字段表漏了它，但设计稿顶栏「禁用 1」需要）
    disabled: { type: 'integer' },
    alerts: {
      type: 'object',
      additionalProperties: false,
      required: ['critical', 'warn', 'info'],
      properties: {
        critical: { type: 'integer' },
        warn: { type: 'integer' },
        info: { type: 'integer' },
      },
    },
    updated_at: { type: 'string' },
  },
};

/** 可空数值（公开侧**没有数据就是 null**，⛔ 不补 0） */
const NULLABLE_NUMBER = { type: ['number', 'null'] };

/** 公开展开块里的"一行"：`label` + 一组可空数值（字段清单见 status.service.js 的映射表） */
function labeledRecordSchema(fields) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['label', ...fields],
    properties: { label: { type: 'string' }, ...nullableFields(fields) },
  };
}

/**
 * 数组元素用带 `label` 的记录；而 `cpu` / `memory` 是**单条汇总**（没有"第几个"的概念）——
 * ⛔ 两者不能共用同一个 schema：给汇总硬塞一个 `label` 会让它变成一个必填字段，
 * 序列化时直接 500（本端点第一版就是这么挂的）。
 */
function summaryRecordSchema(fields) {
  return {
    type: 'object',
    additionalProperties: false,
    required: fields,
    properties: nullableFields(fields),
  };
}

function nullableFields(fields) {
  const properties = {};
  for (const field of fields) properties[field] = NULLABLE_NUMBER;
  return properties;
}

/**
 * 公开单机展开块（`GET /api/public/hosts/{slug}/now`）。
 * ⛔ **一个指标名都不出现**：维度取值被泛化成「磁盘 1 / 网卡 1」（见 `buildPublicDetail()` 的说明）。
 */
const PUBLIC_DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...PUBLIC_HOST_SCHEMA.required, 'cpu', 'memory', 'disks', 'networks', 'gpus', 'updated_at'],
  properties: {
    ...PUBLIC_HOST_SCHEMA.properties,
    cpu: summaryRecordSchema(['usage_pct', 'load1', 'load5', 'load15', 'ctx_switch']),
    memory: summaryRecordSchema([
      'total_bytes', 'used_bytes', 'used_pct', 'available_bytes', 'cached_bytes', 'buffers_bytes',
    ]),
    disks: {
      type: 'array',
      items: labeledRecordSchema([
        'total_bytes', 'used_bytes', 'used_pct', 'inode_used_pct',
        'read_bps', 'write_bps', 'read_iops', 'write_iops', 'latency_ms',
      ]),
    },
    networks: {
      type: 'array',
      items: labeledRecordSchema(['rx_bps', 'tx_bps', 'rx_total_bytes', 'tx_total_bytes', 'conn_count', 'err', 'drop']),
    },
    gpus: {
      type: 'array',
      items: labeledRecordSchema(['util_pct', 'mem_used_bytes', 'mem_total_bytes', 'temp_c', 'power_w']),
    },
    updated_at: { type: 'string' },
  },
};

const PUBLIC_PROBES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'next_cursor', 'truncated', 'updated_at'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slug', 'host_name', 'name', 'target_host', 'type', 'up', 'latency_ms', 'checked_at'],
        properties: {
          slug: { type: ['string', 'null'] },
          host_name: { type: ['string', 'null'] },
          name: { type: 'string' },
          // ⛔ 只可能是域名、公网 IP 或哨兵值「内网地址」（见 desensitizeTarget）
          target_host: { type: ['string', 'null'] },
          type: { type: 'string' },
          up: { type: 'boolean' },
          latency_ms: NULLABLE_NUMBER,
          checked_at: { type: ['string', 'null'] },
        },
      },
    },
    next_cursor: { type: ['string', 'null'] },
    // 条数被上限截断时为真（⛔ 不静默丢数据）
    truncated: { type: 'boolean' },
    updated_at: { type: 'string' },
  },
};

/** 路径参数 `slug` 的形状（与库约束 `agents_public_slug_format_ck` 同源；非法值 → 400） */
const PUBLIC_HOST_PARAMS_SCHEMA = {
  type: 'object',
  required: ['slug'],
  properties: {
    slug: { type: 'string', pattern: '^[2-9A-HJ-NP-Za-km-z]{8,12}$' },
  },
};

/**
 * 注册公开只读路由。
 * @param {import('fastify').FastifyInstance} app
 */
export async function registerPublicRoutes(app) {
  const { config, deps, log } = app;
  const pool = deps.db.app;
  const redis = deps.redis;

  const publicRateLimit = createPublicRateLimiter({ redis, config, logger: log });
  const publicViewGuard = createPublicViewGuard({ redis, config, logger: log, pool });

  // GET /api/public/summary —— 汇总计数（免登录、按 IP 严格限流、受总开关约束）
  app.get(
    '/api/public/summary',
    { schema: { response: { 200: PUBLIC_SUMMARY_SCHEMA } }, preHandler: [publicRateLimit, publicViewGuard] },
    async () => getPublicSummary({ pool, redis, config, logger: log }),
  );

  // GET /api/public/hosts —— 主机列表（⛔ 无 IP、无内部 UUID，标识用 public_slug）
  // ⚠️ 本端点**不接受任何查询参数**（docs/api.md §3.2：四个公开端点都无请求参数）；
  //    传了也无副作用地被忽略 —— 公开侧不提供过滤，以免"按标签过滤"变成一种信息泄露面。
  app.get(
    '/api/public/hosts',
    { schema: { response: { 200: PUBLIC_HOSTS_SCHEMA } }, preHandler: [publicRateLimit, publicViewGuard] },
    async () => listPublicHosts({ pool, redis, config, logger: log }),
  );

  // GET /api/public/hosts/{slug}/now —— 单机当前快照（公开页"就地展开"，⛔ 无历史、无 IP、无设备名）
  app.get(
    '/api/public/hosts/:slug/now',
    {
      schema: { params: PUBLIC_HOST_PARAMS_SCHEMA, response: { 200: PUBLIC_DETAIL_SCHEMA } },
      preHandler: [publicRateLimit, publicViewGuard],
    },
    async (request, reply) => {
      const host = await getPublicHostNow({ pool, redis, config, logger: log, slug: request.params.slug });
      if (host === null) {
        // ⛔ 与"该机被禁用"返回同一个 404：否则 slug 就成了"这台机是否被人工禁用"的枚举口子
        throw new AppError('not_found');
      }
      // 命中缓存时 `updated_at` 是缓存生成时刻 —— 与 `/hosts` 同一口径（方案 §2.4）
      return host;
    },
  );

  // GET /api/public/probes —— 探活概览（每机最近一轮；target 已按口径脱敏）
  app.get(
    '/api/public/probes',
    { schema: { response: { 200: PUBLIC_PROBES_SCHEMA } }, preHandler: [publicRateLimit, publicViewGuard] },
    async () => listPublicProbes({ pool, redis, config, logger: log }),
  );
}
