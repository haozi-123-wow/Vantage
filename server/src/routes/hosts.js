/**
 * Vantage · 面板主机路由（`/api/v1/hosts`，需登录）
 *
 * 依据：docs/api.md §4.2（`GET /api/v1/hosts` 契约：查询参数、字段表、错误码）、
 *       §1.2 ③（`{ items, next_cursor }`）、§4.1.1 ②（会话三态矩阵）、
 *       docs/server-status-api.md §2.8（D8：排序可定、**游标本期不做**）、§3.3
 *
 * 本文件只做 HTTP 语义（会话守卫、参数校验、响应 schema），推导在 `services/status.service.js`。
 *
 * 🔑 三态由**既有中间件**负责（⛔ 不另写判定）：
 *    `loadPanelSession` → `requireFullSession`（`setup_required` → 403 `totp_setup_required`；
 *    `totp_pending` → 403 `totp_required`）→ `requireCsrf`（GET 不校验，挂上只为与 `auth.js` 同构）。
 *
 * 🔑 为什么 `limit` 不用 Fastify 的 querystring schema（`type: 'integer'`）：
 *    `app.js` 刻意配置了 `coerceTypes: false`（§5.2「不做类型强制转换」），而 query string 里的
 *    值**永远是字符串** —— 用 `integer` 声明会让 `?limit=20` 变成 400 `schema_invalid`。
 *    所以这里手写校验（并给出与 ajv 同款的 400 `schema_invalid`），
 *    ⛔ 不要为了"少写几行"去开 coerceTypes：那会同时放宽 Agent 上报路径上所有数值字段的类型约束。
 */

import { createPanelAuth } from '../middleware/authPanel.js';
import {
  IP_HISTORY_DEFAULT_LIMIT,
  IP_HISTORY_MAX_LIMIT,
  PANEL_LIMIT_DEFAULT,
  PANEL_LIMIT_MAX,
  PROBE_HISTORY_DEFAULT_SPAN_S,
  PROBE_HISTORY_MAX_SPAN_S,
  getPanelHostDetail,
  getPanelIpHistory,
  getPanelProbeHistory,
  getPanelProcessSnapshot,
  getPanelSummary,
  listPanelHosts,
} from '../services/status.service.js';
import { AppError } from '../utils/errors.js';
import { parseTimeParam, parseTimeWindow } from '../utils/time.js';

/** 私有列表里 `status` 的合法取值（三态齐全，⛔ 与公开侧的两种不同） */
const STATUS_VALUES = ['online', 'offline', 'disabled'];

/**
 * 探活类型白名单。
 * ⚠️ **三处同源**：`migrations/0005_telemetry.sql` 的 `probe_results_type_ck`、
 *    `models/report.js` 的 `PROBE_ITEM.type`、以及这里。新增类型必须三处一起改
 *    （⛔ 只在前端/路由放开、库里没约束，会让"库里突然多出一种类型"在下游炸开）。
 */
const PROBE_TYPES = Object.freeze(['ping', 'http', 'https', 'tcp', 'dns']);

/** 探活名上限（与 `models/report.js` 的 `REPORT_LIMITS.probeNameMax` 一致） */
const PROBE_NAME_MAX_LENGTH = 128;

/**
 * 解析并**夹取**一个上限类整数参数（`limit`）。
 *
 * 🔑 口径（与 `settings.service.js` 的 `getSettingInt` 同款）：非法值 → 400（前端 bug 要能看见），
 *    超上限 → **夹取 + warn**（⛔ 不因为"要得太多"就拒绝整个请求，那会让调用方彻底拿不到数据）。
 */
function parseBoundedLimit(raw, { field, def, max, logger }) {
  if (raw === undefined || raw === '') return def;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
    throw new AppError('schema_invalid', { details: { field, reason: 'positive_integer_required' } });
  }
  const value = Number(raw);
  if (value < 1) {
    throw new AppError('schema_invalid', { details: { field, min: 1, max } });
  }
  if (value > max) {
    logger?.warn?.({ [field]: value, clamped: max }, `${field} 超出上限，已夹取`);
    return max;
  }
  return value;
}

