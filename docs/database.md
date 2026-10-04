# Vantage 主控数据库文档（PostgreSQL 16 + Redis 7）

> **来源**：由《Vantage-DESIGN-v0.7.md》拆分的**主控（vantage-core）数据层专项文档**。
> **适用对象**：vantage-core 数据层开发者、DBA、运维。
> **文档性质**：数据契约（表结构 / 键空间 / 保留策略 / 维护任务），**不含实现代码**。
> **上位文档**：`Vantage-DESIGN-v0.7.md` 为准（**文件内容已是 v0.8**，文件名保留以维持引用）；冲突时以上位文档与其 §15 技术决策表（共 59 条）为准。
> **阅读约定**：本文中的「✅ 本轮决策 / 本轮已定」= 2026-09-26 Owner 拍板，**均已写入设计文档 v0.8**；逐条对照见 `docs/design-deltas.md`。

**标注图例**

| 标记 | 含义 |
|---|---|
| ✅ 已定 | 直接来自设计文档（含 §15 决策编号），不得擅自更改 |
| ➕ 建议 | 拆分时补齐的工程细节，**需 Owner 确认**后方可作为实现依据 |
| ❓ 待拍板 | 设计文档未定或存在内部冲突，需 Owner 决策 |

---

## 1. 范围与基本约束

### 1.1 本文覆盖
- 主控侧**全部持久化状态**：PostgreSQL 16 表结构、分区、索引、保留与降采样任务。
- Redis 7 **键空间契约**（限流 / nonce / 幂等 / 面板会话 / 告警静默 / 实时扇出）。
- 写入路径、一致性边界、容量估算、备份与权限。

### 1.2 不在本文范围
- Agent 本地状态（Agent **零磁盘缓存**，见 `docs/agent.md`）。
- 面板前端状态（见 `docs/frontend.md`）。
- 接口字段与错误码（见 `docs/api.md`，本文只描述**落库形态**）。

### 1.3 数据层硬约束
1. ⛔ **中心不向 Agent 下发任何内容**（设计 §2.1 宗旨）：数据库只承载**入站**数据，不得出现「待下发配置 / 待执行命令 / 指令队列」类表。
2. **权威时间是 `server_ts`**（中心接收时间，设计 §6.5 / 决策 #16）：所有时序表的分区键与排序依据必须是中心接收时间；`agent_ts` 仅作附加字段用于漂移检测。
3. **断网即丢弃**（决策 #14）：不存在「补传缓冲区」表，PG 侧不承担 Agent 侧数据补齐职责。
4. **Agent 只能写自己的数据**（设计 §6.4）：所有入站写入按 `agent_id` 强绑定，不接受 body 内声明的其它 agent 的数据。
5. **Agent 凭证只存哈希**（设计 §6.1 / §13）：明文 key/secret 永不入库、永不入日志。

---

## 2. 存储选型与角色划分

| 存储 | 版本 | 承载内容 | 是否可丢失 |
|---|---|---|---|
| PostgreSQL | 16 | 主机/凭证/时序/探活/告警/审计/面板账号 | ❌ 不可丢（需备份） |
| Redis | 7 | 限流计数、nonce、幂等键、面板会话、告警静默、实时 Pub/Sub | ✅ 可丢（会话丢失=重新登录；nonce 丢失仅削弱重放防护） |

✅ 已定（设计 §3、§12.1）：中心以 Docker Compose 部署 `vantage-core` + `postgres` + `redis` + `caddy` + `web`。
➕ 建议：PG 与 Redis **只监听容器内网/本地地址**，不对公网暴露（对齐 §13 安全清单「数据库只监听本地」）。

**数据库角色（➕ 建议）**

| 角色 | 权限 | 用途 |
|---|---|---|
| `vantage_migrator` | 拥有 schema，可 DDL（含 `CREATE/DROP TABLE ... PARTITION`） | 迁移与分区维护 |
| `vantage_app` | 仅 DML（SELECT/INSERT/UPDATE/DELETE）+ 序列使用 | core 运行时连接 |
| `vantage_ro`（可选） | 只读 | 排障/BI |

> ✅ 已定（本轮）：**分区创建与 Drop 由 core 内置定时任务执行**（✅ 设计 §9 原文即「vantage-core 定时任务」），并用**分布式锁**（PG advisory lock 或 Redis `cron:lock:<task>`）保证多实例下只跑一次。
> ➕ 权限落地：分区维护需要 DDL → core 内维护**两条连接**：运行时 DML 用 `vantage_app`（最小权限），分区维护任务用 `vantage_migrator`（或等价的独立连接池），⛔ 不把 DDL 权限挂在常规请求路径上。

---

## 3. 表清单总览

| # | 表 | 用途 | 写入方 | 主要读取方 | 保留 |
|---|---|---|---|---|---|
| 1 | `agents` | 被监控主机 + **单套**凭证哈希 + 当前状态/当前 IP | core（接入层） | 面板、告警引擎 | 永久（吊销不删除） |
| 2 | `users` | 面板账号 + 权限字段 + **OIDC SSO 预留字段**（✅ 决策，见 §5.3） | core（管理 API） | 登录/会话 | 永久 |
| 3 | `user_recovery_codes` | 2FA 一次性恢复码（✅ 本轮决策，见 §5.4） | 面板 API | 登录/2FA | 用后即废；重生成即整批作废 |
| 3 | `agent_ip_history` | IP 出现区间（双源） | core（接入层） | 详情页 IP 时间线 | ✅ 180 天（本轮） |
| 4 | `ip_change_events` | IP 变化事件 + Flapping 事件 | core（IP 追踪服务） | 详情页、告警引擎 | ✅ 永久（决策 #11） |
| 5 | `metrics_raw` | 原始 15s 指标（**按天分区**） | core（批量写入） | 降采样任务、短窗查询 | ✅ 15 天（决策 #11/#38） |
| 6 | `metrics_1m` | 1 分钟降采样 | 降采样任务 | 中长周期图表 | ✅ 90 天 |
| 7 | `metrics_5m` | 5 分钟降采样 | 降采样任务 | 长周期图表 | ✅ 1 年 |
| 8 | `process_snapshots` | 进程总数 + Top-N | core（接入层） | 详情页 | ✅ 30 天（本轮） |
| 9 | `probe_results` | 本地探活结果 | core（接入层） | 探活页/详情页、告警引擎 | ✅ 90 天（本轮） |
| 10 | `alert_rules` | 告警规则（受控阈值 DSL） | 面板 API | 告警引擎 | 永久 |
| 11 | `channels` | 通知通道配置（➕ 建议，见 §5.4） | 面板 API | 通知服务 | 永久 |
| 12 | `alert_events` | 告警触发/恢复事件 | 告警引擎 | 面板、通知服务 | ✅ 永久 |
| 13 | `notification_log` | 每次发送结果 | 通知服务 | 面板/排障 | ✅ 180 天（本轮） |
| 14 | `silences` | 静默窗口 / 维护期（➕ 建议，见 §5.4） | 面板 API | 告警引擎 | 过期清理 |
| 15 | `audit_logs` | 审计日志 | 各层 | 面板（需登录） | ✅ 365 天（本轮） |
| 16 | `settings` | 面板可改的系统开关/参数（✅ 本轮决策，见 §5.4） | 面板 API（仅 `admin`） | core 各服务 | 永久（含变更审计） |

> ✅ 已拍板（本轮）：**不做凭证新旧并存**，`agents` 单套 `agent_key_hash`/`agent_secret_enc` 足够 → 原「`agent_keys` 多 key 表」方案作废（见 §5.2）；`users` 权限字段与 SSO 字段见 §5.3。
> ⚠️ ✅ 本轮补充修订（实现时发现的文档冲突）：`agent_secret` **不能只存哈希**——HMAC-SHA256 验签要求中心持有可读的 secret 才能重算签名，故该列改为 **`agent_secret_enc`（AES-256-GCM 加密，明文仍不入库）**；`agent_key` 保持只存 HMAC-pepper 哈希。同时把 `X-Agent-Key` 补回上报请求头（设计 §5.2 本来就要求校验它，见 `docs/api.md` §2.1）。

---

## 4. 命名与类型约定（➕ 建议）

| 项 | 约定 |
|---|---|
| 标识符 | 小写蛇形；表名复数；时间列一律 `*_at`（瞬间）或 `*_ts`（时序点） |
| 主键 | 代理表用 `UUID`（`gen_random_uuid()`）；时序/事件表用 `BIGSERIAL` 或复合主键 |
| 时间 | 一律 `TIMESTAMPTZ`，**存储 UTC**，展示层转本地时区（面板中文优先，见 `docs/frontend.md`） |
| IP | `INET` 类型（非 TEXT），便于网段比较（`same_subnet` 判定） |
| 枚举 | 用 `TEXT + CHECK`（不用 PG `ENUM`，便于后续增删值而不锁表） |
| 大字段 | 半结构数据用 `JSONB`（`tags/top/labels/detail/target`），禁止 `TEXT` 存 JSON |
| 布尔 | `BOOLEAN NOT NULL DEFAULT false`，不用 0/1 |
| 软删 | 凭证/主机用 `status` + `disabled_at`，**不物理删除**（保留审计与历史关联） |

