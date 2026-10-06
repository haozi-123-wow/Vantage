# Vantage 后端 API 文档（vantage-core）

> 来源：由《Vantage-DESIGN-v0.7.md》拆分的后端接口契约文档。
> 适用对象：vantage-core 开发者、Agent 开发者（`docs/agent.md`）、面板开发者（`docs/frontend.md`）。
> 文档性质：接口契约（路径 / 认证 / 请求参数 / 返回字段 / 错误码 / 语义）。只写已定的东西，不含实现代码、不含落地进度。
> 上位文档：`Vantage-DESIGN-v0.7.md`（文件内容已是 v0.8，文件名保留以维持引用；以 §5、§6、§10、§18 为主），设计决策以其 §15 为准（共 59 条）。
> 配套文档：`docs/api-status.md` 记录落地状态、实现期规范与设计决策索引，本文不重复状态信息，以免两份文档互相漂移。

怎么读这份文档

| 你的目的 | 去哪里 |
|---|---|
| 查某个接口要传什么、返回什么 | 先在下面「0. 端点总索引」定位，每个端点都按 认证/限流 → 请求参数 → 返回字段 → 错误码 → 备注 排列 |
| 知道现在能用哪些、哪些还没写 | 「0. 端点总索引」的状态列（已实现 / 未实现）；细节见 `docs/api-status.md` §1 |
| 写 Go Agent | 第 2 章（Agent 侧实现细节另见 `docs/agent.md`） |
| 写面板前端 | §1.2（通用约定）、§3（公开页）、§4（登录后页面）、§5（实时通道） |
| 查会话 / 2FA / 人机验证的内部机制（Redis 键、三态矩阵、防重放） | `docs/api-status.md` §3 |
| 查决议索引 | `docs/api-status.md` §5 |

标注图例

| 标记 | 含义 |
|---|---|
| `已定` | 直接来自设计文档或已确认的设计决策，不得擅自更改 |
| `未实现` | 契约已定，代码尚未落地——当前调用会命中 404 `not_found` |
| `待定` | 尚未确认；逐条决议索引见 `docs/api-status.md` §5 |
| 禁止 | 禁止项（违反单向宗旨即视为重大缺陷） |

> 文中 S1–S9 指登录人机验证的分块；实施记录见 `docs/api-status.md` §3.6，实施规范见 `docs/slider-captcha-selfbuilt.md`（自建）与 `docs/geetest-captcha.md`（极验）。
> 端点标题不再标注状态：某个端点是否已落地，一律以 §0 索引的状态列为准。

---

## 0. 端点总索引

认证方式列的含义：`公开` = 无需凭证；`Cookie` = 面板会话（`vantage_sid`，写请求另需 `X-CSRF-Token`）；`HMAC` = Agent 签名头。
除 `/healthz`、`/readyz`、`/version` 外，所有响应都用 §1.3 的统一错误信封。

| 方法 | 路径 | 用途 | 认证 | 状态 | 小节 |
|---|---|---|---|---|---|
| GET | `/healthz` | 存活探针（不查依赖） | 公开 | 已实现 | §1.6 |
| GET | `/readyz` | 就绪探针（PG + Redis） | 公开 | 已实现 | §1.6 |
| GET | `/version` | 版本信息 | 公开 | 已实现 | §1.6 |
| POST | `/api/v1/agent/report` | Agent 上报指标 / 探活 | HMAC | 已实现 | §2.1 |
| POST | `/api/v1/agent/heartbeat` | Agent 心跳（无变更） | HMAC | 已实现 | §2.2 |
| GET | `/api/public/summary` | 汇总计数（在线/离线/禁用/告警） | 公开 | 已实现 | §3.2 |
| GET | `/api/public/hosts` | 公开主机列表（slug） | 公开 | 已实现 | §3.2 |
| GET | `/api/public/hosts/{slug}/now` | 单机当前快照（就地展开） | 公开 | 已实现 | §3.2 |
| GET | `/api/public/probes` | 探活当前概览 | 公开 | 已实现 | §3.2 |
| POST | `/api/v1/auth/login` | 登录第一步（密码；密码错后要求人机验证） | 公开 | 已实现 | §4.1 |
| POST | `/api/v1/auth/captcha/challenge` | 取验证入口配置（人机验证） | 公开 | 已实现 | §4.1 |
| POST | `/api/v1/auth/captcha/verify` | 校验人机验证并发放一次性 `captcha_token` | 公开 | 已实现 | §4.1 |
| POST | `/api/v1/auth/2fa/verify` | 登录第二步（TOTP 6 位） | Cookie | 已实现 | §4.1 |
| GET | `/api/v1/auth/me` | 恢复登录态 + 取 CSRF | Cookie | 已实现 | §4.1 |
| POST | `/api/v1/auth/logout` | 登出当前会话 | Cookie | 已实现 | §4.1 |
| POST | `/api/v1/auth/logout-all` | 全部会话下线 | Cookie | 已实现 | §4.1 |
| POST | `/api/v1/auth/password` | 自助改密 | Cookie | 已实现 | §4.1 |
| POST | `/api/v1/auth/2fa/setup` | 生成待确认 TOTP 密钥 + 二维码 | Cookie | 已实现 | §4.1 |
| POST | `/api/v1/auth/2fa/enable` | 验码绑定 + 发 10 个恢复码 | Cookie | 已实现 | §4.1 |
| POST | `/api/v1/auth/2fa/disable` | 密码确认解绑 | Cookie | 已实现 | §4.1 |
| POST | `/api/v1/auth/2fa/recovery/verify` | 用恢复码过第二步 | Cookie | 已实现 | §4.1 |
| POST | `/api/v1/auth/2fa/recovery/regenerate` | 重发 10 个恢复码 | Cookie | 已实现 | §4.1 |
| GET | `/api/v1/hosts` | 主机列表（含 IP） | Cookie | 已实现 | §4.2 |
| GET | `/api/v1/summary` | 面板汇总计数（在线/离线/禁用/告警） | Cookie | 已实现 | §4.2 |
| GET | `/api/v1/hosts/{id}` | 主机详情（+ 全序列当前值） | Cookie | 已实现 | §4.2 |
| GET | `/api/v1/hosts/{id}/metrics` | 时序查询（历史曲线） | Cookie | 已实现 | §4.3 |
| GET | `/api/v1/hosts/{id}/probes` | 探活历史 + 可用率 | Cookie | 已实现 | §4.2 |
| GET | `/api/v1/hosts/{id}/ip-history` | IP 变更时间线 | Cookie | 已实现 | §4.2 |
| GET | `/api/v1/hosts/{id}/processes` | 进程 Top 快照 | Cookie | 已实现 | §4.2 |
| GET | `/api/v1/agents` | Agent 列表 + 凭证年龄 | Cookie | 未实现 | §4.4 |
| POST | `/api/v1/agents` | 创建 Agent（明文 key/secret 仅一次） | Cookie（admin） | 已实现 | §4.4 |
| GET | `/api/v1/agents/{id}` | Agent 元信息 | Cookie | 未实现 | §4.4 |
| PATCH | `/api/v1/agents/{id}` | 改显示名 / 标签 | Cookie | 未实现 | §4.4 |
| POST | `/api/v1/agents/{id}/rotate` | 手动轮换凭证 | Cookie | 未实现 | §4.4 |
| POST | `/api/v1/agents/{id}/disable` \| `/enable` | 禁用 / 启用 | Cookie | 未实现 | §4.4 |
| POST | `/api/v1/agents/{id}/revoke` | 吊销（不可恢复） | Cookie | 未实现 | §4.4 |
| POST | `/api/v1/agents/{id}/rotate-reminder/test` | 手动触发一次凭证到期提醒（验证通道） | Cookie | 未实现 | §4.4 |
| GET/POST | `/api/v1/alert-rules` | 规则列表 / 创建 | Cookie | 未实现 | §4.5 |
| GET/PATCH/DELETE | `/api/v1/alert-rules/{id}` | 规则读 / 改 / 删 | Cookie | 未实现 | §4.5 |
| POST | `/api/v1/alert-rules/{id}/dry-run` | 历史试算（不发送） | Cookie | 未实现 | §4.5 |
| GET | `/api/v1/alert-events` | 告警事件列表 | Cookie | 未实现 | §4.6 |
| GET | `/api/v1/alert-events/{id}` | 事件详情 + 发送记录 | Cookie | 未实现 | §4.6 |
| GET/POST | `/api/v1/channels` | 通知通道列表 / 创建 | Cookie | 未实现 | §4.6 |
| PATCH/DELETE | `/api/v1/channels/{id}` | 通道更新 / 删除 | Cookie | 未实现 | §4.6 |
| POST | `/api/v1/channels/{id}/test` | 发送测试消息 | Cookie | 未实现 | §4.6 |
| GET | `/api/v1/notification-log` | 发送记录（排障） | Cookie | 未实现 | §4.6 |
| GET/POST | `/api/v1/silences` | 静默窗口列表 / 创建 | Cookie | 未实现 | §4.7 |
| DELETE | `/api/v1/silences/{id}` | 取消静默窗口 | Cookie | 未实现 | §4.7 |
| GET | `/api/v1/audit-logs` | 审计日志查询 | Cookie | 未实现 | §4.8 |
| GET/POST | `/api/v1/users` | 用户列表 / 创建 | Cookie(admin) | 未实现 | §4.9 |
| PATCH | `/api/v1/users/{id}` | 改角色 / 显示名 / 状态 | Cookie(admin) | 未实现 | §4.9 |
| POST | `/api/v1/users/{id}/password-reset` | 重置他人密码 | Cookie(admin) | 未实现 | §4.9 |
| POST | `/api/v1/users/{id}/2fa/reset` | 重置他人 2FA + 踢下线 | Cookie(admin) | 未实现 | §4.9 |
| GET/PATCH | `/api/v1/settings` | 系统设置读 / 改 | Cookie | 未实现 | §4.10 |
| WS | `/ws/public` | 公开实时通道（脱敏） | 公开 | 已实现 | §5.1 |
| WS | `/ws/live` | 面板实时通道（全量） | Cookie | 已实现 | §5.1 |

> 里程碑映射（M1/M2/M3）与分块落地记录（B1–B8、S1–S9）见 `docs/api-status.md` §1 与 §3.6；本表只回答"能不能用"。

---

## 1. 全局约定

### 1.1 接口分区（设计 §5.4、§10.2）

| 分区 | 前缀 | 鉴权 | 说明 |
|---|---|---|---|
| Agent 接入 | `/api/v1/agent/*` | HMAC 签名（每机独立 key+secret） | 只接受 Agent 出站上报 |
| 面板公开 | `/api/public/*` | 免登录、只读、只返回「当前值」快照 | 严格限流 + 脱敏（设计决策 #10/#21） |
| 面板私有 | `/api/v1/*` | 面板会话（Cookie 不透明 `sid`） | 历史/配置/管理 |
| 实时 | `/ws/public`、`/ws/live` | 前者免登录，后者需登录 | WebSocket（设计决策 #33） |

部署形态待定：面板与反代同源部署（Caddy 反代 `/api` 与 `/ws`），不开启跨域 CORS；若必须跨域，只允许白名单 Origin + `credentials: true`。决议索引见 `docs/api-status.md` §5.1。

### 1.2 通用请求约定

① 两种认证方式（按分区选用，不混用）

| 分区 | 请求必须带的凭证 | 说明 |
|---|---|---|
| Agent 接入（`/api/v1/agent/*`） | 签名头 5 件套：`X-Agent-Id`、`X-Agent-Key`、`X-Timestamp`、`X-Nonce`、`X-Signature`，外加 `Content-Encoding: gzip`、`Content-Type: application/json` | 每机独立 key+secret；算法见 §2.1 |
| 面板私有（`/api/v1/*` 的其余端点） | Cookie `vantage_sid=<不透明 sid>`（浏览器自动携带，前端 `credentials: 'include'`）；写请求另需 `X-CSRF-Token` | sid 由登录 / `GET /auth/me` 下发；前端不读不写 sid |
| 面板公开（`/api/public/*`、`/ws/public`） | 无 | 免登录、只读、只返回「当前值」快照 |
| 运维探针（§1.6） | 无 | 不参与业务错误信封 |

② CSRF（面板写请求必带）

- 触发范围：`POST` / `PATCH` / `DELETE`（`GET`/`HEAD`/`OPTIONS` 不校验）。
- 取值：登录响应与 `GET /auth/me` 的 `csrf` 字段，放进请求头 `X-CSRF-Token`。
- 豁免范围（唯一口径）：实现规则是「无会话即放行」——`requireCsrf` 在请求没有会话时直接通过；等价于只豁免会话建立之前的三个端点：`POST /api/v1/auth/login` 与两个 `POST /api/v1/auth/captcha/*`（取题 / 验题）。这不是"跳过校验"，而是"没有可校验的对象"，除这三者外任何写请求都不得豁免（实现记录见 `docs/api-status.md` §3.1）。旧文「仅 `/auth/login` 豁免」的写法已作废。
- 失败：403 `csrf_invalid`，且不销毁会话（前端可重取 `me` 后重试）。
- `sid` 轮换（过 2FA / 改密 / 恢复码登录）后 `csrf` 不变，前端无需换 token（设计决策 #32 的配套取舍，理由见 `docs/api-status.md` §3.1）。

③ 通用请求 / 响应格式

| 项 | 约定 |
|---|---|
| 字符集 | `Content-Type: application/json; charset=utf-8` |
| 时间（面板 API） | 请求 `from`/`to` 接受 RFC3339（含时区）或 unix 毫秒整数；响应时间一律 RFC3339 UTC（如 `2025-09-25T12:00:00.000Z`） |
| 时间（Agent 上报） | `ts` 为 unix 毫秒（设计 §10.1） |
| 时区 | 服务端一律 UTC；本地化时区转换在前端 |
| 分页 | `?limit=`（默认 20，上限 200）+ `?cursor=`（不透明游标，keyset 分页）。例外：状态类列表（`GET /api/v1/hosts`）返回的是「当前态」而非按时间排列的事件流，排序键是派生值、不满足 keyset 前提，因此 `next_cursor` 恒为 `null`、`cursor` 被忽略（形状仍合规，见 `docs/server-status-api.md` §2.8） |
| 列表响应形状 | 所有列表端点返回 `{ items: [...], next_cursor: string\|null }`，`next_cursor=null` 表示没有下一页。这是下面「响应体形状」一行的唯一明确例外——单个资源与写操作的响应仍直接返回对象 |
| 排序 | 默认按时间倒序；需正序时 `?order=asc` |
| 版本 | 路径前缀 `/api/v1`；破坏性变更升 `/api/v2` |
| 请求 ID | 响应头 `X-Request-Id`；错误体里也有 `request_id`（对账 / 排障） |
| 压缩 | 面板 API 支持 `Accept-Encoding: gzip`；Agent 上报使用 `Content-Encoding: gzip` |
| 响应体形状 | 成功：直接返回数据对象（不套 `data` 壳）；列表端点见上面「列表响应形状」的例外；失败：§1.3 的 `{ error: {...} }`；无内容的写操作：204 |
| 限流响应头 | `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`、429 时 `Retry-After`（秒） |

### 1.3 统一错误模型（语义来自 §5.2「默认拒绝」，实现与 `server/src/utils/errors.js` 的登记表逐条一致）

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

HTTP 状态码使用规则

| 状态码 | 语义 | 代表 code（完整清单以下方错误码总表为准） |
|---|---|---|
| 200 | 成功 | — |
| 201 | 创建成功（如创建 Agent / 规则） | — |
| 204 | 成功无响应体（删除类） | — |
| 400 | 请求不可解析 / 业务校验失败 | `invalid_request`、`schema_invalid`、`range_too_large`、`expr_not_allowed`、`invalid_totp`（§4.1 的 2FA 端点） |
| 401 | 未认证 / 签名失败 / 会话失效 | `signature_invalid`、`timestamp_skew`、`agent_unknown_or_disabled`、`session_expired`、`invalid_credentials` |
| 403 | 已认证但无权限 / 需二次验证 / CSRF 失败 | `role_denied`、`totp_required`、`totp_setup_required`（§4.1）、`csrf_invalid` |
| 404 | 资源不存在 | `not_found` |
| 409 | 冲突（幂等命中以外的语义冲突） | `conflict`、`already_exists`、`nonce_reused`、`channel_in_use`。`nonce_reused` 归 409 而非 401：§2.1 错误表与 §6 验收用例第 4 条都按 409 约定 |
| 413 | 体积超限（含解压后超限） | `payload_too_large` |
| 415 | 不支持的编码/媒体类型 | `unsupported_content_encoding` |
| 429 | 限流 | `rate_limited`（带 `Retry-After`） |
| 500 | 服务端错误 | `internal_error` |
| 503 | 依赖不可用（PG/Redis） | `upstream_unavailable` |

