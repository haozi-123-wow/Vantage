/**
 * Vantage · Agent 上行报文契约（JSON Schema）
 *
 * 依据：docs/api.md §2.1（`POST /api/v1/agent/report` 请求体与错误码）、§2.2（heartbeat）、
 *       §1.5（字段白名单必须严格）、docs/database.md §5.7.2（指标清单与单位）、
 *       Vantage-DESIGN-v0.7.md §5.2（数组长度上限）、决策 #47（体积上限）
 *
 * ⛔ 本文件是**唯一**的字段白名单来源。三条硬规则：
 *  1. 每个 object 都必须写 `additionalProperties: false` —— Agent 侧字段漂移必须报 400
 *     而不是被静默忽略（app.js 的 ajv 已关掉 removeAdditional，两者缺一不可）；
 *  2. 数值一律给 `minimum`/`maximum`，数组一律给 `maxItems` —— 这是「零 RCE + 防炸库」的第一道闸；
 *  3. ⛔ 响应 schema 只允许 `{ok, server_ts}`（§2.3 单向宗旨的自动化防线，见 test/report.test.js）。
 *
 * ⚠️ 类型不使用 ajv-formats 的 `uuid`：它的变体位校验比 sign.js 的 UUID_RE 更严，
 *    会在测试向量/手工构造的 UUID 上产生难以解释的 400。这里统一用显式 `pattern`。
 */

/** 数组长度与字符串长度上限（与 docs/api.md §2.1 的建议值一致；改动即改契约） */
export const REPORT_LIMITS = Object.freeze({
  cpuCoresMax: 256,
  diskMax: 64,
  netMax: 64,
  gpuMax: 16,
  processTopMax: 50,
  probeMax: 64,
  hostnameMax: 253,
  osMax: 128,
  archMax: 32,
  targetMax: 512,
  probeNameMax: 128,
  probeErrorMax: 512,
  metricNameMax: 200, // 与 utils/metric.js 的 METRIC_NAME_MAX_LENGTH 一致
});

/** 与 utils/sign.js 的 UUID_RE 同形（含连字符的 36 位十六进制） */
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
/** 与 utils/ulid.js 的 ULID_RE 同形（Crockford Base32，无 I/L/O/U） */
const ULID_PATTERN = '^[0-9A-HJKMNP-TV-Z]{26}$';

/** 上限 1e18：远超任何真实计量单位，纯粹用来挡住 1e308 这类会污染聚合的输入 */
const MAX_NUMBER = 1e18;

/** 非负数（bytes / 速率 / 延迟 …） */
const nonNeg = (maximum = MAX_NUMBER) => ({ type: 'number', minimum: 0, maximum });
/** 百分比：0–100 */
const pct = { type: 'number', minimum: 0, maximum: 100 };
/** 无符号大整数（进程号、状态码之外的计数） */
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

/** 能力声明（✅ 决策 #55：`host.capabilities`，布尔白名单） */
const CAPABILITIES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: '采集器能力声明；⛔ 白名单外的键一律拒绝（docs/api.md §2.1）',
  properties: {
    'disk.inode': { type: 'boolean' },
    'disk.io': { type: 'boolean' },
    'net.conn_count': { type: 'boolean' },
    'gpu.nvidia': { type: 'boolean' },
    'gpu.amd': { type: 'boolean' },
    'process.top': { type: 'boolean' },
    'probe.ping': { type: 'boolean' },
    'probe.http': { type: 'boolean' },
    'probe.tcp': { type: 'boolean' },
    docker: { type: 'boolean' },
  },
};

/**
 * host 对象。
 * ⚠️ 本对象在 schema 里**不是**必需项（§2.1：首次上报与能力变化时必填，其余可省），
 *    「首次必须携带」这条**有状态**的约束在 services/metrics.service.js 里判（那里才知道库里有没有值）。
 */
