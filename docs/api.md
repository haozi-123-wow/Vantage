# Vantage 后端 API 文档（vantage-core）

> **来源**：由《Vantage-DESIGN-v0.7.md》拆分的**后端接口契约文档**。
> **适用对象**：vantage-core 开发者、Agent 开发者（`docs/agent.md`）、面板开发者（`docs/frontend.md`）。
> **文档性质**：接口契约（路径 / 认证 / **请求参数** / **返回字段** / 错误码 / 语义），**不含实现代码**。
> **上位文档**：`Vantage-DESIGN-v0.7.md`（**文件内容已是 v0.8**，文件名保留以维持引用；§5、§6、§10、§18 为主）；决策以其 §15 为准（共 59 条）。
> **阅读约定**：本文中的「✅ 本轮决策 / 本轮已定」= 2026-09-26 Owner 拍板，**均已写入设计文档 v0.8**；逐条对照见 `docs/design-deltas.md`。

**怎么读这份文档**

| 你的目的 | 去哪里 |
|---|---|
| **查某个接口要传什么、返回什么** | 先在下面「0. 端点总索引」定位，每个端点都按 **认证/限流 → 请求参数 → 返回字段 → 错误码 → 备注** 排列 |
| 知道**现在能用哪些、哪些还没写** | 「实现进度速览」+ 每个端点标题后的 ✅ 已实现 / ⏳ 未实现 |
| 写 **Go Agent** | 第 2 章（Agent 侧实现细节另见 `docs/agent.md`） |
| 写**面板前端** | §1.2（通用约定）、§3（公开页）、§4（登录后页面）、§5（实时通道） |
| 查**会话 / 2FA 的内部机制**（Redis 键、三态矩阵、防重放、待拍板项） | §4.1.1（实现规范与落地状态） |

**标注图例**

| 标记 | 含义 |
|---|---|
| ✅ 已定 | 直接来自设计文档，不得擅自更改 |
| ➕ 建议 | 拆分时补齐的工程细节，**需 Owner 确认** |
| ❓ 待拍板 | 设计文档未定或存在冲突 |
| ✅ 已实现 | 代码已落地、当前可用 |
| ⏳ 未实现 | **契约已定稿（或本轮定稿），但代码尚未落地**——当前调用会命中 404 `not_found` |
| ⛔ | 禁止项（违反单向宗旨即视为重大缺陷） |

> 文中出现的 **S1–S4** = §4.1.1 ⑦ 里「登录人机验证（滑块验证码）」的分块；实施规范见 `docs/slider-captcha-selfbuilt.md`，选型调研见 `docs/slider-captcha.md`。

**实现进度速览（2026-10-03，随落地更新；逐端点状态见对应章节）**

| 模块 | 状态 | 落点 |
|---|---|---|
| 健康检查（`/healthz` `/readyz` `/version`） | ✅ 已实现 | §1.6 |
| Agent 上报 / 心跳（HMAC 签名） | ✅ 已实现（M1） | §2 |
| 面板账号：登录 / me / 登出 / 改密（会话 + CSRF + 审计） | ✅ 已实现 | §4.1（落地记录 §4.1.1 ⑧） |
| 面板 2FA（绑定 / 解绑 / 第二步 / 恢复码） | ✅ 已实现（B6/B7） | §4.1（落地记录 §4.1.1 ⑤⑦⑧） |
| 登录人机验证（滑块，**自建**） | ✅ 已落地（S1–S3；⏳ 待跑 `npm test` 验收） | §4.1；实施规范见 `docs/slider-captcha-selfbuilt.md` |
| 登录人机验证（**极验 v4**，官方按钮） | ✅ **后端（S5–S7）与前端（S8）均已落地**；⏳ 待跑 `npm test` 与真机联调 | §4.1（**双提供方分支已并入本文**）；变更方案见 `docs/geetest-captcha.md`（前端落地记录 §16.7） |
| 首管员 / 离线救援 CLI | ✅ 已实现 | §4.1.1 ⑥ |
| 公开只读快照（`/api/public/*`） | ⏳ 未实现（M2） | §3 |
| 主机 / 历史 / 进程 Top | ⏳ 未实现（M2） | §4.2–§4.4 |
| 告警 / 通道 / 静默 / 设置 / 用户 / 审计查询 | ⏳ 未实现（M3） | §4.5–§4.10 |
| WebSocket（`/ws/*`） | ⏳ 未实现（M3） | §5 |

---

## 0. 端点总索引

**认证方式**列的含义：`公开` = 无需凭证；`Cookie` = 面板会话（`vantage_sid`，写请求另需 `X-CSRF-Token`）；`HMAC` = Agent 签名头。
除 `/healthz`、`/readyz`、`/version` 外，所有响应都用 §1.3 的统一错误信封。

| 方法 | 路径 | 用途 | 认证 | 状态 | 小节 |
|---|---|---|---|---|---|
| GET | `/healthz` | 存活探针（不查依赖） | 公开 | ✅ | §1.6 |
| GET | `/readyz` | 就绪探针（PG + Redis） | 公开 | ✅ | §1.6 |
| GET | `/version` | 版本信息 | 公开 | ✅ | §1.6 |
| POST | `/api/v1/agent/report` | Agent 上报指标 / 探活 | HMAC | ✅ M1 | §2.1 |
| POST | `/api/v1/agent/heartbeat` | Agent 心跳（无变更） | HMAC | ✅ M1 | §2.2 |
| GET | `/api/public/summary` | 汇总计数（在线/离线/告警） | 公开 | ⏳ M2 | §3.2 |
| GET | `/api/public/hosts` | 公开主机列表（slug） | 公开 | ⏳ M2 | §3.3 |
| GET | `/api/public/hosts/{slug}/now` | 单机当前快照 | 公开 | ⏳ M2 | §3.4 |
| GET | `/api/public/probes` | 探活当前概览 | 公开 | ⏳ M2 | §3.5 |
| POST | `/api/v1/auth/login` | 登录第一步（密码；密码错后要求人机验证） | 公开 | ✅ B4 + S | §4.1 |
| POST | `/api/v1/auth/captcha/challenge` | 取滑块验证题（人机验证） | 公开 | ✅ S | §4.1 |
| POST | `/api/v1/auth/captcha/verify` | 校验滑块并发放一次性 `captcha_token` | 公开 | ✅ S | §4.1 |
| POST | `/api/v1/auth/2fa/verify` | 登录第二步（TOTP 6 位） | Cookie | ✅ B7 | §4.1 |
| GET | `/api/v1/auth/me` | 恢复登录态 + 取 CSRF | Cookie | ✅ B4 | §4.1 |
| POST | `/api/v1/auth/logout` | 登出当前会话 | Cookie | ✅ B4 | §4.1 |
| POST | `/api/v1/auth/logout-all` | 全部会话下线 | Cookie | ✅ B4 | §4.1 |
| POST | `/api/v1/auth/password` | 自助改密 | Cookie | ✅ B5 | §4.1 |
| POST | `/api/v1/auth/2fa/setup` | 生成待确认 TOTP 密钥 + 二维码 | Cookie | ✅ B6 | §4.1 |
| POST | `/api/v1/auth/2fa/enable` | 验码绑定 + 发 10 个恢复码 | Cookie | ✅ B6 | §4.1 |
| POST | `/api/v1/auth/2fa/disable` | 密码确认解绑 | Cookie | ✅ B6 | §4.1 |
| POST | `/api/v1/auth/2fa/recovery/verify` | 用恢复码过第二步 | Cookie | ✅ B7 | §4.1 |
| POST | `/api/v1/auth/2fa/recovery/regenerate` | 重发 10 个恢复码 | Cookie | ✅ B7 | §4.1 |
| GET | `/api/v1/hosts` | 主机列表（含 IP） | Cookie | ⏳ M2 | §4.2 |
| GET | `/api/v1/hosts/{id}` | 主机详情 | Cookie | ⏳ M2 | §4.2 |
| GET | `/api/v1/hosts/{id}/metrics` | 时序查询 | Cookie | ⏳ M2 | §4.3 |
| GET | `/api/v1/hosts/{id}/probes` | 探活历史 | Cookie | ⏳ M2 | §4.2 |
| GET | `/api/v1/hosts/{id}/ip-history` | IP 变更历史 | Cookie | ⏳ M2 | §4.2 |
| GET | `/api/v1/hosts/{id}/processes` | 进程 Top 快照 | Cookie | ⏳ M2 | §4.2 |
| GET | `/api/v1/agents` | Agent 列表 + 凭证年龄 | Cookie | ⏳ M3 | §4.4 |
| POST | `/api/v1/agents` | 创建 Agent（明文 key/secret 仅一次） | Cookie | ⏳ M3 | §4.4 |
| GET | `/api/v1/agents/{id}` | Agent 元信息 | Cookie | ⏳ M3 | §4.4 |
| PATCH | `/api/v1/agents/{id}` | 改显示名 / 标签 | Cookie | ⏳ M3 | §4.4 |
| POST | `/api/v1/agents/{id}/rotate` | 手动轮换凭证 | Cookie | ⏳ M3 | §4.4 |
| POST | `/api/v1/agents/{id}/disable` \| `/enable` | 禁用 / 启用 | Cookie | ⏳ M3 | §4.4 |
| POST | `/api/v1/agents/{id}/revoke` | 吊销（不可恢复） | Cookie | ⏳ M3 | §4.4 |
| GET/POST | `/api/v1/alert-rules` | 规则列表 / 创建 | Cookie | ⏳ M3 | §4.5 |
| GET/PATCH/DELETE | `/api/v1/alert-rules/{id}` | 规则读 / 改 / 删 | Cookie | ⏳ M3 | §4.5 |
| POST | `/api/v1/alert-rules/{id}/dry-run` | 历史试算（不发送） | Cookie | ⏳ M3 | §4.5 |
| GET | `/api/v1/alert-events` | 告警事件列表 | Cookie | ⏳ M3 | §4.6 |
| GET | `/api/v1/alert-events/{id}` | 事件详情 + 发送记录 | Cookie | ⏳ M3 | §4.6 |
| GET/POST | `/api/v1/channels` | 通知通道列表 / 创建 | Cookie | ⏳ M3 | §4.6 |
| PATCH/DELETE | `/api/v1/channels/{id}` | 通道更新 / 删除 | Cookie | ⏳ M3 | §4.6 |
| POST | `/api/v1/channels/{id}/test` | 发送测试消息 | Cookie | ⏳ M3 | §4.6 |
| GET | `/api/v1/notification-log` | 发送记录（排障） | Cookie | ⏳ M3 | §4.6 |
| GET/POST | `/api/v1/silences` | 静默窗口列表 / 创建 | Cookie | ⏳ M3 | §4.7 |
| DELETE | `/api/v1/silences/{id}` | 取消静默窗口 | Cookie | ⏳ M3 | §4.7 |
| GET | `/api/v1/audit-logs` | 审计日志查询 | Cookie | ⏳ M3 | §4.8 |
| GET/POST | `/api/v1/users` | 用户列表 / 创建 | Cookie(admin) | ⏳ M3 | §4.9 |
| PATCH | `/api/v1/users/{id}` | 改角色 / 显示名 / 状态 | Cookie(admin) | ⏳ M3 | §4.9 |
| POST | `/api/v1/users/{id}/password-reset` | 重置他人密码 | Cookie(admin) | ⏳ M3 | §4.9 |
| POST | `/api/v1/users/{id}/2fa/reset` | 重置他人 2FA + 踢下线 | Cookie(admin) | ⏳ M3 | §4.9 |
| GET/PATCH | `/api/v1/settings` | 系统设置读 / 改 | Cookie | ⏳ M3 | §4.10 |
| WS | `/ws/public` | 公开实时通道（脱敏） | 公开 | ⏳ M3 | §5.1 |
| WS | `/ws/live` | 面板实时通道（全量） | Cookie | ⏳ M3 | §5.1 |

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

**① 两种认证方式（按分区选用，⛔ 不混用）**