> 错误响应不得回显任何 Agent 配置、阈值、内部路径、脚本或可执行内容（§2.1、§10.1「响应体极简」）。

错误码总表（`error.code` → 状态码 → 触发条件；与 `server/src/utils/errors.js` 登记表逐条一致）

| 状态 | code | 触发条件 |
|---|---|---|
| 400 | `invalid_request` | 请求不可解析、缺必需字段、引用不存在（含：新旧密码相同、未 setup 就 enable） |
| 400 | `schema_invalid` | 字段校验失败：白名单外字段、类型不符、数值超范围、数组超长 |
| 400 | `range_too_large` | 时序查询范围超出该 step 允许的最大跨度（§4.3） |
| 400 | `too_many_series` | 时序查询展开后的序列数 > 20，或「序列数 × 桶数」> 5 万（§4.3；`details.reason` = `series_limit` / `point_budget`） |
| 400 | `expr_not_allowed` | 告警规则传了非 null 的 `expr`（零 RCE 约束，§4.5） |
| 400 | `unknown_setting` | `PATCH /settings` 传了白名单外的 key（§4.10） |
| 400 | `invalid_setting_value` | 设置项的值类型不符合该 key 的定义（§4.10） |
| 400 | `invalid_totp` | 2FA 验证码/恢复码不正确、已用过或同一步号重放（§4.1） |
| 400 | `captcha_required` | 已触发人机验证策略（同 IP / 同账号失败计数超阈）但请求未带 `captcha_token`（§4.1） |
| 400 | `captcha_invalid` | 人机验证未通过 / 题目已过期或已作废 / token 无效或已消费；`details.reason` 见 §4.1 |
| 503 | `captcha_unavailable` | 极验不可达且 `GEETEST_FAIL_MODE=closed`。默认 `open` 时此码不出现（改为放行 + 审计 `auth.captcha_unavailable`）。5xx 的 message 会被折叠成通用文案，前端必须按 `error.code` 匹配 |
| 401 | `signature_invalid` | Agent HMAC 不匹配，或 `X-Agent-Key` 与 `agent_key_hash` 不符 |
| 401 | `timestamp_skew` | Agent 时间戳超出允许窗口（> 5min 硬上限时任何模式都拒） |
| 401 | `agent_unknown_or_disabled` | Agent 不存在 / 已吊销 / 已禁用 |
| 401 | `session_expired` | 无 Cookie、sid 无效或已过期（会话已销毁） |
| 401 | `invalid_credentials` | 登录名或密码不正确（不区分"账号不存在/密码错/已禁用"） |
| 403 | `role_denied` | 已登录但角色不足（`user` 发写请求，§4.9） |
| 403 | `totp_required` | 已绑 2FA 但未过第二步（`totp_pending` 受限态，见 §4.1.0） |
| 403 | `totp_setup_required` | `security.require_2fa=true` 且该账号未绑定（`setup_required` 受限态，见 §4.1.0） |
| 403 | `csrf_invalid` | 写请求缺 `X-CSRF-Token` 或不匹配（不销毁会话） |
| 403 | `origin_denied` | WebSocket 握手的 `Origin` 不在白名单内（§5.1）。它与 `csrf_invalid` 分开：前者防跨站 WS 劫持、后者防 CSRF，排障时要查的东西不同 |
| 404 | `not_found` | 资源不存在 / 路由未命中 |
| 409 | `conflict` | 与当前状态冲突（含：2FA 已绑定还 setup、`require_2fa=true` 时自助解绑） |
| 409 | `already_exists` | 唯一约束冲突（如 Agent `name` 重名、用户名已存在） |
| 409 | `channel_in_use` | 删除仍被规则引用的通知通道（§4.6） |
| 409 | `nonce_reused` | Agent 同 nonce 重复（防重放） |
| 413 | `payload_too_large` | 体积超限（Agent 压缩前 1MB / 解压后 4MB） |
| 415 | `unsupported_content_encoding` | `Content-Encoding` 不在白名单（仅 gzip） |
| 429 | `rate_limited` | 限流命中，带 `Retry-After` |
| 500 | `internal_error` | 未识别的服务端异常（细节只进日志，不进响应） |
| 503 | `upstream_unavailable` | PG / Redis 不可用 |

### 1.4 限流（决策 #23、§5.2；数值为默认值，env 可改）

| 维度 | Redis 键 | 阈值 | 超限行为 |
|---|---|---|---|
| Agent 上报 | `ratelimit:agent:<agent_id>` | 60 次/分钟（`RATELIMIT_AGENT_PER_MINUTE` 默认值） | 429 + `Retry-After` |
| 面板公开接口 | `ratelimit:public:<ip>` | 60 次/分钟（`RATELIMIT_PUBLIC_PER_MINUTE` 默认值） | 429 + `Retry-After` |
| 公开 WS 连接 | `ratelimit:ws:<ip>` | 两层，缺一不可：握手速率 30 次/分钟（`RATELIMIT_WS_HANDSHAKE_PER_MINUTE`）+ 每 IP 并发连接数 3 条（`RATELIMIT_WS_CONCURRENT_PER_IP`，进程内计数） | 拒绝握手（429 `rate_limited`） |
| 登录 | `ratelimit:login:<ip>` | 10 次 / 300s（`RATELIMIT_LOGIN_PER_WINDOW` / `RATELIMIT_LOGIN_WINDOW_S`） | 429（不泄露账号是否存在）。`/auth/2fa/verify` 与 `/auth/2fa/recovery/verify` 复用同一桶（防 6 位码暴力枚举） |
| 人机验证取题 / 验题 | `ratelimit:captcha:<ip>` | 30 次/分钟（`RATELIMIT_CAPTCHA_PER_MINUTE`；比登录桶宽松——"换一张图"是正常操作） | 429。与登录桶独立（否则换图会消耗登录额度）。注意：极验分支下它同时是唯一匿名外呼端点的闸门，另有进程级出站并发上限（§4.1） |
| 通知发送 | `notify:tokenbucket:<channel_id>` | 每通道独立令牌桶（#23） | 排队等待，不丢弃 |

响应头 `X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset` 与 429 时的 `Retry-After` 均已实现。
约定：`X-RateLimit-Reset` = 窗口重置的 Unix epoch 秒；`Retry-After` = 还需等待的秒数。

### 1.5 中间件顺序（设计 §5.2「顺序固定」+ §6.6）

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

关键更正（v0.7 决策 #35）：签名针对解压后的原始 JSON 字节；`preParsing` 钩子截获原始 buffer，先验签、后 `JSON.parse`。Agent 端只序列化一次（同一份字节既签名又发送）。

已定（M1 实现期，补齐两处顺序口径）

1. 防重放（nonce）与幂等的先后：`batch_id` 幂等检查排在 `nonce` 之前。理由：一次完全相同的重传（Agent 重试同一份已签名字节）应当得到 `{ok:true}`——数据本来就在库里；把它判成 409 会让 Agent 陷入无法完成的死循环。真正的重放（同 nonce + 不同 batch）依然是 409。
2. 写库失败时的占位释放：同时删除 `batch:` 与 `nonce:` 两个键。§6.1 的建议只提到幂等键；只删它会在 Redis 里留下一个"已烧毁"的 nonce，Agent 用同一份签名重试会立刻 409，该批次永远补不上。
3. 落库失败即拒收：Redis/PG 不可用时返回 503，不在"限流/nonce/幂等全部失效"的状态下继续写库。

### 1.6 运维端点（`/healthz`、`/readyz`、`/version`）

为什么不放在 `/api/*` 下：这三个端点是运维 / 编排用——不受 `/api` 限流与鉴权影响，也不使用 §1.3 的错误信封（编排器只关心状态码 + 简短 JSON）。
`/healthz` 与 `/readyz` 语义不同，不可合并：前者只证明进程活着（不碰任何依赖），后者证明依赖可用；混用会让依赖一抖动就触发无谓重启。

#### `GET /healthz` — 存活探针 已实现

无认证、无参数。200：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | 恒 `true`（能响应即存活） |
| `service` | string | 服务名（默认 `vantage-core`） |
| `version` | string | 版本号 |
| `uptime_s` | number | 进程已运行秒数 |

#### `GET /version` — 版本信息 已实现

无认证、无参数。200：`{ service, version, node, env }`
（`node` = Node 运行时版本；`env` = 运行环境名；不暴露环境变量内容）

#### `GET /readyz` — 就绪探针 已实现

无认证、无参数。200（依赖可用）/ 503（任一依赖不可用）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | `checks.postgres.ok && checks.redis.ok` |
| `service` / `version` | string | 同上 |
| `checks.postgres` | object | `{ ok, ms, error? }`；探活硬超时 3s（健康检查本身不得挂住） |
| `checks.redis` | object | `{ ok, ms, error? }` |
| `checks.eviction` | object | Redis 可用时附带：`{ maxmemory_policy, evicted_keys, used_memory_bytes }`；R15 要求 `evicted_keys` 恒为 0（否则 nonce/幂等键被驱逐） |
| `checks.skipped` | boolean | 仅启动自检被显式跳过时出现（`checks: { skipped: true }`） |

> 部署建议：`/healthz` → livenessProbe，`/readyz` → readinessProbe。

---

## 2. Agent 上报 API

### 2.1 `POST /api/v1/agent/report`（设计 §10.1）

请求头

| 头 | 必需 | 说明 |
|---|---|---|
| `X-Agent-Id` | 是 | Agent UUID |
| `X-Agent-Key` | 是 | Agent 凭证（`vk_` 前缀）。设计 §5.2 本来就要求校验它，中心用 `agents.agent_key_hash`（HMAC-pepper）校验，证明身份；命令行的 `--key` 形式永久禁止（决策 #37） |
| `X-Timestamp` | 是 | unix 毫秒 |
| `X-Nonce` | 是 | 每请求唯一随机串。取值 16–128 个可打印 ASCII 字符（不含空格），不符合即 400 `invalid_request`（`server/src/utils/sign.js` 的 `NONCE_RE`）；建议 ≥ 16 字节随机后编码为 hex |
| `X-Signature` | 是 | HMAC-SHA256 十六进制小写 |
| `Content-Encoding` | 是 | `gzip` |
| `Content-Type` | 是 | `application/json` |
| `User-Agent` | 待定 | `vantage-agent/<version>`，便于排障（约定未定，见 `docs/api-status.md` §5.1） |

签名算法（§6.2；分隔符 已定）

```
canonical  = method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(raw_body)
signature  = hex( HMAC_SHA256(agent_secret, canonical) )
```

- 已定：固定 `\n`（LF，0x0A）作为 4 处分隔符，末尾不加换行；设计 §6.2 原文未指定分隔符，此处明确化（裸拼接存在边界歧义，如 `path` 尾部数字与 `timestamp` 粘接）。
- `path`：仅路径（如 `/api/v1/agent/report`），不含 host、不含 query、不含末尾斜杠差异（统一用路由原始路径）。
- `raw_body`：gzip 压缩之前的原始 JSON 字节（决策 #19）。
- `timestamp`：十进制 ASCII 的 unix 毫秒（无前导零、无引号）；`nonce`：ASCII 原样。
- 已定：两端必须完全一致，且已有共享测试向量 `contracts/agent-signature.json`（固定 secret/body/时间戳 → 期望签名值；含 `report` 与 `heartbeat` 两条）；Agent(Go) 与 core(Node) 的测试都必须逐字节消费该文件——「实现都对但拼法不同」这类 401 必须被向量测试挡住。
- 🔐 两份凭证的分工（已定）：`X-Agent-Key` 由中心用 `agents.agent_key_hash`（HMAC-pepper 哈希）校验 → 证明身份；`agent_secret` 用于算 HMAC → 证明完整性与时效（中心侧从 `agents.agent_secret_enc` 的 AES-256-GCM 密文解出）。注意：故 secret 必须可逆存储：原 `agent_secret_hash`（只存哈希）在数学上无法验签，已改名 `agent_secret_enc`。`agent_key` / `agent_secret` 均只上行一次（创建/轮换响应），secret 永不作为请求头上行。

请求体（JSON，gzip）

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `agent_id` | string(uuid) | | 必须与 `X-Agent-Id` 一致，否则拒绝（§6.4） |
| `batch_id` | string(ULID) | | 幂等键，每批唯一（决策 #18） |
| `ts` | int64 | | Agent 侧时间（unix 毫秒）；仅用于漂移检测（决策 #16） |
| `seq` | int64 | 可选 | 单调递增序号，便于乱序诊断（设计示例含此字段） |
| `host` | object | | `{ hostname, os, kernel, arch?, boot_time, capabilities }`；已定：能力声明随上报携带——首次上报与能力变化时必填，其余可省；键集合建议 `{disk.inode, disk.io, net.conn_count, gpu.nvidia, gpu.amd, process.top, probe.ping, probe.http, probe.tcp, docker}` → 布尔值；白名单外的键拒绝（400） |
| `reported_ip` | string | 可选 | Agent 自测出口 IP（设计示例含；用于双源比对 §8） |
| `metrics` | object | | 见 §2.2 |
| `probes` | array | 可选 | 本地探活结果，可为空数组（§4.6） |

`metrics` 结构（§10.1，单位见 `docs/database.md` §5.7.2）

| 字段 | 类型 | 说明 |
|---|---|---|
| `cpu.usage` | number | 整体使用率 % |
| `cpu.cores` | number[] | 每核使用率 %（长度上限：建议 ≤ 256）→ 落 `cpu.core.usage{core=n}` |
| `cpu.load` | number[3] | 1/5/15 分钟负载 → 落 `cpu.load1/5/15` |
| `cpu.ctx_switch` | number | 上下文切换 |
| `mem.total` / `mem.used` / `mem.available` | number | bytes |
| `mem.cached` / `mem.buffers` | number | bytes（可选） |
| `mem.swap` | object | `{ total, used }` → 落顶层 `swap.total` / `swap.used` |
| `disk[]` | array | `{ device?, mount, total, used, inode_used, read_bps, write_bps, read_iops?, write_iops?, latency_ms? }`，上限 ≤ 64 |
| `net[]` | array | `{ device, rx_bps, tx_bps, rx_total, tx_total, conn_count?, err?, drop? }`，上限 ≤ 64 |
| `gpu[]` | array | `{ index, util, mem_used, mem_total, temp, power }`，上限 ≤ 16 |
| `process` | object | `{ count, top: [{ pid, name, cpu, mem }] }`，`top` 上限 ≤ 50（明细落 `process_snapshots`，不进时序） |
| `docker` | null | 本期固定 `null`（预留，§4.2）；传对象会被 400 拒绝，而不是被静默忽略 |

> 已定（M1 实现期，消除 §2.1 与 `docs/database.md` §5.7.2 的两处不一致）
> 1. `disk[]` 增加可选字段 `device`：§5.7.2 的维度名是 `{device,mount}`，但本表的字段清单此前漏列了 `device`。
>    M1 把它设为可选——缺失时该序列只带 `mount` 维度（同一 Agent 必须保持一致）。
> 2. `iops?` 拆成 `read_iops?` / `write_iops?`：§5.7.2 登记的指标是 `disk.read_iops` 与 `disk.write_iops`，单个 `iops` 无法映射到任一序列，故不设该字段（传 `iops` 会被 400 拒绝）。
> 3. 派生指标：`mem.used_pct` / `swap.used_pct` / `disk.used_pct` 由中心用同一批的分子分母就地算出（本表不含这三个百分比字段），分母缺失或为 0 时不产出该序列（不写 0/NaN）。

`probes[]` 元素

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 与 Agent 本地 `config.yaml` 中 `probes[].name` 一致（中心无法修改，§4.6） |
| `type` | string | `ping` / `http` / `https` / `tcp` |
| `target` | string | 目标（url 或 host:port） |
| `up` | bool | 结果 |
| `latency_ms` | number | 延迟 |
| `status_code` | int/null | 仅 http(s) |
| `error` | string/null | 失败原因 |

响应（§10.1、§2.1 极简）

