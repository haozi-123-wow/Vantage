# Vantage 后端 API 文档（vantage-core）

> **来源**：由《Vantage-DESIGN-v0.7.md》拆分的**后端接口契约文档**。
> **适用对象**：vantage-core 开发者、Agent 开发者（`docs/agent.md`）、面板开发者（`docs/frontend.md`）。
> **文档性质**：接口契约（路径 / 头 / 字段 / 错误码 / 语义），**不含实现代码**。
> **上位文档**：`Vantage-DESIGN-v0.7.md`（**文件内容已是 v0.8**，文件名保留以维持引用；§5、§6、§10、§18 为主）；决策以其 §15 为准（共 59 条）。
> **阅读约定**：本文中的「✅ 本轮决策 / 本轮已定」= 2026-09-26 Owner 拍板，**均已写入设计文档 v0.8**；逐条对照见 `docs/design-deltas.md`。

**标注图例**

| 标记 | 含义 |
|---|---|
| ✅ 已定 | 直接来自设计文档，不得擅自更改 |
| ➕ 建议 | 拆分时补齐的工程细节，**需 Owner 确认** |
| ❓ 待拍板 | 设计文档未定或存在冲突 |
| ⛔ | 禁止项（违反单向宗旨即视为重大缺陷） |

---

## 1. 全局约定

### 1.1 接口分区（✅ 设计 §5.4、§10.2）

| 分区 | 前缀 | 鉴权 | 说明 |
|---|---|---|---|
| Agent 接入 | `/api/v1/agent/*` | **HMAC 签名**（每机独立 key+secret） | 只接受 Agent 出站上报 |
| 面板公开 | `/api/public/*` | **免登录**、只读、只返回「当前值」快照 | 严格限流 + 脱敏（决策 #10/#21） |
| 面板私有 | `/api/v1/*` | **面板会话**（Cookie 不透明 `sid`） | 历史/配置/管理 |
| 实时 | `/ws/public`、`/ws/live` | 前者免登录，后者需登录 | WebSocket（决策 #33） |

➕ 建议：面板与反代**同源部署**（Caddy 反代 `/api` 与 `/ws`），不开启跨域 CORS；若必须跨域，只允许白名单 Origin + `credentials: true`。

### 1.2 通用请求约定（➕ 建议）

| 项 | 约定 |
|---|---|
| 字符集 | `Content-Type: application/json; charset=utf-8` |
| 时间（面板 API） | 查询参数 `from`/`to` 接受 RFC3339（含时区）或 unix 毫秒整数；**响应时间一律 RFC3339 UTC**（如 `2025-09-25T12:00:00.000Z`） |
| 时间（Agent 上报） | ✅ `ts` 为 unix 毫秒（设计 §10.1） |
| 时区 | 服务端一律 UTC；本地化时区转换在前端 |
| 分页 | ✅ 已定：`?limit=`（默认 20，上限 200）+ `?cursor=`（**不透明游标，keyset 分页**）；响应带 `next_cursor` |
| 排序 | 默认按时间倒序；需正序时 `?order=asc` |
| 版本 | 路径前缀 `/api/v1`（✅）；破坏性变更升 `/api/v2` |
| 请求 ID | 响应头 `X-Request-Id`（便于对账审计，➕ 建议） |
| 压缩 | 面板 API 支持 `Accept-Encoding: gzip`；Agent 上报使用 `Content-Encoding: gzip`（✅） |

### 1.3 统一错误模型（➕ 建议；✅ 语义来自 §5.2「默认拒绝」）

```json
{
  "error": {
    "code": "invalid_signature",
    "message": "签名校验失败（人类可读，中文）",
    "details": { "field": "X-Signature" },
    "request_id": "01J..."
  }
}
```

**HTTP 状态码使用规则**

| 状态码 | 语义 | 典型 code |
|---|---|---|
| 200 | 成功 | — |
| 201 | 创建成功（如创建 Agent / 规则） | — |
| 204 | 成功无响应体（删除类） | — |
| 400 | 请求不可解析 / 业务校验失败 | `invalid_request`、`schema_invalid`、`range_too_large`、`expr_not_allowed` |
| 401 | 未认证 / 签名失败 / 会话失效 | `signature_invalid`、`timestamp_skew`、`agent_unknown_or_disabled`、`session_expired`、`invalid_credentials` |
| 403 | 已认证但无权限 / 需二次验证 / CSRF 失败 | `role_denied`、`totp_required`、`csrf_invalid` |
| 404 | 资源不存在 | `not_found` |
| 409 | 冲突（幂等命中以外的语义冲突） | `conflict`、`already_exists`、`nonce_reused`（✅ 校正：§1.3 原把 `nonce_reused` 列在 401，与 §2.1 错误表及 §6 验收用例第 4 条的 **409** 矛盾，现统一为 409）、`channel_in_use` |
| 413 | 体积超限（含解压后超限） | `payload_too_large` |
| 415 | 不支持的编码/媒体类型 | `unsupported_content_encoding` |
| 429 | 限流 | `rate_limited`（带 `Retry-After`） |
| 500 | 服务端错误 | `internal_error` |
| 503 | 依赖不可用（PG/Redis） | `upstream_unavailable` |

> ⛔ 错误响应**不得**回显任何 Agent 配置、阈值、内部路径、脚本或可执行内容（§2.1、§10.1「响应体极简」）。

### 1.4 限流（✅ 决策 #23、§5.2；数值为 ➕ 建议）

| 维度 | Redis 键 | 建议阈值 | 超限行为 |
|---|---|---|---|
| Agent 上报 | `ratelimit:agent:<agent_id>` | 周期性上报的 2–3 倍余量（如默认 15s 上报 → 60 次/分钟） | 429 + `Retry-After` |
| 面板公开接口 | `ratelimit:public:<ip>` | 60 次/分钟 | 429 |
| 公开 WS 连接 | `ratelimit:ws:<ip>` | 并发连接数上限（如 3）+ 连接建立速率 | 拒绝握手 |
| 登录 | `ratelimit:login:<ip>` | 如 10 次/5 分钟，失败递增 | 429（不泄露账号是否存在） |
| 通知发送 | `notify:tokenbucket:<channel_id>` | 每通道独立令牌桶（✅ #23） | 排队等待，不丢弃 |

响应头（➕ 建议）：`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`、`Retry-After`。

### 1.5 中间件顺序（✅ 设计 §5.2「顺序固定」+ §6.6）

```
tls(可选 mTLS)
 → 体积上限（Content-Length / 解压输出上限，防 zip bomb）
 → gzip 解压（仅 Agent 上报路径）
 → 【Agent】取解压后原始 JSON Buffer → sha256 + HMAC 验签 →  ✱ 必须在 JSON.parse 之前
 → JSON.parse
 → schemaValidate（字段白名单 + 数值范围 + 数组长度上限）
 → rateLimit（Redis）
 → 鉴权（Agent：agent_id 一致性；面板：会话 + RBAC）
 → audit（谁在何时上报/访问了什么）
 → 业务处理
```