const HOST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hostname', 'os', 'kernel', 'boot_time'],
  properties: {
    hostname: { type: 'string', minLength: 1, maxLength: REPORT_LIMITS.hostnameMax },
    os: { type: 'string', minLength: 1, maxLength: REPORT_LIMITS.osMax },
    kernel: { type: 'string', minLength: 1, maxLength: REPORT_LIMITS.osMax },
    arch: { type: 'string', minLength: 1, maxLength: REPORT_LIMITS.archMax },
    // ✅ M-5 已收窄：Agent 实现定型为「整数 unix **秒**」，这里锁死为整数。
    //    原先两种口径都收是等 Agent 定型；混口径不会报错，只会让「运行时长」在面板上差 1000 倍。
    boot_time: { type: 'integer', minimum: 0, maximum: 4102444800 }, // ≤ 2100-01-01（秒）
    capabilities: CAPABILITIES_SCHEMA,
  },
};

/** 磁盘条目 */
const DISK_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['mount'],
  properties: {
    mount: { type: 'string', minLength: 1, maxLength: 255 },
    // ➕ 可选：§5.7.2 的序列维度含 device，但 §2.1 的字段表没列它。
    //    缺失时该序列只带 mount 维度（同一 Agent 必须保持一致），见 server/README.md 开放项 M-6。
    device: { type: 'string', minLength: 1, maxLength: 64 },
    total: nonNeg(),
    used: nonNeg(),
    inode_used: pct, // ⚠️ 字段名沿用 §2.1 的 `inode_used`，语义是**百分比** → 落 disk.inode_used_pct
    read_bps: nonNeg(),
    write_bps: nonNeg(),
    read_iops: nonNeg(),
    write_iops: nonNeg(),
    latency_ms: nonNeg(),
  },
};

/** 网卡条目 */
const NET_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['device'],
  properties: {
    device: { type: 'string', minLength: 1, maxLength: 64 },
    rx_bps: nonNeg(),
    tx_bps: nonNeg(),
    rx_total: nonNeg(),
    tx_total: nonNeg(),
    conn_count: count,
    err: nonNeg(),
    drop: nonNeg(),
  },
};

/** GPU 条目 */
const GPU_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['index'],
  properties: {
    index: { type: 'integer', minimum: 0, maximum: 1024 },
    util: pct,
    mem_used: nonNeg(),
    mem_total: nonNeg(),
    temp: { type: 'number', minimum: -100, maximum: 300 },
    power: nonNeg(),
  },
};

/** 进程 Top-N 条目 */
const PROCESS_TOP_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['pid', 'name'],
  properties: {
    pid: { type: 'integer', minimum: 0, maximum: 2 ** 31 - 1 },
    name: { type: 'string', minLength: 1, maxLength: 256 },
    cpu: pct,
    mem: nonNeg(),
  },
};

/** metrics 对象（✅ §10.1；单位见 docs/database.md §5.7.2） */
const METRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // 底线：一批至少要有一个 CPU 使用率与内存总量，否则这一批没有任何可判定的时序数据
  required: ['cpu', 'mem'],
  properties: {
    cpu: {
      type: 'object',
      additionalProperties: false,
      required: ['usage'],
      properties: {
        usage: pct,
        cores: {
          type: 'array',
          maxItems: REPORT_LIMITS.cpuCoresMax,
          items: pct,
        },
        load: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: nonNeg(1e9),
        },
        ctx_switch: nonNeg(),
      },
    },
    mem: {
      type: 'object',
      additionalProperties: false,
      required: ['total'],
      properties: {
        total: nonNeg(),
        used: nonNeg(),
        available: nonNeg(),
        cached: nonNeg(),
        buffers: nonNeg(),
        swap: {
          type: 'object',
          additionalProperties: false,
          properties: { total: nonNeg(), used: nonNeg() },
        },
      },
    },
    disk: { type: 'array', maxItems: REPORT_LIMITS.diskMax, items: DISK_ITEM },
    net: { type: 'array', maxItems: REPORT_LIMITS.netMax, items: NET_ITEM },
    gpu: { type: 'array', maxItems: REPORT_LIMITS.gpuMax, items: GPU_ITEM },
    process: {
      type: 'object',
      additionalProperties: false,
      required: ['count'],
      properties: {
        count: count,
        top: { type: 'array', maxItems: REPORT_LIMITS.processTopMax, items: PROCESS_TOP_ITEM },
      },
    },
    // ✅ G10：Agent 自监控最小集（docs/agent.md §10）。
    //    落库指标名：agent.mem_rss / agent.report_failures / agent.reload_ok。
    //    `reload_ok` 线上是布尔（语义清晰），中心摊平时转成 1/0 —— 时序值只能是数字。
    agent: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mem_rss: nonNeg(),
        report_failures: count,
        reload_ok: { type: 'boolean' },
      },
    },
    // ✅ 本期固定 null（预留位，§4.2）。用 `type: 'null'` 而不是省略字段，
    //    是为了让「Agent 提前发了 docker 数据」当场报 400 而不是被静默丢弃。
    docker: { type: 'null' },
  },
};