```json
{ "ok": true, "server_ts": 1758800000123 }
```

响应体只能包含 `ok` 与 `server_ts`；不得出现 config / command / script / url / threshold / 任何可执行字段。已定：幂等命中时不加 `duplicate: true`——保持响应形态恒定，重复批次由中心日志与指标体现（Agent 也无需区分）。

错误码

| 状态码 | code | 触发条件 |
|---|---|---|
| 400 | `invalid_request` | body 不可解析、缺必需字段、`agent_id` 与头不一致 |
| 400 | `schema_invalid` | 白名单外字段、数值超范围、数组超长 |
| 401 | `agent_unknown_or_disabled` | agent 不存在、被吊销/禁用 |
| 401 | `signature_invalid` | HMAC 不匹配，或 `X-Agent-Key` 与 `agent_key_hash` 不符 |
| 401 | `timestamp_skew` | `\|now-ts\| > 300s`（严格模式）或 > 5min 硬上限（任何模式，决策 #17） |
| 409 | `nonce_reused` | `nonce:<agent_id>:<nonce>` 已存在（防重放） |
| 413 | `payload_too_large` | 已定：压缩前上限 1MB / 解压输出上限 4MB（超限即拒，且不进入 `JSON.parse`，防 zip bomb） |
| 415 | `unsupported_content_encoding` | 非 gzip（或将来不在白名单内的编码） |
| 429 | `rate_limited` | Agent 限流 |
| 500 | `internal_error` | 服务端异常 |

> 时钟漂移策略：默认「接受 + 修正 + 告警」（不丢弃），仅 `clock_drift` 告警（阈值 60s）；严格拒收为 opt-in（决策 #17）。故 `timestamp_skew` 在默认模式下仅在超过 5min 硬上限时出现。

### 2.2 `POST /api/v1/agent/heartbeat`（可并入 report）

- 设计 §10.2：可并入 `report`；本文约定允许该端点，body 仅 `{agent_id, batch_id, ts, seq?}`，用途是「无变更时只报心跳」（§4.3 网络开销目标）。
- 语义：更新 `last_seen_at`/`last_ip`/漂移，不写指标；其余（签名、幂等、响应体、错误码）与 `report` 完全一致。
- 已定：保留该端点（不并入 `report`），限流共用 `ratelimit:agent:<id>` 桶。（"给心跳单独设更宽的桶"已作为提案列入 `docs/api-status.md` §5.1。）

### 2.3 明确不存在的接口（单向宗旨，§2.1、§10.2）

以下端点永不存在，任何 PR 中出现即视为违规：

- `GET /api/v1/agent/config`、`GET /agent/tasks`、`GET /agent/commands`
- `POST /api/v1/agent/command`、`/restart`、`/exec`、`/script`、`/upgrade` 等任何下发/执行类
- 任何由中心主动向 Agent 发起的连接（Agent 只出站）

复核方式（§13 安全清单）：中心代码零下发路径；上报响应的 schema 只允许 `{ok, server_ts}`；对外无法解释为下发的字段必须删除。

---

## 3. 面板公开 API（`/api/public/*`，免登录）

### 3.1 可见性与脱敏（§5.4、决策 #10/#21）

| 内容 | 公开 | 需登录 |
|---|---|---|
| 主机列表 + 在线/离线状态 | | |
| 当前指标快照（CPU/内存/磁盘/网络/GPU） | | |
| 探活当前 up/down 概览 | | |
| 汇总计数（在线/离线/告警数） | | |
| 历史曲线 / 历史查询 | 未实现 | |
| IP 变更历史、进程 Top、审计日志 | 未实现 | |
| 告警规则配置、Agent 管理、密钥操作 | 未实现 | |

公开接口绝不返回：真实 IP、内网拓扑、`agent_key`/`secret`、其他 Agent 的内部标识、配置、阈值、审计信息（§5.4、决策 #21）。

已定：公开接口中的主机标识使用独立的 `public_slug`（`agents.public_slug`，创建 Agent 时生成的随机短 ID，与内部 UUID 无关，见 `docs/database.md` §5.1）——这满足了 §5.4「绝不泄露 key/内部 ID」，同时把 §10.2 的 `GET /api/public/hosts/:id/now` 中的 `:id` 明确为 slug。公开列表不返回内部 UUID；`public_slug` 不随 `name`/`display_name` 变化。
已定：公开视图的每机绝对时间一律分钟级取整（`floor(epoch/60)*60`，`last_seen_at` 的秒位恒为 `00`），并额外给出中文相对化文案 `last_seen_ago`。两者都不得精确到秒——秒级时间戳 + 轮询足以把公开页变成「主机上下线行为指纹」分析器。私有接口（§4.2）不做这个取整（那里的 `last_seen_at` 是精确值，用于排障）。
已定：显示名优先取 `display_name`，其次 `name`（决策 #21「支持自定义显示名」）。设计稿曾建议"缺失时回退泛化名（如「主机 3」）"，本方案不采纳：`name` 本身就是运维自己起的别名（不是主机名），回退它不泄露任何东西，而泛化名需要前端按序号生成、还会让同一台机在两处显示不同。决议索引见 `docs/server-status-api.md` §11。

### 3.2 端点（§10.2；四个端点均已实现）

四个端点都无请求参数（除路径参数）、都免登录，都受总开关 `public_view.enabled` 约束（关闭 → 一律 404 `not_found`）。返回形状：`hosts` 与 `probes` 是列表端点 → `{ items: [...], next_cursor: null }`（§1.2 ③；状态类接口本期没有真游标，见 `docs/server-status-api.md` §2.8，但形状必须合规）；`summary` 与 `hosts/{slug}/now` 是单个对象，直接返回（不套壳）。

限流：`ratelimit:public:<ip>`，默认 60 次/分钟（`RATELIMIT_PUBLIC_PER_MINUTE`）。注意：它与登录桶、Agent 桶完全独立。执行顺序固定：限流 → 总开关 → 缓存/查询（不能把总开关放在限流之前，否则被关闭期间的扫描不计数）。

#### `GET /api/public/summary` — 汇总计数

200：

| 字段 | 类型 | 说明 |
|---|---|---|
| `total` | number | 主机总数 |
| `online` / `offline` | number | 在线 / 离线数（`disabled` 不计入这两个） |
| `disabled` | number | 新增：补齐（原表漏了它，但设计稿顶栏「禁用 1」需要）；`total = online + offline + disabled` |
| `alerts` | object | `{ critical, warn, info }` 各严重级当前告警数。注意：当前恒为 0：告警引擎（M3）未实现，接口按契约查询 `alert_events` 而非硬编码 0，M3 落地后本字段自动变正确 |
| `updated_at` | string(RFC3339) | 快照生成时间（= 服务端缓存生成时刻） |

#### `GET /api/public/hosts` — 主机列表

200：`{ items: [...], next_cursor: null, updated_at }`（§1.2 ③），每项字段如下（无内部 UUID、无 IP）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `slug` | string | 公开标识（`agents.public_slug`，见 §3.1） |
| `name` | string | 显示名优先取 `display_name`，其次 `name`（决策 #21） |
| `status` | string | `online` / `offline`。不出现 `disabled`（人工禁用是内部运营信息）；注意：由读取时推导（`last_seen_at` 与阈值比较），不是直接读 `agents.status` —— 否则 cron 静默失效时接口会开始"报平安" |
| `os` | string? | 操作系统；缺失时字段缺省（不是 null） |
| `uptime` | number? | 运行时长（秒，由 `host_info.boot_time` 推导）；缺失时字段缺省 |
| `snapshot` | object | `{ cpu_pct, mem_pct, disk_pct, net_rx_bps, net_tx_bps, gpu_pct? }`；无数据一律 `null`（不补 0 —— 那是把"失联"显示成"空闲"）；`gpu_pct` 在无 GPU 序列时整键缺省 |
| `probes` | object | `{ up, down }`：该机最近一轮探活结果；从未探活 → `{ "up": 0, "down": 0 }` |
| `last_seen_ago` | string \| null | 相对化文案（`刚刚` / `N 分钟前` / `N 小时前` / `N 天前` / `超过 30 天`）。注意：`disabled` 或从未上报时为 `null`（不编造"超过 30 天"） |
| `last_seen_at` | string(RFC3339) \| null | 分钟级取整后的绝对时间（见 §3.1 的 口径）；从未上报为 `null` |

排序：与私有列表（§4.2）同一套「有问题优先」——非在线（`offline`）在前 → 有活动告警的在前 → 在线 → `last_seen_at DESC` 兜底。两边不得各排各的（同一批主机在两个页面上顺序必须一致）。

缓存：整个响应体缓存 `PUBLIC_CACHE_TTL_S`（默认 10s）于 Redis `snapshot:public:hosts`；命中时 `updated_at` = 缓存生成时刻。注意：缓存的是已脱敏的响应（绝不缓存含 IP / 内部 UUID 的内容）。

#### `GET /api/public/hosts/{slug}/now` — 单机当前快照

路径参数：`slug`（公开标识，不是内部 UUID）。形状不合法（不符合 8–12 位公开字符集）→ 400 `schema_invalid`；不存在或该机已被人工禁用 → 同一個 404 `not_found`（两者不可区分，否则 slug 成了"这台机是否被禁用"的枚举口子）。

200：列表条目字段（§3.2 上一张表，卡片可直接复用）+ 展开块：

| 字段 | 类型 | 说明 |
|---|---|---|
| `cpu` | object | `{ usage_pct, load1, load5, load15, ctx_switch }`，缺失为 `null` |
| `memory` | object | `{ total_bytes, used_bytes, used_pct, available_bytes, cached_bytes, buffers_bytes }` |
| `disks[]` | object[] | 每行 `{ label, total_bytes, used_bytes, used_pct, inode_used_pct, read_bps, write_bps, read_iops, write_iops, latency_ms }` |
| `networks[]` | object[] | 每行 `{ label, rx_bps, tx_bps, rx_total_bytes, tx_total_bytes, conn_count, err, drop }` |
| `gpus[]` | object[] | 每行 `{ label, util_pct, mem_used_bytes, mem_total_bytes, temp_c, power_w }` |
| `updated_at` | string | 快照生成时刻（命中缓存时 = 缓存生成时刻） |

设备名泛化口径：`label` 由服务端生成 ——
磁盘按 `mount`（无 mount 时按 `device`）字典序编号成 `磁盘 1..n`、网卡按 `device` 编号成 `网卡 1..n`，
GPU 用 `index`（本身就是稳定序号）→ `GPU 1..n`。
响应里一个指标名都不出现（没有 `disk.used_pct{mount=/data}` 这种键），
设备名、挂载点、路径、端口一律不下发 —— 将来给 `metrics_raw` 加维度也不可能顺着这条路漏出去（白名单式构造）。
注意：编号只保证同一批数据内稳定（同一次响应的字典序一致）；设备增删会让编号整体平移，这是刻意取舍（不做持久化映射表）。

错误：400 `schema_invalid`（slug 形状非法）｜404 `not_found`（不存在 / 已禁用 / 总开关关闭）

#### `GET /api/public/probes` — 探活当前概览

200：`{ items: [...], next_cursor: null, truncated: boolean, updated_at }`，每项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `slug` / `host_name` | string \| null | 该探活属于哪台机（公开标识与显示名） |
| `name` | string | 探活名（Agent 本地 `config.yaml` 里的名字，如「网关」「官网」） |
| `target_host` | string \| null | 脱敏后的目标，见下 |
| `type` | string | `ping` / `http` / `https` / `tcp` / `dns` |
| `up` | boolean | 最近一轮是否可达 |
| `latency_ms` | number \| null | |
| `checked_at` | string \| null | 探活时刻（精确值：探活不参与"主机上下线"指纹，故不做分钟级取整） |

`target_host` 脱敏口径：
URL → 只留主机名（去掉路径/查询串/端口）；`host:port` → 去掉端口；域名 → 原样；
私网/保留 IP（RFC1918 / CGNAT / ULA / 回环 / 链路本地）→ 固定文案 `内网地址`；
公网 IP → 原样（解析域名同样能得到，隐藏只会让公开页变成一排「—」）；解析不出来 → `null`（不回显原串）。

注意：只列非禁用主机、只取每机最近一轮；条数上限 500，被截断时 `truncated: true`（不静默丢数据）。

缓存与限流（§5.4「带缓存与限流」；缓存与限流参数见 §1.4 与 §3.2 上文的默认值）

- 服务端缓存：响应级缓存 —— `/api/public/hosts` → `snapshot:public:hosts`、`/api/public/summary` → `snapshot:public:summary`，TTL = `PUBLIC_CACHE_TTL_S`（默认 10s，0 = 关闭）。契约原文写的 `snapshot:agent:<id>`（每机粒度）与"全量列表"端点不匹配（按机缓存会退化成 N 次读取），故改用响应级；`snapshot:agent:<id>` 至今无写入方，保留给将来的 `/ws/*` 实时扇出。缓存读/写失败一律不影响响应（读失败按未命中、写失败只 warn）。
- 响应头：`Cache-Control: no-store`（避免中间层/CDN 缓存过期或跨用户数据）；
- 限流：`ratelimit:public:<ip>`，60 次/分钟（`RATELIMIT_PUBLIC_PER_MINUTE`，见 §1.4）；
- 整体开关：`public_view.enabled`（§5.4）；已定：默认开启（装好即可免登录查看当前状态，符合决策 #10 初衷）；关闭时所有 `/api/public/*` 与 `/ws/public` 返回 404（不泄露「存在但被关闭」）。
- 注意：默认开启的配套要求（必须同时做到）：① 公开接口与 `/ws/public` 按 IP 严格限流（`ratelimit:public:*`、`ratelimit:ws:*`）；② 严格脱敏（§3.1 的 清单）；③ 设置页给出醒目状态与「一键关闭」；④ 首次登录后引导复核该开关（`docs/frontend.md` §4.6）。

---

## 4. 面板私有 API（`/api/v1/*`，需登录）

### 4.1 认证与会话（13 个端点）

> 本节 13 个端点全部已实现（B4/B5 会话与改密、B6/B7 2FA、S 系列人机验证），分块记录、验收清单与行为细则见 `docs/api-status.md` §2、§3。
> 内部机制（Redis 键、三态矩阵、防重放）见 `docs/api-status.md` §3。

#### 4.1.0 本节通用约定

| 项 | 约定 |
|---|---|
| Cookie | 名 `vantage_sid`（可配），仅存不透明 256-bit 随机 `sid`；`HttpOnly + SameSite=Lax + Path=/ + Max-Age=绝对 TTL`，`Secure` 由 `COOKIE_SECURE` 决定（可选 `__Host-` 前缀）。Cookie 与响应体里不得出现用户资料/角色之外的敏感信息 |
| 会话状态（Redis `session:<sid>`） | `{ user_id, roles, totp_ok, setup_required, created_at, last_seen, ip, ua, csrf }`；`roles` 恒为 `["admin"]` 或 `["user"]` 单元素数组（保持数组形态便于将来扩多角色） |
| 生命周期 | 滑动 30min（每次命中续期）+ 绝对 24h（自 `created_at` 起算，续期不影响）；同账号并发上限 3（超限踢最旧，新建的那个永不参与淘汰）；IP/UA 只记录不强制校验 |
| CSRF | 本节所有写请求都要 `X-CSRF-Token`；豁免仅限会话建立前的三个端点（`login` + 两个 `captcha/*`，详见 §1.2 ②） |
| 登录失败 | 统一 401 `invalid_credentials`（不区分账号不存在 / 密码错 / 已禁用），且计入 `ratelimit:login:<ip>`；同时 INCR 两个失败计数器并在响应里带 `captcha_required` 提示（S） |
| 人机验证 | 首次登录不要求；一旦出现密码错误，同 IP / 同账号失败计数 ≥ `security.login_captcha.after_failures`（默认 1）→ 后续登录必须携带 `captcha_token`。登录成功后两个计数清零：闸门在验密之前，不清零会让窗口内"错过一次"的账号每次登录都被要求验证（哪怕密码这次是对的）。它与三态矩阵正交：只决定这次登录请求能否进入验密环节。提供方由 `CAPTCHA_PROVIDER` 决定：取值 `geetest` / `selfbuilt` / `none`；未设置时自动推断（配了极验密钥 → `geetest`，否则 → `selfbuilt`）；显式声明 `geetest` 却缺密钥 → 启动即失败（不允许"声明用极验却静默放行"）。`none` = 整条链路关闭（出题 / 验题 404、登录永不被要求人机验证）：它是 env 级、面板不可见的部署期总闸；正常关闭人机验证请用设置项 `security.login_captcha.enabled=false`（面板可改、有审计）。两个提供方在本表上的差异只有两处：① `captcha/challenge` 的响应体（自建回两张 SVG；极验回 `provider`+`captcha_id`+`product`+`language`）；② `captcha/verify` 的请求体与 `details.reason` 枚举。登录端点的请求/响应一个字都不改（§4.1 两个端点有逐字段对照） |