---

## 5. 表结构定义

> 下列 ✅ 字段来自设计 §9；类型、约束、默认值、索引为 ➕ 拆分补齐。

### 5.1 `agents` — 被监控主机与凭证（✅ 结构已定）

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | `UUID` | PK | `agent_id`，创建时生成，全局不变 |
| `name` | `TEXT` | NOT NULL **UNIQUE** | 主机名/别名（✅ §9 字段；✅ 决策：**name 唯一**） |
| `public_slug` | `TEXT` | NOT NULL **UNIQUE** | ✅ 本轮决策：公开接口的**唯一对外标识**（创建时生成的随机短 ID，建议 8–12 位 base62、避开 `0/O/1/l/I` 等易混字符）；⛔ 内部 UUID **不得**出现在 `/api/public/*` 响应与 URL 中；不随 `name`/`display_name` 变化（避免公开链接失效） |
| `display_name` | `TEXT` | NULL | 公开视图显示名（✅ 决策 #21） |
| `agent_key_hash` | `TEXT` | NOT NULL | `agent_key` 的哈希（**不存明文**） |
| `agent_secret_enc` | `TEXT` | NOT NULL | HMAC secret 的**密文**（AES-256-GCM，主密钥来自 env，**明文不存库**）。⚠️ ✅ 本轮修订：原写 `agent_secret_hash`（只存哈希）——**行不通**，HMAC 验签要求中心能解出 secret 重算签名；改名并改为加密存储，`agent_key` 仍走哈希（`agent_key_hash`，HMAC-pepper） |
| `tags` | `JSONB` | `'[]'::jsonb` | 标签，用于规则 `target`（决策 #21/#7.1） |
| `status` | `TEXT` | `CHECK (status IN ('online','offline','disabled'))` | ✅ §9 注释：online/offline/disabled；✅ 已定（本轮）：**不引入 `abnormal`**——「有告警 / 时钟漂移 / IP Flapping」一律用**派生徽标与计数**表达（`ip_flapping`、`clock_drift_ms`、firing 事件计数），状态机保持三态 |
| `last_ip` | `INET` | NULL | 当前主出口 IP（✅ §8 比较基准） |
| `last_seen_at` | `TIMESTAMPTZ` | NULL | 最后上报时间（✅ §5.3 心跳） |
| `last_agent_ts` | `BIGINT` | NULL | ➕ 最后一次上报的 `agent_ts`（漂移检测，决策 #17） |
| `clock_drift_ms` | `BIGINT` | NULL | ➕ 最近一次计算的漂移（详情页角标，§6.5） |
| `reported_ip` | `INET` | NULL | ➕ Agent 自报出口 IP（双源比对，§8） |
| `host_info` | `JSONB` | NULL | ➕ 最近一次的 `host` 对象（hostname/os/kernel/arch/boot_time/capabilities） |
| `capabilities` | `JSONB` | NULL | ✅ 已定（本轮）：能力声明快照，来自上报体 `host.capabilities`（设计 §4.9）；键集合与语义见 `docs/api.md` §2.1；面板据此隐藏不支持的图表/列 |
| `ip_flapping` | `BOOLEAN` | `false` | ➕ Flapping 态标记（决策 #39：暂停 IP 变化类告警） |
| `flapping_since` | `TIMESTAMPTZ` | NULL | ➕ 进入 Flapping 的时间（恢复稳定后置空） |
| `created_at` | `TIMESTAMPTZ` | `now()` | ✅ §9 |
| `rotated_at` | `TIMESTAMPTZ` | NULL | ✅ §9，最后一次**手动**轮换时间（从未轮换为 NULL） |
| `rotate_reminder_at` | `TIMESTAMPTZ` | NULL | ➕ 上次「该轮换凭证」提醒时间；**每日一次**提醒据此按「日期」去重（✅ 本轮决策，§5.2） |
| `disabled_at` | `TIMESTAMPTZ` | NULL | ✅ §9，吊销/禁用时间 |

索引：`UNIQUE (name)`（✅ 决策：**name 唯一**）、`UNIQUE (public_slug)`（✅ 本轮决策）、`GIN (tags)`、`(status)`、`(last_seen_at)`（离线扫描用）、`((COALESCE(rotated_at, created_at)))`（轮换提醒扫描，§8.2）。

### 5.2 凭证策略：单套凭证、不做新旧并存 + 到期提醒（✅ 本轮决策）

**决策**：不做「新旧并存过渡」的自动/半自动轮换 → `agents` 的单套 `agent_key_hash` / `agent_secret_enc` 足够，**不需要 `agent_keys` 多 key 表**（原「方案 A」作废）。

| 项 | 语义 |
|---|---|
| 有效凭证数 | 每个 Agent 任一时刻**只有一套**（key + secret），无并存期 |
| 触发方式 | 仅**管理员在面板显式操作**（不自动轮换） |
| 轮换过程 | 生成新 key/secret（明文仅展示一次）→ **旧凭证立即失效** → 管理员登录目标机替换 key 文件 → `reload`/`restart` |
| 为何必须人工上机 | 中心⛔不能把新 key 推给 Agent（单向宗旨 ✅ §2.1），故「人工替换」是唯一路径（同决策 #37） |
| 中断代价 | 替换窗口内该机上报 401 → 中心按 3×周期判离线并告警（符合丢弃式策略 ✅ 决策 #14）；➕ 建议在维护窗口执行 |
| 兜底 | 遗忘轮换不会导致凭证过期失效（无自动过期），只靠**提醒**驱动（见下） |

**到期提醒（✅ 本轮决策：阈值可配 + 面板徽标 + 每日一次通知）**

| 载体 | 规格 |
|---|---|
| 面板 | Agent 列表/详情展示 `credential_age_days`（= `now() - COALESCE(rotated_at, created_at)`），超阈值打「建议轮换」徽标，并给出轮换入口（✅ 见 `docs/frontend.md`） |
| 阈值 | **可配**：`credential_rotate.reminder_days`（✅ 本轮决策：存 `settings` 表，面板可改、立即生效，默认 **90** 天）；面板徽标与服务端通知**共用同一阈值** |
| 通知 | core **每日一次**任务扫描超阈 Agent → 复用既有 `channels` 通道发提醒给管理员（✅ 决策 #23）；`rotate_reminder_at` 记录上次提醒日，**同一天不重复**，未轮换则次日继续提醒（直到处理） |
| 提醒开关 | ➕ `credential_rotate.notify`（✅ 本轮决策：存 `settings` 表，默认开），关闭时只保留面板徽标、不发通知 |
| 红线 | ⛔ 提醒内容与面板展示中**不含**任何凭证明文；⛔ 不提供「自动轮换」开关 |

### 5.3 `users` — 面板账号（权限字段与 SSO 字段为 ✅ 本轮决策，字段名为 ➕ 建议）

依据：决策 #31「面板登录＝有状态会话（非 JWT）；Cookie 仅存不透明 sid，状态在 Redis；**用户账号在 PG `users`**」。
本轮新增：**权限字段**（暂时两级：管理员 / 普通用户）+ **OIDC SSO 预留字段**（后续对接用）。

**本地账号与权限**

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `username` | `TEXT` | UNIQUE NOT NULL | 登录名 |
| `display_name` | `TEXT` | NULL | 展示名 |
| `email` | `TEXT` | NULL | 邮箱（➅ SSO 对接需要，本地账号可空）；见下方唯一性约束 |
| `password_hash` | `TEXT` | NULL | ➕ Argon2id（bcrypt 次选）；**SSO-only 用户为 NULL**（⛔ 不允许空密码本地登录） |
| `role` | `TEXT` | NOT NULL DEFAULT `'user'`，`CHECK (role IN ('admin','user'))` | ✅ 决策：**暂时两级**——`admin`（管理员）/ `user`（普通用户）；后续可扩为多角色（届时改为 `roles` 数组或角色表） |
| `totp_secret_enc` | `TEXT` | NULL | TOTP 密钥，**加密存储**；未启用为 NULL |
| `totp_enabled` | `BOOLEAN` | NOT NULL DEFAULT false | 是否已启用 TOTP（✅ 本轮决策：面板自助绑定，见 `docs/api.md` §4.1） |
| `totp_bound_at` | `TIMESTAMPTZ` | NULL | ➕ 绑定成功时间（面板展示与审计用） |
| `status` | `TEXT` | NOT NULL DEFAULT `'active'`，`CHECK (status IN ('active','disabled'))` | 禁用即禁止登录（会话也应被清理） |
| `last_login_at` | `TIMESTAMPTZ` | NULL | |
| `last_login_ip` | `INET` | NULL | |
| `last_login_method` | `TEXT` | NULL | ➕ `password` / `totp` / `oidc`，便于审计与排障 |
| `created_at` / `updated_at` / `disabled_at` | `TIMESTAMPTZ` | | |