/** 探活结果条目 */
const PROBE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type', 'target', 'up'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: REPORT_LIMITS.probeNameMax },
    // 与 probe_results_type_ck 一致（dns 为预留位）
    type: { type: 'string', enum: ['ping', 'http', 'https', 'tcp', 'dns'] },
    target: { type: 'string', minLength: 1, maxLength: REPORT_LIMITS.targetMax },
    up: { type: 'boolean' },
    latency_ms: nonNeg(),
    status_code: { type: ['integer', 'null'], minimum: 100, maximum: 599 },
    error: { type: ['string', 'null'], maxLength: REPORT_LIMITS.probeErrorMax },
  },
};

/** `POST /api/v1/agent/report` 请求体 */
export const REPORT_BODY_SCHEMA = {
  $id: 'vantage/agentReportBody',
  type: 'object',
  additionalProperties: false,
  required: ['agent_id', 'batch_id', 'ts', 'metrics'],
  properties: {
    agent_id: { type: 'string', pattern: UUID_PATTERN },
    batch_id: { type: 'string', pattern: ULID_PATTERN },
    ts: { type: 'integer', minimum: 0, maximum: 4102444800000 }, // ≤ 2100-01-01，挡住明显的单位错误
    seq: count,
    host: HOST_SCHEMA,
    // ➕ Agent 自测出口 IP（与连接来源 IP 双源比对，§8）。格式在服务层用 net.isIP 复核。
    reported_ip: { type: 'string', minLength: 2, maxLength: 45 },
    metrics: METRICS_SCHEMA,
    probes: { type: 'array', maxItems: REPORT_LIMITS.probeMax, items: PROBE_ITEM },
  },
};

/** `POST /api/v1/agent/heartbeat` 请求体（§2.2：仅心跳，无 metrics） */
export const HEARTBEAT_BODY_SCHEMA = {
  $id: 'vantage/agentHeartbeatBody',
  type: 'object',
  additionalProperties: false,
  required: ['agent_id', 'batch_id', 'ts'],
  properties: {
    agent_id: { type: 'string', pattern: UUID_PATTERN },
    batch_id: { type: 'string', pattern: ULID_PATTERN },
    ts: { type: 'integer', minimum: 0, maximum: 4102444800000 },
    seq: count,
  },
};

/**
 * 成功响应（两个端点共用）。
 * ⛔ 这是「响应体极简」的**强制**落实：schema 层就只允许这两个键，
 *    任何想往里塞 config/command/threshold 的改动都会在这里被挡下（并在测试里失败）。
 */
export const AGENT_OK_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'server_ts'],
  properties: {
    ok: { type: 'boolean' },
    server_ts: { type: 'integer' },
  },
};

/** 供路由 `schema.response` 使用（200 一档即可，错误体由全局错误处理器产出） */
export const AGENT_RESPONSE_SCHEMAS = Object.freeze({
  200: AGENT_OK_RESPONSE_SCHEMA,
});