会话三态与各端点的可达性（判定规则与实现记录见 `docs/api-status.md` §3.2）：

| 端点 | `full` | `totp_pending`（已绑未过第二步） | `setup_required`（策略要求未绑定） |
|---|---|---|---|
| `login` | —（建立会话） | — | — |
| `me` | 200 | 200 | 403 `totp_setup_required` |
| `2fa/verify` | （重验；同一码会被防重放拒） | | 409 `conflict`（账号没绑 TOTP） |
| `2fa/setup` | （未绑定时） | 可达 | 可达 |
| `2fa/enable` | | 403 `totp_required` | （强制绑定流程） |
| `2fa/disable` | | 403 `totp_required` | 403 `totp_setup_required` |
| `2fa/recovery/verify` | | | 409 `conflict` |
| `2fa/recovery/regenerate` | | 403 `totp_required` | 403 `totp_setup_required` |
| `password` | | 403 `totp_required` | 403 `totp_setup_required` |
| `logout` / `logout-all` | | | （不能把人锁死在面板里） |

> 强制策略：`security.require_2fa=true` 时，未绑定 TOTP 的账号登录后进入 `setup_required` 受限态，只放行 `2fa/setup` / `2fa/enable` / `logout*`，其余一律 403 `totp_setup_required`；不允许跳过。
> 注意：两处必须知道的例外（见上表）：① `me` 在 `setup_required` 态返回 403——前端 `refreshMe()` 正是靠它进入强制绑定流程（旧文把它写进"放行"列表，已作废）；② `2fa/verify` 与 `2fa/recovery/verify` 没有状态守卫，请求直达服务层，对未绑定账号返回 409 `conflict`（不是 403）。
> 注意：上表不含两个 `captcha/*` 端点：它们在会话建立之前运行，与会话状态无关（不受三态矩阵约束，见 §4.1）。

---

#### `POST /api/v1/auth/login` — 登录第一步（密码）已实现

| 项 | 值 |
|---|---|
| 认证 | 无（会话建立前的端点，CSRF 天然放行） |
| 限流 | `ratelimit:login:<ip>`，10 次 / 300s（成功与失败都计数） |
| 人机验证 | 密码错后要求 `captcha_token`（判定见 §4.1.0，S） |
| 审计 | 成功 `auth.login`；失败 `auth.login_failed`（`detail.reason` 恒为 `invalid_credentials`） |

请求体

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `username` | string | | 1–128；大小写不敏感（按 `lower(username)` 匹配）；响应回显库内原始写法 |
| `password` | string | | 1–128 |
| `captcha_token` | string | 条件 | ≤128；仅在服务端要求时必需（见下）；来自 `POST /auth/captcha/verify` |

成功 200（同时下发 `Set-Cookie: vantage_sid=<sid>`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `csrf` | string | 后续写请求的 `X-CSRF-Token` 来源（≥24 字符；`sid` 轮换后不变） |
| `totp_required` | boolean | `true` = 该账号已绑 2FA，须先调 `2fa/verify`；此时不返回 `user`/`roles` |
| `user` | object | 仅 `totp_required=false` 时返回（字段见下） |
| `roles` | string[] | 仅 `totp_required=false` 时返回，恒 `["admin"]`/`["user"]` |

`user` 对象（白名单式构造，永不含 `password_hash`/`totp_secret_enc`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string(uuid) | 用户 ID |
| `username` | string | 登录名 |
| `display_name` | string \| null | 显示名 |
| `role` | string | `admin` / `user` |
| `status` | string | `active` / `disabled` |
| `totp_enabled` | boolean | 是否已绑定 2FA |

响应示例

```jsonc
// 未绑定 2FA（含 require_2fa=true 但未绑定：引导交给 me）
{ "user": { "id": "…", "username": "admin", "display_name": "管理员", "role": "admin",
            "status": "active", "totp_enabled": false },
  "roles": ["admin"], "csrf": "…", "totp_required": false }

// 已绑定 2FA：会话进入 totp_pending，除 me / 2fa 外全部 403
{ "csrf": "…", "totp_required": true }
```

错误：401 `invalid_credentials`（三种失败同码同文同耗时；密码错后其 `details.captcha_required` 为 `true`，S）｜400 `schema_invalid`（缺字段 / 超长）｜400 `captcha_required`（策略要求滑块但缺 `captcha_token`，S）｜400 `captcha_invalid`（token 无效 / 已过期 / 已消费，S；`details.reason` = `expired` 或 `ip_mismatch`）｜429 `rate_limited`（带 `Retry-After`）

备注

- 等时校验：账号不存在（或 SSO-only 无本地密码）时也对固定假哈希跑一次完整 Argon2——响应体与耗时都不可区分（防用户名枚举）。
  注意：加滑块后此不变量必须保持：是否要求滑块的判定只依赖 IP / 提交用户名的失败计数与设置项，不查库，因此不会引入新的计时侧信道（S）。
- 登录顺带整理 `user_sessions:<uid>`（清僵尸成员 + 超限踢最旧）；`last_login_at/ip/method` 在会话建好之后才写（Redis 挂了不能留下"成功登录"的痕迹）。
- 校验顺序不可调换（S）：先卡滑块、后验密码。若反过来，攻击者不必通过人机验证就能让服务端每次跑满 19MiB 的 Argon2，等于白送一个 DoS 放大器。
- 滑块相关细节（失败计数器、token 绑定与消费时机、`details.reason` 枚举）见 `docs/slider-captcha-selfbuilt.md` §2/§5/§6.4。

#### `POST /api/v1/auth/captcha/challenge` — 取验证入口配置 已实现（自建 S；极验分支 S7）

> 响应形状按提供方分支（`CAPTCHA_PROVIDER`，启动时定死，见 §4.1.0）。两个分支都带 `provider` 字段供前端选组件 —— 但它都不是安全边界：真正的判定只在 `captcha/verify`。

| 项 | 值 |
|---|---|
| 认证 / CSRF | 无（会话建立前；与会话无关，理由同 `login`，见 §1.2 ②） |
| 限流 | `ratelimit:captcha:<ip>`，30 次 / 分钟（独立桶，见 §1.4） |
| 开关 | 满足任一即 404 `not_found`：`security.login_captcha.enabled=false`、提供方凭据未配置、外部服务处于熔断窗口且 `GEETEST_FAIL_MODE=open`（不用 403：不暴露"存在但被关"） |
| 审计 | 不记（否则"取题"噪声会淹没审计表） |

请求：无 body。

成功 200（`provider=selfbuilt`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | string | 恒为 `selfbuilt` |
| `captcha_id` | string | 题目标识（≥16 字节随机，base64url）；Redis `captcha:<id>`，TTL 120s |
| `bg_svg` | string | 背景图（含缺口）的 SVG 文本，前端内联渲染 |
| `piece_svg` | string | 拼图块的 SVG 文本（用户拖动它） |
| `width` / `height` | number | 逻辑画布尺寸；前端可等比缩放显示，但提交的坐标必须是逻辑坐标 |
| `expires_in` | number | 秒（默认 120） |

响应中不得出现缺口坐标、容差、失败次数上限（`docs/slider-captcha-selfbuilt.md` §6.1 有逐条"不泄露答案的写法"）。

成功 200（`provider=geetest`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | string | 恒为 `geetest` |
| `captcha_id` | string | 极验 captcha_id（公开值，前端 `initGeetest4` 要用）。`captcha_key` 永不下发 |
| `product` | string | `popup`（默认：官方按钮 + 带遮罩的验证弹窗）或 `float` |
| `language` | string | 验证窗语言（`zho`/`eng`/…；由极验渲染，不受本站 i18n 控制） |

注意：极验分支没有 `expires_in`：题目与答案由极验云端管理，服务端唯一能承诺的 TTL 是验题后自己发的一次性凭证（出现在 `verify` 的响应里）。
注意：极验分支也没有 `bg_svg`/`piece_svg`：出题是极验的事。

错误：404 `not_found`（关闭 / 未配置 / 熔断）｜429 `rate_limited`｜503 `upstream_unavailable`（Redis 不可用，fail-closed）

#### `POST /api/v1/auth/captcha/verify` — 校验人机验证并发放一次性 token 已实现（自建 S；极验分支 S7）

| 项 | 值 |
|---|---|
| 认证 / CSRF | 无（会话建立前） |
| 限流 | `ratelimit:captcha:<ip>`（与取题共用）。注意：极验分支下本端点是全站唯一"匿名可触发外呼"的端点，此桶同时是外呼放大器的闸门 |
| 审计 | 未通过 `auth.captcha_failed`（`detail`：`provider` + `reason` + 可选 `vendor_reason` / `delta_px`；不含答案、不含提交原值、不含 token 与 `pass_token`）；外部服务不可用另记 `auth.captcha_unavailable`（见下） |
| 判定 | 服务端唯一判定点。自建 = 容差 + 轨迹规则；极验 = 把 4 个参数转发到 `gcaptcha4.geetest.com/validate` 并采信其结论（不重试） |

请求体（`provider=selfbuilt`）

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `captcha_id` | string | | ≤128 |
| `x` | number | | 逻辑坐标（0 ≤ x ≤ width） |
| `y` | number | 可选 | 仅横向滑动时可省 |
| `track` | array | | `[[t_ms, x], …]`，点数上限 200（防超大 body） |

请求体（`provider=geetest`） = 极验 `captchaObj.getValidate()` 的字段

| 字段 | 类型 | 必需 | 约束（防御性护栏，不是极验契约） |
|---|---|---|---|
| `lot_number` | string | | ≤128 |
| `captcha_output` | string | | ≤4096 |
| `pass_token` | string | | ≤2048 |
| `gen_time` | string | | ≤32 |
| `captcha_id` | string | 可选 | ≤128。注意：极验会带上它 —— 见下方说明；服务端放行但不读 |

注意：`getValidate()` 返回的不止那 4 个字段：它是极验客户端 `POST https://gcaptcha4.geetest.com/verify` 响应里 `data.seccode` 的原样对象，键序 `captcha_id, lot_number, pass_token, gen_time, captcha_output`。
- 因此 `captcha_id` 必须在白名单里：否则"把 `getValidate()` 原样转发"的客户端会被 400 `schema_invalid` 挡死（真实故障：验题永远失败 → 登录永远 400 `captcha_required`）。
- 但服务端不读它：出站二次校验用的是服务端配置里的 `captchaId`，且走 URL query（`server/src/utils/geetest.js` 的 `buildValidateUrl`）—— 所以不存在「调用方指定用哪个验证 id」的输入面。
- `additionalProperties: false` 保持不变：只放行这一个已知的厂商字段，其它多余字段（探测/伪造）照旧被拒（回归用例 AC-G5c）。
- 前端仍应显式挑字段（`web/src/utils/geetest.ts` 的 `toVerifyBody()`）：白名单的收口点在服务端，前端不留"厂商再加字段就再炸一次"的隐患。

成功 200（两个提供方完全一致）

| 字段 | 类型 | 说明 |
|---|---|---|
| `captcha_token` | string | 一次性凭证；Redis `captcha:ok:<token>`（TTL 120s，值绑定解出验证的 IP） |
| `expires_in` | number | 秒（默认 120） |

错误

| 状态 | code | 触发（`details.reason`） |
|---|---|---|
| 400 | `captcha_invalid` | 自建：`mismatch`（偏差超容差）/ `track_suspicious` / `not_found`（题目过期或已作废）/ `too_many_attempts`（同一题失败 ≥3 次）<br>极验：`validate_failed`（极验明确判未通过；`details.vendor_reason` 附其原文） |
| 400 | `schema_invalid` | 缺字段 / `track` 超长 / 字段超长 |
| 429 | `rate_limited` | 同 IP 超限 |
| 503 | `captcha_unavailable` | 极验不可达且 `GEETEST_FAIL_MODE=closed`（§1.3）。注意：默认 `open` 时不会出现本码——那时按「放行」处理并写 `auth.captcha_unavailable` 审计 |
| 503 | `upstream_unavailable` | Redis 不可用（fail-closed）｜404 `not_found`（关闭 / 未配置 / 熔断且 open） |

备注

- 一次性与"成功才消费"：凭证在 `POST /auth/login` 登录成功时才 `DEL`。注意：因此它在 120s 内可被复用（含提交错误密码）——这是刻意的：否则用户验证通过后打错密码就要重新验证一次。攻击者同样受登录限流约束（§1.4）。
  这正是选两步契约而不是"把 4 个参数随登录一起提交"的原因：极验的 `pass_token` 是一次性的，而两步契约让它在 `/captcha/verify` 只用掉一次（`docs/geetest-captcha.md` §3.4）。
- token 绑定 IP：换 IP 使用同一 token → 400 `captcha_invalid`（挡"打码平台批量出 token 转卖"）。
- 前端不得自行判定对错（前端判对错＝纯前端验证码，零防护价值）。极验的 `onSuccess` 同样必须经服务端 `/validate` 才算数。
- 失败模式（极验）：`/validate` 请求异常或 HTTP 非 200 时，按 `GEETEST_FAIL_MODE` 处理 —— 默认 `open`（放行 + 审计 + error 日志 + 30s 熔断），`closed` 则 503。完整论证见 `docs/geetest-captcha.md` §9。
- 已定：进程级出站并发上限。本端点是全站唯一「匿名可触发外呼」的端点，单靠 `ratelimit:captcha:<ip>` 挡不住多 IP 分布调用；超限时不再干等 3s 超时，直接按 `GEETEST_FAIL_MODE` 处理（`open` → 放行 + 审计；`closed` → 503 `captcha_unavailable`）。契约已定但尚未落地（`server/src` 内无并发信号量），落地状态见 `docs/api-status.md` §3.6（S9）。
- 自建的完整阈值、容差与"不泄露答案"的写法见 `docs/slider-captcha-selfbuilt.md` §6；极验的参数、签名与响应解析见 `docs/geetest-captcha.md` §4。

#### `POST /api/v1/auth/2fa/verify` — 登录第二步（TOTP）已实现

| 项 | 值 |
|---|---|
| 认证 | Cookie（`totp_pending` 态的主要用途） |
| CSRF | 必带 |
| 限流 | 与 `login` 共用 `ratelimit:login:<ip>`（防 6 位码暴力枚举；注意：限流挂在会话校验之前，无会话狂刷同样计数） |
| 审计 | 成功 `auth.2fa_verify`；失败 `auth.2fa_verify_failed`（`reason`: `invalid_totp` / `replayed_step`） |

请求体

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `code` | string | | TOTP 6 位数字（6–8 字符，内部去空白后按 `^\d{6}$` 校验） |

成功 204（无响应体）+ `Set-Cookie: vantage_sid=<新 sid>`

错误

| 状态 | code | 触发 |
|---|---|---|
| 400 | `invalid_totp` | 验证码不正确，或该步号已被使用过（30s 窗口内重放同一码） |
| 400 | `schema_invalid` | 缺 `code` / 长度越界 |
| 401 | `session_expired` | 无 Cookie / 会话已失效 |
| 403 | `csrf_invalid` | 缺 `X-CSRF-Token` |
| 409 | `conflict` | 该账号未绑定 TOTP（会话态与库态脱节，提示重新登录） |
| 429 | `rate_limited` | 与登录共用桶超限 |

备注

- 成功后 `sid` 必须轮换（决策 #32，防会话固定）；`csrf` 不变。
- 同一步号只接受一次：命中步号先经 Redis `SADD totp:used:<uid>`（TTL 90s）原子认领，`SADD` 返回 0 即判重放（`docs/api-status.md` §3.3）。
- 前端：`totp_required:true` 后所有其它接口都 403，UI 必须留在登录流程内；验证成功后重新调 `GET /auth/me` 拿 `user`/`roles` 再跳转（`docs/frontend.md` §4.2）。
- 不写 `touchLogin`：`users.last_login_method` 的 CHECK 只允许 `password/totp/oidc`，且第一步已记录本次登录。