| 分区 | 请求必须带的凭证 | 说明 |
|---|---|---|
| Agent 接入（`/api/v1/agent/*`） | 签名头 5 件套：`X-Agent-Id`、`X-Agent-Key`、`X-Timestamp`、`X-Nonce`、`X-Signature`，外加 `Content-Encoding: gzip`、`Content-Type: application/json` | 每机独立 key+secret；算法见 §2.1 |
| 面板私有（`/api/v1/*` 的其余端点） | Cookie `vantage_sid=<不透明 sid>`（浏览器自动携带，前端 `credentials: 'include'`）；**写请求另需** `X-CSRF-Token` | sid 由登录 / `GET /auth/me` 下发；⛔ 前端不读不写 sid |
| 面板公开（`/api/public/*`、`/ws/public`） | 无 | 免登录、只读、只返回「当前值」快照 |
| 运维探针（§1.6） | 无 | 不参与业务错误信封 |

**② CSRF（面板写请求必带）**

- **触发范围**：`POST` / `PATCH` / `DELETE`（`GET`/`HEAD`/`OPTIONS` 不校验）。
- **取值**：登录响应与 `GET /auth/me` 的 `csrf` 字段 → 放进请求头 `X-CSRF-Token`。
- **豁免范围**：`POST /api/v1/auth/login` 与两个 `POST /api/v1/auth/captcha/*`（取题 / 验题）——它们都在**会话建立之前**运行，浏览器没有可借的环境权限。⛔ 这不是"跳过校验"，而是"没有可校验的对象"：实现上 `requireCsrf` 在**无会话时直接放行**（§4.1.1 ①）。⛔ 除这三者外，任何写请求都不得豁免。
- **失败**：403 `csrf_invalid`，且**不销毁会话**（前端可重取 `me` 后重试）。
- ⚠️ **`sid` 轮换（过 2FA / 改密 / 恢复码登录）后 `csrf` 不变**——前端无需换 token（✅ 决策 #32 的配套取舍，理由见 §4.1.1 ①）。

**③ 通用请求 / 响应格式**

| 项 | 约定 |
|---|---|
| 字符集 | `Content-Type: application/json; charset=utf-8` |
| 时间（面板 API） | 请求 `from`/`to` 接受 RFC3339（含时区）或 unix 毫秒整数；**响应时间一律 RFC3339 UTC**（如 `2025-09-25T12:00:00.000Z`） |
| 时间（Agent 上报） | ✅ `ts` 为 unix 毫秒（设计 §10.1） |
| 时区 | 服务端一律 UTC；本地化时区转换在前端 |
| 分页 | ✅ 已定：`?limit=`（默认 20，上限 200）+ `?cursor=`（**不透明游标，keyset 分页**）；响应带 `next_cursor` |
| 排序 | 默认按时间倒序；需正序时 `?order=asc` |
| 版本 | 路径前缀 `/api/v1`（✅）；破坏性变更升 `/api/v2` |
| 请求 ID | 响应头 `X-Request-Id`；错误体里也有 `request_id`（对账 / 排障） |
| 压缩 | 面板 API 支持 `Accept-Encoding: gzip`；Agent 上报使用 `Content-Encoding: gzip`（✅） |
| **响应体形状** | 成功：**直接**返回数据对象或数组（⛔ 不套 `data` 壳）；失败：§1.3 的 `{ error: {...} }`；无内容的写操作：204 |
| 限流响应头 | `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`、429 时 `Retry-After`（秒） |

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
| 400 | 请求不可解析 / 业务校验失败 | `invalid_request`、`schema_invalid`、`range_too_large`、`expr_not_allowed`、`invalid_totp`（✅ 已生效，§4.1 的 2FA 端点） |
| 401 | 未认证 / 签名失败 / 会话失效 | `signature_invalid`、`timestamp_skew`、`agent_unknown_or_disabled`、`session_expired`、`invalid_credentials` |
| 403 | 已认证但无权限 / 需二次验证 / CSRF 失败 | `role_denied`、`totp_required`、`totp_setup_required`（✅ 已生效，§4.1）、`csrf_invalid` |
| 404 | 资源不存在 | `not_found` |
| 409 | 冲突（幂等命中以外的语义冲突） | `conflict`、`already_exists`、`nonce_reused`（✅ 校正：§1.3 原把 `nonce_reused` 列在 401，与 §2.1 错误表及 §6 验收用例第 4 条的 **409** 矛盾，现统一为 409）、`channel_in_use` |
| 413 | 体积超限（含解压后超限） | `payload_too_large` |
| 415 | 不支持的编码/媒体类型 | `unsupported_content_encoding` |
| 429 | 限流 | `rate_limited`（带 `Retry-After`） |
| 500 | 服务端错误 | `internal_error` |
| 503 | 依赖不可用（PG/Redis） | `upstream_unavailable` |

> ⛔ 错误响应**不得**回显任何 Agent 配置、阈值、内部路径、脚本或可执行内容（§2.1、§10.1「响应体极简」）。

**错误码总表（`error.code` → 状态码 → 触发条件；✅ 与 `server/src/utils/errors.js` 登记表逐条一致）**

| 状态 | code | 触发条件 |
|---|---|---|
| 400 | `invalid_request` | 请求不可解析、缺必需字段、引用不存在（含：新旧密码相同、未 setup 就 enable） |
| 400 | `schema_invalid` | 字段校验失败：白名单外字段、类型不符、数值超范围、数组超长 |
| 400 | `range_too_large` | 时序查询范围超出该 step 允许的最大跨度（§4.3） |
| 400 | `expr_not_allowed` | 告警规则传了非 null 的 `expr`（零 RCE 约束，§4.5） |
| 400 | `unknown_setting` | `PATCH /settings` 传了白名单外的 key（§4.10） |
| 400 | `invalid_setting_value` | 设置项的值类型不符合该 key 的定义（§4.10） |
| 400 | `invalid_totp` | 2FA 验证码/恢复码不正确、已用过或同一步号重放（§4.1） |
| 400 | `captcha_required` | 已触发人机验证策略（同 IP / 同账号失败计数超阈）但请求未带 `captcha_token`（§4.1，S 系列已落地） |
| 400 | `captcha_invalid` | 人机验证未通过 / 题目已过期或已作废 / token 无效或已消费；`details.reason` 见 §4.1（自建 S 系列 + 极验 S7 均已落地） |
| 503 | `captcha_unavailable` | **极验不可达且 `GEETEST_FAIL_MODE=closed`**（S7 已落地）。⚠️ 默认 `open` 时此码不出现（改为放行 + 审计 `auth.captcha_unavailable`）；⛔ 5xx 的 message 会被折叠成通用文案，前端**必须按 `error.code` 匹配**（S7 已落地） |
| 401 | `signature_invalid` | Agent HMAC 不匹配，或 `X-Agent-Key` 与 `agent_key_hash` 不符 |
| 401 | `timestamp_skew` | Agent 时间戳超出允许窗口（> 5min 硬上限时任何模式都拒） |
| 401 | `agent_unknown_or_disabled` | Agent 不存在 / 已吊销 / 已禁用 |
| 401 | `session_expired` | 无 Cookie、sid 无效或已过期（会话已销毁） |
| 401 | `invalid_credentials` | 登录名或密码不正确（⛔ 不区分"账号不存在/密码错/已禁用"） |
| 403 | `role_denied` | 已登录但角色不足（`user` 发写请求，§4.9） |
| 403 | `totp_required` | 已绑 2FA 但未过第二步（`totp_pending` 受限态，§4.1.1 ②） |
| 403 | `totp_setup_required` | `security.require_2fa=true` 且该账号未绑定（`setup_required` 受限态，§4.1.1 ②） |
| 403 | `csrf_invalid` | 写请求缺 `X-CSRF-Token` 或不匹配（⛔ 不销毁会话） |
| 404 | `not_found` | 资源不存在 / 路由未命中 |
| 409 | `conflict` | 与当前状态冲突（含：2FA 已绑定还 setup、`require_2fa=true` 时自助解绑） |
| 409 | `already_exists` | 唯一约束冲突（如 Agent `name` 重名、用户名已存在） |
| 409 | `channel_in_use` | 删除仍被规则引用的通知通道（§4.6） |
| 409 | `nonce_reused` | Agent 同 nonce 重复（防重放） |
| 413 | `payload_too_large` | 体积超限（Agent 压缩前 1MB / 解压后 4MB） |
| 415 | `unsupported_content_encoding` | `Content-Encoding` 不在白名单（仅 gzip） |
| 429 | `rate_limited` | 限流命中，带 `Retry-After` |
| 500 | `internal_error` | 未识别的服务端异常（细节只进日志，⛔ 不进响应） |
| 503 | `upstream_unavailable` | PG / Redis 不可用 |

### 1.4 限流（✅ 决策 #23、§5.2；数值为 ➕ 建议）

| 维度 | Redis 键 | 建议阈值 | 超限行为 |
|---|---|---|---|
| Agent 上报 | `ratelimit:agent:<agent_id>` | 周期性上报的 2–3 倍余量（如默认 15s 上报 → 60 次/分钟） | 429 + `Retry-After` |
| 面板公开接口 | `ratelimit:public:<ip>` | 60 次/分钟 | 429 |
| 公开 WS 连接 | `ratelimit:ws:<ip>` | 并发连接数上限（如 3）+ 连接建立速率 | 拒绝握手 |
| 登录 | `ratelimit:login:<ip>` | 如 10 次/5 分钟，失败递增 | 429（不泄露账号是否存在）。✅ 已生效；✅ `/auth/2fa/verify` 与 `/auth/2fa/recovery/verify` **复用同一桶**（防 6 位码暴力枚举，见 §4.1.1） |
| 滑块取题 / 验题 | `ratelimit:captcha:<ip>` | 30 次/分钟（比登录桶宽松——"换一张图"是正常操作） | 429。⛔ 与登录桶**独立**（否则换图会消耗登录额度）（S 系列已落地） |
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

### 1.6 运维端点（`/healthz`、`/readyz`、`/version`）

**为什么不放在 `/api/*` 下**：这三个端点是**运维 / 编排用**——不受 `/api` 限流与鉴权影响，也**不使用** §1.3 的错误信封（编排器只关心状态码 + 简短 JSON）。
⛔ `/healthz` 与 `/readyz` 语义不同，**不可合并**：前者只证明进程活着（不碰任何依赖），后者证明依赖可用；混用会让依赖一抖动就触发无谓重启。

#### `GET /healthz` — 存活探针 ✅ 已实现

无认证、无参数。**200**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | 恒 `true`（能响应即存活） |
| `service` | string | 服务名（默认 `vantage-core`） |
| `version` | string | 版本号 |
| `uptime_s` | number | 进程已运行秒数 |

#### `GET /version` — 版本信息 ✅ 已实现

无认证、无参数。**200**：`{ service, version, node, env }`
（`node` = Node 运行时版本；`env` = 运行环境名；⛔ 不暴露环境变量内容）

#### `GET /readyz` — 就绪探针 ✅ 已实现

无认证、无参数。**200**（依赖可用）/ **503**（任一依赖不可用）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | `checks.postgres.ok && checks.redis.ok` |
| `service` / `version` | string | 同上 |
| `checks.postgres` | object | `{ ok, ms, error? }`；探活硬超时 **3s**（⛔ 健康检查本身不得挂住） |
| `checks.redis` | object | `{ ok, ms, error? }` |
| `checks.eviction` | object | Redis 可用时附带：`{ maxmemory_policy, evicted_keys, used_memory_bytes }`；✅ R15 要求 `evicted_keys` **恒为 0**（否则 nonce/幂等键被驱逐） |
| `checks.skipped` | boolean | 仅启动自检被显式跳过时出现（`checks: { skipped: true }`） |

> 部署建议：`/healthz` → livenessProbe，`/readyz` → readinessProbe。

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

### 3.2 端点（✅ §10.2；全部 ⏳ 未实现，M2）

四个端点**都无请求参数**（除路径参数）、**都免登录**、响应都是**直接的对象/数组**（不套壳）。

#### `GET /api/public/summary` — 汇总计数

**200**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `total` | number | 主机总数 |
| `online` / `offline` | number | 在线 / 离线数 |
| `alerts` | object | `{ critical, warn, info }` 各严重级当前告警数 |
| `updated_at` | string(RFC3339) | 快照生成时间 |

#### `GET /api/public/hosts` — 主机列表