**SSO 预留字段（OIDC，本期只落库与占位，不实现流程）**

| 列 | 类型 | 说明 |
|---|---|---|
| `oidc_issuer` | `TEXT` | IdP 的 `iss`（多 IdP 时用于区分来源） |
| `oidc_subject` | `TEXT` | OIDC `sub`；**与 `issuer` 组成永久唯一身份** |
| `oidc_email` | `TEXT` | IdP 返回的 `email` claim 原值（可能与本地 `email` 不同，故分列保留） |
| `oidc_linked_at` | `TIMESTAMPTZ` | 绑定时间 |
| `oidc_last_sync_at` | `TIMESTAMPTZ` | ➕ 最近一次 SSO 登录/同步时间（便于排查账号漂移） |

**约束与索引**

```sql
UNIQUE (lower(username))
UNIQUE (lower(email)) WHERE email IS NOT NULL
UNIQUE (oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL   -- 部分唯一索引
CHECK (password_hash IS NOT NULL OR oidc_subject IS NOT NULL)       -- 至少一种登录方式
```

> ✅ 决定含义：`role` 字段**本期就建**，两级语义为「管理员=全部操作（含凭证管理、用户管理、规则/通道配置）；普通用户=登录后只读（含历史、IP、进程、审计）」。
> ✅ 已定（本轮）：普通用户（`role='user'`）**纯只读**——可看全部内容（含历史曲线、IP 变更、进程 Top、告警事件、审计日志），**所有写操作仅 `admin`**（告警规则/通道/静默、Agent 创建·轮换·禁用·吊销、用户管理、`public_view.enabled` 开关）。
> ❓ 仍未定（后续单条提问）：SSO 的角色映射（IdP claim → `admin`/`user`）留到对接 SSO 时定。
> ➕ 若将来一个用户要绑定多个 IdP，需升级为 `user_identities(user_id, issuer, subject, email, linked_at)` 关联表；当前单列预留够用。
> 登录失败限速放 Redis（`ratelimit:login:<ip>`），不落 PG。

### 5.4 其它 ➕ 建议新增表（设计有需求、§9 无表）

**`settings`（面板可改的系统开关/参数，✅ 本轮决策）**

| 列 | 类型 | 说明 |
|---|---|---|
| `key` | `TEXT` PK | 开关名，**白名单固定**（见下）；未知 key → 拒绝 |
| `value` | `JSONB NOT NULL` | 值（布尔/数值/字符串，按 key 定类型校验） |
| `updated_by` | `UUID` FK → `users(id)` | 最近修改人 |
| `updated_at` | `TIMESTAMPTZ` | 最近修改时间 |

| 允许的 key（白名单） | 类型 | 默认值 | 用途 |
|---|---|---|---|
| `public_view.enabled` | bool | ✅ **true**（本轮决策） | 免登录公开视图总开关（§5.4 设计；`docs/api.md` §3.2） |
| `security.require_2fa` | bool | false | 强制所有账号绑定 TOTP（`docs/api.md` §4.1） |
| `credential_rotate.reminder_days` | int | 90 | 凭证轮换提醒阈值（§5.2） |
| `credential_rotate.notify` | bool | true | 是否发通知（关＝只留面板徽标，§5.2） |
| `security.login_captcha.enabled` | bool | ✅ **true**（S 系列） | 登录人机验证（滑块）总开关；关闭时取题端点按 404 处理，登录也永不因滑块被拒（`docs/api.md` §4.1） |
| `security.login_captcha.after_failures` | int | ✅ **1**（S 系列） | 同 IP / 同账号失败几次后开始要求人机验证（1 = 一次密码错就要；范围 1–10） |
| （预留）`alert.default_cooldown_s` 等 | — | — | 将来新增开关**必须先加入白名单** |

- ✅ 生效方式：面板 `PATCH` 后**立即生效**——core 读取走「Redis 缓存 `settings:cache`（TTL 建议 30s）+ 变更时主动失效」，避免每请求查库；⛔ 不需要重启容器。
- ✅ 缺行即取**代码内默认值**（上表右列），因此新部署不需要预置数据。
- ✅ 每次变更写 `audit_logs`（`action=settings.update`，`detail` 记 key/旧值/新值，⛔ 不含任何密钥）。
- ⛔ **不放密钥**：通道密钥/加签 secret 属 `channels.config`，TOTP 密钥属 `users.totp_secret_enc`，都不进本表。
- ➕ 建议：变更后向在线 WS 连接广播一条 `delta{channel:"settings"}`，让所有已打开的面板立即刷新（可选）。

**`user_recovery_codes`（2FA 一次性恢复码，✅ 本轮决策）**

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `UUID` PK | |
| `user_id` | `UUID` FK → `users(id)` ON DELETE CASCADE | |
| `code_hash` | `TEXT NOT NULL` | **只存哈希**（明文仅生成时返回一次） |
| `used_at` | `TIMESTAMPTZ` | 用后置位即作废（⛔ 一次性） |
| `created_at` | `TIMESTAMPTZ` | 生成时间（重新生成时整批先删/作废） |

索引：`(user_id) WHERE used_at IS NULL`（查可用码数）；✅ 固定 10 个/次，剩余 ≤2 时前端提示重新生成。
➕ 恢复渠道二（管理员）：`POST /api/v1/users/{id}/2fa/reset` 会**清空该用户全部恢复码**（`docs/api.md` §4.9），无需新列。

**`channels`（通知通道配置，依据 §7.2 / 决策 #23）**

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `UUID` PK | |
| `kind` | `TEXT` | `smtp` / `wecom` / `dingtalk` / `feishu` / `webhook` |
| `name` | `TEXT` | 显示名 |
| `config` | `JSONB` | 通道参数（SMTP host/port/tls/user、Webhook URL/加签 secret 等），**敏感项加密存储** |
| `template` | `JSONB` | 该通道的模板（§7.2「每通道独立模板」） |
| `rate_limit` | `JSONB` | 令牌桶参数（速率/突发），决策 #23 |
| `enabled` | `BOOLEAN` | 开关（§7.2「可开关、可测发送」） |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | |

**`silences`（静默窗口 / 维护期，依据 §7.1）**

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `UUID` PK | |
| `name` | `TEXT` | 维护说明 |
| `target` | `JSONB` | 作用对象（单机/标签/全体，与规则 `target` 同构） |
| `starts_at` / `ends_at` | `TIMESTAMPTZ` | 窗口 |
| `created_by` | `UUID` FK → `users(id)` | |
| `created_at` | `TIMESTAMPTZ` | |

> ✅ 已定（本轮）：`alert_rules.channels` 存 **`channels.id` 数组**（JSONB）——通道是**唯一的凭证与模板归属方**，密码/加签 secret 全局只存一份；规则不内联通道参数，多规则可复用同一通道。
> ➕ 语义补充：通道 `enabled=false` 时规则保留关联但**跳过发送**（写 `notification_log`：`ok=false, error='channel_disabled'`）；删除仍被规则引用的通道 → 接口返回 409 `channel_in_use`（须先解绑），⛔ 不做级联删除。

### 5.5 `agent_ip_history`（✅ 结构已定）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `BIGSERIAL` | PK | ✅ |
| `agent_id` | `UUID` | FK → `agents(id)` ON DELETE RESTRICT | ✅ |
| `ip` | `INET` | NOT NULL | ✅ |
| `source` | `TEXT` | `CHECK (source IN ('remote','agent_reported'))` | ✅ §8 双源比对 |
| `first_seen` | `TIMESTAMPTZ` | NOT NULL | ✅ |
| `last_seen` | `TIMESTAMPTZ` | NOT NULL | ✅ 同一 IP 连续上报只更新此列 |

索引：`(agent_id, last_seen DESC)`、`UNIQUE (agent_id, ip, source)`（用于「同一 IP 合并区间」的 UPSERT）。
➕ 建议：仅记录**主出口 IP**（忽略私网/回环/虚拟网卡，§8），过滤在写入前完成。

### 5.6 `ip_change_events`（✅ 结构已定 + ➕ Flapping 扩展）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `BIGSERIAL` PK | ✅ |
| `agent_id` | `UUID` FK | ✅ |
| `old_ip` / `new_ip` | `INET` | ✅ |
| `same_subnet` | `BOOLEAN` | ✅ §8「是否同网段」 |
| `changed_at` | `TIMESTAMPTZ` | ✅ |
| `source` | `TEXT` | ➕ `remote` / `agent_reported`（§8 要求记录「来源」） |
| `kind` | `TEXT` | ➕ `change` / `flapping`（决策 #39：Flapping 只记一条事件） |
| `change_count` | `INT` | ➕ 触发 Flapping 判定时 10 分钟窗口内的变化次数 |
| `subnet_prev` / `subnet_next` | `CIDR` | ➕ 可选，便于「跨网段变化」规则复算 |