#### `GET /api/v1/auth/me` — 恢复登录态 + 取 CSRF 已实现

| 项 | 值 |
|---|---|
| 认证 | Cookie |
| 参数 | 无 |

成功 200

| 字段 | 类型 | 说明 |
|---|---|---|
| `user` | object | 同 `login` 的 `user`（六字段白名单） |
| `roles` | string[] | 同 `login` |
| `session.created_at` | string(RFC3339) | 会话创建时间 |
| `session.last_seen` | string(RFC3339) | 最近活跃时间（写入节流 60s） |
| `session.ip` | string \| null | 登录来源 IP |
| `session.ua` | string \| null | User-Agent（截断 ≤200 字符） |
| `csrf` | string | 与登录响应同源；`sid` 轮换后不变 |

错误：401 `session_expired`｜403 `totp_setup_required`（`setup_required` 态必须回 403——前端 `store/auth.ts` 靠它进入强制绑定流程，见 §4.1.0 三态矩阵）

备注：`totp_pending` 态下 `me` 正常 200（前端据此恢复会话但留在登录流程内）；会话有效但账号已被删除时 → 销毁会话、清 Cookie、回 401。

#### `POST /api/v1/auth/logout` — 登出当前会话 已实现

| 项 | 值 |
|---|---|
| 认证 | Cookie（受限态也可登出） |
| CSRF | 必带 |
| 审计 | `auth.logout`（`detail.session_found`） |

请求：无 body。成功 204 + 清 Cookie（`Max-Age=0`）。
错误：401 `session_expired`｜403 `csrf_invalid`。
备注：不存在的 sid 也回 204（不泄露信息）。

#### `POST /api/v1/auth/logout-all` — 全部会话下线 已实现

| 项 | 值 |
|---|---|
| 认证 | Cookie |
| CSRF | 必带 |
| 审计 | `auth.logout_all`（`detail.sessions_destroyed`） |

请求：无 body。成功 204 + 清当前 Cookie（`user_sessions:<uid>` 内全部 sid 被删，含当前这一个）。
错误：401 `session_expired`｜403 `csrf_invalid`。

#### `POST /api/v1/auth/password` — 自助改密 已实现

| 项 | 值 |
|---|---|
| 认证 | Cookie，必须完整态（`totp_pending` / `setup_required` 一律 403） |
| CSRF | 必带 |
| 审计 | 成功 `auth.password_change`（`detail.other_sessions_kicked`）；失败 `auth.password_change_failed` |

请求体

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `old_password` | string | | 1–128 |
| `new_password` | string | | 8–128（Schema 卡边界）；不得与旧密码相同 |

成功 204（无响应体）+ `Set-Cookie: vantage_sid=<新 sid>`

错误

| 状态 | code | 触发 |
|---|---|---|
| 400 | `schema_invalid` | 新密码长度不在 8–128 |
| 400 | `invalid_request` | 新密码与旧密码相同 |
| 401 | `invalid_credentials` | 旧密码不正确（哈希不改动，旧密码仍可登录） |
| 401 | `session_expired` | 会话/账号异常 |
| 403 | `csrf_invalid` | 缺 `X-CSRF-Token` |
| 403 | `totp_required` / `totp_setup_required` | 处于受限态 |

备注：执行顺序刻意固定为 验旧密码 → 写新哈希 → 轮换 sid → 踢其它会话（保留当前）→ 审计——先轮换后写库会让用户陷入"旧密码已失效、新密码又没生效"。
#### `POST /api/v1/auth/2fa/setup` — 生成待确认密钥 + 二维码 已实现（B6）

| 项 | 值 |
|---|---|
| 认证 | Cookie（`full` / `totp_pending` / `setup_required` 三态都可达） |
| CSRF | 必带 |
| 审计 | `user.2fa_setup` |

请求：无 body。

成功 200

| 字段 | 类型 | 说明 |
|---|---|---|
| `secret` | string | Base32（无填充，32 字符）——供手工输入认证器；明文仅此一次，库里只存 AES-256-GCM 密文 |
| `otpauth_uri` | string | `otpauth://totp/Vantage:<username>?secret=…&issuer=Vantage&algorithm=SHA1&digits=6&period=30` |
| `qr_svg` | string | 服务端渲染的 SVG 文本（`qrcode` 依赖），前端直接内联渲染即可 |

错误

| 状态 | code | 触发 |
|---|---|---|
| 401 | `session_expired` | 无会话 |
| 403 | `csrf_invalid` | 缺 CSRF |
| 409 | `conflict` | 该账号已绑定 2FA（允许换绑=用密码绕过 2FA；自救走恢复码或管理员重置，见 `docs/api-status.md` §4.1 D7） |

备注：`setup` 只写"待确认密钥"（`totp_enabled` 保持 `false`），未通过 `enable` 前不生效；未绑定时重复 setup 会覆盖上一次的待确认密钥（无副作用）。

#### `POST /api/v1/auth/2fa/enable` — 验码绑定 + 下发恢复码 已实现（B6）

| 项 | 值 |
|---|---|
| 认证 | Cookie（`setup_required` / `full` 可调；`totp_pending` 403 `totp_required`） |
| CSRF | 必带 |
| 审计 | 成功 `user.2fa_enable`（`detail.recovery_codes=10`）；失败 `user.2fa_enable_failed` |

请求体

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `code` | string | | 认证器当前 6 位码（6–8 字符） |

成功 200 + `Set-Cookie: vantage_sid=<新 sid>`

| 字段 | 类型 | 说明 |
|---|---|---|
| `recovery_codes` | string[] | 恰好 10 个一次性恢复码，形如 `XXXXX-XXXXX`（Crockford Base32，无 `I/L/O/U`）；明文仅此一次，库里只存 HMAC 哈希 |
| `remaining_recovery_codes` | number | 当前可用数量（此处恒 10） |

错误：400 `invalid_totp`（码错 / 重放）｜400 `invalid_request`（未先 setup，或待确认密钥已失效）｜401 `session_expired`｜403 `csrf_invalid`｜403 `totp_required`（pending 态）｜409 `conflict`（已绑定 / 绑定状态并发变化）

备注：验码通过 = 已证明持有 → 会话直接置为 `full` 并轮换 sid（D1：绑定成功即下发 10 个恢复码，前端须强制提示保存）。

#### `POST /api/v1/auth/2fa/disable` — 密码二次确认解绑 已实现（B6）

| 项 | 值 |
|---|---|
| 认证 | Cookie，必须完整态 |
| CSRF | 必带 |
| 审计 | 成功 `user.2fa_disable`（`detail.recovery_codes_deleted`）；失败 `user.2fa_disable_failed`（`detail.reason`） |

请求体

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `password` | string | | 1–128；密码二次确认（不接受 TOTP 码替代） |

成功 204（无响应体；不轮换 sid、不踢会话——用户仍是完整态）

错误

| 状态 | code | 触发 |
|---|---|---|
| 401 | `invalid_credentials` | 密码不正确 |
| 403 | `csrf_invalid` | 缺 CSRF |
| 403 | `totp_required` / `totp_setup_required` | 非完整态 |
| 409 | `conflict` | 尚未绑定 2FA，或 `security.require_2fa=true` 时禁止自助解绑（D3，`reason=require_2fa_policy`） |

备注：解绑连恢复码一起作废（D5，`resetTotp` 两条语句在同一事务内），避免留下悬空凭据。

#### `POST /api/v1/auth/2fa/recovery/verify` — 用恢复码过第二步 已实现（B7）

| 项 | 值 |
|---|---|
| 认证 | Cookie（`totp_pending` 态的主要用途） |
| CSRF | 必带 |
| 限流 | 与 `login` 共用 `ratelimit:login:<ip>` |
| 审计 | 成功 `user.recovery_used`（`detail.remaining_recovery_codes`）；失败 `user.recovery_verify_failed` |

请求体

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `code` | string | | 8–20 字符；归一化在哈希口径内：大小写、连字符、空白、易混字符（`I/L→1`、`O→0`）都能命中同一条记录 |

成功 200 + `Set-Cookie: vantage_sid=<新 sid>`

| 字段 | 类型 | 说明 |
|---|---|---|
| `remaining_recovery_codes` | number | 剩余可用数量（≤2 时前端应强提示重新生成） |

错误：400 `invalid_totp`（不存在 / 已用过 / 格式非法）｜400 `schema_invalid`｜401 `session_expired`｜403 `csrf_invalid`｜409 `conflict`（账号已解绑，恢复码已随之作废）｜429 `rate_limited`

备注：消耗是单条 `UPDATE … WHERE used_at IS NULL`（行锁保证并发下同一码只可能成功一次，用后即废）；成功后轮换 sid 并置 `totp_ok=true`。

#### `POST /api/v1/auth/2fa/recovery/regenerate` — 重发 10 个恢复码 已实现（B7）

| 项 | 值 |
|---|---|
| 认证 | Cookie，必须完整态 |
| CSRF | 必带 |
| 审计 | `user.recovery_regenerate`（`detail.recovery_codes=10`） |

请求：无 body。

成功 200：`{ recovery_codes: string[10], remaining_recovery_codes: 10 }`（字段同 `enable`，明文仅此一次）

错误：401 `session_expired`｜403 `csrf_invalid`｜403 `totp_required`（pending 态）｜403 `totp_setup_required`｜409 `conflict`（未绑定 2FA）

备注：整批替换——旧码在事务内被删除、立即失效（前端须提示"旧恢复码已全部作废"）。

SSO（OIDC）本期不做，仅预留（已定）

- `users` 表已预留 `oidc_issuer` / `oidc_subject` / `oidc_email` / `oidc_linked_at` / `oidc_last_sync_at`（见 `docs/database.md` §5.3）；本期不实现 OIDC 流程，不开放 `/api/v1/auth/oidc/*` 端点。
- 预留形态（后续对接时按此实现）：`GET /api/v1/auth/oidc/start`（302 跳 IdP authorize，携带 `state` + `nonce` + PKCE）、`GET /api/v1/auth/oidc/callback`（校验 `state` 与 `id_token` → 按 `(oidc_issuer, oidc_subject)` 定位 `users` → 复用同一套 Redis `sid` 会话机制）、`POST /api/v1/auth/oidc/link` / `unlink`（已登录用户自助绑定/解绑）。
- 待定：后续待定：是否允许 SSO 自助注册、IdP 的 group/role claim 如何映射到 `admin`/`user`（`docs/database.md` §12.2 N3）。
- 红线：OIDC 只用于面板登录，不得成为「向 Agent 下发」的通道（`docs/api.md` §2.3、设计 §18.3）。

> §4.1.1「实现规范与落地状态」→ `docs/api-status.md` §3（会话模型、三态矩阵与端点可达性、Redis 键、TOTP / 恢复码、离线救援 CLI、分块落地表、行为细则）。原 §4.1.1 ⑧ 的决策 D1–D7 已全部确认，逐条见该文件 §4.1。
> 旧文里与本契约冲突的两处表述（`me` 被列为 `setup_required` 的"放行"端点、"其余接口一律 403"）已作废，以上面 §4.1.0 的表为准。

### 4.2 主机（需登录，含 IP 与历史）

> 本节中的 `GET /api/v1/hosts`、`/api/v1/summary`、`/hosts/{id}`、`/probes`、`/ip-history`、`/processes` 均已实现，`/hosts/{id}/metrics`（时序查询，参数定稿见 §4.3）也已实现。
> 实现口径（在线判定同源、`null` 不补 0、脱敏白名单、排序）逐条见 `docs/server-status-api.md` 与 `docs/api-status.md` §4.6。

#### `GET /api/v1/hosts` — 主机列表

鉴权：`loadPanelSession` → `requireFullSession` → `requireCsrf`（GET 不校验 CSRF，挂上以与 `/auth/*` 同构）。
三态：`setup_required` → 403 `totp_setup_required`；`totp_pending` → 403 `totp_required`（复用既有中间件，不另写判定）。
限流：本期不加专用桶 —— 已登录 + 登录桶已覆盖；注意：若将来要对齐公开接口，可加 `ratelimit:panel:<user_id>`。

查询参数（`status` / `tag` / `q` 已实现；`cursor` 尚未实现）