**200**：数组，每项字段如下（⛔ 无内部 UUID、无 IP）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `slug` | string | **公开标识**（`agents.public_slug`，见 §3.1） |
| `name` | string | 显示名优先取 `display_name`，其次 `name`（决策 #21） |
| `status` | string | `online` / `offline` |
| `os` | string? | 操作系统 |
| `uptime` | number? | 运行时长 |
| `snapshot` | object | `{ cpu_pct, mem_pct, disk_pct, net_rx_bps, net_tx_bps, gpu_pct? }` |
| `probes` | object | `{ up, down }` 计数 |
| `last_seen_ago` | string | **相对化描述**（如 `"2 分钟前"`）或分钟级取整（➕ 建议，避免毫秒级行为指纹） |

#### `GET /api/public/hosts/{slug}/now` — 单机当前快照

**路径参数**：`slug`（公开标识，**不是**内部 UUID）。
**200**：同上的 `snapshot` **展开** + 分区 / 网卡 / GPU 数组。
⛔ 不含 IP、不含设备内网标识；设备名建议泛化为 `disk 1..n` / `eth 1..n`（➕ 建议）。

#### `GET /api/public/probes` — 探活当前概览

**200**：数组 `[{ slug, name, target_host, type, up, latency_ms, checked_at }]`，其中 `target_host` **脱敏**（仅域名 / 泛化形式）。

**缓存与限流（✅ §5.4「带缓存与限流」；➕ 参数为建议）**

- 服务端缓存：`snapshot:agent:<id>`（TTL 5–15s，与上报周期 15s 对齐）；
- 响应头：`Cache-Control: no-store`（避免中间层/CDN 缓存过期或跨用户数据）；
- 限流：`ratelimit:public:<ip>`，建议 60 次/分钟；
- 整体开关：`public_view.enabled`（✅ §5.4）；✅ 已定（本轮）：**默认开启**（装好即可免登录查看当前状态，符合决策 #10 初衷）；关闭时**所有** `/api/public/*` 与 `/ws/public` 返回 404（不泄露「存在但被关闭」）。
- ⚠️ 默认开启的配套要求（必须同时做到）：① 公开接口与 `/ws/public` 按 IP **严格限流**（`ratelimit:public:*`、`ratelimit:ws:*`）；② 严格脱敏（§3.1 的 ⛔ 清单）；③ 设置页给出醒目状态与「一键关闭」；④ 首次登录后引导复核该开关（`docs/frontend.md` §4.6）。

---

## 4. 面板私有 API（`/api/v1/*`，需登录）

### 4.1 认证与会话（13 个端点，✅ 全部已落地）

**本节 13 个端点全部已落地**（B4/B5 会话与改密、B6/B7 2FA、S 系列人机验证）；⏳ 待 Owner 跑 `npm test` 验收（人机验证的集成用例在 `server/test/auth.captcha.test.js`）。内部机制（Redis 键、三态矩阵、防重放、待拍板项）见 §4.1.1。

#### 4.1.0 本节通用约定

| 项 | 约定 |
|---|---|
| Cookie | 名 `vantage_sid`（可配），仅存不透明 256-bit 随机 `sid`；`HttpOnly + SameSite=Lax + Path=/ + Max-Age=绝对 TTL`，`Secure` 由 `COOKIE_SECURE` 决定（可选 `__Host-` 前缀）。⛔ Cookie 与响应体里**不得**出现用户资料/角色之外的敏感信息 |
| 会话状态（Redis `session:<sid>`） | `{ user_id, roles, totp_ok, setup_required, created_at, last_seen, ip, ua, csrf }`；`roles` 恒为 `["admin"]` 或 `["user"]` 单元素数组（保持数组形态便于将来扩多角色） |
| 生命周期 | 滑动 30min（每次命中续期）+ **绝对 24h**（自 `created_at` 起算，续期不影响）；同账号并发上限 3（超限**踢最旧**，新建的那个永不参与淘汰）；IP/UA **只记录不强制校验** |
| CSRF | 本节所有写请求都要 `X-CSRF-Token`；**豁免仅限会话建立前的三个端点**（`login` + 两个 `captcha/*`，详见 §1.2 ②） |
| 登录失败 | 统一 401 `invalid_credentials`（**不区分**账号不存在 / 密码错 / 已禁用），且计入 `ratelimit:login:<ip>`；同时 INCR 两个失败计数器并在响应里带 `captcha_required` 提示（S） |
| 人机验证 | **首次登录不要求**；一旦出现密码错误，同 IP / 同账号失败计数 ≥ `security.login_captcha.after_failures`（默认 1）→ 后续登录必须携带 `captcha_token`。⚠️ 与三态矩阵**正交**：它只决定"这次登录请求能不能进入验密环节"，⛔ 不改变 `full`/`totp_pending`/`setup_required` 的判定。✅ **默认提供方已是极验 v4（S7 已落地）**，自建滑块保留为可选 provider（`CAPTCHA_PROVIDER=selfbuilt`）。⚠️ 两个提供方在**本表**上的差异只有两处：① `captcha/challenge` 的响应体（自建回两张 SVG；极验回 `provider`+`captcha_id`+`product`+`language`）；② `captcha/verify` 的**请求体**与 `details.reason` 枚举。⛔ 登录端点的请求/响应**一个字都不改**（§4.1 两个端点有逐字段对照） |

**会话三态与各端点的可达性**（✅ 与代码一致；判定规则见 §4.1.1 ②）：

| 端点 | `full` | `totp_pending`（已绑未过第二步） | `setup_required`（策略要求未绑定） |
|---|---|---|---|
| `login` | —（建立会话） | — | — |
| `me` | ✅ 200 | ✅ 200 | ⛔ 403 `totp_setup_required` |
| `2fa/verify` | ✅（重验；同一码会被防重放拒） | ✅ | ⛔ 409 `conflict`（账号没绑 TOTP） |
| `2fa/setup` | ✅（未绑定时） | ✅ 可达 | ✅ 可达 |
| `2fa/enable` | ✅ | ⛔ 403 `totp_required` | ✅（强制绑定流程） |
| `2fa/disable` | ✅ | ⛔ 403 `totp_required` | ⛔ 403 `totp_setup_required` |
| `2fa/recovery/verify` | ✅ | ✅ | ⛔ 409 `conflict` |
| `2fa/recovery/regenerate` | ✅ | ⛔ 403 `totp_required` | ⛔ 403 `totp_setup_required` |
| `password` | ✅ | ⛔ 403 `totp_required` | ⛔ 403 `totp_setup_required` |
| `logout` / `logout-all` | ✅ | ✅ | ✅（⛔ 不能把人锁死在面板里） |

> ✅ 强制策略：`security.require_2fa=true` 时，未绑定 TOTP 的账号登录后进入 `setup_required` 受限态，只放行 `me` / `2fa/setup` / `2fa/enable` / `logout*`，其余一律 403 `totp_setup_required`；⛔ 不允许跳过。
> ⚠️ 上表**不含**两个 `captcha/*` 端点：它们在**会话建立之前**运行，与会话状态无关（⛔ 不受三态矩阵约束，见 §4.1）。

---

#### `POST /api/v1/auth/login` — 登录第一步（密码）✅ 已实现

| 项 | 值 |
|---|---|
| 认证 | 无（会话建立前的端点，CSRF 天然放行） |
| 限流 | `ratelimit:login:<ip>`，10 次 / 300s（**成功与失败都计数**） |
| 人机验证 | 密码错后要求 `captcha_token`（判定见 §4.1.0，S） |
| 审计 | 成功 `auth.login`；失败 `auth.login_failed`（`detail.reason` 恒为 `invalid_credentials`） |

**请求体**

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `username` | string | ✅ | 1–128；**大小写不敏感**（按 `lower(username)` 匹配）；响应回显库内原始写法 |
| `password` | string | ✅ | 1–128 |
| `captcha_token` | string | ➕ | ≤128；⛔ 仅在服务端要求时必需（见下）；来自 `POST /auth/captcha/verify`（S） |

**成功 200**（同时下发 `Set-Cookie: vantage_sid=<sid>`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `csrf` | string | 后续写请求的 `X-CSRF-Token` 来源（≥24 字符；`sid` 轮换后**不变**） |
| `totp_required` | boolean | `true` = 该账号已绑 2FA，须先调 `2fa/verify`；此时**不返回** `user`/`roles` |
| `user` | object | 仅 `totp_required=false` 时返回（字段见下） |
| `roles` | string[] | 仅 `totp_required=false` 时返回，恒 `["admin"]`/`["user"]` |

`user` 对象（⛔ 白名单式构造，永不含 `password_hash`/`totp_secret_enc`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string(uuid) | 用户 ID |
| `username` | string | 登录名 |
| `display_name` | string \| null | 显示名 |
| `role` | string | `admin` / `user` |
| `status` | string | `active` / `disabled` |
| `totp_enabled` | boolean | 是否已绑定 2FA |

**响应示例**

```jsonc
// 未绑定 2FA（含 require_2fa=true 但未绑定：引导交给 me）
{ "user": { "id": "…", "username": "admin", "display_name": "管理员", "role": "admin",
            "status": "active", "totp_enabled": false },
  "roles": ["admin"], "csrf": "…", "totp_required": false }

// 已绑定 2FA：会话进入 totp_pending，除 me / 2fa 外全部 403
{ "csrf": "…", "totp_required": true }
```

**错误**：401 `invalid_credentials`（三种失败同码同文**同耗时**；密码错后其 `details.captcha_required` 为 `true`，S）｜400 `schema_invalid`（缺字段 / 超长）｜400 `captcha_required`（策略要求滑块但缺 `captcha_token`，S）｜400 `captcha_invalid`（token 无效 / 已过期 / 已消费，S）｜429 `rate_limited`（带 `Retry-After`）

**备注**

- **等时校验**：账号不存在（或 SSO-only 无本地密码）时也对固定假哈希跑一次完整 Argon2——响应体与耗时都不可区分（防用户名枚举）。
  ⚠️ 加滑块后此不变量**必须保持**：是否要求滑块的判定只依赖 **IP / 提交用户名的失败计数**与设置项，⛔ **不查库**，因此不会引入新的计时侧信道（S）。
- 登录顺带整理 `user_sessions:<uid>`（清僵尸成员 + 超限踢最旧）；`last_login_at/ip/method` 在**会话建好之后**才写（⛔ Redis 挂了不能留下"成功登录"的痕迹）。
- ⛔ **校验顺序不可调换**（S）：**先卡滑块、后验密码**。若反过来，攻击者不必通过人机验证就能让服务端每次跑满 19MiB 的 Argon2，等于白送一个 DoS 放大器。
- 滑块相关细节（失败计数器、token 绑定与消费时机、`details.reason` 枚举）见 `docs/slider-captcha-selfbuilt.md` §2/§5/§6.4。

#### `POST /api/v1/auth/captcha/challenge` — 取验证入口配置 ✅ 已实现（自建 S；极验分支 S7）

> 📌 **响应形状按提供方分支**（`CAPTCHA_PROVIDER`，启动时定死，见 §4.1.0）。两个分支都带 `provider` 字段供前端选组件 —— 但⛔ **它都不是安全边界**：真正的判定只在 `captcha/verify`。

| 项 | 值 |
|---|---|
| 认证 / CSRF | 无（会话建立前；与会话无关，理由同 `login`，见 §1.2 ②） |
| 限流 | `ratelimit:captcha:<ip>`，30 次 / 分钟（**独立桶**，见 §1.4） |
| 开关 | 满足任一即 **404 `not_found`**：`security.login_captcha.enabled=false`、提供方凭据未配置、**外部服务处于熔断窗口且 `GEETEST_FAIL_MODE=open`**（⛔ 不用 403：不暴露"存在但被关"） |
| 审计 | ⛔ 不记（否则"取题"噪声会淹没审计表） |

**请求**：无 body。

**成功 200（`provider=selfbuilt`）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | string | 恒为 `selfbuilt` |
| `captcha_id` | string | 题目标识（≥16 字节随机，base64url）；Redis `captcha:<id>`，TTL 120s |
| `bg_svg` | string | 背景图（含缺口）的 **SVG 文本**，前端内联渲染 |
| `piece_svg` | string | 拼图块的 **SVG 文本**（用户拖动它） |
| `width` / `height` | number | **逻辑**画布尺寸；前端可等比缩放显示，但提交的坐标必须是逻辑坐标 |
| `expires_in` | number | 秒（默认 120） |