索引：`(agent_id, changed_at DESC)`、`(kind, changed_at DESC)`。
✅ 该表**永久保留**（决策 #11：IP 变更、告警事件永久）。

### 5.7 `metrics_raw` — 原始指标（✅ 结构已定）

✅ 设计 §9 定义：

```
metrics_raw(agent_id, metric, value, labels, ts)
  PRIMARY KEY (agent_id, metric, ts)
  PARTITION BY RANGE (ts)          -- 每日一分区 metrics_raw_YYYYMMDD
```

| 列 | 类型 | 说明 |
|---|---|---|
| `agent_id` | `UUID NOT NULL` | |
| `metric` | `TEXT NOT NULL` | **序列全名**：`基名` 或 `基名{维度=值,...}`（✅ 本轮决策：维度写进指标名，规范见 §5.7.2） |
| `value` | `DOUBLE PRECISION NOT NULL` | 数值（单位随指标，见 §5.7.2） |
| `labels` | `JSONB NOT NULL DEFAULT '{}'` | 维度标签的**便利副本**（由 `metric` 反解得出，便于排查与前端直读）；⛔ **非权威**，权威是 `metric` 字符串；两者不一致以 `metric` 为准 |
| `ts` | `TIMESTAMPTZ NOT NULL` | **`server_ts`（权威时间）**，分区键 |

#### 5.7.1 ✅ 已拍板：维度写进指标名（主键不变）

**问题回顾（保留作为决策依据）**：`PRIMARY KEY (agent_id, metric, ts)` 隐含「一台机一个 metric 名在同一时刻只有一个值」。若把挂载点/网卡/GPU 序号只放进 `labels`，同一时刻的两条 `disk.used_pct` 会**主键冲突互相覆盖**；而 `JSONB` 无法进入 PG 主键（无 btree 操作符类）。

**决策（本轮，方案 A）**：维度**编码进 `metric` 字符串**，主键 `(agent_id, metric, ts)` **保持不变**。

| 项 | 结论 |
|---|---|
| 序列标识 | `metric` 全名即唯一序列键（含维度），一机一序列一行 |
| `labels` | 降级为便利副本（由 `metric` 反解），可随时重建；⛔ 不参与唯一性、不作为查询权威 |
| 设计 §9 注释的 `gpu.0.util` | **不再采用**（点号序号丢失维度语义），统一写 `gpu.util{index=0}` |
| 写入/查询一致 | 转义与拼装必须**同一段代码同源实现**（Agent 端产生、core 端校验、API 端解析），见 §5.7.2 |
| 影响面 | 同时决定 `docs/api.md` §4.3 的 `metrics=` 参数语义与 `docs/frontend.md` 的 series/图例标识 |

#### 5.7.2 指标命名、维度转义与单位（✅ 已定，三份文档统一引用）

**基名（无维度）**：`cpu.usage`、`mem.used_pct`、`process.count` …
**含维度的全名**：`基名{维度=值,维度=值}`

| 规则 | 说明 |
|---|---|
| 维度键 | 只允许小写字母、数字、下划线（`mount` / `device` / `index` / `core`） |
| 维度排序 | 按**键名字母序**升序拼接（保证同一序列只有一种写法，避免 `{a=1,b=2}` 与 `{b=2,a=1}` 变成两条序列） |
| 分隔 | 多维度用 `,` 分隔、**无空格**，`=` 连接键值 |
| 保留原样 | 可读字符 `/` `:` `-` `.` `@` `+` 无需转义（如 `mount=/data`、`device=eth0`） |
| **必须转义** | `%` `{` `}` `=` `,` 及空白 → **百分号编码**：`%`→`%25`、`{`→`%7B`、`}`→`%7D`、`=`→`%3D`、`,`→`%2C`、空格→`%20`。⚠️ `%` 必须一起转义，否则编码**不是单射**，不同维度会撞成同一序列名 |
| 无维度 | **不带**花括号（`cpu.usage`，而非 `cpu.usage{}`） |
| 大小写 | 基名与维度键全小写；维度值保留原始大小写（`Eth0` ≠ `eth0`，建议 Agent 侧统一小写设备名） |
| 长度 | 全名 ≤ **200 字符**，超限由 schema 校验拒绝（防异常挂载点/设备名撑爆索引） |
| 反解 | 两端各提供 `buildMetric(base, labels)` / `parseMetric(full)`，**必须同源实现 + 共用测试向量** |

**指标清单与单位**

| 组 | 指标（含维度） | 单位 |
|---|---|---|
| CPU | `cpu.usage`、`cpu.core.usage{core=<n>}`、`cpu.load1\|load5\|load15`、`cpu.ctx_switch` | %、%、—、次/s |
| 内存 | `mem.total\|used\|available\|cached\|buffers`、`mem.used_pct` | bytes、% |
| Swap | `swap.total\|used\|used_pct` | bytes、% |
| 磁盘 | `disk.total\|used`、`disk.used_pct`、`disk.inode_used_pct`、`disk.read_bps\|write_bps`、`disk.read_iops\|write_iops`、`disk.latency_ms`（维度 `{device,mount}`） | bytes、%、%、bytes/s、次/s、ms |
| 网络 | `net.rx_bps\|tx_bps`、`net.rx_total\|tx_total`、`net.conn_count`、`net.err\|drop`（维度 `{device}`） | bytes/s、bytes、个、次/s |
| GPU | `gpu.util`、`gpu.mem_used\|mem_total`、`gpu.temp`、`gpu.power`（维度 `{index}`） | %、bytes、℃、W |
| 进程 | `process.count`（无限维；Top-N 落 `process_snapshots`） | 个 |

**示例**：`disk.used_pct{mount=/}`、`disk.used_pct{device=sda1,mount=/data}`（字母序 device 在前）、`net.rx_bps{device=eth0}`、`gpu.util{index=0}`、`cpu.core.usage{core=3}`（核序号也是维度；**取代**上文的 `cpu.core.<n>.usage` 写法）。

**告警规则引用语义（✅ 本轮决策：两种写法都支持）**

| 规则里写 | 语义 | 适用 |
|---|---|---|
| **基名**（`disk.used_pct`） | 对该基名下**每个维度序列分别判定**——每个挂载点各判一次，哪个序列越限就为该序列产生事件（事件带全名） | 「任意分区满 90% 就告警」 |
| **全名**（`disk.used_pct{mount=/data}`） | **只判该单一序列** | 「只盯 /data」 |

- 事件必须能区分序列：`alert_events.metric` 存**触发序列全名**（见 §5.12），同一规则在多序列上可同时各有一条 firing 事件。
- ➕ UI 的「全部维度 / 指定维度」开关**不新增 API 字段**，直接映射为「传基名 / 传全名」，避免语义重复。

**维度值变化与重命名（✅ 已定，本轮）**：设备重命名 / 挂载点变更会让维度值变化 → 该序列「消失」、新序列「出现」，**视为两条独立序列**；⛔ 不迁移历史数据、不做别名映射（曲线自然断开，但历史仍可查）。面板的维度选择器应同时列出新旧序列（例如同时出现 `disk.used_pct{mount=/data}` 与 `disk.used_pct{mount=/data1}`）。

> 阈值类告警的 `metric` 引用上表（`docs/api.md` §4.5）。**注意**：上报体里 `cpu.cores`、`mem.swap`、`disk[]`、`net[]`、`gpu[]` 等嵌套/数组结构在落库时**必须摊平成上述全名序列**，否则「指标 + 比较符 + 阈值」的受控 DSL 无法引用。

#### 5.7.3 分区与索引

- ✅ 分区键 `ts`，**按天** RANGE 分区，命名 `metrics_raw_YYYYMMDD`。
- ➕ 建议：额外建一个 `metrics_raw_default` **DEFAULT 分区**兜底（分区维护任务失败时写入不报错，运维再拆出）；同时 core 启动时**预建未来 7 天**分区（幂等 `CREATE TABLE IF NOT EXISTS`）。
- ➕ 索引建议：由于 PK `(agent_id, metric, ts)` 已是 `(agent_id, metric)` 前缀 + `ts`，PG 可反向扫描满足 `ts DESC`，**额外的 `(agent_id, metric, ts DESC)` 索引大概率冗余**（设计 §9 提出该索引，建议先不建，压测后按需加）。
- ➕ `ts` 上可加 **BRIN**（设计 §9 已提），适合只追加、天然按时间聚集的分区表，体积远小于 btree。

### 5.8 `metrics_1m` / `metrics_5m` — 降采样层（✅ 结构已定）