| 参数 | 必需 | 说明 |
|---|---|---|
| `status` | 否 | `online` / `offline` / `disabled`。注意：过滤的是推导后的状态（不是过滤 `agents.status` 列 —— 否则 `?status=online` 会把"库说 online 但其实已失联"的机器一起返回）；非法取值 → 400 `schema_invalid` |
| `tag` | 否 | 标签精确匹配（`tags @> to_jsonb($x)`，走 `agents_tags_gin_idx`）；长度 1–64 |
| `q` | 否 | 名称模糊搜索（对 `name` / `display_name` 做 `ILIKE`）；长度 1–64。注意：服务端对 `%` `_` `\` 做转义后再拼（按字面匹配），前端不要自己转义（否则会双重转义）。空串 `?q=` 按"未提供"处理（= 不过滤），不是 400、也不是空结果 |
| `limit` | 否 | 默认 20 / 上限 200（§1.2 ③）；非正整数 → 400 `schema_invalid`；超过上限夹取到 200 并告警（不因为"要得太多"而拒绝整个请求） |
| `cursor` | 否 | 本期不实现（状态类接口没有 keyset 的自然键，排序键是派生值）。传了被忽略（不返回 400 —— 前端骨架已带该参数） |
| 其它 | — | 未知参数忽略（前端可能带 `_t` 之类的缓存击穿参数） |

返回 200：`{ items: [...], next_cursor: null, updated_at }`（§1.2 ③；注意：`next_cursor` 本期恒为 null —— 不返回假游标，那会让前端以为要翻页）。每项字段 = 公开字段的超集：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string(uuid) | 内部 ID（仅私有接口可见） |
| `slug` | string | 公开标识（便于与公开页对照） |
| `name` | string | 显示名优先 `display_name`，其次 `name`（与公开侧同一口径） |
| `display_name` | string \| null | 显示名原始列（面板可同时展示两者） |
| `tags` | string[] | 标签 |
| `status` | string | `online` / `offline` / `disabled`（三态齐全；推导规则同公开侧） |
| `os` / `arch` | string \| null | 系统 / 架构（缺失为 `null`；注意：公开侧是"字段缺省"） |
| `uptime` | number \| null | 运行时长（秒） |
| `last_seen_ago` | string \| null | 相对化文案（与公开侧同一函数，两边不得出现不同措辞） |
| `last_seen_at` | string(RFC3339) \| null | 最近上报时间（精确值；公开接口才做分钟级取整） |
| `last_ip` / `reported_ip` | string \| null | 上报来源 IP / Agent 自测出口 IP（双源比对，§8）；注意：`INET` 列经 `host()` 转文本（IPv6 会剥离 `/掩码`） |
| `clock_drift_ms` | number \| null | 时钟漂移（决策 #16/#17）；符号口径 负值 = Agent 慢 |
| `ip_flapping` | boolean | 是否处于 IP 抖动（决策 #39） |
| `flapping_since` | string(RFC3339) \| null | 进入抖动的时间（面板显示"持续多久"） |
| `active_alerts` | number | 当前 `firing` 事件数。注意：当前恒为 0（告警引擎在 M3），查询用 `LEFT JOIN + COALESCE`，不能是 `INNER JOIN`（否则无告警的主机会整体消失） |
| `probes` | object | `{ up, down }`（最近一轮，同公开侧） |
| `snapshot` | object | 当前快照（结构同 §3.2 的 `snapshot`，两边必须是同一个结构，同一张表格组件复用） |

错误：401 `session_expired`（未登录）｜403 `totp_required` / `totp_setup_required`（受限态）｜400 `schema_invalid`（`status` 非法、`limit` 非正整数、`q` 超长/重复参数）

#### `GET /api/v1/summary` — 面板汇总计数（新增）

鉴权：同 `/hosts`（`requireFullSession`）。限流：本期不加专用桶。缓存：不做响应缓存（私有响应的可见性绑在会话上）。

200：与 `GET /api/public/summary`（§3.2）完全同形：`{ total, online, offline, disabled, alerts: {critical,warn,info}, updated_at }`。前端可共用同一个类型。

> 为什么必须单独有这个端点：列表页顶栏要显示「在线 X / 离线 Y / 告警 Z」，而用 `GET /api/v1/hosts` 的返回自己数是错的 ——
> `limit` 一旦截断（默认 20），数出来的只是"这一页里有几台"。两者共用服务端同一个计数实现，故数字不可能不一致。

#### `GET /api/v1/hosts/{id}` — 主机详情

路径参数：`id`（内部 UUID；形状非法 → 400 `schema_invalid`，不让它撞到 SQL 的 `22P02`）。不存在 → 404。

200：= 列表条目（§4.2 上一张表的全部字段，前端同一张表格组件两边复用）+ 纵深字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `host_info` | object \| null | 最近一次的原始 `host` 快照（`hostname`/`os`/`kernel`/`arch`/`boot_time`/`capabilities`）。注意：私有域允许给（排障要用）；公开侧只给 `os` 与 `uptime` |
| `capabilities` | object \| null | 能力声明快照（决定面板展示哪些图表） |
| `current_metrics` | object | 全部序列当前值：键 = 指标全名（含维度，如 `disk.used_pct{mount=/data}`），值 = number \| null。注意：与五槽位 `snapshot` 并存：`snapshot` 给卡片/汇总用，`current_metrics` 给"每核 / 各分区 / 各网卡"的纵深块用 |
| `updated_at` | string | 快照生成时刻（DB 时钟） |

注意：`current_metrics` 只含观测窗口（5 分钟）内有过写入的序列 —— 窗口外的旧序列不返回（不把 5 天前的读数当"当前值"）。

#### `GET /api/v1/hosts/{id}/probes` — 探活历史

查询参数

| 参数 | 说明 |
|---|---|
| `from` / `to` | RFC3339（含时区）或 unix 毫秒/秒；默认 = 最近 24 小时；最大跨度 30 天 → 超出 400 `range_too_large`；不带时区的裸时间串 → 400（猜错时区 = 8 小时数据错位） |
| `name` | 只取某个 probe（≤128） |
| `type` | `ping` / `http` / `https` / `tcp` / `dns`；非法值 → 400 `schema_invalid` |

200：`{ host_id, from, to, truncated, items: [...], updated_at }`，每个 probe 一项：

| 字段 | 说明 |
|---|---|
| `name` / `type` / `target` | 该 probe 的身份（注意：私有域给完整 target，公开侧才脱敏） |
| `availability` | `{ total, up, down, ratio, window_from, window_to }`。注意：`total/up/down` 是整个窗口的统计，不受返回点数截断影响；窗口内无探活时 `ratio: null`（不是 1） |
| `latest` | 最近一次结果 `{ checked_at, up, latency_ms, status_code, error }`（窗口内没有 → `null`） |
| `results` | 时间条数据，按时间倒序，每项同 `latest` 的形状 |
| `truncated` | 该 probe 的点数被上限截断（每 probe 最多 500 点，取最近的） |

错误：401 `session_expired`｜403 受限态｜404 `not_found`｜400 `schema_invalid` / `range_too_large`

#### `GET /api/v1/hosts/{id}/ip-history` — IP 变更时间线

查询参数：`limit`（默认 100、上限 500，两个列表各自适用；超限夹取）。

200：`{ host_id, current_ip, reported_ip, ip_flapping, flapping_since, intervals: [...], events: [...], updated_at }`

| 字段 | 说明 |
|---|---|
| `current_ip` / `reported_ip` | 取自 `agents` 行（与列表同源），不从区间表反推 |
| `intervals[]` | IP 出现区间：`{ ip, source, first_seen, last_seen }`；注意：同一地址不同 `source`（`remote` / `agent_reported`）是两行——那是"双源比对"的基础数据 |
| `events[]` | 变化/Flapping 事件：`{ old_ip, new_ip, same_subnet, changed_at, source, kind, change_count, subnet_prev, subnet_next }`，按时间倒序；`kind='flapping'` 表示"进入抖动"这一事件本身 |

注意：两个列表语义不同（区间是聚合的、事件是逐次的），前端不要把两者按行对齐。

#### `GET /api/v1/hosts/{id}/processes` — 进程 Top 快照

查询参数：`at`（RFC3339 或 unix 毫秒；省略 = 最近一条）。注意：语义是「该时刻之前最近的一条」——采样是周期性的，要求时间戳严格相等等于永远查不到；`at` 在未来 → 400 `schema_invalid`（否则会被误读成"数据缺失"）。

200：`{ host_id, at, total, top, updated_at }`。
注意：没有采集到（超出 30 天保留期 / 从未上报进程）时 `at` / `total` / `top` 同时为 `null` —— 与"那一刻确实没有进程"（`total: 0, top: []`）必须能区分。

#### `GET /api/v1/hosts/{id}/metrics` — 时序查询

见 §4.3（该节有完整的查询参数、档位约束与响应格式）。

> 注意：已作废的旧草案：本节原先还给 `/{id}/probes`、`/{id}/ip-history`、`/{id}/processes`
> 写过一版形状（`{probes, current}` / `{ranges, events}` / `{ts, total, top}`）。那三版已在上述契约取代
> （分组 + 可用率、区间/事件双列表 + 当前 IP、`at`/`total`/`top` 三态可空）。不要再沿用旧字段名。

### 4.3 时序查询 `GET /api/v1/hosts/{id}/metrics`（已实现；参数全部定稿，决策记录见 `docs/api-status.md` §4.8）

查询参数

| 参数 | 必需 | 说明 |
|---|---|---|
| `metrics` | | 逗号分隔，元素可为基名或全名：`cpu.usage,mem.used_pct,disk.used_pct`（基名 = 该基名下全部维度序列，如所有挂载点）或 `disk.used_pct{mount=/data}`（全名 = 单一序列）。元素个数上限 20（去重后；超限 → 400 `schema_invalid`，`details.field='metrics'`），与下面两道闸门的"展开后条数"是两回事。命名与转义规范见 `docs/database.md` §5.7.2（已定：维度写进指标名） |
| `from` / `to` | | 时间范围 |
| `step` | 未实现 | `auto`（默认）/ `30s` / `1m` / `5m`。没有 `15s`：Agent 默认上报周期是 30s，比它还细的网格会让每两个桶空一个，看起来像"一直在丢采集" |
| `agg` | 未实现 | `avg`（默认）/ `max` / `min` / `last`。四者在降采样层都是预先算好的列（`v_avg`/`v_min`/`v_max`/`v_last`），没有额外成本 |
| `include_n` | 未实现 | `true` / `false`（默认 false）。为 true 时点是 `[ts, value, n]`，`n` = 桶内样本数 |

基名展开的实现口径（已定）：`metric = :base` 或区间命中 `metric >= base || '{' AND metric < base || '}'`。
不用 `LIKE 'base{%'` —— `_` 在 LIKE 里是单字符通配符，而本项目基名大量使用下划线（`used_pct` / `rx_bps` / `ctx_switch`），会造成潜在的匹配污染。

注意：`metrics` 的分隔符只认花括号之外的逗号：序列全名的维度分隔符本身就是逗号，
所以 `disk.used_pct{device=sda1,mount=/data}` 算一个元素；维度值里若真需要逗号，按 `docs/database.md` §5.7.2 必须写成 `%2C`。
（这是"逗号分隔"与"命名规范"撞车撞出来的，实现时踩到过一次，已用回归用例钉住。）

档位与范围约束（已定：最长 30 天，不做跨表再聚合）

| step | 数据源 | 一格多长 | 允许的最大范围 | 一条线最多多少点 |
|---|---|---|---|---|
| `30s` | `metrics_raw` | 30s（= 上报周期） | ≤ 24 小时 | 2,880 |
| `1m` | `metrics_1m` | 60s | ≤ 7 天 | 10,080 |
| `5m` | `metrics_5m` | 300s | ≤ 30 天 | 8,640 |

全局上限 30 天（系统对外只承诺这么长的历史）。超过该档上限或全局上限 → 400 `range_too_large`，`details` 带 `step` / `max_span_s` / `span_s`。

`step=auto` 的规则（已定）：选最细的一档使点数 ≤ 2000，都不满足就用最粗的 `5m`；响应里回传实际用的 step。
这条规则恰好等于产品上那 5 个预设按钮 —— 所以前端只传 `from`/`to` 即可，不需要再加 `window=1h` 之类的预设参数：

| 前端按钮 | 实际档位 | 点数 |
|---|---|---|
| 1 小时 | `30s` | 120 |
| 6 小时 | `30s` | 720 |
| 24 小时 | `1m` | 1,440（`30s` 会是 2,880，超目标） |
| 7 天 | `5m` | 2,016（`1m` 会是 10,080） |
| 30 天 | `5m` | 8,640（已经是最粗档） |

两道闸门（已定；超限一律 400，绝不截断）

| 闸门 | 限制 | 换算成用户看得见的东西 |
|---|---|---|
| A | 展开后序列数 ≤ 20 | 一个 `disk.used_pct` 在 30 个挂载点的机器上会展开成 30 条线 |
| B | 序列数 × 桶数 ≤ 50,000 | 1 小时～7 天档都是"最多 20 条"，只有 30 天档是 5 条（8,640 × 5 = 43,200，最坏响应 ≈1MB） |

超限 → 400 `too_many_series`，`details` 带 `reason`（`series_limit` / `point_budget`）、
`max_series_at_this_range`（本范围下最多能选几条，前端据此限制维度勾选框）与 `hint`。
不截断：悄悄少画几条线在图表上完全看不出来，是最难排查的一类错误。
注意：闸门判定先于取数（先只取"展开后的序列名"，`LIMIT 上限+1`）—— 否则 30 × 8640 个点已经白捞回来了。

响应（已定格式，适配 ECharts）

```json
{
  "host_id": "9f1c2e4a-…",
  "step": "1m",
  "agg": "avg",
  "from": "2025-09-25T00:00:00.000Z",
  "to": "2025-09-25T06:00:00.000Z",
  "series": [
    { "metric": "disk.used_pct{device=sda1,mount=/data}", "base": "disk.used_pct",
      "labels": { "device": "sda1", "mount": "/data" }, "unit": "%",
      "points": [[1758758400000, 12.3], [1758758460000, 13.1]] }
  ],
  "updated_at": "2025-09-25T06:00:03.000Z"
}
```

- `step` = 实际使用的档位（`step=auto` 时由服务端选定）；`agg` = 实际使用的聚合方式。
- 注意：`from` / `to` 回显的是对齐到桶边界之后的时间（下界向下取整、上界向上取整）。前端画横轴请直接用这两个值，不要用请求里那个，否则会差一格。
- `metric` = 权威序列全名；`base` = 基名（前端按它分组）；`labels` = 由全名反解出的维度对象（不等同于公开视图的脱敏要求——这里已登录）；`unit` = 由 `unitOf(base)` 推出，未知基名为 `null`。
- `points` 用 `[ts_ms, value]` 二元数组压缩体积，`ts` 是桶起点（UTC 对齐、毫秒）；缺失桶既不补 0 也不补 null，只是不出现，由前端按空档断线（补 0 会把"采集断了"画成"CPU 掉到 0"）。
- `n`（桶内样本数）用 `?include_n=true` 返回，此时点是 `[ts_ms, value, n]`，供前端标注数据完整度（`docs/frontend.md`）。
- 指标名合法、但这台机在窗口内没有这条序列 → 200 + `series: []`（不是 404：「这台机没有 GPU」不是客户端的错）。

### 4.4 Agent 与凭证管理（需登录，全部仅 `admin`）

> `POST /api/v1/agents` 已实现；列表 / 详情 / `PATCH` / `rotate` / `disable` / `enable` / `revoke` / `rotate-reminder/test` 尚未实现（列表字段与"吊销语义"两处待定稿，见 `docs/api-status.md` §4.7）。
> 本节任何响应都不得出现 `agent_key_hash` / `agent_secret_hash` / `agent_secret_enc`；明文凭证只在创建与轮换的响应里出现一次。
> 通用约定：全部端点需 `requireFullSession`（受限态 → 403 `totp_required` / `totp_setup_required`）+ `requireRole('admin')`（非 admin → 403 `role_denied`）+ 写请求 CSRF；审计动作 `agent.*`。

#### `GET /api/v1/agents` — Agent 列表

查询参数：无（待定：可按 `status` 过滤，待实现时定）。

返回 200：`{ items: [...], rotate_policy }`（§1.2 ③），每项字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | string | `active` / `disabled` / `revoked` |
| `rotated_at` | string(RFC3339) \| null | 最近一次凭证轮换时间 |
| `credential_age_days` | number | `now() - COALESCE(rotated_at, created_at)` 的天数 |
| `rotate_recommended` | boolean | 是否超阈（已定：列表徽标） |
| `last_seen_at` | string(RFC3339) \| null | 最近上报时间 |
| `last_ip` | string \| null | 最近上报 IP |

响应根级另附 `rotate_policy`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `rotate_policy` | object | `{ days, notify }`，由 `settings` 的 `credential_rotate.*` 派生；前端不硬编码阈值 |

#### `POST /api/v1/agents` — 创建 Agent（已实现）

权限：`requireFullSession` + `requireRole('admin')` + CSRF。审计：`agent.create`（target = `name`，detail 只含 `agent_id`/`public_slug`/`tags`，不含凭证）。

请求体

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | | 唯一；1–128 字符（trim 后非空、不允许控制字符）；重名 → 409 `already_exists`（`details.field='name'`） |
| `display_name` | string | 可选 | ≤128；空串按"未提供"处理（→ `null`） |
| `tags` | string[] | 可选 | ≤32 个，每项 1–32 字符；重复项 → 400（重复标签会让"按标签筛选"失去意义） |

成功 201

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string(uuid) | 内部 ID（Agent 上报时用作 `X-Agent-Id` 与 body 的 `agent_id`） |
| `name` / `display_name` / `tags` | — | 回显（面板可直接渲染结果行，无需再查列表） |
| `public_slug` | string | 公开标识（与内部 UUID 无关，见 §3.1） |
| `status` | string | 注意：连接状态，新 Agent 恒为 `offline`（不是"凭证已启用"那种口径） |
| `created_at` | string(RFC3339) | |
| `agent_key` | string | `vk_` 前缀；身份用（上报时放 `X-Agent-Key`）；仅此一次返回 |
| `agent_secret` | string | `vs_` 前缀；签名用（算 HMAC，不上行）；仅此一次返回 |
| `install_hint` | object | 一键安装提示，见下 |

`install_hint` 的形状（与本节初稿的 `string` 不同：前端要分三段展示 + 一条风险提示）

| 字段 | 类型 | 说明 |
|---|---|---|
| `center_url` | string | `--center` 用的中心地址：优先 `PUBLIC_ORIGIN`，未配置时按当前请求推导（并在 `warnings` 里提醒去配置） |
| `script_url` | string \| null | `AGENT_INSTALL_SCRIPT_URL`（`vantage.sh` 的下载地址） |
| `one_liner` | string \| null | 形式①：`VANTAGE_KEY=… VANTAGE_SECRET=… sh -c 'curl … \| sudo -E sh -s -- install --center … --agent-id …'`（注意：含明文凭证、会进 shell history） |
| `interactive` | string \| null | 形式②：交互式 / stdin（最安全，不含凭证） |
| `key_file` | string \| null | 形式③：`--key-file /etc/vantage/agent.key --secret-file /etc/vantage/agent.secret`（长期方案） |
| `security_note` | string | 风险与善后（history / `/proc/$PID/environ` / 建议 `unset` + `history -d`）。注意：面板必须展示 |
| `warnings` | array | `[{ code, message }]`；目前两种：`install_script_not_configured`、`center_url_not_https` |

注意：未配置 `AGENT_INSTALL_SCRIPT_URL` 时：`script_url` 与三个命令字段全为 `null`，并给出 `install_script_not_configured` 警告。
绝不返回带 `<mirror>` 占位符的假命令 —— 一条会 `curl` 到错误地址、还被 `sudo sh` 执行的命令，比"没有命令"危险得多。
注意：三种形式永远不出现 `--key <明文>` / `--secret <明文>`（`ps` / `/proc/$PID/cmdline` 对同机低权用户可见，决策 #37 永久红线）。

错误：400 `schema_invalid`（字段类型/长度/白名单/重复标签）｜401 `session_expired`｜403 `totp_required` / `totp_setup_required` / `role_denied` / `csrf_invalid`｜409 `already_exists`（重名）

> 上线闭环（`docs/agent.md` §12.3）：面板建 Agent（本端点）→ 复制一键命令到宿主机执行 → 首次上报成功（面板出现该机与首次 IP）→ 按需编辑 `config.yaml`（探活/采集/频率）→ 配置告警通道。

#### `GET /api/v1/agents/{id}` — 元信息

返回 200：Agent 元信息；不含任何明文凭证或哈希值。

#### `PATCH /api/v1/agents/{id}` — 改显示名 / 标签

请求体：`{ display_name?, tags?, name? }`——`name` 变更同样要过唯一性校验（重名 → 409 `already_exists`）。
返回 200：更新后的元信息。

#### `POST /api/v1/agents/{id}/rotate` — 手动轮换凭证

请求体：无。
返回 200：结构同创建（`{ id, public_slug, agent_key, agent_secret, install_hint }`，明文仅一次）。
语义：旧凭证立即失效（无并存过渡期）；中心无法下发新 key，管理员须自行上机替换 key 文件后 `reload`/`restart`（`docs/agent.md` §6）；替换窗口内该机上报 401 → 会被判离线并触发告警。

#### `POST /api/v1/agents/{id}/disable` \| `/enable` — 禁用 / 启用

请求体：无。语义：禁用后该 Agent 上报一律 401 `agent_unknown_or_disabled`。

#### `POST /api/v1/agents/{id}/revoke` — 吊销

请求体：无。语义：不可恢复；`disabled_at` 落库，历史数据保留。

到期提醒（已定：不自动轮换，只提醒）

- 面板：列表/详情展示 `credential_age_days` + `rotate_recommended` 徽标（前端见 `docs/frontend.md`）。
- 阈值可配（已定）：`credential_rotate.reminder_days`（存 `settings` 表，面板可改、立即生效，默认 90 天），面板徽标与服务端通知共用同一阈值；`GET /api/v1/agents` 响应根级附带 `rotate_policy: { days, notify }`，由后端下发、前端不硬编码。
- 通知：core 每日一次扫描超阈 Agent → 复用 `channels` 通道提醒管理员（决策 #23），`rotate_reminder_at` 按日期去重、未处理则次日继续；提醒内容不含任何凭证；不存在「自动轮换」开关。
- 已定：新增 `POST /api/v1/agents/{id}/rotate-reminder/test`（手动触发一次提醒，便于在真到点之前确认通道配通）——与 `POST /channels/{id}/test` 同性质，纳入 M3 验收。

> 决策 #37 修订（已定）：设计 §12.3 要求「生成 key → 拼装成安装命令」，§12.2/决策 #37 又「禁用命令行传 key」。裁定为——
> 1. 面板默认给出一条带 key 的一键命令，使用 `VANTAGE_KEY=<key>` 环境变量内联形式（并同时给出交互式/stdin 与 `--key-file` 两种更安全形式，供用户二选一）；
> 2. 面板同时单独展示一次 `agent_key` / `agent_secret` 明文（便于手工写入受限文件）；
> 3. 仍然禁止 `--key <明文>` 参数形式（`ps` / `/proc/$PID/cmdline` 对同机低权用户可见）；
> 4. 注意：面板必须标注风险与善后：env 形式会进 shell history，root 可读 `/proc/$PID/environ`；脚本落地后即时 `unset`，建议用户 `history -d` 清理或改用 `--key-file`；
> 5. 已同步：设计文档 v0.8 的 §12.2、§13 安全清单与决策 #37 已按此措辞修订（`docs/agent.md` §6.1/§12.1 亦已同步）。
> 6. 轮换接口（`POST /api/v1/agents/{id}/rotate`）返回结构同上（同样给一键命令 + 明文各一次）。

### 4.5 告警规则（§7.1：受控阈值 DSL，零 RCE）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/alert-rules` | 列表（`?enabled=&kind=`） |
| POST | `/api/v1/alert-rules` | 创建，见下 |
| GET/PATCH/DELETE | `/api/v1/alert-rules/{id}` | 读/改/删 |
| POST | `/api/v1/alert-rules/{id}/dry-run` | 待定：对最近历史数据试算，返回「若启用会触发几次」（不发送通知） |