⛔ 响应中**不得**出现缺口坐标、容差、失败次数上限（`docs/slider-captcha-selfbuilt.md` §6.1 有逐条"不泄露答案的写法"）。

**成功 200（`provider=geetest`）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | string | 恒为 `geetest` |
| `captcha_id` | string | 极验 captcha_id（**公开**值，前端 `initGeetest4` 要用）。⛔ `captcha_key` 永不下发 |
| `product` | string | `popup`（默认：官方按钮 + 带遮罩的验证弹窗）或 `float` |
| `language` | string | 验证窗语言（`zho`/`eng`/…；由极验渲染，⛔ 不受本站 i18n 控制） |

⚠️ 极验分支**没有 `expires_in`**：题目与答案由极验云端管理，服务端唯一能承诺的 TTL 是验题后自己发的一次性凭证（出现在 `verify` 的响应里）。
⚠️ 极验分支也**没有 `bg_svg`/`piece_svg`**：出题是极验的事。

**错误**：404 `not_found`（关闭 / 未配置 / 熔断）｜429 `rate_limited`｜503 `upstream_unavailable`（Redis 不可用，fail-closed）

#### `POST /api/v1/auth/captcha/verify` — 校验人机验证并发放一次性 token ✅ 已实现（自建 S；极验分支 S7）

| 项 | 值 |
|---|---|
| 认证 / CSRF | 无（会话建立前） |
| 限流 | `ratelimit:captcha:<ip>`（与取题共用）。⚠️ 极验分支下本端点是**全站唯一"匿名可触发外呼"**的端点，此桶同时是外呼放大器的闸门 |
| 审计 | 未通过 `auth.captcha_failed`（`detail`：`provider` + `reason` + 可选 `vendor_reason` / `delta_px`；⛔ 不含答案、不含提交原值、不含 token 与 `pass_token`）；外部服务不可用另记 `auth.captcha_unavailable`（见下） |
| 判定 | **服务端唯一判定点**。自建 = 容差 + 轨迹规则；极验 = 把 4 个参数转发到 `gcaptcha4.geetest.com/validate` 并采信其结论（⛔ 不重试） |

**请求体（`provider=selfbuilt`）**

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `captcha_id` | string | ✅ | ≤128 |
| `x` | number | ✅ | 逻辑坐标（0 ≤ x ≤ width） |
| `y` | number | ➕ | 仅横向滑动时可省 |
| `track` | array | ✅ | `[[t_ms, x], …]`，**点数上限 200**（防超大 body） |

**请求体（`provider=geetest`）** = 极验 `captchaObj.getValidate()` 的 4 个字段

| 字段 | 类型 | 必需 | 约束（**防御性护栏**，不是极验契约） |
|---|---|---|---|
| `lot_number` | string | ✅ | ≤128 |
| `captcha_output` | string | ✅ | ≤4096 |
| `pass_token` | string | ✅ | ≤2048 |
| `gen_time` | string | ✅ | ≤32 |

⚠️ 极验分支**刻意不收 `captcha_id`**：服务端用自己的配置值 —— 让调用方指定"用哪个验证 id"没有意义，只会多一个可被拿来探测/伪造的输入面。

**成功 200（两个提供方**完全一致**）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `captcha_token` | string | 一次性凭证；Redis `captcha:ok:<token>`（TTL 120s，**值绑定解出验证的 IP**） |
| `expires_in` | number | 秒（默认 120） |

**错误**

| 状态 | code | 触发（`details.reason`） |
|---|---|---|
| 400 | `captcha_invalid` | **自建**：`mismatch`（偏差超容差）/ `track_suspicious` / `not_found`（题目过期或已作废）/ `too_many_attempts`（同一题失败 ≥3 次）<br>**极验**：`validate_failed`（极验明确判未通过；`details.vendor_reason` 附其原文） |
| 400 | `schema_invalid` | 缺字段 / `track` 超长 / 字段超长 |
| 429 | `rate_limited` | 同 IP 超限 |
| 503 | `captcha_unavailable` | **极验不可达且 `GEETEST_FAIL_MODE=closed`**（§1.3）。⚠️ 默认 `open` 时**不会**出现本码——那时按「放行」处理并写 `auth.captcha_unavailable` 审计 |
| 503 | `upstream_unavailable` | Redis 不可用（fail-closed）｜404 `not_found`（关闭 / 未配置 / 熔断且 open） |

**备注**

- **一次性与"成功才消费"**：凭证在 `POST /auth/login` **登录成功时**才 `DEL`。⚠️ 因此它在 120s 内可被复用（**含提交错误密码**）——这是刻意的：否则用户验证通过后打错密码就要重新验证一次。攻击者同样受登录限流约束（§1.4）。
  🔑 这正是选**两步契约**而不是"把 4 个参数随登录一起提交"的原因：极验的 `pass_token` 是**一次性**的，而两步契约让它在 `/captcha/verify` 只用掉一次（`docs/geetest-captcha.md` §3.4）。
- **token 绑定 IP**：换 IP 使用同一 token → 400 `captcha_invalid`（挡"打码平台批量出 token 转卖"）。
- ⛔ 前端**不得**自行判定对错（前端判对错＝纯前端验证码，零防护价值）。极验的 `onSuccess` 同样必须经服务端 `/validate` 才算数。
- **失败模式（极验）**：`/validate` 请求异常或 HTTP 非 200 时，按 `GEETEST_FAIL_MODE` 处理 —— 默认 **`open`（放行 + 审计 + error 日志 + 30s 熔断）**，`closed` 则 503。完整论证见 `docs/geetest-captcha.md` §9。
- 自建的完整阈值、容差与"不泄露答案"的写法见 `docs/slider-captcha-selfbuilt.md` §6；极验的参数、签名与响应解析见 `docs/geetest-captcha.md` §4。

#### `POST /api/v1/auth/2fa/verify` — 登录第二步（TOTP）✅ 已实现

| 项 | 值 |
|---|---|
| 认证 | Cookie（`totp_pending` 态的主要用途） |
| CSRF | 必带 |
| 限流 | **与 `login` 共用** `ratelimit:login:<ip>`（防 6 位码暴力枚举；⚠️ 限流挂在会话校验**之前**，无会话狂刷同样计数） |
| 审计 | 成功 `auth.2fa_verify`；失败 `auth.2fa_verify_failed`（`reason`: `invalid_totp` / `replayed_step`） |

**请求体**

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `code` | string | ✅ | TOTP 6 位数字（6–8 字符，内部去空白后按 `^\d{6}$` 校验） |

**成功 204**（无响应体）+ `Set-Cookie: vantage_sid=<新 sid>`

**错误**

| 状态 | code | 触发 |
|---|---|---|
| 400 | `invalid_totp` | 验证码不正确，或**该步号已被使用过**（30s 窗口内重放同一码） |
| 400 | `schema_invalid` | 缺 `code` / 长度越界 |
| 401 | `session_expired` | 无 Cookie / 会话已失效 |
| 403 | `csrf_invalid` | 缺 `X-CSRF-Token` |
| 409 | `conflict` | 该账号**未绑定** TOTP（会话态与库态脱节，提示重新登录） |
| 429 | `rate_limited` | 与登录共用桶超限 |

**备注**

- ✅ **成功后 `sid` 必须轮换**（决策 #32，防会话固定）；`csrf` 不变。
- ✅ **同一步号只接受一次**：命中步号先经 Redis `SADD totp:used:<uid>`（TTL 90s）原子认领，`SADD` 返回 0 即判重放（§4.1.1 ④）。
- 前端：`totp_required:true` 后所有其它接口都 403，UI 必须留在登录流程内；验证成功后**重新调 `GET /auth/me`** 拿 `user`/`roles` 再跳转（`docs/frontend.md` §4.2）。
- ⛔ 不写 `touchLogin`：`users.last_login_method` 的 CHECK 只允许 `password/totp/oidc`，且第一步已记录本次登录。

#### `GET /api/v1/auth/me` — 恢复登录态 + 取 CSRF ✅ 已实现

| 项 | 值 |
|---|---|
| 认证 | Cookie |
| 参数 | 无 |

**成功 200**

| 字段 | 类型 | 说明 |
|---|---|---|
| `user` | object | 同 `login` 的 `user`（六字段白名单） |
| `roles` | string[] | 同 `login` |
| `session.created_at` | string(RFC3339) | 会话创建时间 |
| `session.last_seen` | string(RFC3339) | 最近活跃时间（写入节流 60s） |
| `session.ip` | string \| null | 登录来源 IP |
| `session.ua` | string \| null | User-Agent（截断 ≤200 字符） |
| `csrf` | string | 与登录响应同源；`sid` 轮换后不变 |

**错误**：401 `session_expired`｜**403 `totp_setup_required`**（`setup_required` 态**必须**回 403——前端 `store/auth.ts` 靠它进入强制绑定流程，见 §4.1.1 ⑧ D2）

**备注**：`totp_pending` 态下 `me` **正常 200**（前端据此恢复会话但留在登录流程内）；会话有效但账号已被删除时 → 销毁会话、清 Cookie、回 401。

#### `POST /api/v1/auth/logout` — 登出当前会话 ✅ 已实现

| 项 | 值 |
|---|---|
| 认证 | Cookie（**受限态也可登出**） |
| CSRF | 必带 |
| 审计 | `auth.logout`（`detail.session_found`） |

**请求**：无 body。**成功 204** + 清 Cookie（`Max-Age=0`）。
**错误**：401 `session_expired`｜403 `csrf_invalid`。
**备注**：不存在的 sid 也回 204（⛔ 不泄露信息）。

#### `POST /api/v1/auth/logout-all` — 全部会话下线 ✅ 已实现

| 项 | 值 |
|---|---|
| 认证 | Cookie |
| CSRF | 必带 |
| 审计 | `auth.logout_all`（`detail.sessions_destroyed`） |

**请求**：无 body。**成功 204** + 清当前 Cookie（`user_sessions:<uid>` 内**全部** sid 被删，含当前这一个）。
**错误**：401 `session_expired`｜403 `csrf_invalid`。

#### `POST /api/v1/auth/password` — 自助改密 ✅ 已实现

| 项 | 值 |
|---|---|
| 认证 | Cookie，**必须完整态**（`totp_pending` / `setup_required` 一律 403） |
| CSRF | 必带 |
| 审计 | 成功 `auth.password_change`（`detail.other_sessions_kicked`）；失败 `auth.password_change_failed` |

**请求体**

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `old_password` | string | ✅ | 1–128 |
| `new_password` | string | ✅ | **8–128**（Schema 卡边界）；⛔ 不得与旧密码相同 |

**成功 204**（无响应体）+ `Set-Cookie: vantage_sid=<新 sid>`

**错误**

| 状态 | code | 触发 |
|---|---|---|
| 400 | `schema_invalid` | 新密码长度不在 8–128 |
| 400 | `invalid_request` | 新密码与旧密码相同 |
| 401 | `invalid_credentials` | 旧密码不正确（⛔ 哈希不改动，旧密码仍可登录） |
| 401 | `session_expired` | 会话/账号异常 |
| 403 | `csrf_invalid` | 缺 `X-CSRF-Token` |
| 403 | `totp_required` / `totp_setup_required` | 处于受限态 |

**备注**：执行顺序刻意固定为 **验旧密码 → 写新哈希 → 轮换 sid → 踢其它会话（保留当前）→ 审计**——先轮换后写库会让用户陷入"旧密码已失效、新密码又没生效"。
#### `POST /api/v1/auth/2fa/setup` — 生成待确认密钥 + 二维码 ✅ 已实现（B6）

| 项 | 值 |
|---|---|
| 认证 | Cookie（`full` / `totp_pending` / `setup_required` 三态**都可达**） |
| CSRF | 必带 |
| 审计 | `user.2fa_setup` |

**请求**：无 body。

**成功 200**