| 列 | 类型 | 说明 |
|---|---|---|
| `agent_id` | `UUID NOT NULL` | |
| `metric` | `TEXT NOT NULL` | 与原始层**完全同一命名**（含维度全名，见 §5.7.2） |
| `bucket` | `TIMESTAMPTZ NOT NULL` | 桶起点（1m/5m 对齐 UTC 整点） |
| `v_avg` / `v_min` / `v_max` / `v_last` | `DOUBLE PRECISION` | 聚合值 |
| `n` | `INT` | 桶内样本数（用于判断数据完整度/画断点） |

✅ 主键：`(agent_id, metric, bucket)`；✅ 保留：1m **90 天**、5m **1 年**（决策 #11/#38）。
➕ 索引：`(agent_id, metric, bucket DESC)`（与 PK 同前缀，一般无需额外索引，同 §5.7.3 结论）。
✅ 已定（本轮）：这两张表**不分区**，超期清理走**每日分批 DELETE**——因为每日任务只删「刚过期那一天」的量（1m ≈36 万行、5m ≈7.2 万行），按 1 万行/批提交不会产生长事务或明显膨胀；表结构更简单、查询无需跨分区。⛔ 不采用按天/月分区（一年 365 个分区对 5 台规模是过度设计）。
➕ 代价与对策：需要**定期 VACUUM（或 autovacuum）**回收；建议监控表的膨胀率与 `n_dead_tup`，异常时手动 `VACUUM (ANALYZE)`。若将来规模上到几十台且行数翻十倍，再评估改为分区。

### 5.9 `process_snapshots`（✅ 结构已定，➕ 补主键）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `BIGSERIAL` PK | ➕ 建议补（设计未给主键） |
| `agent_id` | `UUID NOT NULL` FK | ✅ |
| `ts` | `TIMESTAMPTZ NOT NULL` | ✅（`server_ts`） |
| `total` | `INT` | ✅ 进程总数 |
| `top` | `JSONB` | ✅ `[{pid,name,cpu,mem}]`，长度上限由 schema 白名单约束（设计 §5.2） |

➕ 约束建议：`CHECK (jsonb_array_length(top) <= 50)`；索引 `(agent_id, ts DESC)`；保留 ✅ **30 天**（本轮决策；这是非时序表里最占空间的一张——`top` 为 JSONB，粗估 5 台 ≈0.2GB）。

### 5.10 `probe_results`（✅ 结构已定）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `BIGSERIAL` PK | ✅ |
| `agent_id` | `UUID NOT NULL` FK | ✅ |
| `probe_name` | `TEXT NOT NULL` | ✅ 本地 `config.yaml` 中的探活名（中心改不了，§4.6） |
| `probe_type` | `TEXT NOT NULL` | ✅ `ping`/`http`/`https`/`tcp`（可扩展 `dns`） |
| `target` | `TEXT NOT NULL` | ✅ |
| `up` | `BOOLEAN NOT NULL` | ✅ |
| `latency_ms` | `DOUBLE PRECISION` | ✅ |
| `status_code` | `INT` | ✅ 仅 http/https |
| `error` | `TEXT` | ✅ 失败原因（超时/连接拒绝/状态码不符） |
| `checked_at` | `TIMESTAMPTZ NOT NULL` | ✅ |

索引：`(agent_id, probe_name, checked_at DESC)`、`(agent_id, checked_at DESC)`；保留 ✅ **90 天**（本轮决策；5 台 × 约 3 个探活 × 30s ≈ 4.3 万行/天，90 天 ≈0.4GB）。
➕ 建议：新增 `detail JSONB`（可选，存 body_contains 命中情况等）——**需与上报 schema 白名单同步**。

### 5.11 `alert_rules`（✅ 结构已定）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `UUID`/`BIGSERIAL` PK | ✅ 设计未定类型（➕ 建议 UUID） |
| `name` | `TEXT NOT NULL` | ✅ |
| `target` | `JSONB NOT NULL` | ✅ 作用对象：单机 `{agents:[id]}` / 标签 `{tags:[..]}` / 全体 `{all:true}` |
| `kind` | `TEXT NOT NULL` | ✅ `threshold` / `offline` / `ip_change` / `probe` / `clock_drift`（对齐 §7.1 五类） |
| `metric` | `TEXT` | ➕ 阈值类指标：**基名或全名**（✅ 本轮决策，§5.7.2）；基名＝逐维度序列分别判定，全名＝单序列；非阈值类为 NULL |
| `metric_match` | `TEXT` | ➕ 可选派生列：`base`（基名，逐维度判定）/ `exact`（全名，单序列）；仅为查询与 UI 回显方便（可由 `metric` 是否含 `{` 推出，⛔ 不作权威） |
| `op` | `TEXT` | ➕ 比较符 `>` `>=` `<` `<=`（§7.1 受控 DSL） |
| `expr` | `TEXT` | ✅ 扩展位（**默认 NULL 且不执行**；§7.1 零 RCE，将来接 CEL/expr-lang 沙箱） |
| `threshold` | `DOUBLE PRECISION` | ✅ |
| `duration` | `INT` | ✅ 持续时长（秒），§7.1 `for` |
| `severity` | `TEXT` | ✅ `info`/`warn`/`critical` |
| `channels` | `JSONB` | ✅ **通道 id 数组**，引用 `channels.id`（✅ 本轮决策，见 §5.4）；通道是凭证/模板的唯一归属方，规则不内联参数 |
| `cooldown` | `INT` | ✅ 静默期（秒） |
| `enabled` | `BOOLEAN` | ✅ |
| `params` | `JSONB` | ✅ 本轮决策：**非阈值类规则的参数统一放这里**（按 `kind` 白名单校验，见下方规格）；阈值类为空对象 |
| `created_by` / `created_at` / `updated_at` | | ➕ 审计需要 |

**`params` 白名单规格（✅ 本轮决策：统一 JSONB，列不随规则类型膨胀）**

| `kind` | 使用的顶层字段 | `params` 结构（默认值） |
|---|---|---|
| `threshold` | `metric` / `op` / `threshold` / `duration` | `{}` |
| `probe` | `duration` | `{ probe_name?: string（省略＝该机全部探活）, probe_type?: "ping"\|"http"\|"https"\|"tcp", cond: "down"\|"latency_gt"\|"status_not_in", latency_ms?: number, status_codes?: number[] }` |
| `ip_change` | `duration` | `{ mode: "any"\|"subnet"\|"frequent", window_s?: 600, changes?: 3 }`（`frequent` 与 §8 的 Flapping 判定共用参数；⛔ Flapping 态下该类告警被暂停，见决策 #39） |
| `offline` | `duration` | `{ cycles?: 3 }`（默认 3×该机上报周期，✅ §5.3） |
| `clock_drift` | `duration` | `{ threshold_ms?: 60000 }`（✅ 决策 #17 默认 60s） |

> ✅ 校验规则：`params` 出现未知键 → 400 `schema_invalid`（白名单，⛔ 不做宽松透传）；数值范围校验（`window_s` 60–86400、`changes` 2–100、`latency_ms` 1–600000、`threshold_ms` 1000–600000）；`status_codes` 长度 ≤ 20 且为 100–599。

> ⚠️ **零 RCE 硬约束**：`expr` 列存在但**中心只做数值比较**，绝不 `eval`；写入接口必须拒绝任何可执行语义（见 `docs/api.md`）。

### 5.12 `alert_events` / `notification_log`（✅ 结构已定）

`alert_events`：

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `BIGSERIAL` PK | ➕ 类型 |
| `rule_id` | `UUID` FK | ✅ |
| `agent_id` | `UUID` FK | ✅ |
| `value` | `DOUBLE PRECISION` | ✅ 触发时的实际值 |
| `metric` | `TEXT` | ➕ **触发序列全名**（如 `disk.used_pct{mount=/data}`）；阈值类规则必填——这是「同一规则在多挂载点上各触发一次」的区分依据（✅ 本轮决策） |
| `labels` | `JSONB` | ➕ 由全名反解（展示用，⛔ 非权威） |
| `started_at` | `TIMESTAMPTZ` | ✅ |
| `resolved_at` | `TIMESTAMPTZ` | ✅ 恢复时间（§7.3 恢复通知） |
| `status` | `TEXT` | ✅ `firing` / `resolved` / `suppressed`（➕ 建议补 suppressed 表达同类合并/静默） |
| `notified_at` | `TIMESTAMPTZ` | ✅ 最后一次成功通知时间 |

索引：`(agent_id, started_at DESC)`、`(status, started_at DESC)`、`(rule_id, started_at DESC)`、`(rule_id, agent_id, metric)`；➕ 建议部分唯一索引 `UNIQUE (rule_id, agent_id, metric) WHERE status = 'firing'`（同一序列同一规则同时只允许一条 firing 事件，防重复/并发重复触发）；✅ 永久保留。