请求体字段（§7.1）

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 规则名 |
| `target` | object | `{ agents: [id] }` / `{ tags: [..] }` / `{ all: true }` |
| `kind` | string | `threshold` / `offline` / `ip_change` / `probe` / `clock_drift` |
| `metric` | string | 仅 `threshold`：基名或全名（`docs/database.md` §5.7.2）——已定：基名＝对该基名下每个维度序列分别判定（每个挂载点各判一次，各自产生事件），全名＝只判该单一序列；UI 的「全部维度/指定维度」开关直接映射为传基名/传全名，不新增 `dimension_mode` 字段 |
| `op` | string | 仅 `threshold`：`>` `>=` `<` `<=` |
| `threshold` | number | 阈值 |
| `duration` | int | 持续时长（秒），§7.1 `for` |
| `severity` | string | `info` / `warn` / `critical` |
| `channels` | string[] | 已定：通道 id 数组（引用 `channels.id`，见 `docs/database.md` §5.4）；通道是凭证/模板的唯一归属方，规则不内联通道参数；通道 `enabled=false` 时保留关联但跳过发送（`notification_log` 记 `channel_disabled`） |
| `cooldown` | int | 静默期（秒） |
| `enabled` | bool | 开关 |
| `params` | object | 已定：非阈值类规则的参数统一放这里、按 `kind` 白名单校验（未知键 → 400 `schema_invalid`）：`probe{probe_name?,probe_type?,cond,latency_ms?,status_codes?}` / `ip_change{mode:any\|subnet\|frequent,window_s?,changes?}` / `offline{cycles?}` / `clock_drift{threshold_ms?}`；阈值类传 `{}`。完整规格见 `docs/database.md` §5.11 |
| `expr` | string/null | 扩展位；本期必须为 `null`，传非空 → 400 `expr_not_allowed`（零 RCE，§7.1） |

校验规则：`kind`/`op`/`severity` 枚举校验；`threshold` 数值范围（如 `-1e12 ~ 1e12`）；`duration ≥ 0`；`cooldown ≥ 0`；`target` 三种形态互斥；任何字段含脚本/表达式语义一律拒绝。

> 静默窗口 / 维护期（§7.1）单独见 §4.7 `silences`。

### 4.6 告警事件与通知通道

> 全部 未实现（M3）。

#### `GET /api/v1/alert-events` — 告警事件列表

查询参数

| 参数 | 说明 |
|---|---|
| `status` | `firing` / `resolved` |
| `severity` | `info` / `warn` / `critical` |
| `agent_id` / `rule_id` | 按主机 / 规则过滤 |
| `metric` | 按触发序列全名过滤 |
| `from` / `to` | 时间范围 |
| `limit` / `cursor` | 见 §1.2 ③ |

返回 200：`{ items: [...], next_cursor }`（§1.2 ③），每项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `metric` | string | 触发序列全名（已定：同一规则在不同挂载点/网卡上各自成条） |
| `value` | number | 触发时的值 |
| `started_at` | string(RFC3339) | 触发时间 |
| `resolved_at` | string(RFC3339) \| null | 恢复时间 |
| `notified_at` | string(RFC3339) \| null | 最近一次通知时间 |

> 已定：不引入事件 `ack`（认领）语义——"别再报"用静默窗口/维护期（§4.7）与规则 `cooldown` 覆盖；不加 ack 字段与按钮。
> 前端可用 `labels` 把全名渲染成可读名（`docs/frontend.md`）。

#### `GET /api/v1/alert-events/{id}` — 事件详情

返回 200：事件本体 + `notification_log` 数组（该事件的各次发送结果，§7.3）。

#### `GET /api/v1/channels` — 通知通道列表

返回 200：数组；敏感字段（SMTP 密码、加签 secret、Webhook token）只回遮罩值（如 `smtp_pwd: "****"`）。

#### `POST /api/v1/channels` — 创建通道

请求体：`{ kind, name, config, template, rate_limit?, enabled }`，`kind` ∈ `smtp` / `wecom` / `dingtalk` / `feishu` / `webhook`（§7.2）。
返回 201：创建后的通道（敏感字段同样遮罩）。

#### `PATCH /api/v1/channels/{id}` — 更新通道 ｜ `DELETE /api/v1/channels/{id}` — 删除通道

- PATCH：`config` 采用部分更新——未提交的敏感字段保持原值（不会因为"前端没回填密码"而被清空）。
- DELETE：仍被规则引用 → 409 `channel_in_use`（须先解绑，不级联删规则）。

#### `POST /api/v1/channels/{id}/test` — 发送测试消息

请求体：无（或可选测试文案）。
返回 200：`{ ok, error? }`；结果同时记入 `notification_log`（「可测发送」）。

#### `GET /api/v1/notification-log` — 发送记录（排障）

查询参数（待定）：`event_id` / `channel` / `ok` / `from` / `to`。

### 4.7 静默窗口 / 维护期（§7.1）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/silences` | `?active=true` 过滤生效中 |
| POST | `/api/v1/silences` | `{name, target, starts_at, ends_at}`（`target` 与规则同构） |
| DELETE | `/api/v1/silences/{id}` | 取消 |

### 4.8 审计日志（§13，需登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/audit-logs` | `?from&to&actor=&actor_type=&action=&target=&limit&cursor` → `{ items: [{id, actor, actor_type, action, target, ip, detail, ts}] }`（`detail` 已脱敏；查询参数集待定） |

### 4.9 权限（RBAC，已定：暂时两级）

| 角色 | 允许 |
|---|---|
| `user`（普通用户） | 全部 GET（含历史曲线、IP 变更、进程 Top、审计日志、告警事件） |
| `admin`（管理员） | `user` 的全部读权限 + 告警规则/通道/静默 的写操作 + Agent 创建/轮换/禁用/吊销 + 用户管理（分配 `role`）+ `public_view.enabled` 开关 |

- 决策：本期只有这两级（`users.role` 单值字段，见 `docs/database.md` §5.3）；原设计的「只读/运维/管理员」三级暂不实现——需要时再扩（届时权限判定改为角色集合判定，接口形态不变）。
- 已定：`user`（普通用户）纯只读——所有写操作仅 `admin`；不需要为「降级只写告警配置」之类的中间态设计权限（`docs/database.md` §5.3）。
- 越权 → 403 `role_denied` + 写审计；前端按 `role` 隐藏写按钮（`docs/frontend.md`）。
用户管理端点（待定：仅 `admin` 已定，字段级契约在 M3 定稿；决议索引 `docs/api-status.md` §5.2）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/users` | 用户列表（含 `role`/`status`/`totp_enabled`/`recovery_codes_left`；不含 `password_hash`/`totp_secret_enc`） |
| POST | `/api/v1/users` | 创建用户（`{ username, password?, role, display_name?, email? }`） |
| PATCH | `/api/v1/users/{id}` | 改 `role` / `display_name` / `status` |
| POST | `/api/v1/users/{id}/password-reset` | 重置他人密码（明文不回显） |
| POST | `/api/v1/users/{id}/2fa/reset` | 已定（恢复渠道二）：清空目标用户 `totp_enabled=false`、`totp_secret_enc=NULL`，作废其全部恢复码，强制踢下线该用户所有会话，写审计（`action=user.2fa_reset`）；不允许经该接口读取或导出任何 TOTP 密钥；前端须二次确认（输入用户名） |

> 注意：上表除 `2fa/reset` 外均为待定，请求/返回字段集在 M3 实现时定稿；任何用户接口都不得返回 `password_hash` / `totp_secret_enc`。

### 4.10 系统设置 `settings`（已定：面板可改、立即生效）

> 未实现（M3）。`user` 角色可读，仅 `admin` 可改。

#### `GET /api/v1/settings` — 读取全部设置项

请求参数：无。

返回 200：`{ items: [...] }`（§1.2 ③），每项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 白名单 key（见下表） |
| `value` | 任意 | 当前生效值 |
| `type` | string | 该 key 的类型（`bool` / `int`），供前端渲染控件 |
| `default` | 任意 | 代码默认值 |
| `updated_by` | string(uuid) \| null | 最近一次修改者 |
| `updated_at` | string(RFC3339) \| null | 最近一次修改时间 |

#### `PATCH /api/v1/settings` — 修改设置项（仅 `admin`）

请求体：部分更新对象，键为白名单 key，例如 `{ "public_view.enabled": false, "credential_rotate.reminder_days": 60 }`。

返回 200：更新后的全量设置集合（结构同 `GET`）；立即生效（无需重启）。

错误

| 状态 | code | 触发 |
|---|---|---|
| 400 | `unknown_setting` | key 不在白名单（未登记 key 一律拒绝） |
| 400 | `invalid_setting_value` | 值的类型不符合该 key 的定义 |
| 403 | `role_denied` | 非 `admin` |

白名单与默认值（与 `docs/database.md` §5.4 一致）

| key | 类型 | 默认 |
|---|---|---|
| `public_view.enabled` | bool | true（已定） |
| `security.require_2fa` | bool | false |
| `credential_rotate.reminder_days` | int | 90 |
| `credential_rotate.notify` | bool | true |
| `security.login_captcha.enabled` | bool | true（S 系列：开启＝"密码错后要求滑块"；关闭时取题端点 404） |
| `security.login_captcha.after_failures` | int | 1（S 系列：失败几次后开始要求，1–10；1 = 一次密码错就要） |

- 每次变更写审计（`action=settings.update`，`detail` 含 key/旧值/新值，不含密钥）。
- 该接口不承载通道密钥、TOTP 密钥等任何敏感值（分别在 `channels` / 用户 2FA 接口）。
- 待定：变更后向在线 WS 广播 `delta{channel:"settings"}`，让已打开的面板即时刷新。
- `/api/v1/agents` 响应里的 `rotate_policy` 即由 `credential_rotate.*` 派生（`docs/frontend.md` §4.6）。

---

## 5. WebSocket 协议（§18.2、决策 #33）

### 5.1 频道与握手

> 两个频道均已实现，分三层：`server/src/ws/hub.js`（订阅中心，纯单测）、`server/src/ws/fanout.js`（订阅 `live:metrics` → 广播）、`server/src/routes/ws.js`（握手 + 快照 + 保活）。测试落点：`server/test/ws.hub.test.js`（15 例）、`server/test/ws.api.test.js`（8 例，真开端口、真连接）；决策 H1–H9 见 `docs/api-status.md` §4.9。

| 频道 | 鉴权 | 内容 |
|---|---|---|
| `/ws/public` | 免登录 | 只读、脱敏（无 IP/内网/历史/进程），严格限流 |
| `/ws/live` | 需登录（Cookie `sid`，且 `totp_ok=true`） | 全量（历史/详情所需字段） |

- 握手校验 `Origin` 白名单（防跨站 WS 劫持）；`/ws/live` 校验 Cookie 会话有效性。
- 反代需放行 `Upgrade` / `Connection: upgrade`，且读超时 > 保活间隔。
- 限流分两层，缺一不可：
  - 握手速率：桶 `ratelimit:ws:<ip>`，默认 30 次/分钟（`RATELIMIT_WS_HANDSHAKE_PER_MINUTE`）—— 防"反复连-断"刷服务端握手与鉴权开销；
  - 并发连接数：每 IP 默认 3 条（`RATELIMIT_WS_CONCURRENT_PER_IP`）—— 防"一个 IP 挂一堆连接把内存吃光"。
  注意：只做其中一个都会留下明显缺口（只限速率挡不住"慢慢连 1000 条"，只限并发挡不住连断风暴）。
  注意：并发数是进程内计数（按已登记连接）：多实例部署时实际上限 = 每实例 N 条。之所以不落 Redis —— 连接数这种"随连接生灭"的计数用 INCR/DECR 极易在进程崩溃时泄漏，泄漏的后果是某个 IP 被永久挡住，比"上限略宽"严重得多。
- Origin 不匹配 → 403 `origin_denied`（不复用 `csrf_invalid`：两者防的是不同攻击，合并会让排障时分不清该查 Cookie 还是查 `PUBLIC_ORIGIN`）。
  注意：请求不带 `Origin` 时放行：Origin 校验唯一能挡的是浏览器（防"别的站点用受害者的 Cookie 偷偷开一条 WS"），而脚本/curl 本来就能伪造任何头，对它们校验毫无意义 —— 这种情况交给会话鉴权把关。

### 5.2 消息格式（语义来自 §18.2；决策记录见 `docs/api-status.md` §4.9）

消息类型总表（客户端→服务端只允许 `subscribe` 一种应用层消息）

| 方向 | `type` | 时机 | 关键字段 |
|---|---|---|---|
| 服务端 → 客户端 | `snapshot` | 连接建立后立即推全量 | `ts`、`hosts[]`、`summary` |
| 客户端 → 服务端 | `subscribe` | 连接后按需订阅 | `channels[]`（缺省＝全部）、`agents[]`（`["*"]` 或具体 id） |
| 服务端 → 客户端 | `delta` | 上报落库后增量广播 | `channel` + 各频道字段（`metrics`/`status`/`probes`/`alerts`） |

连接建立后服务端立即推送全量快照

```json
{ "type": "snapshot", "ts": 1758800000123, "channels": ["metrics","status","probes","alerts"],
  "hosts": [ { "id": "...", "slug": "...", "status": "online", "snapshot": { "...": "..." } } ],
  "summary": { "total": 5, "online": 4, "offline": 1, "disabled": 0, "alerts": { "critical": 0, "warn": 0, "info": 0 } },
  "updated_at": "2026-10-05T12:00:00.000Z" }