| 字段 | 类型 | 说明 |
|---|---|---|
| `secret` | string | Base32（无填充，32 字符）——供**手工输入**认证器；⛔ 明文仅此一次，库里只存 AES-256-GCM 密文 |
| `otpauth_uri` | string | `otpauth://totp/Vantage:<username>?secret=…&issuer=Vantage&algorithm=SHA1&digits=6&period=30` |
| `qr_svg` | string | 服务端渲染的 **SVG 文本**（`qrcode` 依赖），前端直接内联渲染即可 |

**错误**

| 状态 | code | 触发 |
|---|---|---|
| 401 | `session_expired` | 无会话 |
| 403 | `csrf_invalid` | 缺 CSRF |
| 409 | `conflict` | **该账号已绑定 2FA**（⛔ 允许换绑=用密码绕过 2FA；自救走恢复码或管理员重置，见 §4.1.1 ⑧ D7） |

**备注**：`setup` 只写"待确认密钥"（`totp_enabled` 保持 `false`），⛔ **未通过 `enable` 前不生效**；未绑定时重复 setup 会覆盖上一次的待确认密钥（无副作用）。

#### `POST /api/v1/auth/2fa/enable` — 验码绑定 + 下发恢复码 ✅ 已实现（B6）

| 项 | 值 |
|---|---|
| 认证 | Cookie（`setup_required` / `full` 可调；`totp_pending` ⛔ 403 `totp_required`） |
| CSRF | 必带 |
| 审计 | 成功 `user.2fa_enable`（`detail.recovery_codes=10`）；失败 `user.2fa_enable_failed` |

**请求体**

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `code` | string | ✅ | 认证器当前 6 位码（6–8 字符） |

**成功 200** + `Set-Cookie: vantage_sid=<新 sid>`

| 字段 | 类型 | 说明 |
|---|---|---|
| `recovery_codes` | string[] | **恰好 10 个**一次性恢复码，形如 `XXXXX-XXXXX`（Crockford Base32，无 `I/L/O/U`）；⛔ 明文仅此一次，库里只存 HMAC 哈希 |
| `remaining_recovery_codes` | number | 当前可用数量（此处恒 10） |

**错误**：400 `invalid_totp`（码错 / 重放）｜400 `invalid_request`（未先 setup，或待确认密钥已失效）｜401 `session_expired`｜403 `csrf_invalid`｜403 `totp_required`（pending 态）｜409 `conflict`（已绑定 / 绑定状态并发变化）

**备注**：✅ 验码通过 = 已证明持有 → 会话**直接置为 `full`** 并轮换 sid（D1：绑定成功即下发 10 个恢复码，前端须强制提示保存）。

#### `POST /api/v1/auth/2fa/disable` — 密码二次确认解绑 ✅ 已实现（B6）

| 项 | 值 |
|---|---|
| 认证 | Cookie，**必须完整态** |
| CSRF | 必带 |
| 审计 | 成功 `user.2fa_disable`（`detail.recovery_codes_deleted`）；失败 `user.2fa_disable_failed`（`detail.reason`） |

**请求体**

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `password` | string | ✅ | 1–128；**密码二次确认**（⛔ 不接受 TOTP 码替代） |

**成功 204**（无响应体；**不轮换 sid、不踢会话**——用户仍是完整态）

**错误**

| 状态 | code | 触发 |
|---|---|---|
| 401 | `invalid_credentials` | 密码不正确 |
| 403 | `csrf_invalid` | 缺 CSRF |
| 403 | `totp_required` / `totp_setup_required` | 非完整态 |
| 409 | `conflict` | 尚未绑定 2FA，**或** `security.require_2fa=true` 时禁止自助解绑（✅ D3，`reason=require_2fa_policy`） |

**备注**：✅ 解绑**连恢复码一起作废**（D5，`resetTotp` 两条语句在同一事务内），避免留下悬空凭据。

#### `POST /api/v1/auth/2fa/recovery/verify` — 用恢复码过第二步 ✅ 已实现（B7）

| 项 | 值 |
|---|---|
| 认证 | Cookie（`totp_pending` 态的主要用途） |
| CSRF | 必带 |
| 限流 | **与 `login` 共用** `ratelimit:login:<ip>` |
| 审计 | 成功 `user.recovery_used`（`detail.remaining_recovery_codes`）；失败 `user.recovery_verify_failed` |

**请求体**

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `code` | string | ✅ | 8–20 字符；**归一化在哈希口径内**：大小写、连字符、空白、易混字符（`I/L→1`、`O→0`）都能命中同一条记录 |

**成功 200** + `Set-Cookie: vantage_sid=<新 sid>`

| 字段 | 类型 | 说明 |
|---|---|---|
| `remaining_recovery_codes` | number | 剩余可用数量（≤2 时前端应强提示重新生成） |

**错误**：400 `invalid_totp`（不存在 / **已用过** / 格式非法）｜400 `schema_invalid`｜401 `session_expired`｜403 `csrf_invalid`｜409 `conflict`（账号已解绑，恢复码已随之作废）｜429 `rate_limited`

**备注**：消耗是单条 `UPDATE … WHERE used_at IS NULL`（行锁保证并发下**同一码只可能成功一次**，用后即废）；成功后轮换 sid 并置 `totp_ok=true`。

#### `POST /api/v1/auth/2fa/recovery/regenerate` — 重发 10 个恢复码 ✅ 已实现（B7）

| 项 | 值 |
|---|---|
| 认证 | Cookie，**必须完整态** |
| CSRF | 必带 |
| 审计 | `user.recovery_regenerate`（`detail.recovery_codes=10`） |

**请求**：无 body。

**成功 200**：`{ recovery_codes: string[10], remaining_recovery_codes: 10 }`（字段同 `enable`，明文仅此一次）

**错误**：401 `session_expired`｜403 `csrf_invalid`｜403 `totp_required`（pending 态）｜403 `totp_setup_required`｜409 `conflict`（未绑定 2FA）

**备注**：**整批替换**——旧码在事务内被删除、立即失效（前端须提示"旧恢复码已全部作废"）。

**SSO（OIDC）本期不做，仅预留（✅ 本轮决策）**

- `users` 表已预留 `oidc_issuer` / `oidc_subject` / `oidc_email` / `oidc_linked_at` / `oidc_last_sync_at`（见 `docs/database.md` §5.3）；本期**不实现** OIDC 流程，**不开放** `/api/v1/auth/oidc/*` 端点。
- 预留形态（后续对接时按此实现）：`GET /api/v1/auth/oidc/start`（302 跳 IdP authorize，携带 `state` + `nonce` + PKCE）、`GET /api/v1/auth/oidc/callback`（校验 `state` 与 `id_token` → 按 `(oidc_issuer, oidc_subject)` 定位 `users` → 复用同一套 Redis `sid` 会话机制）、`POST /api/v1/auth/oidc/link` / `unlink`（已登录用户自助绑定/解绑）。
- ❓ 后续待定：是否允许 SSO 自助注册、IdP 的 group/role claim 如何映射到 `admin`/`user`（`docs/database.md` §12.2 N3）。
- ⛔ 红线：OIDC 只用于**面板登录**，不得成为「向 Agent 下发」的通道（`docs/api.md` §2.3、设计 §18.3）。

#### 4.1.1 实现规范与落地状态（2026-10-02 定稿）

> 本节是**契约级落地清单**（不含代码）：把 §4.1 的契约展开到「Redis 键 / 状态判定 / 错误码 / 依赖 / 落地顺序」这一层，供实现与验收逐条对照。
> **怎么读**：标【✅ 已生效】的是当前代码的真实行为（以本节为准）；标【⏳】的是已定稿、尚未落地（或部分落地）的方案。落地进度总表见 ⑦，开放决策见 ⑧。

**① 会话模型【✅ 已生效】（Redis；键空间见 `docs/database.md` §7，⛔ 不新增用途前缀）**

| 键 | 结构 | TTL | 字段 |
|---|---|---|---|
| `session:<sid>` | hash | 滑动 30min + 绝对 24h | `user_id`、`roles`（JSON 数组串，恒 `["admin"]`/`["user"]`）、`totp_ok`、`setup_required`、`created_at`、`last_seen`、`ip`、`ua`（截断 ≤200 字符）、`csrf` |
| `user_sessions:<uid>` | set | 同会话 | 该用户全部 sid（限并发 `SESSION_MAX_PER_USER`=3、踢最旧、全部下线） |

- Cookie：名取 `config.security.session.cookieName`（默认 `vantage_sid`），`HttpOnly + SameSite=Lax + Path=/ + Max-Age=绝对 TTL`，`Secure` 由 `COOKIE_SECURE` 决定。
- `last_seen` 仅在距上次写入 > 60s 时更新（否则每个请求一次 Redis 写）。
- **集合自愈**：每次登录都会整理 `user_sessions:<uid>` —— ① 清掉「hash 已过期但成员还在」的僵尸 sid（Redis 过期只删键，没人负责 `SREM`，不清理会让集合随"登录→闲置过期→再登录"无界增长）；② 存活会话超过上限则踢最旧。⛔ 新建的那个 sid 永不参与淘汰（同毫秒创建时"最旧"可能就是它自己）。
- **轮换**（✅ 决策 #32）：过 2FA、改密、恢复码验证成功 → 新建 sid + 删旧 sid + 原子替换 `user_sessions` 成员，响应重新下发 Cookie；⛔ `csrf` **不随轮换改变**（防的是会话标识被固定；跟着换会让返回 204 的接口来不及把新 csrf 交给前端，自伤成"后续写请求全 403"）。
- CSRF：会话 hash 内 `csrf` 与请求头 `X-CSRF-Token` 双提交比对；⛔ 仅 `/auth/login` 豁免（此时无会话，前端 `skipCsrf` 已按此实现）。

**② 三态矩阵（受限态判定）【✅ 已生效】**

| 状态 | 判定 | 放行 | 其余接口 |
|---|---|---|---|
| `full` | `totp_ok=1` | 全部 | — |
| `totp_pending` | 已绑 TOTP 但未过第二步 | `me`、`2fa/verify`、`2fa/recovery/verify`、`2fa/setup`、`logout*` | 403 `totp_required` |
| `setup_required` | `security.require_2fa=true` 且该账号 `totp_enabled=false` | `me`、`2fa/setup`、`2fa/enable`、`logout*` | 403 `totp_setup_required` |

> ❓ D2：`me` 在受限态**返回 403**（而非 200）——面板 `web/src/store/auth.ts` 的 `refreshMe()` 正是靠捕获 `totp_setup_required` 进入强制绑定流程；此处与 §4.1 原文「放行 `auth/me`」的字面表述有差异，按 D2 结论统一。
> ❓ D7：矩阵里 `totp_pending` 放行列表中的 `2fa/setup` 指"**可达**"（不因状态 403），但服务层对**已绑定账号**一律 409 `conflict`——放行 ≠ 会成功；否则"换绑再自验"就是 2FA 绕过（详见 ⑧ D7）。`2fa/enable` 在 `totp_pending` 态**不**放行（403 `totp_required`，⛔ 重复绑定）。
> `security.require_2fa` 的读取：新增**最小** `services/settings.service.js`（四个白名单 key 的默认值 + `getBool()`，带 `settings:cache` TTL 30s，缺行取默认）；M3 的 `PATCH /api/v1/settings`（§4.10）直接复用，不返工。

**③ 错误码【✅ 已生效】**（⛔ 不得改名，前端 i18n 与错误映射已就位）：`invalid_totp`（400）、`totp_setup_required`（403）。

**④ Redis 键【✅ 已生效】**：`totp:used:<user_id>`（TTL 90s）—— 同一 TOTP 步号只接受一次，防 30s 窗口内重放同一验证码（SET 结构存步号集合，`enable` 与 `2fa/verify` 共用；见 ⑨ 防重放条）。
✅ **S 系列已新增 4 个键**（已登记进 `docs/database.md` §7）：`captcha:<captcha_id>`（题目与答案，TTL 120s）、`captcha:ok:<captcha_token>`（一次性凭证，值绑定 IP，TTL 120s）、`login:fail:ip:<ip>` 与 `login:fail:acct:<sha256(用户名)[:16]>`（失败计数，TTL = 登录窗口 `loginWindowS`）；另有独立限流桶 `ratelimit:captcha:<ip>`。