✅ 关键更正（v0.7 决策 #35）：签名针对**解压后的原始 JSON 字节**；`preParsing` 钩子截获原始 buffer，**先验签、后 `JSON.parse`**。Agent 端只序列化一次（同一份字节既签名又发送）。

✅ 已定（M1 实现期，补齐两处顺序口径）

1. **防重放（nonce）与幂等的先后**：`batch_id` 幂等检查排在 `nonce` 之前。理由：一次**完全相同的重传**（Agent 重试同一份已签名字节）应当得到 `{ok:true}`——数据本来就在库里；把它判成 409 会让 Agent 陷入无法完成的死循环。真正的重放（**同 nonce + 不同 batch**）依然是 409。
2. **写库失败时的占位释放**：同时删除 `batch:` 与 `nonce:` 两个键。§6.1 的建议只提到幂等键；只删它会在 Redis 里留下一个"已烧毁"的 nonce，Agent 用同一份签名重试会立刻 409，该批次永远补不上。
3. **落库失败即拒收**：Redis/PG 不可用时返回 503，⛔ 不在"限流/nonce/幂等全部失效"的状态下继续写库。

---

## 2. Agent 上报 API

### 2.1 `POST /api/v1/agent/report`（✅ 设计 §10.1）

**请求头**

| 头 | 必需 | 说明 |
|---|---|---|
| `X-Agent-Id` | ✅ | Agent UUID |
| `X-Agent-Key` | ✅ | Agent 凭证（`vk_` 前缀）。✅ 本轮修订：设计 §5.2 本来就要求校验它，本表此前遗漏 → 已补回。中心用 `agents.agent_key_hash`（HMAC-pepper）校验，**证明身份**；⛔ 命令行的 `--key` 形式仍永久禁止（决策 #37） |
| `X-Timestamp` | ✅ | unix 毫秒 |
| `X-Nonce` | ✅ | 每请求唯一随机串（➕ 建议 ≥ 16 字节随机，32 hex 字符） |
| `X-Signature` | ✅ | HMAC-SHA256 十六进制小写 |
| `Content-Encoding` | ✅ | `gzip` |
| `Content-Type` | ✅ | `application/json` |
| `User-Agent` | ➕ | `vantage-agent/<version>`，便于排障 |

**签名算法（✅ §6.2；✅ 本轮已定分隔符）**

```
canonical  = method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(raw_body)
signature  = hex( HMAC_SHA256(agent_secret, canonical) )
```

- ✅ 已定（本轮）：**固定 `\n`（LF，0x0A）作为 4 处分隔符**，末尾**不加**换行；设计 §6.2 原文未指定分隔符，此处明确化（裸拼接存在边界歧义，如 `path` 尾部数字与 `timestamp` 粘接）。
- `path`：**仅路径**（如 `/api/v1/agent/report`），⛔ 不含 host、⛔ 不含 query、⛔ 不含末尾斜杠差异（统一用路由原始路径）。
- `raw_body`：**gzip 压缩之前**的原始 JSON 字节（✅ 决策 #19）。
- `timestamp`：十进制 ASCII 的 unix 毫秒（无前导零、无引号）；`nonce`：ASCII 原样。
- ⛔ 两端必须完全一致；该规范需配套**共享测试向量**（固定 secret/body/时间戳 → 期望签名值），Agent 与 core 各跑一遍。
- 🔐 **两份凭证的分工（✅ 本轮修订）**：`X-Agent-Key` 由中心用 `agents.agent_key_hash`（HMAC-pepper 哈希）校验 → 证明**身份**；`agent_secret` 用于算 HMAC → 证明**完整性与时效**（中心侧从 `agents.agent_secret_enc` 的 AES-256-GCM 密文解出）。⚠️ 故 secret **必须可逆存储**：原 `agent_secret_hash`（只存哈希）在数学上无法验签，已改名 `agent_secret_enc`。`agent_key` / `agent_secret` 均**只上行一次**（创建/轮换响应），⛔ secret 永不作为请求头上行。

**请求体（JSON，gzip）**

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `agent_id` | string(uuid) | ✅ | 必须与 `X-Agent-Id` 一致，否则拒绝（✅ §6.4） |
| `batch_id` | string(ULID) | ✅ | 幂等键，每批唯一（✅ 决策 #18） |
| `ts` | int64 | ✅ | Agent 侧时间（unix 毫秒）；**仅用于漂移检测**（决策 #16） |
| `seq` | int64 | ➕ | 单调递增序号，便于乱序诊断（设计示例含此字段） |
| `host` | object | ✅ | `{ hostname, os, kernel, arch?, boot_time, capabilities }`；✅ 已定（本轮）：**能力声明随上报携带**——首次上报与能力变化时**必填**，其余可省；键集合建议 `{disk.inode, disk.io, net.conn_count, gpu.nvidia, gpu.amd, process.top, probe.ping, probe.http, probe.tcp, docker}` → 布尔值；⛔ 白名单外的键拒绝（400） |
| `reported_ip` | string | ➕ | Agent 自测出口 IP（设计示例含；用于双源比对 §8） |
| `metrics` | object | ✅ | 见 §2.2 |
| `probes` | array | ➕ | 本地探活结果，可为空数组（§4.6） |

**`metrics` 结构（✅ §10.1，单位见 `docs/database.md` §5.7.2）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `cpu.usage` | number | 整体使用率 % |
| `cpu.cores` | number[] | 每核使用率 %（长度上限：建议 ≤ 256）→ 落 `cpu.core.usage{core=n}` |
| `cpu.load` | number[3] | 1/5/15 分钟负载 → 落 `cpu.load1/5/15` |
| `cpu.ctx_switch` | number | 上下文切换 |
| `mem.total` / `mem.used` / `mem.available` | number | bytes |
| `mem.cached` / `mem.buffers` | number | bytes（可选） |
| `mem.swap` | object | `{ total, used }` → 落**顶层** `swap.total` / `swap.used` |
| `disk[]` | array | `{ device?, mount, total, used, inode_used, read_bps, write_bps, read_iops?, write_iops?, latency_ms? }`，上限 ≤ 64 |
| `net[]` | array | `{ device, rx_bps, tx_bps, rx_total, tx_total, conn_count?, err?, drop? }`，上限 ≤ 64 |
| `gpu[]` | array | `{ index, util, mem_used, mem_total, temp, power }`，上限 ≤ 16 |
| `process` | object | `{ count, top: [{ pid, name, cpu, mem }] }`，`top` 上限 ≤ 50（明细落 `process_snapshots`，不进时序） |
| `docker` | null | ✅ 本期固定 `null`（预留，§4.2）；⛔ 传对象会被 400 拒绝，而不是被静默忽略 |