/** 与 `services/status.service.js` 的公开快照结构**逐字相同**（同一张表格组件两边复用） */
const SNAPSHOT_SCHEMA = {
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
 * 私有主机条目（docs/api.md §4.2 的字段表 + 方案 §3.3 的追加项）。
 * ⛔ `agent_key_hash` / `agent_secret_enc` / `host_info` 原始对象 / 任何阈值与配置
 *    都不得出现在这里（设计 §13 安全清单）。
 */
const PANEL_HOST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'slug', 'name', 'display_name', 'tags', 'status', 'os', 'arch', 'uptime',
    'snapshot', 'probes', 'last_seen_ago', 'last_seen_at',
    'last_ip', 'reported_ip', 'clock_drift_ms', 'ip_flapping', 'flapping_since', 'active_alerts',
  ],
  properties: {
    id: { type: 'string' },
    slug: { type: 'string' },
    name: { type: 'string' },
    display_name: { type: ['string', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: STATUS_VALUES },
    os: { type: ['string', 'null'] },
    arch: { type: ['string', 'null'] },
    uptime: { type: ['number', 'null'] },
    snapshot: SNAPSHOT_SCHEMA,
    probes: {
      type: 'object',
      additionalProperties: false,
      required: ['up', 'down'],
      properties: { up: { type: 'integer' }, down: { type: 'integer' } },
    },
    last_seen_ago: { type: ['string', 'null'] },
    // 私有侧为**精确值**（docs/api.md §4.2：公开接口才做相对化处理）
    last_seen_at: { type: ['string', 'null'] },
    last_ip: { type: ['string', 'null'] },
    reported_ip: { type: ['string', 'null'] },
    // 符号口径：**负值 = Agent 慢**（与前端徽标同号）
    clock_drift_ms: { type: ['number', 'null'] },
    ip_flapping: { type: 'boolean' },
    flapping_since: { type: ['string', 'null'] },
    active_alerts: { type: 'integer' },
  },
};

const PANEL_HOSTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'next_cursor', 'updated_at'],
  properties: {
    items: { type: 'array', items: PANEL_HOST_SCHEMA },
    next_cursor: { type: ['string', 'null'] },
    updated_at: { type: 'string' },
  },
};

/** 可空数值 / 字符串（私有侧字段缺失一律显式 `null`，与公开侧的"字段缺省"不同） */
const NULLABLE_NUMBER = { type: ['number', 'null'] };
const NULLABLE_STRING = { type: ['string', 'null'] };

/** `GET /api/v1/summary`：与公开汇总**同一形状**（前端可共用类型） */
const PANEL_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['total', 'online', 'offline', 'disabled', 'alerts', 'updated_at'],
  properties: {
    total: { type: 'integer' },
    online: { type: 'integer' },
    offline: { type: 'integer' },
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

/** `GET /api/v1/hosts/{id}`：列表条目 + 纵深字段（`current_metrics` 是**任意键**的映射） */
const PANEL_HOST_DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...PANEL_HOST_SCHEMA.required, 'host_info', 'capabilities', 'current_metrics', 'updated_at'],
  properties: {
    ...PANEL_HOST_SCHEMA.properties,
    // ⚠️ `additionalProperties: true` 不是可选项 —— **少了它，fast-json-stringify 会把对象序列化成 `{}`**
    //    （"任意键对象"没有 properties 可依据，默认当空对象处理）。这个坑是静默的：
    //    HTTP 200、字段名也在，只是内容全空；本文件的三处（host_info / capabilities / current_metrics）
    //    与 `top` 的 items 都踩过。⛔ 往后再加"透传的 JSONB"字段时必须带上这一行。
    // 私有域允许给原始 host 快照（白名单在**上报**那一侧：models/report.js 的 host schema）
    host_info: { type: ['object', 'null'], additionalProperties: true },
    capabilities: { type: ['object', 'null'], additionalProperties: true },
    // 键 = 指标全名（含维度），值 = 当前值
    current_metrics: { type: 'object', additionalProperties: true },
    updated_at: { type: 'string' },
  },
};