**⑤ TOTP 与恢复码【✅ 已生效（B1 原语 + B6/B7 端点）】（零依赖自研，`node:crypto`；二维码渲染用 `qrcode`，server/ 已安装）**

- 密钥：20 字节随机 → RFC 4648 Base32；`otpauth_uri` = `otpauth://totp/Vantage:<username>?secret=…&issuer=Vantage&algorithm=SHA1&digits=6&period=30`（label 需 URL 编码）。
- 校验：容 ±1 步（时钟漂移）+ 常量时间比较；实现自测用 **RFC 6238 Appendix B 官方向量**（明文 `12345678901234567890` → Base32 `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`；`T=59 → 287082`、`T=1111111109 → 081804`）——向量不符时**修实现**，不放宽断言。
- `totp_secret_enc`：AES-256-GCM，AAD = `totp-secret:<user_id>`（与 `agentSecretAad` 同理，防密文跨用户搬运）。
- 恢复码：固定 10 个、每个 10 字符 Base32（去易混 `0/O/1/I`）、展示形如 `XXXXX-XXXXX`；库里**只存** `HMAC-SHA256(SECRET_KEY, "vantage:recovery:" + 归一化码)` 的哈希；重新生成＝整批替换（旧码立即作废）；使用＝置 `used_at`（用后即废）。
- `qr_svg`：服务端用 `qrcode` 渲染 SVG。✅ `server/` 已安装 `qrcode@^1.5.4`（本模块唯一新增运行时依赖）。

**⑥ 首管员与离线救援 CLI【✅ 已落地】**（否则 `users` 为空、无人能登录）：`server/scripts/create-user.js`，风格对齐 `scripts/create-agent.js`：

```
node scripts/create-user.js --username admin --role admin --password-stdin   # 建首个管理员
node scripts/create-user.js --list                                          # ⛔ 不返回 password_hash / totp_secret_enc
node scripts/create-user.js --reset-password <username> --password-stdin
node scripts/create-user.js --reset-2fa <username>                          # 离线版「恢复渠道二」
```

⛔ 密码只经 stdin 传入（不进 shell 历史与 `ps`），且任何路径都不打印口令/密钥。

**⑦ 落地顺序（分块交付，每块独立可验收）**

> 进度（2026-10-03）：**B1–B8 ✅ 已落地**；**S1–S4 ✅ 已落地**（S1 原语+单测、S2 服务/端点/限流/失败计数、S3 前端、S4 文档登记）；**S5–S7 ✅ 已落地**（极验后端）；**S8 ✅ 已落地**（极验前端）。⏳ 全部**待 Owner 跑 `npm test` 验收**（B 系列既有 111 例 + S 系列新增用例）、`vue-tsc` 与真机验证。
> ⚠️ 端点可用性：本节 13 个端点**全部可用**（重启 vantage-core 后生效）。

| 块 | 内容 | 验收口径 | 状态 |
|---|---|---|---|
| B1 | `utils/totp.js` + `crypto.js` 增 `totpSecretAad` / `hashRecoveryCode` / `verifyRecoveryCode` | 纯离线单测：RFC 6238 向量、Base32 往返、恢复码归一化 | ✅ 已落地（`test/totp.test.js`） |
| B2 | `repositories/user.repo.js`（users + user_recovery_codes）+ `scripts/create-user.js` | PGlite 真 SQL 用例（跑 0001–0008 迁移）；能建出首个 `admin` | ✅ 已落地（`test/user.repo.test.js`） |
| B3 | `services/session.service.js` + `middleware/authPanel.js` + 错误码 + `totp:used` 键 | 会话生命周期：滑动/绝对超时、并发上限踢最旧、轮换、CSRF | ✅ 已落地（`test/session.test.js`；⚠️ 所有 preHandler 必须 `async`，否则 Fastify 按回调式处理会让请求永久挂起） |
| B4 | `routes/auth.js`：`login` / `me` / `logout` / `logout-all` + 登录限流 + Cookie + 审计 | 桩 PG/Redis + `app.inject()`；**此时前端 `/login` 首次可联通** | ✅ 已落地（`test/auth.test.js`；含最小 `services/settings.service.js` 读取 `security.require_2fa`） |
| B5 | `POST /auth/password` | 改密后旧 sid 立即失效、其它会话被踢、写审计 | ✅ 已落地（同上） |
| B6 | `2fa/setup`（含 `qrcode` 依赖）/ `2fa/enable` / `2fa/disable` | 真机扫码绑定一次（人工，见下「需要人工验证什么」） | ✅ 已落地（`test/auth.2fa.test.js`） |
| B7 | `2fa/recovery/regenerate` / `recovery/verify` + `2fa/verify` + `require_2fa` 受限态补全 + 防重放 | §6.2 的用例 12–14（10/11 已随 B4/B5 覆盖） | ✅ 已落地（同上） |
| B8 | 文档回填：本节去掉 ⏳、§4.1 表状态列改 ✅、补「需要人工验证什么」清单 | 文档与代码口径一致 | ✅ 已落地（本轮随 B6/B7 完成） |
| S1 | `utils/slider.js`（出题 / 容差 / 轨迹判定纯函数）+ `test/slider.test.js` | 容差边界、轨迹各规则正反例、200 次出题随机性、**响应字符串不含答案** | ✅ 已落地（`test/slider.test.js`） |
| S2 | `services/captcha.service.js` + 2 个端点 + 独立限流桶（`utils/redisCounter.js` 复用固定窗口 Lua）+ 两个失败计数器 + 错误码 + 键登记 + 设置项/`getSettingInt` | `docs/slider-captcha-selfbuilt.md` §10.3 的 AC-1…AC-13 | ✅ 已落地（`test/auth.captcha.test.js`） |
| S3 | `SliderCaptcha.vue` + `Login.vue` 集成 + `store/auth.ts`/`api/private.ts` + i18n | 「首次不出现 / 出错就地出现 / 拖对自动重提」三条人工验证 + `vue-tsc` 通过 | 🔶 已落地（前端，⏳ 待联调与编译验证） |
| S4 | 文档回填（本节、`database.md` §5.4/§7、`frontend.md` §4.2） | 文档与代码口径一致 | ✅ 已落地（后端部分；`frontend.md` 的公开域口径待一并更正） |
| S5–S7 | 极验 v4 后端（纯函数 + provider 抽象 + 端点/配置/熔断） | `docs/geetest-captcha.md` §10.1/§10.2（AC-G1…AC-G12） | ✅ 已落地（`test/geetest.test.js`、`test/auth.captcha.geetest.test.js`；落地记录见该文 §16） |
| S8 | 极验 v4 前端（`GeetestCaptcha.vue` + `utils/geetest.ts` + `Login.vue` 按 `provider` 选组件 + i18n） | 「首次不出现 / 密码错后就地出现官方按钮 / 通过后自动重提 / `CAPTCHA_PROVIDER=selfbuilt` 时回落滑块」+ `vue-tsc` 通过 | ✅ 已落地（前端；⏳ 待 `vue-tsc` 与真机联调，落地记录见 `docs/geetest-captcha.md` §16.7） |

**需要人工验证什么（Owner 清单，B6/B7 验收口径）**

1. `cd server && npm test` —— 新增 `test/auth.2fa.test.js`（26 例）应全绿，既有 85 例不回归。
2. 重启 vantage-core 后，真机走一次绑定：`设置 → 绑定 2FA`（或先用 curl 打 `2fa/setup`）→ 用认证器（Google Authenticator / 1Password 等）**扫码** → 输入 6 位码 `enable` → 确认认证器里显示「Vantage:<用户名>」。
3. 登出再登录：应出现第二步验证；输入认证器实时码应通过；**30s 内重复使用同一码应被拒**（防重放）。
4. 用一个恢复码登入 → 确认「剩余 9 个」提示；再把剩余数量打到 ≤2 验证前端强提示。
5. `security.require_2fa=true` 下用一个未绑定账号登录 → 应被引导到绑定页并完成强制绑定。
6. （可选）`node scripts/create-user.js --reset-2fa <username>` 走一遍离线救援，确认被锁用户可重新登录。

> 未列入 **B 系列**的（⛔ 当时不在范围）：用户管理 CRUD（§4.9）、`PATCH /api/v1/settings`（§4.10）、OIDC 流程、WS 鉴权、前端任何改动。
> ⚠️ **S 系列例外**：登录人机验证**包含前端改动**（`web/src/components/SliderCaptcha.vue` + 登录页集成），这是它的必要组成部分。

**⑧ 待 Owner 拍板（D1–D6 已按建议实现，待追认；D7 为实现期安全收敛，待追认）**

| # | 议题 | 建议 | 状态 |
|---|---|---|---|
| D1 | `2fa/enable` 是否顺带生成并返回 10 个恢复码（§4.1 原表未写，但 `docs/frontend.md` §4.6 要求「绑定成功即展示 10 个码」） | 是：`enable` 返回 `{ recovery_codes, remaining_recovery_codes }`，并同步补 §4.1 表 | ✅ 已按建议实现（§4.1 表已同步） |
| D2 | 受限态下 `GET /auth/me` 的返回码（原文写「放行」） | 403 `totp_setup_required`（前端已按此实现，见本节 ②） | ✅ 已按建议实现 |
| D3 | `security.require_2fa=true` 时是否禁止自助解绑 2FA | 禁止，返回 409 `conflict` | ✅ 已按建议实现 |
| D4 | 改密策略 | 长度 8–128（Schema 卡边界）+ 不得与旧密码相同（400 `invalid_request`）+ 必须在 `full` 态 | ✅ 已按建议实现 |
| D5 | `2fa/disable` 是否同时作废全部恢复码 | 是（避免留下悬空凭据） | ✅ 已按建议实现（事务内解绑+清码） |
| D6 | 审计 `action` 命名 | `auth.login` / `auth.logout` / `auth.logout_all` / `auth.password_change` / `auth.2fa_verify` / `user.2fa_setup`·`enable`·`disable` / `user.recovery_regenerate`·`used` | ✅ 已全部启用（失败路径另加 `*_failed` 变体，见 ⑨） |
| D7 | 矩阵②把 `2fa/setup` 列入 `totp_pending` 放行（原文）——字面实现允许"只持密码者换绑验证器再自验"，构成 **2FA 绕过** | 收敛为：已绑定账号（含 `totp_pending` 态）调用 setup → 409 `conflict` 且不动库；丢设备自救走恢复码（渠道一）或管理员重置（渠道二） | 🔶 已按安全收敛实现，**待 Owner 追认**（若坚持原文放行，需先给出防绕过的替代约束） |

**⑨ 已实现行为细则（B4–B7，与代码逐条对应）**

**登录 / 会话 / 改密（B4/B5）**

- **登录限流**：成功与失败**都计数**（只数失败会让攻击者用正确密码"洗白"计数）；Redis 不可用时拒绝服务（503），⛔ 不做无限流登录。
- **等时校验**：账号不存在（或 SSO-only 无本地密码）时也对固定假哈希跑一次完整 Argon2——"账号不存在"与"密码错"的**响应体和耗时都不可区分**。
- **失败审计**：`auth.login_failed` 的 `detail.reason` 恒为 `invalid_credentials`（审计可被 `user` 角色读取，⛔ 不在里面写"账号是否存在"的答案）；`target` 记尝试的用户名。
- **改密顺序**：验旧密码 → 写新哈希 → 轮换 sid → 踢其它会话（保留当前）→ 审计。
- **审计 action**：`auth.login` / `auth.login_failed` / `auth.logout` / `auth.logout_all` / `auth.password_change` / `auth.password_change_failed`。
- **`require_2fa` 的读取**：`settings` 表 + `settings:cache` 缓存（TTL 30s），变更需主动失效缓存（✅ R16）。

**2FA（B6/B7）**