> ✅ 已定（M1 实现期，消除 §2.1 与 `docs/database.md` §5.7.2 的两处不一致）
> 1. `disk[]` 增加可选字段 **`device`**：§5.7.2 的维度名是 `{device,mount}`，但本表的字段清单此前漏列了 `device`。
>    M1 把它设为**可选**——缺失时该序列只带 `mount` 维度（同一 Agent 必须保持一致）。
> 2. `iops?` 拆成 **`read_iops?` / `write_iops?`**：§5.7.2 登记的指标是 `disk.read_iops` 与 `disk.write_iops`，单个 `iops` 无法映射到任一序列，故不设该字段（传 `iops` 会被 400 拒绝）。
> 3. **派生指标**：`mem.used_pct` / `swap.used_pct` / `disk.used_pct` 由**中心**用同一批的分子分母就地算出（本表不含这三个百分比字段），分母缺失或为 0 时**不产出**该序列（⛔ 不写 0/NaN）。

**`probes[]` 元素**

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 与 Agent 本地 `config.yaml` 中 `probes[].name` 一致（中心无法修改，§4.6） |
| `type` | string | `ping` / `http` / `https` / `tcp` |
| `target` | string | 目标（url 或 host:port） |
| `up` | bool | 结果 |
| `latency_ms` | number | 延迟 |
| `status_code` | int/null | 仅 http(s) |
| `error` | string/null | 失败原因 |

**响应（✅ §10.1、§2.1 极简）**

```json
{ "ok": true, "server_ts": 1758800000123 }
```

⛔ 响应体**只能**包含 `ok` 与 `server_ts`；不得出现 config / command / script / url / threshold / 任何可执行字段。✅ 已定（本轮）：幂等命中时**不加** `duplicate: true`——保持响应形态恒定，重复批次由中心日志与指标体现（Agent 也无需区分）。

**错误码**

| 状态码 | code | 触发条件 |
|---|---|---|
| 400 | `invalid_request` | body 不可解析、缺必需字段、`agent_id` 与头不一致 |
| 400 | `schema_invalid` | 白名单外字段、数值超范围、数组超长 |
| 401 | `agent_unknown_or_disabled` | agent 不存在、被吊销/禁用 |
| 401 | `signature_invalid` | HMAC 不匹配，或 `X-Agent-Key` 与 `agent_key_hash` 不符 |
| 401 | `timestamp_skew` | `\|now-ts\| > 300s`（严格模式）或 > **5min 硬上限**（任何模式，✅ 决策 #17） |
| 409 | `nonce_reused` | `nonce:<agent_id>:<nonce>` 已存在（✅ 防重放） |
| 413 | `payload_too_large` | ✅ 已定：压缩前上限 **1MB** / 解压输出上限 **4MB**（超限即拒，且⛔ 不进入 `JSON.parse`，防 zip bomb） |
| 415 | `unsupported_content_encoding` | 非 gzip（或将来不在白名单内的编码） |
| 429 | `rate_limited` | Agent 限流 |
| 500 | `internal_error` | 服务端异常 |

> ✅ 时钟漂移策略：默认「**接受 + 修正 + 告警**」（不丢弃），仅 `clock_drift` 告警（阈值 60s）；**严格拒收为 opt-in**（决策 #17）。故 `timestamp_skew` 在默认模式下**仅在超过 5min 硬上限**时出现。

### 2.2 `POST /api/v1/agent/heartbeat`（✅ 可并入 report）

- ✅ 设计 §10.2：可并入 `report`；本文约定**允许**该端点，body 仅 `{agent_id, batch_id, ts, seq?}`，用途是「无变更时只报心跳」（§4.3 网络开销目标）。
- 语义：更新 `last_seen_at`/`last_ip`/漂移，不写指标；其余（签名、幂等、响应体、错误码）与 `report` **完全一致**。
- ➕ 建议：心跳单独设限流桶（间隔更长，如 60s），仍复用 `ratelimit:agent:<id>`。✅ 已定（本轮）：**保留该端点**（不并入 report），限流**共用** Agent 桶。

### 2.3 ⛔ 明确不存在的接口（单向宗旨，✅ §2.1、§10.2）

以下端点**永不存在**，任何 PR 中出现即视为违规：

- `GET /api/v1/agent/config`、`GET /agent/tasks`、`GET /agent/commands`
- `POST /api/v1/agent/command`、`/restart`、`/exec`、`/script`、`/upgrade` 等任何下发/执行类
- 任何由中心**主动**向 Agent 发起的连接（Agent 只出站）

**复核方式**（✅ §13 安全清单）：中心代码零下发路径；上报响应的 schema 只允许 `{ok, server_ts}`；对外无法解释为下发的字段必须删除。

---

## 3. 面板公开 API（`/api/public/*`，免登录）

### 3.1 可见性与脱敏（✅ §5.4、决策 #10/#21）

| 内容 | 公开 | 需登录 |
|---|---|---|
| 主机列表 + 在线/离线状态 | ✅ | |
| 当前指标快照（CPU/内存/磁盘/网络/GPU） | ✅ | |
| 探活当前 up/down 概览 | ✅ | |
| 汇总计数（在线/离线/告警数） | ✅ | |
| 历史曲线 / 历史查询 | ❌ | ✅ |
| IP 变更历史、进程 Top、审计日志 | ❌ | ✅ |
| 告警规则配置、Agent 管理、密钥操作 | ❌ | ✅ |

⛔ 公开接口**绝不**返回：真实 IP、内网拓扑、`agent_key`/`secret`、其他 Agent 的内部标识、配置、阈值、审计信息（§5.4、决策 #21）。

✅ 已定（本轮）：公开接口中的主机标识使用**独立的 `public_slug`**（`agents.public_slug`，创建 Agent 时生成的随机短 ID，与内部 UUID 无关，见 `docs/database.md` §5.1）——这满足了 §5.4「绝不泄露 key/内部 ID」，同时把 §10.2 的 `GET /api/public/hosts/:id/now` 中的 `:id` 明确为 **slug**。⛔ 公开列表**不返回内部 UUID**；`public_slug` 不随 `name`/`display_name` 变化。
➕ 建议：公开视图的 `last_seen_at` 只暴露**相对化描述**（如 `"2 分钟前"`）或分钟级取整，避免精确到毫秒的行为指纹。
➕ 建议：显示名优先取 `display_name`，其次 `name`（决策 #21「支持自定义显示名」）。

### 3.2 端点（✅ §10.2）

| 方法 | 路径 | 说明 | 响应要点 |
|---|---|---|---|
| GET | `/api/public/summary` | 汇总计数 | `{ total, online, offline, alerts: { critical, warn, info }, updated_at }` |
| GET | `/api/public/hosts` | 主机列表 | 每项 `{ slug, name(显示名), status, os?, uptime?, snapshot: { cpu_pct, mem_pct, disk_pct, net_rx_bps, net_tx_bps, gpu_pct? }, probes: { up, down }, last_seen_ago }` |
| GET | `/api/public/hosts/{slug}/now` | 单机当前快照 | 同上 `snapshot` 的展开 + 分区/网卡/GPU 数组（**不含 IP、不含设备内网标识**——设备名建议泛化为 `disk 1..n` / `eth 1..n`，➕ 建议） |
| GET | `/api/public/probes` | 探活当前概览 | `[{ slug, name, target_host(脱敏：仅域名/泛化), type, up, latency_ms, checked_at }]` |