const PROBE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checked_at', 'up', 'latency_ms', 'status_code', 'error'],
  properties: {
    checked_at: NULLABLE_STRING,
    up: { type: 'boolean' },
    latency_ms: NULLABLE_NUMBER,
    status_code: { type: ['integer', 'null'] },
    error: NULLABLE_STRING,
  },
};

const PROBE_HISTORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['host_id', 'from', 'to', 'truncated', 'items', 'updated_at'],
  properties: {
    host_id: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    truncated: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'target', 'availability', 'latest', 'results', 'truncated'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          target: { type: 'string' },
          availability: {
            type: 'object',
            additionalProperties: false,
            required: ['total', 'up', 'down', 'ratio', 'window_from', 'window_to'],
            properties: {
              total: { type: 'integer' },
              up: { type: 'integer' },
              down: { type: 'integer' },
              // 窗口内没有任何探活 ⇒ null（⛔ 不是 1，那会谎报"一直可用"）
              ratio: NULLABLE_NUMBER,
              window_from: NULLABLE_STRING,
              window_to: NULLABLE_STRING,
            },
          },
          latest: { ...PROBE_RESULT_SCHEMA, type: ['object', 'null'] },
          results: { type: 'array', items: PROBE_RESULT_SCHEMA },
          truncated: { type: 'boolean' },
        },
      },
    },
    updated_at: { type: 'string' },
  },
};

const IP_HISTORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'host_id', 'current_ip', 'reported_ip', 'ip_flapping', 'flapping_since',
    'intervals', 'events', 'updated_at',
  ],
  properties: {
    host_id: { type: 'string' },
    current_ip: NULLABLE_STRING,
    reported_ip: NULLABLE_STRING,
    ip_flapping: { type: 'boolean' },
    flapping_since: NULLABLE_STRING,
    intervals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ip', 'source', 'first_seen', 'last_seen'],
        properties: {
          ip: { type: 'string' },
          source: { type: 'string' },
          first_seen: NULLABLE_STRING,
          last_seen: NULLABLE_STRING,
        },
      },
    },
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['old_ip', 'new_ip', 'same_subnet', 'changed_at', 'source', 'kind', 'change_count', 'subnet_prev', 'subnet_next'],
        properties: {
          old_ip: NULLABLE_STRING,
          new_ip: { type: 'string' },
          same_subnet: { type: ['boolean', 'null'] },
          changed_at: NULLABLE_STRING,
          source: NULLABLE_STRING,
          kind: { type: 'string' },
          change_count: { type: ['integer', 'null'] },
          subnet_prev: NULLABLE_STRING,
          subnet_next: NULLABLE_STRING,
        },
      },
    },
    updated_at: { type: 'string' },
  },
};

const PROCESS_SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['host_id', 'at', 'total', 'top', 'updated_at'],
  properties: {
    host_id: { type: 'string' },
    // ⚠️ 「没有采集到」时三个字段同时为 null（⛔ 不是 total:0/top:[] —— 那会被读成"那一刻没有进程"）
    at: NULLABLE_STRING,
    total: { type: ['integer', 'null'] },
    // ⚠️ `top` 的元素是**上报原样**的 JSONB（pid/name/cpu/mem），故必须 `additionalProperties: true`
    //    —— 否则每一项会被序列化成 `{}`（见 PANEL_HOST_DETAIL_SCHEMA 的说明）
    top: { type: ['array', 'null'], items: { type: 'object', additionalProperties: true } },
    updated_at: { type: 'string' },
  },
};

/** 路径参数 `id` 必须是 UUID（非法值 → 400 `schema_invalid`，⛔ 不让它撞到 SQL 的 22P02） */
const HOST_ID_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
  },
};

/** 时间区间查询参数（`probes` 用；`from`/`to` 接受 RFC3339 或 unix 毫秒/秒） */

/**
 * 解析 `from`/`to` 窗口（默认"最近 24 小时"）。
 * ⚠️ 窗口默认值用**进程时钟**（24h 级别的默认值对秒级时钟差不敏感），
 *    ⛔ 但状态判定一律用 DB `now()` —— 这条界线见 services/status.service.js 的说明。
 */
