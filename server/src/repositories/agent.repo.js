/**
 * Vantage · `agents` 表数据访问
 *
 * 依据：docs/database.md §5.1（agents 表结构）、§6.1（单次上报的落库顺序第 1–2 步）、
 *       §6.2（时间权威 = server_ts）
 *
 * ⛔ 只做 SQL，不做业务判断（分层：routes → services → repositories，见设计 §5.1）。
 * ⛔ `agent_key_hash` / `agent_secret_enc` 只允许在鉴权路径读取，不得进日志与响应。
 */

/**
 * 鉴权用查询：按 id 取凭证与状态。
 * ⛔ 刻意**不做进程内缓存**：凭证轮换后必须立即失效（✅ 决策 R1/R42，无宽限期），
 *    主键查询在这种小表上是亚毫秒级，缓存带来的「轮换后还能用几秒」是纯风险。
 *
 * ⚠️ 返回值里含 `agentKeyHash` / `agentSecretEnc` —— 调用方**只允许**在鉴权路径本地使用，
 *    ⛔ 不要把这个对象整体挂到 `request` 上或写进日志（会泄漏凭证哈希与密文信封）。
 *    接入层为此专门构造了一个"可安全记录"的子集，见 middleware/authAgent.js。
 *
 * @param {import('pg').Pool} pool
 * @param {string} agentId
 * @returns {Promise<null | { id: string, name: string, status: string, agentKeyHash: string, agentSecretEnc: string, lastIp: string|null, reportedIp: string|null, ipFlapping: boolean, capabilities: object|null, hostInfo: object|null, disabledAt: Date|null }>}
 */