**缓存与限流（✅ §5.4「带缓存与限流」；➕ 参数为建议）**

- 服务端缓存：`snapshot:agent:<id>`（TTL 5–15s，与上报周期 15s 对齐）；
- 响应头：`Cache-Control: no-store`（避免中间层/CDN 缓存过期或跨用户数据）；
- 限流：`ratelimit:public:<ip>`，建议 60 次/分钟；
- 整体开关：`public_view.enabled`（✅ §5.4）；✅ 已定（本轮）：**默认开启**（装好即可免登录查看当前状态，符合决策 #10 初衷）；关闭时**所有** `/api/public/*` 与 `/ws/public` 返回 404（不泄露「存在但被关闭」）。
- ⚠️ 默认开启的配套要求（必须同时做到）：① 公开接口与 `/ws/public` 按 IP **严格限流**（`ratelimit:public:*`、`ratelimit:ws:*`）；② 严格脱敏（§3.1 的 ⛔ 清单）；③ 设置页给出醒目状态与「一键关闭」；④ 首次登录后引导复核该开关（`docs/frontend.md` §4.6）。

---

## 4. 面板私有 API（`/api/v1/*`，需登录）

### 4.1 会话与二次验证（✅ §18.1、决策 #31/#32）

**Cookie**：仅存不透明 `sid`（256-bit 随机）；`HttpOnly + Secure + SameSite=Lax`（可选 `__Host-` 前缀）。⛔ 不得在 Cookie 或响应体中放用户资料、角色以外的任何敏感信息。