function parseHistoryWindow(query, { defaultSpanS, maxSpanS }) {
  const now = new Date();
  return parseTimeWindow({
    from: query.from,
    to: query.to,
    defaultFrom: new Date(now.getTime() - defaultSpanS * 1000),
    maxSpanS,
    now,
  });
}

/**
 * 校验并归一化查询参数（⛔ 未知参数仅忽略，不做 400 —— 前端可能带缓存击穿参数）。
 * @returns {{ status: string|null, tag: string|null, q: string|null, limit: number }}
 */
function parseFilters(query, logger) {
  const filters = { status: null, tag: null, q: null, limit: PANEL_LIMIT_DEFAULT };

  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !STATUS_VALUES.includes(query.status)) {
      throw new AppError('schema_invalid', { details: { field: 'status', allowed: STATUS_VALUES } });
    }
    filters.status = query.status;
  }

  for (const field of ['tag', 'q']) {
    const raw = query[field];
    if (raw === undefined) continue;
    // ⚠️ 空串（`?q=`）按**未提供**处理：搜索框清空后照原样提交是常见行为，
    //    而"空搜索"的合理语义就是"不过滤"。⛔ 若按字面匹配，`?tag=` 会返回空列表
    //    （没有任何主机的标签等于空串），看起来像"数据丢了"。
    if (raw === '') continue;
    // 重复参数（`?q=a&q=b`）在 Fastify 里是数组 → 一并拒绝，避免"取第一个"这种隐式行为
    if (typeof raw !== 'string' || raw.length > 64) {
      throw new AppError('schema_invalid', { details: { field, max_length: 64 } });
    }
    // ⚠️ 这里传**原样文本**：LIKE 元字符的转义由 repositories/agent.repo.js 负责
    //    （那是 SQL 的归属方，放在路由层会让"绕过路由直接调 service"的调用方拿到通配符语义）
    filters[field] = raw;
  }

  filters.limit = parseBoundedLimit(query.limit, {
    field: 'limit',
    def: PANEL_LIMIT_DEFAULT,
    max: PANEL_LIMIT_MAX,
    logger,
  });

  return filters;
}

/**
 * 注册面板主机路由。
 * @param {import('fastify').FastifyInstance} app
 */