- **setup 的绑定守卫（✅ D7 收敛）**：`totp_enabled=true` 时 setup 一律 409 `conflict` 且**不动库**（矩阵原把 setup 列入 `totp_pending` 放行，字面实现=用密码绕过 2FA，见 ⑧ D7）。
- **防重放**：`verifyTotp()` 命中的**步号**必须先经 Redis `SADD totp:used:<uid>`（TTL 90s）原子认领，返回 0 即重放 → 400 `invalid_totp` + 审计 `reason='replayed_step'`（与 `invalid_totp` 区分：这是"有人重复使用验证码"的安全信号）。`enable` 与 `2fa/verify` 共用该守卫；90s 恰好覆盖 ±1 步的可验证窗口。
- **状态门槛**：见 §4.1.0 的三态矩阵；限流中间件挂在会话校验**之前**（无会话狂刷 verify 同样计数）。
- **enable 成功 = 已过第二步**：验证码即持有证明，会话直接补丁为 `full` 并**轮换 sid**；恢复码在 enable 时生成并整批写入（D1）。
- **disable 的顺序**：验密码（统一 401）→ 未绑定 409 → `require_2fa` 策略 409（D3）→ 事务内解绑+清恢复码（D5，`resetTotp` 两条语句）。**不轮换 sid、不动当前会话**。
- **第二步不写 `touchLogin`**：`users.last_login_method` 的 CHECK 只允许 `password/totp/oidc`（迁移 0002），且第一步已记录本次登录的时间与 IP——不为此发明新枚举值。
- **恢复码校验的容错口径**：归一化（大写、去连字符/空白、`I/L→1`、`O→0`）在**哈希口径之内**，`a1b2c-d3e4f` 与 `A1B2CD3E4F` 命中同一条记录；消耗是单条 `UPDATE … WHERE used_at IS NULL`；错误码统一 400 `invalid_totp`。
- **审计 action**：成功 `user.2fa_setup` / `user.2fa_enable` / `user.2fa_disable` / `user.recovery_regenerate` / `user.recovery_used` / `auth.2fa_verify`；失败对应 `*_failed`（`detail.reason`：`invalid_totp` / `replayed_step` / `invalid_code` / `invalid_credentials` / `require_2fa_policy`）。⛔ detail 里没有验证码、恢复码明文、secret（有测试钉住）。

### 4.2 主机（需登录，含 IP 与历史）

> 全部 ⏳ 未实现（M2）。⚠️ 本节的响应字段清单以设计文档已明确者为限，未列出的细节（如详情页 `host_info` 的完整字段集）**待实现时按 `docs/database.md` 定稿**，⛔ 不要凭本节猜测。

#### `GET /api/v1/hosts` — 主机列表

**查询参数**

| 参数 | 必需 | 说明 |
|---|---|---|
| `status` | ➕ | `online` / `offline` / `disabled` |
| `tag` | ➕ | 按标签过滤 |
| `q` | ➕ | 名称模糊搜索 |
| `limit` / `cursor` | ➕ | 见 §1.2 ③（默认 20 / 上限 200，keyset 游标） |

**返回 200**：数组（+ 分页时的 `next_cursor`），每项字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string(uuid) | 内部 ID（⛔ 仅私有接口可见） |
| `name` | string | 主机名 |
| `display_name` | string \| null | 显示名 |
| `tags` | string[] | 标签 |
| `status` | string | `online` / `offline` / `disabled` |
| `os` / `arch` | string \| null | 系统 / 架构 |
| `last_seen_at` | string(RFC3339) | 最近上报时间（**精确值**；公开接口才做相对化处理） |
| `last_ip` / `reported_ip` | string \| null | 上报来源 IP / Agent 自测出口 IP（双源比对，✅ §8） |
| `clock_drift_ms` | number \| null | 时钟漂移（决策 #16/#17） |
| `ip_flapping` | boolean | 是否处于 IP 抖动（决策 #39） |
| `active_alerts` | number | 当前未恢复告警数 |
| `snapshot` | object | 当前快照（结构同 §3.3 的 `snapshot`） |

**错误**：401 `session_expired`（未登录）

#### `GET /api/v1/hosts/{id}` — 主机详情

**路径参数**：`id`（内部 UUID）。
**返回 200**：主机信息 + `host_info` + `capabilities` + 当前快照 + 探活当前状态（各子对象的完整字段集待实现时定稿，见本节开头提醒）。

#### `GET /api/v1/hosts/{id}/metrics` — 时序查询

见 **§4.3**（该节有完整的查询参数、档位约束与响应格式）。

#### `GET /api/v1/hosts/{id}/probes` — 探活历史

**查询参数**：`from` / `to`（时间范围）、`name`（探活名）、`type`（`ping` / `http` / `https` / `tcp`）。

**返回 200**

| 字段 | 类型 | 说明 |
|---|---|---|
| `probes`（或数组本体） | array | 每项 `{ probe_name, probe_type, target, up, latency_ms, status_code, error, checked_at }` |
| 当前状态摘要 | object | 每个 probe 的当前 up/down 摘要（与历史同响应返回） |

#### `GET /api/v1/hosts/{id}/ip-history` — IP 变更历史

**查询参数**：`from` / `to`。

**返回 200**

| 字段 | 类型 | 说明 |
|---|---|---|
| `ranges` | array | 每项 `{ ip, source, first_seen, last_seen }` |
| `events` | array | 每项 `{ old_ip, new_ip, same_subnet, source, kind, change_count, changed_at }` |

> ✅ §8：该接口支撑「当前 IP + 变更时间线」的展示；`source` 区分 `agent_reported` / `center_observed` 等来源。

#### `GET /api/v1/hosts/{id}/processes` — 进程 Top 快照

**查询参数**：`at`（unix 毫秒或 RFC3339；省略取**最近一条**）。

**返回 200**

| 字段 | 类型 | 说明 |
|---|---|---|
| `ts` | number | 该快照的时间戳 |
| `total` | number | 进程总数 |
| `top` | array | 每项 `{ pid, name, cpu, mem }`（明细来自 `process_snapshots`，⛔ 不进时序库） |

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

### 4.4 Agent 与凭证管理（需登录，✅ 全部仅 `admin`）

> 全部 ⏳ 未实现（M3）。⛔ 本节任何响应都**不得**出现 `agent_key_hash` / `agent_secret_hash` / `agent_secret_enc`；明文凭证**只在创建与轮换的响应里出现一次**。

#### `GET /api/v1/agents` — Agent 列表

**查询参数**：无（➕ 可按 `status` 过滤，待实现时定）。

**返回 200**：数组，每项字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | string | `active` / `disabled` / `revoked` |
| `rotated_at` | string(RFC3339) \| null | 最近一次凭证轮换时间 |
| `credential_age_days` | number | `now() - COALESCE(rotated_at, created_at)` 的天数 |
| `rotate_recommended` | boolean | 是否超阈（✅ 本轮决策：列表徽标） |
| `last_seen_at` | string(RFC3339) \| null | 最近上报时间 |
| `last_ip` | string \| null | 最近上报 IP |

响应根级另附 `rotate_policy`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `rotate_policy` | object | `{ days, notify }`，由 `settings` 的 `credential_rotate.*` 派生；⛔ 前端不硬编码阈值 |

#### `POST /api/v1/agents` — 创建 Agent

**请求体**

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | **唯一**；重名 → 409 `already_exists` |
| `display_name` | string | ➕ | 显示名 |
| `tags` | string[] | ➕ | 标签 |

**成功 201**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string(uuid) | 内部 ID |
| `public_slug` | string | 公开标识（与内部 UUID 无关，见 §3.1） |
| `agent_key` | string | `vk_` 前缀；⛔ **仅此一次**返回，之后永不可再取（✅ §6.1） |
| `agent_secret` | string | `vs_` 前缀；⛔ 同样仅此一次 |
| `install_hint` | string | 带 key 的一键安装命令（`VANTAGE_KEY` env 内联）+ 交互式 / `--key-file` 两种替代形式（✅ 决策 #37 修订，见下文） |

**错误**：400 `schema_invalid`｜409 `already_exists`（重名）｜403 `role_denied`（非 admin）

#### `GET /api/v1/agents/{id}` — 元信息

**返回 200**：Agent 元信息；⛔ 不含任何明文凭证或哈希值。

#### `PATCH /api/v1/agents/{id}` — 改显示名 / 标签

**请求体**：`{ display_name?, tags?, name? }`——`name` 变更同样要过唯一性校验（重名 → 409 `already_exists`）。
**返回 200**：更新后的元信息。

#### `POST /api/v1/agents/{id}/rotate` — 手动轮换凭证

**请求体**：无。
**返回 200**：结构同创建（`{ id, public_slug, agent_key, agent_secret, install_hint }`，明文仅一次）。
**语义**：✅ 旧凭证**立即失效**（⛔ 无并存过渡期）；中心无法下发新 key，管理员须自行上机替换 key 文件后 `reload`/`restart`（`docs/agent.md` §6）；替换窗口内该机上报 401 → 会被判离线并触发告警。

#### `POST /api/v1/agents/{id}/disable` \| `/enable` — 禁用 / 启用

**请求体**：无。**语义**：禁用后该 Agent 上报一律 401 `agent_unknown_or_disabled`。

#### `POST /api/v1/agents/{id}/revoke` — 吊销

**请求体**：无。**语义**：不可恢复；`disabled_at` 落库，历史数据保留。

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

> 全部 ⏳ 未实现（M3）。

#### `GET /api/v1/alert-events` — 告警事件列表

**查询参数**

| 参数 | 说明 |
|---|---|
| `status` | `firing` / `resolved` |
| `severity` | `info` / `warn` / `critical` |
| `agent_id` / `rule_id` | 按主机 / 规则过滤 |
| `metric` | 按**触发序列全名**过滤 |
| `from` / `to` | 时间范围 |
| `limit` / `cursor` | 见 §1.2 ③ |

**返回 200**：数组（+ 分页时的 `next_cursor`），每项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `metric` | string | **触发序列全名**（✅ 本轮决策：同一规则在不同挂载点/网卡上各自成条） |
| `value` | number | 触发时的值 |
| `started_at` | string(RFC3339) | 触发时间 |
| `resolved_at` | string(RFC3339) \| null | 恢复时间 |
| `notified_at` | string(RFC3339) \| null | 最近一次通知时间 |

> ✅ 已定（本轮）：**不引入事件 `ack`（认领）语义**——"别再报"用静默窗口/维护期（§4.7）与规则 `cooldown` 覆盖；⛔ 不加 ack 字段与按钮。
> 📌 前端可用 `labels` 把全名渲染成可读名（`docs/frontend.md`）。

#### `GET /api/v1/alert-events/{id}` — 事件详情

**返回 200**：事件本体 + `notification_log` 数组（该事件的各次发送结果，✅ §7.3）。

#### `GET /api/v1/channels` — 通知通道列表

**返回 200**：数组；⛔ 敏感字段（SMTP 密码、加签 secret、Webhook token）**只回遮罩值**（如 `smtp_pwd: "****"`）。

#### `POST /api/v1/channels` — 创建通道

**请求体**：`{ kind, name, config, template, rate_limit?, enabled }`，`kind` ∈ `smtp` / `wecom` / `dingtalk` / `feishu` / `webhook`（✅ §7.2）。
**返回 201**：创建后的通道（敏感字段同样遮罩）。

#### `PATCH /api/v1/channels/{id}` — 更新通道 ｜ `DELETE /api/v1/channels/{id}` — 删除通道

- **PATCH**：`config` 采用**部分更新**——未提交的敏感字段保持原值（⛔ 不会因为"前端没回填密码"而被清空）。
- **DELETE**：✅ 仍被规则引用 → 409 `channel_in_use`（须先解绑，⛔ 不级联删规则）。

#### `POST /api/v1/channels/{id}/test` — 发送测试消息

**请求体**：无（或可选测试文案）。
**返回 200**：`{ ok, error? }`；结果同时记入 `notification_log`（✅「可测发送」）。

#### `GET /api/v1/notification-log` — 发送记录（排障）