**会话状态**（Redis `session:<sid>`）：`{ user_id, roles, totp_ok, created_at, last_seen, ip, ua, csrf }`。
> ✅ 本轮决策补充：字段名沿用设计 §18.1 的 `roles`（数组），但权限**暂时只有两级**，故其值恒为 `["admin"]` 或 `["user"]` 单元素数组——保持数组形态是为了将来扩为多角色时不破坏 API 与前端。
**生命周期**：滑动 30min + 绝对 24h；同账号限并发 3（超限踢最旧）；IP/UA **只记录不强制校验**。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/auth/login` | body `{username, password}`；成功 → `Set-Cookie: sid=...` + `{ user, roles, csrf, totp_required: false }`；若启用 TOTP → `{ totp_required: true, csrf }` 且会话 `totp_ok=false`（此时其余接口返回 403 `totp_required`） |
| POST | `/api/v1/auth/2fa/verify` | body `{code}`（TOTP 6 位）；成功后**轮换 sid**（防固定，✅ 决策 #32）并置 `totp_ok=true` |
| GET | `/api/v1/auth/me` | 返回 `{ user, roles, session: { created_at, last_seen, ip, ua }, csrf }`（前端启动时调用，用于恢复登录态并取 CSRF） |
| POST | `/api/v1/auth/logout` | `DEL session:<sid>` + 清 Cookie |
| POST | `/api/v1/auth/logout-all` | 删除 `user_sessions:<uid>` 内全部 sid（✅「全部下线」） |
| POST | `/api/v1/auth/password` | body `{old_password, new_password}`；成功 → 轮换 sid + 踢其它会话 + 审计 |
| POST | `/api/v1/auth/2fa/setup` | ✅ 已定（本轮：面板自助绑定）：生成 secret（加密存 `users.totp_secret_enc`，此时 `totp_enabled=false`）→ 返回 `{ secret, otpauth_uri, qr_svg }`；⛔ 未通过 verify 前不生效 |
| POST | `/api/v1/auth/2fa/enable` | ✅ body `{ code }`（TOTP 6 位）→ 校验通过置 `totp_enabled=true`；失败 400 `invalid_totp` |
| POST | `/api/v1/auth/2fa/disable` | ✅ body `{ password }`（**密码二次确认**）→ 置 `totp_enabled=false` 并清空 secret；写审计 |
| POST | `/api/v1/auth/2fa/recovery/regenerate` | ✅ 已定（本轮：渠道一，自助）：生成 **10 个一次性恢复码**，明文仅返回一次，库里只存哈希；重新生成**立即作废旧码** |
| POST | `/api/v1/auth/2fa/recovery/verify` | ✅ 已定（本轮）：受限态下用**恢复码**替代 TOTP 验证码 → 通过则轮换 sid 并置 `totp_ok=true`，**该码立即作废**；响应附 `remaining_recovery_codes`（建议 ≤2 时前端强提示重新生成） |

> ✅ 已定（本轮）**强制策略**：配置 `security.require_2fa=true` 时，未绑定 TOTP 的账号登录后进入**受限态**（与 `totp_ok=false` 同一机制）——只放行 2FA 绑定接口与 `auth/me`，其余接口一律 403 `totp_setup_required`，前端引导到绑定页；⛔ 不允许跳过。

**CSRF（✅ 依据 §18.1 会话 hash 含 `csrf`）**：所有**状态变更**请求（POST/PATCH/DELETE）必须带 `X-CSRF-Token`，值取自登录/`me` 响应；不匹配 → 403 `csrf_invalid`。

**登录失败**：统一返回 401 `invalid_credentials`（**不区分**账号不存在/密码错误），并计入 `ratelimit:login:<ip>`。

**SSO（OIDC）本期不做，仅预留（✅ 本轮决策）**

- `users` 表已预留 `oidc_issuer` / `oidc_subject` / `oidc_email` / `oidc_linked_at` / `oidc_last_sync_at`（见 `docs/database.md` §5.3）；本期**不实现** OIDC 流程，**不开放** `/api/v1/auth/oidc/*` 端点。
- 预留形态（后续对接时按此实现）：`GET /api/v1/auth/oidc/start`（302 跳 IdP authorize，携带 `state` + `nonce` + PKCE）、`GET /api/v1/auth/oidc/callback`（校验 `state` 与 `id_token` → 按 `(oidc_issuer, oidc_subject)` 定位 `users` → 复用同一套 Redis `sid` 会话机制）、`POST /api/v1/auth/oidc/link` / `unlink`（已登录用户自助绑定/解绑）。
- ❓ 后续待定：是否允许 SSO 自助注册、IdP 的 group/role claim 如何映射到 `admin`/`user`（`docs/database.md` §12.2 N3）。
- ⛔ 红线：OIDC 只用于**面板登录**，不得成为「向 Agent 下发」的通道（`docs/api.md` §2.3、设计 §18.3）。

### 4.2 主机（需登录，含 IP 与历史）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/hosts` | 列表；过滤 `?status=online\|offline\|disabled&tag=&q=&limit=&cursor=`；每项含 `id, name, display_name, tags, status, os, arch, last_seen_at, last_ip, reported_ip, clock_drift_ms, ip_flapping, active_alerts, snapshot` |
| GET | `/api/v1/hosts/{id}` | 详情：主机信息 + `host_info` + `capabilities` + 当前快照 + 探活当前状态 |
| GET | `/api/v1/hosts/{id}/metrics` | 时序查询，见 §4.3 |
| GET | `/api/v1/hosts/{id}/probes` | 探活历史：`?from&to&name=&type=` → `[{ probe_name, probe_type, target, up, latency_ms, status_code, error, checked_at }]`；另返回每个 probe 的当前状态摘要 |
| GET | `/api/v1/hosts/{id}/ip-history` | `?from&to` → `{ ranges: [{ ip, source, first_seen, last_seen }], events: [{ old_ip, new_ip, same_subnet, source, kind, change_count, changed_at }] }`（✅ §8 展示「当前 IP + 变更时间线」） |
| GET | `/api/v1/hosts/{id}/processes` | `?at=<ts>`（省略取最近一条）→ `{ ts, total, top: [{ pid, name, cpu, mem }] }`（✅ 需登录） |

### 4.3 时序查询 `GET /api/v1/hosts/{id}/metrics`（✅ §10.2，参数为 ➕ 建议）

**查询参数**

| 参数 | 必需 | 说明 |
|---|---|---|
| `metrics` | ✅ | 逗号分隔，元素可为**基名**或**全名**：`cpu.usage,mem.used_pct,disk.used_pct`（基名 = 该基名下**全部维度序列**，如所有挂载点）或 `disk.used_pct{mount=/data}`（全名 = 单一序列）。✅ 命名与转义规范见 `docs/database.md` §5.7.2（**已定：维度写进指标名**） |
| `from` / `to` | ✅ | 时间范围 |
| `step` | ➕ | `auto`（默认）/ `15s` / `1m` / `5m`；不允许其它值（防止对原始层做任意聚合） |
| `agg` | ➕ | `avg`（默认）/ `max` / `min`（仅降采样层支持 `min/max`） |

➕ 基名展开的实现口径：`metric = :base` **或** 前缀命中，建议用**区间比较**而非 LIKE——`metric >= base || '{' AND metric < base || '}'`（避免 `%`/`_` 通配符转义问题；基名本身不含这两个字符）。

**档位与范围约束（➕ 建议，须在实现中硬校验）**

| step | 数据源 | 允许的最大范围 | 说明 |
|---|---|---|---|
| `15s` | `metrics_raw` | ≤ 6 小时 | 原始层仅保留 15 天，但窗口过大代价高 |
| `1m` | `metrics_1m` | ≤ 30 天 | |
| `5m` | `metrics_5m` | ≤ 1 年 | 长周期图表只查降采样层（✅ 设计 §9） |

`step=auto` 时由服务端按范围选档并在响应中回传**实际** step；超过最大范围 → 400 `range_too_large`（推荐前端先请求 `5m`）。
➕ 建议：单请求**展开后** series 数 ≤ 20、单 series 点数 ≤ 2000，超限返回 400（防图表卡死与 DB 压力）；基名展开过多时前端应先收窄维度。

**响应（➕ 建议格式，适配 ECharts）**

```json
{
  "step": "1m",
  "from": "2025-09-25T00:00:00.000Z",
  "to": "2025-09-25T06:00:00.000Z",
  "series": [
    { "metric": "disk.used_pct{device=sda1,mount=/data}", "base": "disk.used_pct",
      "labels": { "device": "sda1", "mount": "/data" }, "unit": "%",
      "points": [[1758758400000, 12.3], [1758758460000, 13.1]] }
  ]
}
```

- `metric` = **权威序列全名**；`base` = 基名（前端按它分组）；`labels` = 由全名反解出的维度对象（**不等同于**公开视图的脱敏要求——这里已登录）。
- `points` 用 `[ts_ms, value]` 二元数组压缩体积；缺失桶**不补 0**，由前端按 `null` 断线处理（避免把采集缺失画成 0）。
- `n`（桶内样本数）可选用 `?include_n=true` 返回，供前端标注数据完整度（`docs/frontend.md`）。

### 4.4 Agent 与凭证管理（需登录，✅ 仅 `admin`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/agents` | 列表：`status`、`rotated_at`、`credential_age_days`（= `now()-COALESCE(rotated_at,created_at)`）、`rotate_recommended`（✅ 本轮决策：超阈徽标）、`last_seen_at`、`last_ip`；响应根级附 `rotate_policy: { days, notify }`（阈值由后端下发，⛔ 前端不硬编码） |
| POST | `/api/v1/agents` | body `{name, display_name?, tags?}` → 201 返回 `{ id, public_slug, agent_key, agent_secret, install_hint }`；✅ **`install_hint` = 带 key 的一键命令（`VANTAGE_KEY` 环境变量内联形式）+ 交互式/`--key-file` 两种替代形式**（✅ 本轮修订：见下方「决策 #37 修订」）；`agent_key`/`agent_secret` **同时单独返回一次**；⛔ 明文仅此一次可取得，之后永不可再取（✅ §6.1）；`name` **唯一**，重名 → 409 `already_exists` |
| GET | `/api/v1/agents/{id}` | 元信息（⛔ 不含任何明文或哈希） |
| PATCH | `/api/v1/agents/{id}` | 改 `display_name` / `tags`（`name` 变更需同样过唯一性校验） |
| POST | `/api/v1/agents/{id}/rotate` | **手动轮换**（✅ 本轮决策）：返回**新** key/secret（明文仅一次）→ **旧凭证立即失效**（⛔ 无并存过渡期）；中心无法下发新 key，管理员须自行上机替换 key 文件后 `reload`/`restart`（`docs/agent.md` §6）；替换窗口内该机上报 401 → 会被判离线告警 |
| POST | `/api/v1/agents/{id}/disable` \| `/enable` | 禁用/启用（禁用后上报一律 401） |
| POST | `/api/v1/agents/{id}/revoke` | 吊销（不可恢复，`disabled_at` 落库，保留历史） |

**到期提醒（✅ 本轮决策：不自动轮换，只提醒）**

- 面板：列表/详情展示 `credential_age_days` + `rotate_recommended` 徽标（前端见 `docs/frontend.md`）。
- 阈值**可配**（✅ 本轮决策）：`credential_rotate.reminder_days`（✅ 存 `settings` 表，面板可改、立即生效，默认 **90** 天），面板徽标与服务端通知共用同一阈值；`GET /api/v1/agents` 响应根级附带 `rotate_policy: { days, notify }`，由后端下发、⛔ 前端不硬编码。
- 通知：core **每日一次**扫描超阈 Agent → 复用 `channels` 通道提醒管理员（✅ 决策 #23），`rotate_reminder_at` 按日期去重、未处理则次日继续；⛔ 提醒内容不含任何凭证；⛔ 不存在「自动轮换」开关。
- ➕ 可选：`POST /api/v1/agents/{id}/rotate-reminder/test`（手动触发一次提醒，便于验证通道是否配好）——❓ 是否需要待定。

> ✅ **决策 #37 修订（本轮 Owner 决定）**：设计 §12.3 要求「生成 key → 拼装成**安装命令**」，§12.2/决策 #37 又「禁用命令行传 key」。本轮裁定为——
> 1. ✅ 面板**默认给出一条带 key 的一键命令**，使用 **`VANTAGE_KEY=<key>` 环境变量内联**形式（并同时给出交互式/stdin 与 `--key-file` 两种更安全形式，供用户二选一）；
> 2. ✅ 面板**同时单独展示一次** `agent_key` / `agent_secret` 明文（便于手工写入受限文件）；
> 3. ⛔ **仍然禁止 `--key <明文>` 参数形式**（`ps` / `/proc/$PID/cmdline` 对同机低权用户可见）；
> 4. ⚠️ 面板必须标注风险与善后：env 形式会进 **shell history**，root 可读 `/proc/$PID/environ`；脚本落地后即时 `unset`，建议用户 `history -d` 清理或改用 `--key-file`；
> 5. ✅ **已同步**：设计文档 **v0.8** 的 §12.2、§13 安全清单与决策 #37 已按此措辞修订（`docs/agent.md` §6.1/§12.1 亦已同步）。
> 6. 轮换接口（`POST /api/v1/agents/{id}/rotate`）返回结构同上（同样给一键命令 + 明文各一次）。

### 4.5 告警规则（✅ §7.1：受控阈值 DSL，零 RCE）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/alert-rules` | 列表（`?enabled=&kind=`） |
| POST | `/api/v1/alert-rules` | 创建，见下 |
| GET/PATCH/DELETE | `/api/v1/alert-rules/{id}` | 读/改/删 |
| POST | `/api/v1/alert-rules/{id}/dry-run` | ➕ 建议：对最近历史数据试算，返回「若启用会触发几次」（不发送通知） |

**请求体字段（✅ §7.1）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 规则名 |
| `target` | object | `{ agents: [id] }` / `{ tags: [..] }` / `{ all: true }` |
| `kind` | string | `threshold` / `offline` / `ip_change` / `probe` / `clock_drift` |
| `metric` | string | 仅 `threshold`：**基名或全名**（`docs/database.md` §5.7.2）——✅ 已定：基名＝对该基名下**每个维度序列分别判定**（每个挂载点各判一次，各自产生事件），全名＝只判该单一序列；UI 的「全部维度/指定维度」开关直接映射为传基名/传全名，⛔ 不新增 `dimension_mode` 字段 |
| `op` | string | 仅 `threshold`：`>` `>=` `<` `<=` |
| `threshold` | number | 阈值 |
| `duration` | int | 持续时长（秒），§7.1 `for` |
| `severity` | string | `info` / `warn` / `critical` |
| `channels` | string[] | ✅ 已定：**通道 id 数组**（引用 `channels.id`，见 `docs/database.md` §5.4）；通道是凭证/模板的唯一归属方，⛔ 规则不内联通道参数；通道 `enabled=false` 时保留关联但跳过发送（`notification_log` 记 `channel_disabled`） |
| `cooldown` | int | 静默期（秒） |
| `enabled` | bool | 开关 |
| `params` | object | ✅ 已定：非阈值类规则的参数统一放这里、**按 `kind` 白名单校验**（未知键 → 400 `schema_invalid`）：`probe{probe_name?,probe_type?,cond,latency_ms?,status_codes?}` / `ip_change{mode:any\|subnet\|frequent,window_s?,changes?}` / `offline{cycles?}` / `clock_drift{threshold_ms?}`；阈值类传 `{}`。完整规格见 `docs/database.md` §5.11 |
| `expr` | string/null | ✅ 扩展位；**本期必须为 `null`**，传非空 → 400 `expr_not_allowed`（零 RCE，§7.1） |

**校验规则**：`kind`/`op`/`severity` 枚举校验；`threshold` 数值范围（如 `-1e12 ~ 1e12`）；`duration ≥ 0`；`cooldown ≥ 0`；`target` 三种形态互斥；任何字段含脚本/表达式语义一律拒绝。

> ✅ 静默窗口 / 维护期（§7.1）单独见 §4.7 `silences`。

### 4.6 告警事件与通知通道

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/alert-events` | `?status=firing\|resolved&severity=&agent_id=&rule_id=&metric=&from&to&limit&cursor` → 事件列表（含 `metric`（**触发序列全名**，✅ 本轮决策，用于区分同一规则的不同挂载点）、`value`、`started_at`、`resolved_at`、`notified_at`） |

> ✅ 已定（本轮）：**不引入事件 `ack`（认领）语义**——「别再报」用静默窗口/维护期（§4.7 `silences`）与规则 `cooldown` 覆盖；⛔ 不加 ack 字段与按钮。
> 📌 相关：事件列表的 `metric` 字段让同一规则在不同挂载点/网卡上的触发**各自成条**（点击可看该序列的当前值；前端用 `labels` 渲染可读名）。
| GET | `/api/v1/alert-events/{id}` | 详情 + 该事件的 `notification_log` 数组（发送结果，✅ §7.3） |
| GET | `/api/v1/channels` | 通道列表（✅ §7.2）；⛔ 敏感字段（SMTP 密码、加签 secret、Webhook token）**只回遮罩值**（如 `smtp_pwd: "****"`） |
| POST | `/api/v1/channels` | 创建通道：`{kind, name, config, template, rate_limit?, enabled}`；`kind` ∈ `smtp`/`wecom`/`dingtalk`/`feishu`/`webhook`（✅ §7.2） |
| PATCH/DELETE | `/api/v1/channels/{id}` | 更新/删除；`config` 采用**部分更新**（未提交的敏感字段保持原值）；✅ 删除仍被规则引用的通道 → 409 `channel_in_use`（须先解绑，⛔ 不级联删规则） |
| POST | `/api/v1/channels/{id}/test` | 发送测试消息（✅「可测发送」），结果记入 `notification_log` 并返回 `{ok, error?}` |
| GET | `/api/v1/notification-log` | ➕ 建议：`?event_id=&channel=&ok=&from&to` 排障用 |

### 4.7 静默窗口 / 维护期（✅ §7.1）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/silences` | `?active=true` 过滤生效中 |
| POST | `/api/v1/silences` | `{name, target, starts_at, ends_at}`（`target` 与规则同构） |
| DELETE | `/api/v1/silences/{id}` | 取消 |

### 4.8 审计日志（✅ §13，需登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/audit-logs` | `?from&to&actor=&actor_type=&action=&target=&limit&cursor` → `[{id, actor, actor_type, action, target, ip, detail, ts}]`（`detail` 已脱敏） |

### 4.9 权限（RBAC，✅ 本轮决策：**暂时两级**）

| 角色 | 允许 |
|---|---|
| `user`（普通用户） | 全部 **GET**（含历史曲线、IP 变更、进程 Top、审计日志、告警事件） |
| `admin`（管理员） | `user` 的全部读权限 **+** 告警规则/通道/静默 的写操作 **+** Agent 创建/轮换/禁用/吊销 **+** 用户管理（分配 `role`）+ `public_view.enabled` 开关 |

- ✅ 决策：本期**只有这两级**（`users.role` 单值字段，见 `docs/database.md` §5.3）；原设计的「只读/运维/管理员」三级**暂不实现**——需要时再扩（届时权限判定改为角色集合判定，接口形态不变）。
- ✅ 已定：`user`（普通用户）**纯只读**——所有写操作仅 `admin`；不需要为「降级只写告警配置」之类的中间态设计权限（`docs/database.md` §5.3）。
- 越权 → 403 `role_denied` + 写审计；前端按 `role` 隐藏写按钮（`docs/frontend.md`）。
- 用户管理接口（➕ 建议，仅 `admin`）：`GET/POST /api/v1/users`、`PATCH /api/v1/users/{id}`（改 `role`/`display_name`/`status`）、`POST /api/v1/users/{id}/password-reset`；⛔ 任何接口都不得返回 `password_hash`/`totp_secret_enc`。
- ✅ 已定（本轮：恢复渠道二，管理员后台）`POST /api/v1/users/{id}/2fa/reset`：清空目标用户 `totp_enabled=false`、`totp_secret_enc=NULL`，**作废其全部恢复码**，**强制踢下线该用户所有会话**，写审计（`action=user.2fa_reset`）；⛔ 不允许经该接口读取或导出任何 TOTP 密钥；前端须二次确认（输入用户名）。

### 4.10 系统设置 `settings`（✅ 本轮决策：面板可改、立即生效）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/settings` | 返回全部设置项（`{ key, value, updated_by, updated_at }` + 每项的**类型与默认值**供前端渲染）；`user` 可读（面板需要显示公开视图状态） |
| PATCH | `/api/v1/settings` | 仅 `admin`；body 为部分更新 `{ "public_view.enabled": false, ... }`；⛔ **未知 key → 400 `unknown_setting`**（白名单）；类型不符 → 400 `invalid_setting_value`；成功返回更新后集合，**立即生效**（无需重启） |

**白名单与默认值**（与 `docs/database.md` §5.4 一致）

| key | 类型 | 默认 |
|---|---|---|
| `public_view.enabled` | bool | **true**（✅ 本轮决策） |
| `security.require_2fa` | bool | false |
| `credential_rotate.reminder_days` | int | 90 |
| `credential_rotate.notify` | bool | true |

- ✅ 每次变更写审计（`action=settings.update`，`detail` 含 key/旧值/新值，⛔ 不含密钥）。
- ⛔ 该接口**不承载**通道密钥、TOTP 密钥等任何敏感值（分别在 `channels` / 用户 2FA 接口）。
- ➕ 建议：变更后向在线 WS 广播 `delta{channel:"settings"}`，让已打开的面板即时刷新。
- 📌 `/api/v1/agents` 响应里的 `rotate_policy` 即由 `credential_rotate.*` 派生（`docs/frontend.md` §4.6）。

---

## 5. WebSocket 协议（✅ §18.2、决策 #33）

### 5.1 频道与握手

| 频道 | 鉴权 | 内容 |
|---|---|---|
| `/ws/public` | 免登录 | 只读、**脱敏**（无 IP/内网/历史/进程），严格限流 |
| `/ws/live` | 需登录（Cookie `sid`，且 `totp_ok=true`） | 全量（历史/详情所需字段） |

- ✅ 握手校验 `Origin` 白名单（防跨站 WS 劫持）；`/ws/live` 校验 Cookie 会话有效性。
- ✅ 反代需放行 `Upgrade` / `Connection: upgrade`，且读超时 > 保活间隔。
- ✅ 限流：`ratelimit:ws:<ip>`。

### 5.2 消息格式（➕ 建议的具体编码，语义 ✅ §18.2）

**连接建立后服务端立即推送全量快照**

```json
{ "type": "snapshot", "ts": 1758800000123,
  "hosts": [ { "id": "...", "status": "online", "snapshot": { "...": "..." } } ],
  "summary": { "total": 5, "online": 4, "offline": 1, "alerts": 0 } }
```

**客户端 → 服务端（✅ 已定：应用层只允许 `subscribe`）**

```json
{ "type": "subscribe", "channels": ["hosts","probes","alerts"], "agents": ["*"] }
```

- ✅ 已定（本轮）：**应用层只接受 `subscribe`**（`agents: ["*"]` 或具体 id 数组；`channels` 缺省＝全部）。它只影响本连接收到哪些 delta，⛔ 不携带任何指令语义。
- ✅ **保活走协议层帧**：服务端定时发送 WebSocket **ping 帧**（RFC 6455），浏览器**自动回 pong 帧**（JS 不参与，无需应用层消息）；服务端用 `ws` 库的 `pong` 事件判活。这样客户端→服务端的应用层消息面收敛为**一条**。
- ⛔ 收到任何非 `subscribe` 的应用层消息 → 立即关闭连接（`1008 policy violation`）并记审计；这是「WS 不得成为下发通道」在协议层的最小化落实（✅ §18.3）。

**服务端 → 客户端增量 delta（单机/单指标粒度）**

```json
{ "type": "delta", "ts": 1758800015000, "channel": "metrics",
  "agent_id": "...", "metrics": { "cpu.usage": 12.4, "mem.used_pct": 63.2 } }
{ "type": "delta", "channel": "status", "agent_id": "...", "status": "offline", "last_seen_at": "..." }
{ "type": "delta", "channel": "probes", "agent_id": "...", "probe": { "name": "site-health", "up": false } }
{ "type": "delta", "channel": "alerts", "event": { "id": 1, "rule_id": "...", "severity": "warn", "status": "firing" } }
```

> 服务端→客户端**不做**应用层 ping；保活由协议层帧完成（见上），因此这条消息类型表里**不存在** `ping`/`pong`。

### 5.3 语义约束

| 项 | 约定 |
|---|---|
| 扇出 | Agent 上报 → 落库 → `PUBLISH live:metrics`（Redis Pub/Sub）→ 各 WS 连接广播（✅ §18.2；Pub/Sub 不持久化，与「不补传」一致） |
| 顺序 | 先 `snapshot` 后 `delta`；掉线期间的 delta **不补**（✅ 无断点续传） |
| 保活 | 服务端定时发**协议层 ping 帧**；超时未收到协议层 `pong` 帧即断开并清理（✅ 本轮决策） |
| 重连 | 前端指数退避重连，重连成功即**重新拉全量快照**（✅） |
| 脱敏 | `/ws/public` 的 `snapshot`/`delta` 与公开 REST 一致（无 IP/内网、仅别名+状态+指标概览） |
| 多实例 | 因走 Pub/Sub，core 多实例/多 worker **零改动**（✅） |

---

## 6. 请求示例与验收用例（供联调）

### 6.1 Agent 上报链路（必须覆盖）

1. **正常**：合法签名 → 200 `{ok:true, server_ts}`，PG 出现该批数据，`agents.last_seen_at` 更新，`live:metrics` 有 PUBLISH。
2. **重复批次**：同 `batch_id` 连发 2 次 → 第二次不入库、仍 200，行数不变（✅ 决策 #18）。
3. **篡改 body**：改 1 字节 → 401 `signature_invalid`（✅ 验签在 `JSON.parse` 之前）。
4. **nonce 重放**：同 nonce 不同 body → 409 `nonce_reused`；600s 后同 nonce 可再用（✅ 决策 #36）。
5. **时间越窗**：`ts` 偏 6 分钟 → 401 `timestamp_skew`（> 5min 硬上限，任何模式）；偏 2 分钟 → 默认模式**接受**并产生 `clock_drift` 告警（决策 #17）。
6. **zip bomb / 超大包**：解压输出超上限 → 413，且**不进入 JSON.parse**（✅ §6.6）。
7. **schema 越界**：多加一个未声明字段 → 400 `schema_invalid`（✅ 白名单）。
8. **跨机越权**：`agent_id` 用别的 Agent → 400 拒绝 + 审计（✅ §6.4）。
9. **IP 变化**：换 IP 上报 → `ip_change_events` 新增 1 条；10 分钟内变化 > 3 次 → 只记 1 条 `flapping` 且**不触发** IP 变化告警（✅ 决策 #39）。
10. **响应体纯净**：断言响应 JSON 的键集合**恰为** `{ok, server_ts}`（⛔ 单向宗旨回归用例，✅ §13）。

### 6.2 面板链路（必须覆盖）

1. 未登录访问 `/api/v1/hosts` → 401 `session_expired`。
2. 登录 + 2FA 未完成时访问业务接口 → 403 `totp_required`。
3. 状态变更缺 `X-CSRF-Token` → 403 `csrf_invalid`。
4. 登录成功 / 2FA 通过 / 改密后 `sid` **必须变化**（防会话固定，✅ 决策 #32）。
5. 第 4 个并发登录 → 最旧会话被踢（✅ 决策 #32）；`logout-all` 后全部 401。
6. `role='user'`（普通用户）的账号 POST 规则 → 403 `role_denied` + 审计。
7. `/api/public/*` 响应体断言**不含** `last_ip`/`reported_ip`/内部 UUID/`agent_key`（⛔ 决策 #21）。
8. 关闭 `public_view.enabled` → 公开接口全部 404。
9. `metrics?from&to` 超出该 step 允许范围 → 400 `range_too_large`；`step=auto` 回传实际档位。

---

## 7. 待 Owner 拍板清单（API 视角）

> ✅ **本清单已清空**：A1–A14 全部拍板（下表逐条标注结论与落点）。唯一保留的开放项是 **A13 的 SSO 对接细节**（`docs/database.md` §12.2 N3），不阻塞任何里程碑。

| # | 议题 | 建议 |
|---|---|---|
| A1 | ✅ 已定：canonical 固定 `\n` 分隔（4 处），path 仅路径不含 query | 见 §2.1；配共享测试向量 |
| A2 | ✅ 已定：公开接口用独立 `public_slug`，⛔ 不含内部 UUID | 见 §3.1、`docs/database.md` §5.1 |
| A3 | ✅ 已定：幂等命中**不加** `duplicate: true`，响应形态恒定 | 见 §2.1 |
| A4 | ✅ 已定：压缩前 **1MB** / 解压后 **4MB**（Agent 侧单批熔断阈值 256KB） | 见 §2.1、`docs/agent.md` §5.3 |
| A5 | ✅ 已定：**保留**心跳端点，限流**共用** Agent 桶 | 见 §2.2 |
| A6 | ✅ 已定：指标维度写进指标名（方案 A），`metrics` 参数接受**基名或全名** | 见 §4.3；step 范围表按 §4.3 实施 |
| A7 | ✅ 已定：WS 应用层**只允许 `subscribe`**；保活改用**协议层 ping/pong 帧**（浏览器自动回）；其它消息 → 关闭 `1008` | 见 §5.2、§5.3 |
| A8 | ✅ 已定：`install_hint` **带 key（`VANTAGE_KEY` env 内联）+ 另给交互式/`--key-file` 两种形式**；`agent_key`/`agent_secret` 同时单独展示一次；⛔ 仍禁 `--key` 参数 | 见 §4.4「决策 #37 修订」；✅ 设计文档 v0.8 §12.2/§13/#37 已同步修订 |
| A9 | ✅ 已定：**面板自助绑定 TOTP**（setup/enable/disable + `security.require_2fa` 强制策略） | 见 §4.1 |
| A10 | ✅ 已定：分页用 **cursor（keyset）**，`limit` 默认 20/上限 200 | 见 §1.2 |
| A11 | ✅ 已定：权限两级 `admin` / `user`，且 **`user` 纯只读**（所有写操作仅 `admin`） | 见 §4.9 |
| A12 | ✅ 已定：**不做**事件 `ack`，用 `silences` + 规则 `cooldown` 覆盖 | 见 §4.6 |
| A13 | ✅ 已定：**两条恢复渠道**——① 一次性恢复码（10 个、哈希存储、用后作废、可重新生成）；② 管理员后台 `POST /api/v1/users/{id}/2fa/reset`（清绑定 + 作废恢复码 + 踢下线 + 审计） | 见 §4.1、§4.9 |
| A14 | ✅ 已定：面板开关存 **PG `settings` 表**（白名单 key + JSONB），`PATCH /api/v1/settings` 立即生效并写审计 | 见 §4.10、`docs/database.md` §5.4 |

---

## 8. 与设计文档的对照（溯源）

| 本文位置 | 设计文档来源 |
|---|---|
| §1.1–1.2 | §5.4 分级、§10.2 接口清单 |
| §1.3–1.4 | §5.2 默认拒绝/限流、§7.3 令牌桶 |
| §1.5 | §5.2 中间件顺序、§6.6 验签顺序（决策 #35） |
| §2.1 | §6.2 签名、§10.1 上报体与响应、决策 #18/#19/#36 |
| §2.2 | §10.2 心跳、§4.3 网络开销 |
| §2.3 | §2.1 单向宗旨、§10.2 ⛔ 无下发接口、§12.4 |
| §3 | §5.4 公开可见性、决策 #10/#21、§8 IP 隐私 |
| §4.1 | §18.1 有状态会话、决策 #31/#32 |
| §4.2–4.3 | §5.3 心跳/离线、§6.5 漂移、§8 IP 历史、§9 时序与降采样 |
| §4.4 | §6.1 凭证、§12.2–12.3 安装流程、决策 #15/#37 |
| §4.5–4.7 | §7.1–7.3 告警规则/通道/风暴防护、决策 #22/#23 |
| §4.8–4.9 | §13 安全清单（审计、RBAC） |
| §5 | §18.2 实时通道、§18.3 单向一致性 |
| §6 | §13「单向性复核」、§19 评审响应清单 |