export async function registerHostRoutes(app) {
  const { config, deps, log } = app;
  const pool = deps.db.app;
  const redis = deps.redis;

  const panel = createPanelAuth({ redis, config, logger: log });

  // GET /api/v1/hosts —— 主机列表（含 IP / 内部 ID / 漂移 / Flapping / 活动告警数）
  app.get(
    '/api/v1/hosts',
    {
      schema: { response: { 200: PANEL_HOSTS_SCHEMA } },
      preHandler: [panel.loadPanelSession, panel.requireFullSession, panel.requireCsrf],
    },
    async (request) => {
      // ⚠️ `cursor` 本期**忽略**（方案 §2.8 / D8-a）：⛔ 不返回 400 ——
      //    前端骨架可能已经带着它（`web/src/api/private.ts` 的 `list({cursor})`），
      //    为"支持形状"而拒服务只会让联调卡死；忽略则语义诚实（反正只有一页）。
      const filters = parseFilters(request.query ?? {}, log);
      return listPanelHosts({ pool, config, logger: log, ...filters });
    },
  );

  // GET /api/v1/summary —— 面板汇总计数（➕ 2026-10-04：列表页顶栏不能靠"数当前页"得出全量）
  // ⚠️ 与公开 `/api/public/summary` **同一形状**（共用 computeSummary），⛔ 但**不做响应缓存**
  app.get(
    '/api/v1/summary',
    {
      schema: { response: { 200: PANEL_SUMMARY_SCHEMA } },
      preHandler: [panel.loadPanelSession, panel.requireFullSession, panel.requireCsrf],
    },
    async () => getPanelSummary({ pool, config }),
  );

  /**
   * 四个单机子端点共用的前置：会话三态 + `id` 必须是 UUID。
   * ⚠️ `id` 的格式校验放在 schema 里（非法值 → 400 `schema_invalid`），
   *    ⛔ 否则 `WHERE id = $1::uuid` 会先撞 PG 的 `22P02`，被折叠成 400 `invalid_request` ——
   *    同一个错误两种 code，前端没法统一处理。
   */
  const hostScoped = {
    schema: { params: HOST_ID_PARAMS_SCHEMA },
    preHandler: [panel.loadPanelSession, panel.requireFullSession, panel.requireCsrf],
  };

  /** 主机不存在 → 404（⛔ 与"主机存在但没有该项数据"区分开：后者是 200 + null 字段） */
  function notFound(id) {
    return new AppError('not_found', { details: { resource: 'host', id } });
  }

  // GET /api/v1/hosts/{id} —— 单机详情（列表条目 + host_info/capabilities/current_metrics）
  app.get(
    '/api/v1/hosts/:id',
    { ...hostScoped, schema: { ...hostScoped.schema, response: { 200: PANEL_HOST_DETAIL_SCHEMA } } },
    async (request) => {
      const detail = await getPanelHostDetail({ pool, config, logger: log, id: request.params.id });
      if (detail === null) throw notFound(request.params.id);
      return detail;
    },
  );

  // GET /api/v1/hosts/{id}/probes —— 探活历史（时间条 + 可用率 + 最近延迟）
  app.get(
    '/api/v1/hosts/:id/probes',
    { ...hostScoped, schema: { ...hostScoped.schema, response: { 200: PROBE_HISTORY_SCHEMA } } },
    async (request) => {
      const query = request.query ?? {};
      const { from, to } = parseHistoryWindow(query, {
        defaultSpanS: PROBE_HISTORY_DEFAULT_SPAN_S,
        maxSpanS: PROBE_HISTORY_MAX_SPAN_S,
      });
      const name = typeof query.name === 'string' && query.name !== '' ? query.name : null;
      const type = typeof query.type === 'string' && query.type !== '' ? query.type : null;
      if (name !== null && name.length > PROBE_NAME_MAX_LENGTH) {
        throw new AppError('schema_invalid', { details: { field: 'name', max_length: PROBE_NAME_MAX_LENGTH } });
      }
      if (type !== null && !PROBE_TYPES.includes(type)) {
        throw new AppError('schema_invalid', { details: { field: 'type', allowed: PROBE_TYPES } });
      }

      const history = await getPanelProbeHistory({
        pool, config, logger: log, id: request.params.id, from, to, name, type, now: new Date(),
      });
      if (history === null) throw notFound(request.params.id);
      return history;
    },
  );

  // GET /api/v1/hosts/{id}/ip-history —— IP 变更时间线（区间 + 事件）
  app.get(
    '/api/v1/hosts/:id/ip-history',
    { ...hostScoped, schema: { ...hostScoped.schema, response: { 200: IP_HISTORY_SCHEMA } } },
    async (request) => {
      const limit = parseBoundedLimit(request.query?.limit, {
        field: 'limit',
        def: IP_HISTORY_DEFAULT_LIMIT,
        max: IP_HISTORY_MAX_LIMIT,
        logger: log,
      });
      const history = await getPanelIpHistory({ pool, config, id: request.params.id, limit });
      if (history === null) throw notFound(request.params.id);
      return history;
    },
  );

  // GET /api/v1/hosts/{id}/processes —— 进程总数 + Top-N（`at` 省略取最近一条）
  app.get(
    '/api/v1/hosts/:id/processes',
    { ...hostScoped, schema: { ...hostScoped.schema, response: { 200: PROCESS_SNAPSHOT_SCHEMA } } },
    async (request) => {
      const at = parseTimeParam(request.query?.at, 'at');
      if (at !== null && at.getTime() > Date.now() + 60_000) {
        // `at` 在未来 ⇒ 永远是"查不到"（返回 null 会让人以为数据缺失，其实是参数写错了）
        throw new AppError('schema_invalid', { details: { field: 'at', reason: 'in_future' } });
      }
      const snapshot = await getPanelProcessSnapshot({ pool, config, id: request.params.id, at });
      if (snapshot === null) throw notFound(request.params.id);
      return snapshot;
    },
  );
}