`notification_log`：

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `BIGSERIAL` PK | ✅ |
| `event_id` | `BIGINT` FK → `alert_events(id)` | ✅ |
| `channel` | `TEXT`/`UUID` | ✅ 设计写 `channel`；➕ 建议存 `channels.id`（可回溯配置） |
| `target` | `TEXT` | ✅ 实际接收方（邮箱/群机器人） |
| `ok` | `BOOLEAN` | ✅ |
| `error` | `TEXT` | ✅ |
| `ts` | `TIMESTAMPTZ` | ✅ |

➕ 建议补 `attempt INT`（重试次数）。索引：`(event_id)`、`(ts DESC)`；保留 ✅ **180 天**（本轮决策）。

### 5.13 `audit_logs`（✅ 结构已定）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `BIGSERIAL` PK | ✅ |
| `actor` | `TEXT`/`UUID` | ✅ 操作者（面板用户 uuid / `agent:<id>` / `system`） |
| `actor_type` | `TEXT` | ✅ `user` / `agent` / `system` |
| `action` | `TEXT` | ✅ 如 `agent.create` `agent.rotate` `rule.update` `login` `session.revoke_all` |
| `target` | `TEXT` | ✅ 目标标识 |
| `ip` | `INET` | ✅ |
| `detail` | `JSONB` | ✅ **脱敏后的**变更详情（禁止写入 key/secret 明文） |
| `ts` | `TIMESTAMPTZ` | ✅ |

索引：`(ts DESC)`、`(actor, ts DESC)`、`(action, ts DESC)`；保留 ✅ **365 天**（本轮决策）。

> ✅ 面板侧「操作留审计日志」为 §13 安全清单必做项；IP 变更历史/进程 Top/审计日志均**需登录**可见（§5.4）。

---

## 6. 写入路径与一致性边界

### 6.1 单次上报的落库顺序（➕ 建议）

```
POST /api/v1/agent/report
  → 中间件：大小上限 → gzip 解压（限输出字节）→ 原始 JSON buffer 验签 → JSON.parse → schema 校验 → 限流 → 幂等(batch_id)
  → 事务 BEGIN
      1) UPSERT agents：last_seen_at / last_ip / last_agent_ts / status='online' / host_info
      2) 时钟漂移计算 → clock_drift_ms、必要时生成 clock_drift 告警事件
      3) IP 追踪：与 last_ip 比较 → agent_ip_history（区间 UPSERT）→ 变化则 ip_change_events（含 Flapping 判定）
      4) 批量 INSERT metrics_raw（单条多值 / COPY，全部 ts=server_ts）
      5) INSERT process_snapshots（若本批含 process）
      6) 批量 INSERT probe_results（若本批含 probes）
    COMMIT
  → COMMIT 之后：PUBLISH live:metrics（Redis Pub/Sub）→ 告警引擎评估 → 通知队列
  → 响应 {ok:true, server_ts}
```

✅ 约束：**写库成功才应答**；幂等键 `batch_id` 在**进入事务前**用 Redis `SETNX` 占位（TTL 10min，决策 #18），避免重复批次重复入库。
➕ 建议：Redis 占位成功但事务失败时**删除占位**（否则该批次被永久判重而丢数据）；或把占位 TTL 设短（如 60s）容忍重试。

### 6.2 关键一致性点

| 点 | 要求 |
|---|---|
| 时间权威 | 写入 `ts`/`checked_at` 一律 `server_ts`；`agent_ts` 只存附加列（决策 #16） |
| 过期上报 | 中心丢弃 `ts` 迟于 **6h**（建议值）的上报（§5.3）；严格模式（超窗即拒）为 opt-in（决策 #17） |
| 跨机越权 | 请求体中的 `agent_id` 必须与签名者一致，否则拒绝并记审计（§6.4） |
| 幂等写入 | 降采样 `INSERT ... ON CONFLICT (agent_id, metric, bucket) DO UPDATE`（决策 #38）；IP 区间 UPSERT 幂等 |
| 迟到数据 | 单批内的 `ts` 统一为 `server_ts`；降采样任务**回看重算最近 N 个桶**（建议 N=3），保证迟到/重放不产生错桶 |
| 无下发 | 数据层不存在任何「Agent 待读队列 / 指令表」（§2.1） |

---

## 7. Redis 键空间契约

| 键 | 类型 | TTL | 用途 | 依据 |
|---|---|---|---|---|
| `ratelimit:agent:<agent_id>` | 计数/令牌桶 | 窗口期 | Agent 维度限流 | ✅ §5.2、§9 |
| `ratelimit:ws:<ip>` | 计数 | 窗口期 | WS 连接限流 | ✅ §9 |
| `nonce:<agent_id>:<nonce>` | string | **600s** | 防重放（≥ 签名窗口 300s） | ✅ §9、决策 #36 |
| `batch:<batch_id>` | string | **600s** | 幂等去重（决策 #18 写 10min） | ✅ §9、决策 #18 |
| `session:<sid>` | hash | 滑动 30min / 绝对 24h | 面板会话（`user_id,roles,totp_ok,created_at,last_seen,ip,ua,csrf`） | ✅ §18.1 |
| `user_sessions:<uid>` | set | 同会话 | 该用户全部 sid（限并发 3、踢最旧、全部下线） | ✅ §18.1、决策 #32 |
| `alert:cooldown:<rule_id>:<agent_id>` | string | 规则 `cooldown` | 告警静默期 + 同类合并 | ✅ §9、§7.3 |
| `live:metrics` | Pub/Sub 频道 | 不持久化 | 实时扇出（上报→落库→PUBLISH） | ✅ §9、§18.2 |
| `ratelimit:login:<ip>` | 计数 | 窗口期 | 登录限速 | ➕ §13 |
| `ratelimit:public:<ip>` | 计数 | 窗口期 | 公开接口/公开 WS 严格限流 | ➕ §5.4 |
| `snapshot:agent:<id>` | hash/string | 5–15s | 公开「当前快照」缓存 | ➕ §5.4「带缓存」 |
| `ip:recent:<agent_id>` | list/zset | 10min | Flapping 判定（窗口内变化次数） | ➕ 决策 #39 |
| `notify:tokenbucket:<channel_id>` | hash | 常驻 | 通道令牌桶 | ➕ 决策 #23 |
| `totp:used:<user_id>` | set | **90s** | TOTP 步号防重放（同一步只接受一次；✅ B7 已落地，此处补登记） | ✅ `docs/api.md` §4.1.1 ④ |
| `ratelimit:captcha:<ip>` | 计数 | 60s 窗口 | 滑块取题/验题限流（⛔ 与 `ratelimit:login` **独立**，"换一张图"不该消耗登录额度） | ✅ S 系列、`docs/api.md` §1.4 |
| `captcha:<captcha_id>` | hash | **120s** | 滑块题目与**答案**（`x`、`y`、`created_at`、`attempts`）；⛔ 答案只在 Redis，不进 PG/日志/响应 | ✅ S 系列 |
| `captcha:ok:<captcha_token>` | string | **120s** | 人机验证通过后的一次性凭证，**值 = 解出该题的 IP**（防 token 转卖） | ✅ S 系列 |
| `login:fail:ip:<ip>` | 计数 | 登录窗口（默认 300s） | 登录失败计数（按 IP）→ 决定"是否要求人机验证" | ✅ S 系列 |
| `login:fail:acct:<sha256(用户名)[:16]>` | 计数 | 登录窗口（默认 300s） | 登录失败计数（**按账号**）→ 兜住"代理池每个 IP 只试一次"的绕过；⛔ 键里不放明文用户名 | ✅ S 系列 |
| `captcha:vendor:down:<provider>` | 计数 | **30s** | 外部人机验证服务（极验）的**短时熔断**标记：不可达后置位，期间不再干等超时；`failMode=open` 时"熔断 = 该层视为不存在"（出题 404、登录不要求验证），`closed` 时仍要求凭证但立即 503。🔑 它是**性能优化而非安全控制**：读不到按未熔断处理 | ✅ S7、`docs/geetest-captcha.md` §9.3（C19） |
>
> 📌 **已落地（S7，2026-10-03）**：人机验证提供方已切为**极验 v4**（`CAPTCHA_PROVIDER`，未设置时按密钥自动推断，见 `docs/geetest-captcha.md` §8.1/§16）。对键空间的影响只有三点：① `captcha:<captcha_id>` 在 **`provider=geetest` 下不再使用**（题目与答案由极验云端管理，我们没有答案可存），`provider=selfbuilt` 下照旧；② `captcha:ok:*`、`login:fail:*`、`ratelimit:captcha:*` 四个键**完全不变** —— 它们是提供方无关的编排层（策略、计数、一次性凭证），这正是选「两步端点契约」的直接收益；③ 新增 `captcha:vendor:down:<provider>`（上表末行）。⚠️ `ratelimit:captcha:<ip>` 在极验下**更重要**：`/captcha/verify` 已成为全站唯一「匿名可触发外呼」的端点，此桶同时是外呼放大器的闸门。