```

- 已定：`hosts[]` 就是对应 REST 列表端点的 `items`（面板用 `GET /api/v1/hosts` 的形状、公开用 `GET /api/public/hosts` 的形状），`summary` 同理（`GET /api/v1/summary` / `/api/public/summary`）。
  理由：前端同一张表格两个数据来源，形状不一致就得写两套渲染。
- 已定：连接先登记、快照发出后才允许收增量（服务端内部有个"就绪"标志）—— §5.3「先 snapshot 后 delta」由构造保证，不靠"快照先发、广播后到"的时序运气（那在负载高时会偶发"先收增量、后收快照"，前端表现为列表被增量覆盖成残缺状态且难复现）。

客户端 → 服务端（已定：应用层只允许 `subscribe`）

```json
{ "type": "subscribe", "channels": ["metrics","status","probes","alerts"], "agents": ["*"] }
```

- 已定：应用层只接受 `subscribe`（`agents: ["*"]` 或具体 id 数组，≤ 200 个；`channels` 缺省或空数组＝全部）。它只影响本连接收到哪些 delta，不携带任何指令语义。
- `channels[]` 的取值集合就此定死为四个（面板连接）：`metrics` / `status` / `probes` / `alerts`；公开连接只能订 `status`。
  - 没有 `hosts` 频道：主机是管理员在面板上创建的，不会因为 Agent 上报而"冒出来" —— 它属于快照，不是增量。主机列表"动起来"靠的是 `status`（某台上/下线）与 `metrics`（某台数字变了）。契约初稿的订阅示例里写过 `hosts`，那是个错误（照抄它的前端会漏订 `metrics`/`status`，实时功能全哑但连接看起来完全正常）。
  - `alerts` 暂时收不到任何东西（告警引擎 = M3，尚无可生产者）。它在白名单里，属于"合法但安静"。
- 未知频道 / `agents` 元素不是 UUID / 超过 200 个 → 立即关连接（`1008`）+ 记审计 `ws.protocol_violation`，不静默忽略。
  理由：静默忽略会把"`metrics` 拼成 `metric`"变成静默失效（连接正常、日志空白、就是不刷新）；这与"默认拒绝、大声失败"的既有口径一致（同一条规则也作用于非 `subscribe` 的消息）。
- 保活走协议层帧：服务端定时发送 WebSocket ping 帧（RFC 6455），浏览器自动回 pong 帧（JS 不参与，无需应用层消息）；服务端用 `ws` 库的 `pong` 事件判活。这样客户端→服务端的应用层消息面收敛为一条。
- 收到任何非 `subscribe` 的应用层消息 → 立即关闭连接（`1008 policy violation`）并记审计；这是「WS 不得成为下发通道」在协议层的最小化落实（§18.3）。

服务端 → 客户端增量 delta（单机/单指标粒度）

```json
{ "type": "delta", "ts": 1758800015000, "channel": "metrics",
  "agent_id": "...", "metrics": { "cpu.usage": 12.4, "mem.used_pct": 63.2 } }
{ "type": "delta", "channel": "status", "agent_id": "...", "status": "offline", "last_seen_at": "..." }
{ "type": "delta", "channel": "probes", "agent_id": "...", "probe": { "name": "site-health", "up": false } }
{ "type": "delta", "channel": "alerts", "event": { "id": 1, "rule_id": "...", "severity": "warn", "status": "firing" } }
```

> 服务端→客户端不做应用层 ping；保活由协议层帧完成（见上），因此这条消息类型表里不存在 `ping`/`pong`。

- `metrics` / `status` / `probes` 三个频道已经在发（生产者：`ingest.service.js` 的上报落库扇出、`cron.service.js` 的离线扫描扇出 —— 两者走同一 Redis 频道 `live:metrics`、同一形状）。WS 层对面板连接原样转发、不翻译：生产者的形状由各自的测试钉住，在 WS 层重新编码就等于有了第二份实现，两边迟早漂移。
- `alerts` 目前没有生产者（告警引擎是 M3）。它留在白名单里，属于"合法但安静"。
- 注意：`/ws/public` 的 `delta` 形状与上表不同（这是刻意的不对称）：

  ```json
  { "type": "delta", "channel": "status", "ts": 1758800015000,
    "host": { "slug": "...", "name": "web-01", "display_name": null, "status": "offline",
              "last_seen_ago": "3 分钟前", "last_seen_at": "2026-10-05T11:57:00.000Z" } }
  ```

  - `host` = 公开列表条目的形状（服务端收到 `status` delta 后重新取一次公开列表、只推那一台）。
  - 绝不原样转发：原始 delta 里的指标全名带 `device`/`mount`，转发给匿名访客等于把磁盘与挂载点全泄露出去。公开侧也只推 `status`（不推 `metrics`/`probes`/`alerts`）。
  - 注意：没有公开连接时服务端完全不做这次查库（先判"有没有公开连接"再取数）；公开列表本身还有 10s 响应级缓存。
  - 注意：公开视图（`public_view.enabled`）在连接存续期间被关闭 → 服务端主动断开全部公开连接（与 REST 侧的 404 同义，不 fail-open）。

### 5.3 语义约束

| 项 | 约定 |
|---|---|
| 扇出 | Agent 上报 → 落库 → `PUBLISH live:metrics`（Redis Pub/Sub）→ 各 WS 连接广播（§18.2；Pub/Sub 不持久化，与「不补传」一致） |
| 顺序 | 先 `snapshot` 后 `delta`；掉线期间的 delta 不补（无断点续传） |
| 保活 | 服务端定时发协议层 ping 帧；超时未收到协议层 `pong` 帧即断开并清理（已定） |
| 重连 | 前端指数退避重连，重连成功即重新拉全量快照（） |
| 脱敏 | `/ws/public` 的 `snapshot` 就是 `GET /api/public/hosts` 的形状；`delta` 是"重新取一次公开列表、只推那一台"的脱敏条目（见 §5.2）。绝不原样转发 `live:metrics` 的 payload —— 里面的指标全名带 `device`/`mount`，转发给匿名访客等于把磁盘与挂载点全泄露出去 |
| 保活方向 | 服务端发协议层 ping 帧；客户端不必也不该发应用层心跳（浏览器看不到 ping/pong 帧，前端不得把"长时间没有应用层消息"当成断线去重连 —— 安静是常态，真断线由 `onclose`/`onerror` 负责） |
| 多实例 | 因走 Pub/Sub，core 多实例/多 worker 零改动（） |

---

## 6. 验收用例（联调必跑）

### 6.1 Agent 上报链路（必须覆盖）

1. 正常：合法签名 → 200 `{ok:true, server_ts}`，PG 出现该批数据，`agents.last_seen_at` 更新，`live:metrics` 有 PUBLISH。
2. 重复批次：同 `batch_id` 连发 2 次 → 第二次不入库、仍 200，行数不变（决策 #18）。
3. 篡改 body：改 1 字节 → 401 `signature_invalid`（验签在 `JSON.parse` 之前）。
4. nonce 重放：同 nonce 不同 body → 409 `nonce_reused`；600s 后同 nonce 可再用（决策 #36）。
5. 时间越窗：`ts` 偏 6 分钟 → 401 `timestamp_skew`（> 5min 硬上限，任何模式）；偏 2 分钟 → 默认模式接受并产生 `clock_drift` 告警（决策 #17）。
6. zip bomb / 超大包：解压输出超上限 → 413，且不进入 JSON.parse（§6.6）。
7. schema 越界：多加一个未声明字段 → 400 `schema_invalid`（白名单）。
8. 跨机越权：`agent_id` 用别的 Agent → 400 拒绝 + 审计（§6.4）。
9. IP 变化：换 IP 上报 → `ip_change_events` 新增 1 条；10 分钟内变化 > 3 次 → 只记 1 条 `flapping` 且不触发 IP 变化告警（决策 #39）。
10. 响应体纯净：断言响应 JSON 的键集合恰为 `{ok, server_ts}`（单向宗旨回归用例，§13）。

### 6.2 面板链路（必须覆盖）

1. 未登录访问 `/api/v1/hosts` → 401 `session_expired`（已覆盖：`server/test/hosts.api.test.js`）。
2. 登录 + 2FA 未完成时访问业务接口 → 403 `totp_required`（`setup_required` → 403 `totp_setup_required`）。
3. 状态变更缺 `X-CSRF-Token` → 403 `csrf_invalid`。
4. 登录成功 / 2FA 通过 / 改密后 `sid` 必须变化（防会话固定，决策 #32）。
5. 第 4 个并发登录 → 最旧会话被踢（决策 #32）；`logout-all` 后全部 401。
6. `role='user'`（普通用户）的账号 POST 规则 → 403 `role_denied` + 审计。
7. `/api/public/*` 响应体断言不含 `last_ip`/`reported_ip`/内部 UUID/`agent_key`（决策 #21；已覆盖：`server/test/status.service.test.js` 的"字段全填满的 agent"用例 + `server/test/public.api.test.js`）。
8. 关闭 `public_view.enabled` → 公开接口全部 404（且改回后同一个进程实例立刻恢复 200，证明是每请求判定）。
9. `metrics?from&to` 超出该 step 允许范围 → 400 `range_too_large`；`step=auto` 回传实际档位（且该档位等于前端 5 个预设按钮的预期值）；`step=15s` → 400 `schema_invalid`（该档位已删除）；基名展开超过 20 条 → 400 `too_many_series`（`details.max_series_at_this_range` 给出本范围上限）；缺失桶不补 0（测试落点：`server/test/hosts.metrics.test.js`，19 例）。

以下为登录 / 改密 / 2FA 的专项验收用例（已实现并有测试覆盖；测试落点与验收清单见 `docs/api-status.md` §2、§3.6）

10. 登录失败（账号不存在 / 密码错 / 已禁用）→ 均为 401 `invalid_credentials`，且响应体与耗时不可区分（等时校验）。
11. `security.require_2fa=true` 且未绑定 TOTP → 登录成功但进入受限态：`me` 与改密返回 403 `totp_setup_required`（`me` 的返回见 §4.1.0 三态矩阵与 `docs/api-status.md` §4.1 D2），登出仍可用。
12. TOTP 码错误 → 400 `invalid_totp`；同一步号在 30s 窗口内重复使用 → 拒绝（`totp:used:<uid>` 防重放，审计 `reason='replayed_step'`；+31s 新步号放行）。
13. 恢复码用后即废（同一码第二次 → 400），响应含 `remaining_recovery_codes`；`require_2fa=true` 时禁止自助解绑（`docs/api-status.md` §4.1 D3，409 `conflict`）。
14. 登录限流：`/auth/login`、`/auth/2fa/verify` 与 `/auth/2fa/recovery/verify` 共用 `ratelimit:login:<ip>`（10 次/5 分钟，超限 429 + `Retry-After`）。

以下为人机验证（滑块）的专项验收用例（已实现并有测试覆盖：`server/test/auth.captcha.test.js`；完整清单见 `docs/slider-captcha-selfbuilt.md` §10.3）

15. 首次登录不出现滑块：无失败计数时，不带 `captcha_token` 也能登录成功，不返回 `captcha_required`（本需求的核心断言）。
16. 密码错一次后引入：失败响应 401 `invalid_credentials` + `details.captcha_required:true`，两个失败计数器（`login:fail:ip:*` 与 `login:fail:acct:*`）各 +1；随后缺 token 提交 → 400 `captcha_required`。
17. 一次性与绑定：同一 `captcha_token` 在登录成功后再次使用 → 400 `captcha_invalid`；换 IP 使用同一 token → 400 `captcha_invalid`。
18. 分布式兜底：多个 IP 各失败 1 次打同一账号，新 IP 再试 → 400 `captcha_required`（按账号计数生效）。

已实现（S7 后端）：极验 v4 提供方的专项用例 12 条见 `docs/geetest-captcha.md` §10.2（`AC-G1`…`AC-G12`），集成用例在 `server/test/auth.captcha.geetest.test.js`（全程打桩 `fetchImpl`，不真连极验）+ 纯函数单测 `server/test/geetest.test.js`：`AC-G1` 首次登录免验证、`AC-G2` 失败计数、`AC-G3` 缺凭证 400 且不调极验、`AC-G4` challenge 返回 `provider:'geetest'` 且不含 `bg_svg`/`piece_svg`/`expires_in`、`AC-G5` 二次校验只发一次请求且签名正确、`AC-G6` 极验判 fail → 400 `validate_failed`、`AC-G7`/`AC-G8` 极验不可达时按 `failMode` 放行或 503、`AC-G9` HTTP 500/非 JSON 记为不可用（不记成"用户未通过"）、`AC-G10` `captcha_token` 一次性、`AC-G11` 绑定 IP、`AC-G12` 显式声明 geetest 却缺密钥时启动即 `CONFIG_INVALID`。另有 `AC-G12b` 覆盖"未设置 `CAPTCHA_PROVIDER` 时自动推断"。

> 注意：上面的 15–18 是提供方无关的（首次免验证、失败计数、一次性、分布式兜底），换极验后必须继续全绿；自建专有的用例（题目比对/容差/轨迹/`too_many_attempts`/题目过期）留在 `docs/slider-captcha-selfbuilt.md` §10.3，不迁移。

---

## 7. 决策与落地状态（指针）

> 决议清单（A1–A14、D1–D7、C1–C19）与已确认的设计决策全部记录在 `docs/api-status.md` §4；尚未确认的条目集中在 `docs/api-status.md` §5。
> 本文不维护第二份状态清单。

---

## 8. 与设计文档的对照（溯源）

| 本文位置 | 设计文档来源 |
|---|---|
| §0 端点总索引 | §10.2 接口清单 |
| §1.1–1.2 | §5.4 分级、§10.2 接口清单、§5.2 默认拒绝 |
| §1.3–1.4 | §5.2 默认拒绝/限流、§7.3 令牌桶（错误码表与 `server/src/utils/errors.js` 同源） |
| §1.5 | §5.2 中间件顺序、§6.6 验签顺序（决策 #35） |
| §1.6 | §6.6 健康检查约定、R15（`evicted_keys` 恒为 0） |
| §2.1 | §6.2 签名、§10.1 上报体与响应、决策 #18/#19/#36 |
| §2.2 | §10.2 心跳、§4.3 网络开销 |
| §2.3 | §2.1 单向宗旨、§10.2 无下发接口、§12.4 |
| §3 | §5.4 公开可见性、决策 #10/#21、§8 IP 隐私 |
| §4.1 | §18.1 有状态会话、决策 #31/#32（会话轮换与 CSRF）、A9/A13（2FA 自助绑定与两条恢复渠道） |
| （原 §4.1.1） | 见 `docs/api-status.md` §3：§18.1 会话模型、§5.2 默认拒绝——实现规范（①–⑨）：三态矩阵、`totp:used` 防重放、落地顺序、决策 D1–D7 |
| §4.2–4.3 | §5.3 心跳/离线、§6.5 漂移、§8 IP 历史、§9 时序与降采样 |
| §4.4 | §6.1 凭证、§12.2–12.3 安装流程、决策 #15/#37 |
| §4.5–4.7 | §7.1–7.3 告警规则/通道/风暴防护、决策 #22/#23 |
| §4.8–4.9 | §13 安全清单（审计、RBAC 两级） |
| §4.10 | §5.4 设置项白名单、A14（PG `settings` + 立即生效） |
| §5 | §18.2 实时通道、§18.3 单向一致性 |
| §6 | §13「单向性复核」、§19 评审响应清单 |