**查询参数**（➕ 建议）：`event_id` / `channel` / `ok` / `from` / `to`。

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
**用户管理端点（➕ 建议，仅 `admin`；字段级契约待 M3 定稿）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/users` | 用户列表（含 `role`/`status`/`totp_enabled`/`recovery_codes_left`；⛔ 不含 `password_hash`/`totp_secret_enc`） |
| POST | `/api/v1/users` | 创建用户（`{ username, password?, role, display_name?, email? }`） |
| PATCH | `/api/v1/users/{id}` | 改 `role` / `display_name` / `status` |
| POST | `/api/v1/users/{id}/password-reset` | 重置他人密码（⛔ 明文不回显） |
| POST | `/api/v1/users/{id}/2fa/reset` | ✅ 已定（恢复渠道二）：清空目标用户 `totp_enabled=false`、`totp_secret_enc=NULL`，**作废其全部恢复码**，**强制踢下线该用户所有会话**，写审计（`action=user.2fa_reset`）；⛔ 不允许经该接口读取或导出任何 TOTP 密钥；前端须二次确认（输入用户名） |

> ⚠️ 上表除 `2fa/reset` 外均为 ➕ 建议，请求/返回字段集在 M3 实现时定稿；⛔ 任何用户接口都不得返回 `password_hash` / `totp_secret_enc`。

### 4.10 系统设置 `settings`（✅ 本轮决策：面板可改、立即生效）

> ⏳ 未实现（M3）。`user` 角色**可读**，仅 `admin` 可改。

#### `GET /api/v1/settings` — 读取全部设置项

**请求参数**：无。

**返回 200**：数组，每项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 白名单 key（见下表） |
| `value` | 任意 | 当前生效值 |
| `type` | string | 该 key 的类型（`bool` / `int`），供前端渲染控件 |
| `default` | 任意 | 代码默认值 |
| `updated_by` | string(uuid) \| null | 最近一次修改者 |
| `updated_at` | string(RFC3339) \| null | 最近一次修改时间 |

#### `PATCH /api/v1/settings` — 修改设置项（仅 `admin`）

**请求体**：部分更新对象，键为白名单 key，例如 `{ "public_view.enabled": false, "credential_rotate.reminder_days": 60 }`。

**返回 200**：更新后的**全量**设置集合（结构同 `GET`）；**立即生效**（无需重启）。

**错误**

| 状态 | code | 触发 |
|---|---|---|
| 400 | `unknown_setting` | key 不在白名单（⛔ 未登记 key 一律拒绝） |
| 400 | `invalid_setting_value` | 值的类型不符合该 key 的定义 |
| 403 | `role_denied` | 非 `admin` |

**白名单与默认值**（与 `docs/database.md` §5.4 一致）

| key | 类型 | 默认 |
|---|---|---|
| `public_view.enabled` | bool | **true**（✅ 本轮决策） |
| `security.require_2fa` | bool | false |
| `credential_rotate.reminder_days` | int | 90 |
| `credential_rotate.notify` | bool | true |
| `security.login_captcha.enabled` | bool | **true**（S 系列：开启＝"密码错后要求滑块"；关闭时取题端点 404） |
| `security.login_captcha.after_failures` | int | **1**（S 系列：失败几次后开始要求，1–10；1 = 一次密码错就要） |

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

**消息类型总表**（⛔ 客户端→服务端**只允许** `subscribe` 一种应用层消息）

| 方向 | `type` | 时机 | 关键字段 |
|---|---|---|---|
| 服务端 → 客户端 | `snapshot` | 连接建立后**立即**推全量 | `ts`、`hosts[]`、`summary` |
| 客户端 → 服务端 | `subscribe` | 连接后按需订阅 | `channels[]`（缺省＝全部）、`agents[]`（`["*"]` 或具体 id） |
| 服务端 → 客户端 | `delta` | 上报落库后增量广播 | `channel` + 各频道字段（`metrics`/`status`/`probes`/`alerts`） |

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

## 6. 验收用例（联调必跑）

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

**以下为登录 / 改密 / 2FA 的专项验收用例（✅ = 已实现并有测试覆盖；测试落点见 §4.1.1 ⑦）**

10. ✅ 登录失败（账号不存在 / 密码错 / 已禁用）→ 均为 401 `invalid_credentials`，且**响应体与耗时不可区分**（等时校验）。
11. ✅ `security.require_2fa=true` 且未绑定 TOTP → 登录成功但进入受限态：`me` 与改密返回 403 `totp_setup_required`（`me` 的返回见 §4.1.1 ⑧ D2），登出仍可用。
12. ✅ TOTP 码错误 → 400 `invalid_totp`；**同一步号在 30s 窗口内重复使用 → 拒绝**（`totp:used:<uid>` 防重放，审计 `reason='replayed_step'`；+31s 新步号放行）。
13. ✅ 恢复码用后即废（同一码第二次 → 400），响应含 `remaining_recovery_codes`；`require_2fa=true` 时禁止自助解绑（§4.1.1 ⑧ D3，409 `conflict`）。
14. ✅ 登录限流：`/auth/login`、`/auth/2fa/verify` 与 `/auth/2fa/recovery/verify` 共用 `ratelimit:login:<ip>`（10 次/5 分钟，超限 429 + `Retry-After`）。

**以下为人机验证（滑块）的专项验收用例（✅ 已实现并有测试覆盖：`server/test/auth.captcha.test.js`；完整清单见 `docs/slider-captcha-selfbuilt.md` §10.3）**

15. ✅ **首次登录不出现滑块**：无失败计数时，不带 `captcha_token` 也能登录成功，⛔ 不返回 `captcha_required`（本需求的核心断言）。
16. ✅ **密码错一次后引入**：失败响应 401 `invalid_credentials` + `details.captcha_required:true`，两个失败计数器（`login:fail:ip:*` 与 `login:fail:acct:*`）各 +1；随后缺 token 提交 → 400 `captcha_required`。
17. ✅ **一次性与绑定**：同一 `captcha_token` 在登录成功后再次使用 → 400 `captcha_invalid`；换 IP 使用同一 token → 400 `captcha_invalid`。
18. ✅ **分布式兜底**：多个 IP 各失败 1 次打同一账号，新 IP 再试 → 400 `captcha_required`（按账号计数生效）。

**✅ 已实现（S7 后端）：极验 v4 提供方的专项用例** —— 12 条见 `docs/geetest-captcha.md` §10.2（`AC-G1`…`AC-G12`），集成用例在 `server/test/auth.captcha.geetest.test.js`（⛔ 全程打桩 `fetchImpl`，不真连极验）+ 纯函数单测 `server/test/geetest.test.js`：`AC-G1` 首次登录免验证、`AC-G2` 失败计数、`AC-G3` 缺凭证 400 且**不调极验**、`AC-G4` challenge 返回 `provider:'geetest'` 且**不含** `bg_svg`/`piece_svg`/`expires_in`、`AC-G5` 二次校验只发**一次**请求且签名正确、`AC-G6` 极验判 fail → 400 `validate_failed`、`AC-G7`/`AC-G8` 极验不可达时按 `failMode` 放行或 503、`AC-G9` HTTP 500/非 JSON 记为**不可用**（⛔ 不记成"用户未通过"）、`AC-G10` `captcha_token` 一次性、`AC-G11` 绑定 IP、`AC-G12` 显式声明 geetest 却缺密钥时**启动即 `CONFIG_INVALID`**。另有 `AC-G12b` 覆盖"未设置 `CAPTCHA_PROVIDER` 时自动推断"。⏳ 待 Owner 跑 `npm test` 验收。

> ⚠️ 上面的 15–18 是**提供方无关**的（首次免验证、失败计数、一次性、分布式兜底），换极验后**必须继续全绿**；自建**专有**的用例（题目比对/容差/轨迹/`too_many_attempts`/题目过期）留在 `docs/slider-captcha-selfbuilt.md` §10.3，**不迁移**。

---

## 7. 待 Owner 拍板清单（API 视角）

> ✅ **本清单已清空**：A1–A14 全部拍板（下表逐条标注结论与落点）。唯一保留的开放项是 **A13 的 SSO 对接细节**（`docs/database.md` §12.2 N3），不阻塞任何里程碑。
> ✅ **D1–D6 已全部按建议实现（2026-10-02，B6/B7 落地），待 Owner 追认**；逐条见 **§4.1.1 ⑧**。新增 **D7**（setup 在 `totp_pending` 态的安全收敛，见 ⑧）与 D2 同类：实现与 §4.1 原文字面有偏差，理由已写明，等追认。
> 🆕 **2026-10-03 新增范围：滑动验证码**（原设计文档未覆盖此项）——选型调研见 `docs/slider-captcha.md`（**C1 已定 = 自建**），实施规范见 `docs/slider-captcha-selfbuilt.md`（开放决策 **C6–C11**：本轮**已按文档建议实现**——按账号计数、阈值 1、成功不重置、token 绑定 IP，待 Owner 追认）。触发策略：**首次登录不要求，出现密码错误后引入人机验证**。✅ **契约已并入本文**（§1.2 ② 豁免范围、§1.3 错误码 `captcha_required`/`captcha_invalid`、§1.4 独立限流桶 `ratelimit:captcha:<ip>`、§4.1 两个端点与登录端点改动、§4.10 白名单两个 key、§6.2 用例 15–18）；✅ **契约与代码均已落地**（集成用例 `server/test/auth.captcha.test.js`），⏳ 待 Owner 跑 `npm test` 验收。
> 🆕 **2026-10-03 新增范围二：人机验证提供方切换为极验 v4** —— 变更方案见 `docs/geetest-captcha.md`。**已定**：**C12**（新增 `CAPTCHA_PROVIDER`，**默认 `geetest`**，自建滑块**保留**为可选 provider、⛔ 不删代码）、**C13**（极验不可达时 **fail-open 放行**；连带义务：审计 `auth.captcha_unavailable` + `logger.error` + 3s 超时且不重试）、**C16**（用极验**官方按钮**：`product='popup'`，按钮 DOM 在页面加载时生成、容器默认隐藏，**密码错后才显示**）。**待定**：C14（`captcha_unavailable` 错误码登记，§1.3 由 26 → 27 条）、C15（`gt4.js` 引入方式）、C17（⛔ 不传 `userInfo`）、C18（**保持现有两步端点契约**，不改成一次提交）、C19（熔断 / 出站并发上限）。⛔ **尚未落地**：本节 §1.3 / §1.4 / §4.1 描述的都是**自建滑块的现状**；极验的字面契约（§6 的双 provider 分支、`details.reason` 新枚举）随 **S5–S9** 落地后才并入本文。⚠️ 另需注意：`CAPTCHA_PROVIDER` 默认值改为 `geetest` 后，**既有部署升级到该版本会因缺密钥启动失败**（刻意的 fail-fast，见变更方案 §8.1）。

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
| §0 端点总索引 | §10.2 接口清单 |
| §1.1–1.2 | §5.4 分级、§10.2 接口清单、§5.2 默认拒绝 |
| §1.3–1.4 | §5.2 默认拒绝/限流、§7.3 令牌桶（错误码表与 `server/src/utils/errors.js` 同源） |
| §1.5 | §5.2 中间件顺序、§6.6 验签顺序（决策 #35） |
| §1.6 | §6.6 健康检查约定、✅ R15（`evicted_keys` 恒为 0） |
| §2.1 | §6.2 签名、§10.1 上报体与响应、决策 #18/#19/#36 |
| §2.2 | §10.2 心跳、§4.3 网络开销 |
| §2.3 | §2.1 单向宗旨、§10.2 ⛔ 无下发接口、§12.4 |
| §3 | §5.4 公开可见性、决策 #10/#21、§8 IP 隐私 |
| §4.1 | §18.1 有状态会话、决策 #31/#32（会话轮换与 CSRF）、A9/A13（2FA 自助绑定与两条恢复渠道） |
| §4.1.1 | §18.1 会话模型、§5.2 默认拒绝——**本轮实现规范（①–⑨）**：三态矩阵、`totp:used` 防重放、落地顺序、D1–D7 |
| §4.2–4.3 | §5.3 心跳/离线、§6.5 漂移、§8 IP 历史、§9 时序与降采样 |
| §4.4 | §6.1 凭证、§12.2–12.3 安装流程、决策 #15/#37 |
| §4.5–4.7 | §7.1–7.3 告警规则/通道/风暴防护、决策 #22/#23 |
| §4.8–4.9 | §13 安全清单（审计、RBAC 两级） |
| §4.10 | §5.4 设置项白名单、A14（PG `settings` + 立即生效） |
| §5 | §18.2 实时通道、§18.3 单向一致性 |
| §6 | §13「单向性复核」、§19 评审响应清单 |