> ✅ `nonce` TTL 必须 **≥ 签名窗口**（默认 600s ≥ 300s），消除 120–300s 重放窗口。
> ✅ 已定（本轮）：**单个 Redis 实例，不分 DB index、不拆实例**，各用途靠键名前缀区分（`session:` / `nonce:` / `batch:` / `ratelimit:` / `alert:cooldown:` / `live:` / `totp:used:` / `captcha:` / `captcha:ok:` / `captcha:vendor:` / `login:fail:`），并把 `maxmemory-policy` 设为 **`noeviction`** —— 否则 nonce/幂等键被驱逐会**重开重放窗口**、幂等失效。
> ➕ 落地要求：为 Redis `used_memory` 与 **`evicted_keys`（必须恒为 0）** 加运维监控；内存吃紧时先清理 `ratelimit:*`、`snapshot:*`（可重建），⛔ 不要靠开淘汰策略解决。若会话/限流将来把实例撑爆，再评估拆独立实例（当前 5 台规模不需要）。

---

## 8. 分区、降采样与保留

### 8.1 保留期矩阵（✅ 决策 #11 / #38）

| 数据 | 粒度 | 保留 | 清理方式 |
|---|---|---|---|
| `metrics_raw` | 15s | **15 天** | `DROP TABLE metrics_raw_YYYYMMDD`（分区级，秒级、无 VACUUM 压力） |
| `metrics_1m` | 1min | **90 天** | ✅ 不分区：每日分批 `DELETE WHERE bucket < now()-90d`（1 万行/批）+ 依赖 autovacuum |
| `metrics_5m` | 5min | **1 年** | ✅ 同上（`now()-1y`） |
| `ip_change_events` | 事件 | **永久** | —（✅ 决策 #11） |
| `alert_events` | 事件 | **永久** | —（✅ 决策 #11） |
| `probe_results` | 30s/目标 | ✅ **90 天**（本轮） | 分批 `DELETE WHERE checked_at < now()-90d` + 定期 VACUUM |
| `process_snapshots` | 30–60s | ✅ **30 天**（本轮） | 分批 DELETE（该表 `top` 为 JSONB，最占空间） |
| `agent_ip_history` | 区间 | ✅ **180 天**（本轮） | 分批 DELETE（按 `last_seen`） |
| `notification_log` | 每次发送 | ✅ **180 天**（本轮） | 分批 DELETE（按 `ts`） |
| `audit_logs` | 操作 | ✅ **365 天**（本轮） | 分批 DELETE（按 `ts`） |
| `silences` | — | 过期即清 | `DELETE WHERE ends_at < now() - interval '7 day'` |

### 8.2 定时任务（➕ 建议规格）

> ✅ **已实现（M1.5，2026-09-26）**：建分区 / Drop 分区 / 聚合 1m / 聚合 5m / 清理降采样 / 清理非时序表 六项已落地
> （`server/src/services/{partition,downsample,retention,cron}.service.js`）。剩余三项（离线判定 / Flapping 恢复 / 凭证轮换提醒）仍属 M3。
> **为什么提前**：迁移只预建「今天 +7」天分区，而兜底分区一旦落进某天的数据，该日期就**无法事后补建**（实测 `23514`），
> 15 天保留期也会随之静默失效 —— 这是带死线的问题。详见 `docs/design-deltas.md` §9。
> ⚠️ 两处实现差异（结果等价）：① 桶对齐改用 `to_timestamp(floor(extract(epoch from ts)/N)*N)` 而非 `date_trunc`
> （后者对 `timestamptz` 按**会话时区**截断，时区一变就写错桶）；② 删分区前增加**逐分区门禁**
> （该日有原始行但降采样层为空 → 拒绝删除，防永久数据空洞）。

| 任务 | 频率 | 动作 | 幂等要求 |
|---|---|---|---|
| 建分区 | 每日 1 次（另：启动时执行） | 预建未来 7 天 `metrics_raw_*`，`IF NOT EXISTS` | ✅ 幂等 |
| Drop 分区 | 每日 1 次 | 删除 `ts` 全部早于 `now()-15d` 的分区 | ✅ 幂等 |
| 聚合 1m | 每 1 分钟 | 把上一个完整分钟桶（含回看 N=3 桶）聚合写入 `metrics_1m` | ✅ `ON CONFLICT DO UPDATE` |
| 聚合 5m | 每 5 分钟 | 同上写入 `metrics_5m` | ✅ |
| 清理降采样 | 每日 1 次 | 1m > 90d、5m > 1y；**不分区分批 DELETE**（1 万行/批，见 §5.8） | ✅ 幂等（按 `bucket` 条件删） |
| 清理非时序表 | 每日 1 次（建议低峰） | 按 §8.1：`probe_results` 90d、`process_snapshots` 30d、`agent_ip_history` 180d、`notification_log` 180d、`audit_logs` 365d、过期 `silences`；**分批 DELETE**（建议每批 1 万行）避免长事务与膨胀 | ✅ 幂等（按时间条件删） |
| 离线判定 | 建议每 15–30s | `now()-last_seen_at > 3×周期` → 置 `offline` + 触发离线告警（§5.3） | ✅ 状态迁移需防抖（只在 online→offline 时发告警） |
| Flapping 恢复 | 每 1 分钟 | 稳定期后清 `agents.ip_flapping`（决策 #39） | ✅ |
| 凭证轮换提醒 | 每日 1 次 | 扫描 `now() - COALESCE(rotated_at, created_at) > credential_rotate.reminder_days`（默认 90）的 Agent → 面板徽标 + 经 `channels` **每日提醒一次**给管理员 → 写 `rotate_reminder_at`（✅ 本轮决策，见 §5.2） | ✅ 按日期去重；未处理则次日再提醒 |

> ✅ 已定（本轮）：所有定时任务**在 core 内单实例执行**（PG advisory lock 或 Redis 分布式锁 `cron:lock:<task>`），保证 core 多实例时不重复聚合/Drop。
> ➕ 建议：聚合任务失败要**告警**（自身也是被监控对象）；否则会出现「原始数据已 Drop、降采样缺失」的永久性数据空洞。

### 8.3 降采样 SQL 语义（规格，非实现）

- 桶对齐：`date_trunc('minute', ts)` / `date_trunc('hour', ts) + ((extract(minute from ts)::int/5)*5) * interval '1 minute'`（**统一 UTC**）。
  ⚠️ **实现已改为 `to_timestamp(floor(extract(epoch from ts)/N)*N)`**（N = 60 / 300）：两者在 UTC 下逐位等价，
  但 `date_trunc` 对 `timestamptz` 是按**会话时区**截断的 —— 任何一处 `SET timezone` 都会让桶边界整体偏移，
  写进 `(agent_id, metric, bucket)` 主键就是**错桶**（曲线错位且不报错）。
- 取值：`v_avg=avg(value)`、`v_min=min(value)`、`v_max=max(value)`、`v_last=(按 ts 取最后一条)`、`n=count(*)`。
- 重入：`ON CONFLICT (agent_id, metric, bucket) DO UPDATE SET ...`（决策 #38「幂等可重入」）。
- ✅ 已实现（M1.5）：一次覆盖最近 `lookbackBuckets+1` 个**完整**桶（默认 4 个），
  迟到数据落进已聚合的桶时靠 `DO UPDATE` 重算自愈；当前未完成的桶**不参与聚合**。
- ⛔ 触发 Drop 原始分区前必须先确认降采样已覆盖该日（实现为**逐分区** `EXISTS` 门禁），
  否则会产生"原始数据删了、降采样没写进去"的**永久空洞**。

---

## 9. 容量估算（5 台机基线）

✅ 设计 §9 给出：15s 粒度 → **5 台 ≈ 144 万行/天**。反推：144 万 ÷ 5 ÷ (86400/15 = 5760) ≈ **50 条序列/台**（≈ 每台 50 个 metric 时间线，含每核 CPU、各挂载点、各网卡、各 GPU）。

| 层 | 行数/天 | 保留 | 稳态行数 |
|---|---|---|---|
| `metrics_raw` | ≈144 万 | 15 天 | ≈2160 万 |
| `metrics_1m` | ≈36 万 | 90 天 | ≈3240 万 |
| `metrics_5m` | ≈7.2 万 | 1 年 | ≈2630 万 |

➕ 粗估（单行含索引 ~60–100B）：原始层 ≈1.5–2.2GB、1m ≈2–3GB、5m ≈1.6–2.6GB → **时序层约 5–8GB**。
✅ 非时序表（本轮定完保留期）粗估：`probe_results`(90d) ≈0.4GB、`process_snapshots`(30d) ≈0.2GB、`agent_ip_history`(180d)/`notification_log`(180d)/`audit_logs`(365d) 合计 <0.1GB → **合计约 0.7GB**。
➡️ **PG 数据总量约 6–9GB**（不含 WAL、备份与索引膨胀余量）。
➕ 建议：以上为**推算值，需按实际序列数复核**；序列数随 CPU 核数/挂载点/网卡数增长，**CPU 每核一条序列**是主要放大因子——若某机 64 核，单机序列数可翻倍。
➕ 建议：PG 参数方向（参考）：`shared_buffers` 内存 25%、`work_mem` 适度（时序聚合排序）、`autovacuum` 对降采样表保持默认、`wal_compression=on`。具体值待压测。