export async function findAgentForAuth(pool, agentId) {
  const { rows } = await pool.query(
    `SELECT id, name, status, agent_key_hash, agent_secret_enc,
            last_ip, reported_ip, ip_flapping, capabilities, host_info, disabled_at
       FROM agents
      WHERE id = $1`,
    [agentId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    agentKeyHash: row.agent_key_hash,
    agentSecretEnc: row.agent_secret_enc,
    lastIp: row.last_ip,
    reportedIp: row.reported_ip,
    ipFlapping: row.ip_flapping,
    capabilities: row.capabilities,
    hostInfo: row.host_info,
    disabledAt: row.disabled_at,
  };
}

/**
 * 事务内锁定 Agent 行并取「IP 是否变化」。
 *
 * 🔑 为什么变化判定必须写在 SQL 里：`INET` 在 PG 内部是二进制形式，
 *    回读时的文本（`2001:db8::1`）与 Agent/反代传来的写法（`2001:0DB8:0:0::1`）**不一定逐字符相等**。
 *    若在 JS 里做字符串比较，真 IPv6 场景会在**每一次**上报都判成「IP 变化」，
 *    从而刷爆 ip_change_events 并触发 Flapping —— 这是最难查的一类假告警。
 *
 * `FOR UPDATE` 让同一 Agent 的并发批次串行化：否则两个批次可能各自读到同一个旧 IP，
 * 双双插入 change 事件（重复计数，直接污染 Flapping 判定）。
 *
 * @param {import('pg').PoolClient} client
 * @param {string} agentId
 * @param {string|null} remoteIp 本次连接来源 IP
 */
export async function lockAgentForReport(client, agentId, remoteIp) {
  const { rows } = await client.query(
    `SELECT id, name, status, last_ip, reported_ip, ip_flapping, flapping_since,
            capabilities, host_info,
            (last_ip IS DISTINCT FROM $2::inet) AS ip_changed
       FROM agents
      WHERE id = $1
        FOR UPDATE`,
    [agentId, remoteIp],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    lastIp: row.last_ip,
    reportedIp: row.reported_ip,
    ipFlapping: row.ip_flapping,
    flappingSince: row.flapping_since,
    capabilities: row.capabilities,
    hostInfo: row.host_info,
    ipChanged: row.ip_changed === true,
  };
}

/**
 * 落库第 1–2 步：心跳字段 + 时钟漂移 + host/capabilities 快照。
 * 语义：**只前进不倒退**（`COALESCE` 保证「本批没带」不覆盖既有值）。
 *
 * @param {import('pg').PoolClient} client
 * @param {object} input
 * @param {string} input.agentId
 * @param {Date} input.serverTs 权威时间
 * @param {number} input.agentTs Agent 侧 ts（unix 毫秒，只存 `last_agent_ts`）
 * @param {number} input.clockDriftMs agent_ts − server_ts（**负值表示 Agent 慢**）
 * @param {string|null} input.remoteIp 连接来源 IP
 * @param {string|null} input.reportedIp Agent 自报出口 IP
 * @param {object|null} input.hostInfo host 对象快照
 * @param {object|null} input.capabilities 能力声明快照
 */
export async function updateAgentAfterReport(client, input) {
  const { rows } = await client.query(
    `UPDATE agents
        SET last_seen_at   = $2,
            last_agent_ts  = $3,
            clock_drift_ms = $4,
            last_ip        = COALESCE($5::inet, last_ip),
            reported_ip    = COALESCE($6::inet, reported_ip),
            -- ⛔ 已 disable 的 Agent 不允许被一次上报「救活」成 online
            -- 反向迁移（offline → online）由这里负责；正向（online → offline）由
            -- services/offline.service.js 的定时扫描负责（上报是请求驱动的，机器掉线时没有请求进来）。
            status         = CASE WHEN status = 'disabled' THEN status ELSE 'online' END,
            host_info      = COALESCE($7::jsonb, host_info),
            capabilities   = COALESCE($8::jsonb, capabilities)
      WHERE id = $1
      RETURNING last_seen_at, status`,
    [
      input.agentId,
      input.serverTs,
      input.agentTs,
      input.clockDriftMs,
      input.remoteIp ?? null,
      input.reportedIp ?? null,
      input.hostInfo ? JSON.stringify(input.hostInfo) : null,
      input.capabilities ? JSON.stringify(input.capabilities) : null,
    ],
  );
  return rows[0] ?? null;
}

/**
 * 置 Flapping 态（✅ 决策 #39）。
 * `flapping_since = COALESCE(...)` 保证「首次进入」的时间不被后续变化刷新，
 * 否则稳定期判定的起点会一直往后滚，永远无法自然解除。
 */
export async function markIpFlapping(client, { agentId, at }) {
  await client.query(
    `UPDATE agents
        SET ip_flapping   = TRUE,
            flapping_since = COALESCE(flapping_since, $2)
      WHERE id = $1`,
    [agentId, at],
  );
}

/**
 * 签发一台新 Agent（`POST /api/v1/agents` 的落库步骤）。
 *
 * ⚠️ 本函数**只管一条 INSERT**，唯一性冲突的重试/翻译由调用方（`services/agentAdmin.service.js`）负责：
 *    「主机名重复」是**业务冲突**（409，要告诉管理员换个名字），
 *    「public_slug 撞车」是**随机巧合**（换一个 slug 重试即可）——
 *    两者的处置完全不同，而 `pg` 只给出同一个 `23505`，必须靠 `err.constraint` 区分。
 *
 * ⛔ `agent_key_hash` / `agent_secret_enc` 是**凭证材料**：本函数不返回它们，
 *    也不把它们放进日志（调用方同样不得回显）。
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @param {string} input.id 由调用方生成的 UUID（⚠️ secret 的 AAD 绑定了它，故必须先定 id 再封 secret）
 * @param {string} input.name 唯一
 * @param {string} input.publicSlug 公开标识（冲突时抛 23505，调用方换一个重试）
 * @param {string|null} input.displayName
 * @param {string[]} input.tags
 * @param {string} input.agentKeyHash HMAC-pepper 哈希（不可逆）
 * @param {string} input.agentSecretEnc AES-256-GCM 密文信封
 * @returns {Promise<{ id: string, name: string, public_slug: string, display_name: string|null, tags: string[], status: string, created_at: Date }>}
 */
export async function insertAgent(pool, input) {
  const { rows } = await pool.query(
    `INSERT INTO agents (id, name, public_slug, display_name, agent_key_hash, agent_secret_enc, tags, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'offline')
     RETURNING id, name, public_slug, display_name, tags, status, created_at`,
    [
      input.id,
      input.name,
      input.publicSlug,
      input.displayName ?? null,
      input.agentKeyHash,
      input.agentSecretEnc,
      JSON.stringify(input.tags ?? []),
    ],
  );
  return rows[0];
}

// -----------------------------------------------------------------------------
// 状态接口的只读取数（docs/server-status-api.md §3 / §4）
//
// ⛔ 本区块只做 SQL 投影，不做业务判断（分层：routes → services → repositories）。
// ⛔ 也**不做字段裁剪**：「公开侧不得出现哪些字段」由 services/status.service.js 的
//    白名单投影负责（D6）。这里若提前删掉列，私有接口就没得用了。
// -----------------------------------------------------------------------------

/**
 * 「有效状态」的 SQL 表达式 —— **全仓库唯一一份**（列表、汇总计数共用）。
 *
 * 🔑 它必须与 `services/offline.service.js` 的扫描判定式**互为反向**：
 *    那边：`last_seen_at IS NULL OR now() - last_seen_at > 阈值 → offline`
 *    这里：`last_seen_at IS NOT NULL AND now() - last_seen_at <= 阈值 → online`
 *    两侧的阈值都来自同一个 `offlineThresholdS(config)`（作为 `$1` 传进来），
 *    ⛔ 任何一侧另写一份阈值或判定，都会出现「面板说在线、库说离线」这种无法自洽的状态。
 *
 * ⚠️ 为什么阈值走参数而不是字面量：`docs/api-status.md` §4.4 与设计 §5.3 都要求
 *    「中心侧离线阈值 = 上报周期 × 倍数」只有一个来源；参数化后，改倍数只需改 env。
 *
 * ⚠️ `disabled` 优先级最高、不参与超时判定（`agents_disabled_ck` 保证它有 `disabled_at`）：
 *    被人工禁用的机器即使刚刚上报过，也仍然是 `disabled`（它是**运营状态**，不是连接状态）。
 *
 * ⚠️ 必须引用 `agents` 的别名 `a`（调用方的 FROM 子句固定用 `a`）。
 */
const EFFECTIVE_STATUS_SQL = `
        CASE
          WHEN a.status = 'disabled' THEN 'disabled'
          WHEN a.last_seen_at IS NOT NULL
           AND now() - a.last_seen_at <= make_interval(secs => $1::double precision)
            THEN 'online'
          ELSE 'offline'
        END`;

/**
 * LIKE 元字符转义（`%` `_` `\`）。
 *
 * 🔑 为什么转义放在**本文件**（SQL 的归属方）而不是调用方：`_` 在 LIKE 里是单字符通配符，
 *    不转义的话 `?q=a_b` 会把 `axb` 也搜出来、`?q=%` 会变成"匹配所有主机"。
 *    这是**静默**的行为差异（结果多了几条，没人会怀疑搜索框），所以宁可在这里做一次，
 *    ⛔ 也不能指望每个调用方都记得。
 * ⚠️ 反斜杠必须**先**处理：否则转义出来的 `\%` 会被第二步再转一次。
 */
function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 状态接口的**行投影**（列表与单机共用同一段 SQL，⛔ 不复制粘贴）。
 *
 * ⚠️ 内层必须给 `agents` 起别名 `a`（`EFFECTIVE_STATUS_SQL` 依赖它）；
 * 参数 `$1` 固定为阈值，外层查询从 `$2` 起编号。
 */
const STATUS_ROW_SOURCE = `
         SELECT a.id,
                a.name,
                a.display_name,
                a.public_slug,
                a.tags,
                a.last_seen_at,
                host(a.last_ip)      AS last_ip,
                host(a.reported_ip)  AS reported_ip,
                a.clock_drift_ms::double precision AS clock_drift_ms,
                a.ip_flapping,
                a.flapping_since,
                a.host_info,
                a.capabilities,
                COALESCE(al.firing, 0)::int AS active_alerts,
                ${EFFECTIVE_STATUS_SQL} AS effective_status,
                now() AS server_now
           FROM agents a
           -- ⚠️ LEFT JOIN + COALESCE：⛔ 不能是 INNER JOIN，否则「没有任何告警规则的主机」
           --    会从列表里整体消失（方案 §2.7 明确点名的坑）
           LEFT JOIN (
             SELECT agent_id, count(*) AS firing
               FROM alert_events
              WHERE status = 'firing'
              GROUP BY agent_id
           ) al ON al.agent_id = a.id`;

/**
 * 状态接口的取数：主机清单 + 派生状态 + 活动告警数（**一条 SQL**，⛔ 不按主机循环）。
 *
 * 🔑 排序 = 「有问题优先」（`docs/frontend.md` §4.3 / 方案 §2.8）：
 *    非在线（offline/disabled）→ 有活动告警 → 在线 → `last_seen_at DESC` 兜底。
 *    公开列表与私有列表**共用**本函数，所以两边的顺序天然一致（⛔ 不各排各的）。
 *
 * 🔑 `status` 过滤的是**派生后**的值（写在外层 WHERE 里），⛔ 不是过滤 `agents.status` 列 ——
 *    否则 `?status=online` 会把「库说 online 但其实已失联」的机器一起返回。
 *
 * ⚠️ `last_ip` / `reported_ip` 一律经 `host()` 转文本：`INET` 直接回读在 IPv6 带掩码时
 *    会给出 `::1/128` 这种带前缀长度的写法（方案 §6.6）。
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @param {number} input.thresholdS 离线阈值（秒），来自 `offlineThresholdS(config)`
 * @param {'online'|'offline'|'disabled'|null} [input.status] 过滤**派生后**的状态
 * @param {string|null} [input.tag] 标签精确匹配（走 `agents_tags_gin_idx`）
 * @param {string|null} [input.q] 名称模糊搜索的**原样文本**（≤64 由路由层校验；LIKE 转义在本函数内做）
 * @param {number} [input.limit] 上限（调用方已夹取）
 * @param {boolean} [input.includeDisabled] 是否包含 `disabled`（⛔ 公开侧传 false，见 D-禁）
 */
export async function listAgentsForStatus(pool, input) {
  const { thresholdS, status = null, tag = null, q = null, limit = 200, includeDisabled = true } = input;
  const pattern = q === null || q === undefined ? null : escapeLikePattern(q);
  const { rows } = await pool.query(
    `SELECT t.*
       FROM (
${STATUS_ROW_SOURCE}
       ) t
      WHERE ($2::text IS NULL OR t.effective_status = $2)
        AND ($3::boolean OR t.effective_status <> 'disabled')
        AND ($4::text IS NULL OR t.tags @> to_jsonb($4::text))
        AND ($5::text IS NULL
             OR t.name ILIKE '%' || $5 || '%' ESCAPE '\\'
             OR coalesce(t.display_name, '') ILIKE '%' || $5 || '%' ESCAPE '\\')
      ORDER BY (t.effective_status <> 'online') DESC,
               (t.active_alerts > 0) DESC,
               t.last_seen_at DESC NULLS LAST,
               t.name ASC
      LIMIT $6`,
    [thresholdS, status, includeDisabled, tag, pattern, limit],
  );
  return rows;
}

/**
 * 取**单台**主机的状态行（`GET /api/v1/hosts/{id}` 用）。
 * 与 `listAgentsForStatus` 共用同一段投影与同一个阈值参数，⛔ 不另写一份判定。
 * @returns {Promise<object|null>} 找不到 → `null`（路由层转 404）
 */
export async function findAgentStatusById(pool, { id, thresholdS }) {
  const { rows } = await pool.query(
    `SELECT t.*
       FROM (
${STATUS_ROW_SOURCE}
       ) t
      WHERE t.id = $2`,
    [thresholdS, id],
  );
  return rows[0] ?? null;
}

/**
 * 按**公开标识**取单台主机（`GET /api/public/hosts/{slug}/now` 用）。
 *
 * ⚠️ `effective_status <> 'disabled'` 是**必需**的过滤，不是顺手写的：
 *    公开列表不出现 `disabled` 主机，若详情能按 slug 取到它，slug 就成了
 *    「这台机被人工禁用了」的枚举口子 —— 列表与详情必须对同一批主机可见。
 *
 * @returns {Promise<object|null>} 不存在**或**已禁用 → `null`（路由层转 404，⛔ 两者不可区分）
 */
export async function findAgentStatusBySlug(pool, { slug, thresholdS }) {
  const { rows } = await pool.query(
    `SELECT t.*
       FROM (
${STATUS_ROW_SOURCE}
       ) t
      WHERE t.public_slug = $2
        AND t.effective_status <> 'disabled'`,
    [thresholdS, slug],
  );
  return rows[0] ?? null;
}

/**
 * 按**派生状态**汇总主机数（公开 `/api/public/summary` 用，一条 SQL）。
 *
 * ⚠️ 与 `listAgentsForStatus` 共用同一个 `EFFECTIVE_STATUS_SQL` 与同一个阈值参数：
 *    「列表说 3 台在线、汇总说 4 台」这类不一致只可能来自两处各写一份判定，本文件不给这个机会。
 *
 * ⚠️ `disabled` **不计入** `online` / `offline`，但必须计入 `total`
 *    （设计稿顶栏「在线 3 · 离线 1 · 禁用 1」要三个数都对）。
 *
 * @returns {Promise<{ total: number, online: number, offline: number, disabled: number }>}
 */
export async function countAgentsByEffectiveStatus(pool, { thresholdS }) {
  const { rows } = await pool.query(
    `SELECT ${EFFECTIVE_STATUS_SQL} AS effective_status, count(*)::int AS n
       FROM agents a
      GROUP BY 1`,
    [thresholdS],
  );
  const counts = { total: 0, online: 0, offline: 0, disabled: 0 };
  for (const row of rows) {
    const n = Number(row.n) || 0;
    counts.total += n;
    if (row.effective_status in counts) counts[row.effective_status] = n;
  }
  return counts;
}

/**
 * 当前 `firing` 的告警数（按规则严重度分组）。
 *
 * ⚠️ **本期恒为 0**：告警引擎在 M3（方案 §2.7）。这里刻意**照契约实现查询**而不是硬编码 0 ——
 *    M3 一落地，两个状态接口的 `alerts` 字段自动变正确，无需回头改接口。
 * ⛔ 集成测试只能断言「字段存在且为 0」，⛔ 不得写成「告警数正确」的假验收。
 */
export async function countFiringAlertsBySeverity(pool) {
  const { rows } = await pool.query(
    `SELECT r.severity, count(*)::int AS n
       FROM alert_events e
       JOIN alert_rules r ON r.id = e.rule_id
      WHERE e.status = 'firing'
      GROUP BY r.severity`,
  );
  const alerts = { critical: 0, warn: 0, info: 0 };
  for (const row of rows) {
    if (row.severity in alerts) alerts[row.severity] = Number(row.n) || 0;
  }
  return alerts;
}

/** 数据库时钟（`updated_at` 的唯一来源，⛔ 不用 Node 进程时间） */
export async function readDbNow(pool) {
  const { rows } = await pool.query(`SELECT now() AS now`);
  return rows[0]?.now ?? null;
}