---

## 10. 备份、恢复与运维

| 项 | 建议 |
|---|---|
| 备份频率 | 每日 `pg_dump`（逻辑，含 schema + 数据）或 `pg_basebackup` + WAL 归档（可选 PITR） |
| 备份保留 | ≥ 7 份日备；`metrics_raw` 可排除（价值低、体积大），或仅备 schema |
| 恢复演练 | ➕ 建议 M3 前完成一次「空库 + 备份恢复」演练 |
| Redis 持久化 | 可关闭（数据可重建）；若开启 RDB，注意会话丢失＝用户重新登录（可接受） |
| 只读排障 | 用 `vantage_ro` 连接，禁止 DDL |
| 迁移 | `server/migrations/` 版本化 SQL（设计 §11.3），**只前进不回滚**；每迁移附带幂等说明 |
| 初始化 | `scripts/` 提供建库脚本；✅ 密钥不写进脚本（决策 #37 同源思路） |

---

## 11. 安全与合规

- ✅ 凭证**明文永不入库/入日志**：`agents.agent_key_hash`（HMAC-pepper 哈希，不可逆）与 `agents.agent_secret_enc`（AES-256-GCM 密文，⚠️ 必须可逆——HMAC 验签要重算签名）；`channels.config` 敏感项与 `users.totp_secret_enc` 同样**应用层加密**（主密钥来自 env/secret 管理，不入库）。
- ✅ 审计日志 `detail` 必须脱敏（禁止写入 key、secret、Cookie、SMTP 密码）。
- ✅ 数据库只监听本地/容器内网（§13），不暴露公网。
- ✅ `X-Forwarded-For` 可信代理白名单（§13）—— 影响 `audit_logs.ip`、`agent_ip_history.ip` 的真实性，**伪造成本必须可控**。
- ✅ 许可：项目 AGPL-3.0（§16）；依赖许可干净（PostgreSQL/Redis 宽松）。

---

## 12. 待 Owner 拍板清单（本文视角）

### 12.1 ✅ 本轮已拍板（已写入正文）

| # | 议题 | 结论 | 落点 |
|---|---|---|---|
| R1 | 凭证轮换 | **不做新旧并存/自动轮换**：单套凭证 + 面板提示 + 定期通知管理员**手动**轮换 | §3、§5.1、§5.2、§8.2 |
| R2 | `agents.name` | **唯一**（`UNIQUE`） | §5.1 |
| R3 | 用户权限字段 | 新增 `role`，**暂时两级**：`admin` / `user` | §5.3 |
| R4 | 用户表 SSO 预留 | 新增 OIDC 字段：`oidc_issuer` / `oidc_subject` / `oidc_email` / `oidc_linked_at` / `oidc_last_sync_at`（本期只落库，不实现流程） | §5.3 |
| R5 | 指标维度落库方式 | **方案 A：维度写进指标名**（`disk.used_pct{mount=/}`），主键 `(agent_id, metric, ts)` 不变；`labels` 降级为便利副本；转义规则见 §5.7.2 | §5.7.1、§5.7.2、§5.8 |
| R6 | 轮换提醒口径 | 旧凭证**立即失效**；提醒阈值**可配**（`credential_rotate.reminder_days`，默认 **90** 天）+ 面板徽标 + 超阈后**每日一次**通知（`rotate_reminder_at` 按日期去重） | §5.1、§5.2、§8.2 |
| R7 | 普通用户权限 | **纯只读**：可看全部内容，所有写操作仅 `admin`（不做「部分写」中间态） | §5.3 |
| R8 | 告警规则引用指标 | **基名（逐维度序列分别判定）+ 全名（单序列）都支持**；事件用 `alert_events.metric` 记录触发序列全名；UI 开关映射为基名/全名，不新增字段 | §5.7.2、§5.11、§5.12 |
| R9 | 公开接口主机标识 | **独立 `public_slug`**（`agents.public_slug`，随机短 ID、UNIQUE、不随改名变化）；⛔ 公开响应/URL 不含内部 UUID | §5.1 |
| R10 | 非时序表保留期 | `probe_results` **90 天**、`process_snapshots` **30 天**、`agent_ip_history` **180 天**、`notification_log` **180 天**、`audit_logs` **365 天**、`silences` 过期后 7 天清 | §3、§8.1、§8.2 |
| R11 | 规则与通道的关联 | 规则只存 **`channels.id` 数组**（通道库复用，密钥只存一份）；通道禁用则跳过发送（记 `channel_disabled`）；删除被引用通道 → 409 `channel_in_use` | §5.4、§5.11 |
| R12 | 非阈值规则参数 | 统一 `alert_rules.params JSONB` + 按 `kind` 白名单（`probe`/`ip_change`/`offline`/`clock_drift` 各自结构见 §5.11），未知键直接拒绝；列不随规则类型膨胀 | §5.11 |
| R13 | 分区维护归属 | **core 内置定时任务 + 分布式锁**（PG advisory lock / Redis `cron:lock:*`）；DDL 走独立 `vantage_migrator` 连接，运行时 DML 仍用 `vantage_app` | §2、§8.2 |
| R14 | 降采样层分区 | **不分区**，每日分批 DELETE（1 万行/批，只删刚过期那一天）+ 依赖 autovacuum 回收 | §5.8、§8.1、§8.2 |
| R15 | Redis 隔离策略 | **单实例 + 键名前缀区分 + `maxmemory-policy noeviction`**（⛔ 不拆 DB index/实例）；监控 `used_memory` 与 `evicted_keys`（须恒为 0） | §7 |
| R16 | 面板开关的存储 | **PG 新增 `settings` 表**（key 白名单 + JSONB value），面板 `PATCH` 后**立即生效**（Redis 缓存 30s + 变更失效），缺行取代码默认值，每次变更写审计；⛔ 密钥不入本表 | §3、§5.4 |
| R17 | `public_view.enabled` 默认值 | ✅ **默认开启**；配套：公开接口/WS 按 IP 严格限流 + 严格脱敏 + 设置页醒目状态与一键关闭 | §5.4、`docs/api.md` §3.2 |
| R18 | 主机状态机 | **只有 `online` / `offline` / `disabled`**，⛔ 不加 `abnormal`；「有告警／时钟漂移／IP Flapping」用派生徽标与计数表达 | §5.1、`docs/frontend.md` §4.3 |
| R19 | 维度值变化（设备重命名） | **不做历史数据迁移**：维度值变了就是**新序列**，曲线自然断开（⛔ 不改历史行、不做别名映射）；面板在维度选择器里同时列出新旧序列 | §5.7.2 |

### 12.2 仍待拍板

| # | 议题 | 影响 | 说明 |
|---|---|---|---|
| N3 | SSO 对接时的角色映射（IdP claim/group → `admin`/`user`）与是否允许自助绑定 | 后续 SSO 里程碑 | ✅ 按建议保留为**待对接 SSO 时再定**，不阻塞任何里程碑；`users` 的 OIDC 预留字段已就位（§5.3） |

> ✅ 其余数据库侧议题（凭证/权限/维度/保留期/分区/Redis/公开标识/状态机等）**已全部拍板**，见 §12.1；本文不再有待决策项。

---

## 13. 与设计文档的对照（溯源）

| 本文位置 | 设计文档来源 |
|---|---|
| §1.3、§6 | §2.1 单向宗旨、§6.4 权限 |
| §5.1–5.2 | §6.1 凭证模型、§9 `agents`、✅ 本轮「凭证不轮换 + 提醒」决策 |
| §5.3 | 决策 #31（PG `users`）、✅ 本轮权限字段（admin/user）与 OIDC 预留字段决策 |
| §5.4 | §7.1 静默窗口、§7.2 通道 |
| §5.5–5.6 | §8 IP 追踪、决策 #39 |
| §5.7–5.8 | §9 数据模型、决策 #11/#38、✅ 本轮「维度写进指标名」决策（§5.7.1–§5.7.2） |
| §5.9–5.10 | §9、§4.6 探活闭环 |
| §5.11–5.13 | §7.1–7.3 告警、§13 审计 |
| §6 | §5.3 心跳/离线/过期上报、§6.5 时间权威 |
| §7 | §9 Redis 键空间、§18.1 会话、决策 #23/#36/#18 |
| §8 | §9 保留与降采样、决策 #11/#14/#38、✅ 本轮凭证轮换提醒任务 |
| §9 | §9「144 万行/天」、§3 规模 |
| §11 | §13 安全清单 |
