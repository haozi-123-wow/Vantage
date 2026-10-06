# Vantage 设计修订清单（design-deltas）

> **用途**：把「本轮 Owner 拍板」与「拆分四份专项文档时发现的矛盾/空白」逐条对照 `Vantage-DESIGN-v0.7.md` 的**原文口径**列出。
> ✅ **状态：已应用（2026-09-26）** —— 设计文档已按本清单更新为 **v0.8**（文件名仍为 `Vantage-DESIGN-v0.7.md`，内部版本号/变更记录/§4·§5·§6·§9·§9.1·§10·§11·§12·§13·§15·§16·§18·§19 均已改）。
> **本文现在的用途**：作为 v0.7 → v0.8 的**变更审计底稿**（可逐条复核是否落到位）；后续再有修订，继续往下追加条目即可。
> **图例**：🔴 **必须改正文**（原文与结论冲突）｜🟡 **需补章节/补表**（原文缺失）｜🟢 **仅补措辞**（不改结论）｜⏳ 仍挂起

---

## 0. 结论摘要

| 类别 | 条数 | 影响 |
|---|---|---|
| 🔴 **必须改正文**（原文与结论冲突，D-01 ~ D-12） | 12 | §4.7/§4.9、§5.3、§5.4、§6.1、§6.2、§6.6、§9、§10.1、§10.2、§11.2、§12.2/§13、§18.2、决策 #37/#38 |
| 🟡 **需补章节/补表**（原文空白，D-13 ~ D-22） | 10 | `settings`、`channels`、`silences`、`user_recovery_codes`、`users` 表；指标命名规范；保留期矩阵；定时任务；Redis 键空间；Flapping 承载列 |
| 🟢 **仅补一句措辞**（结论不变，见 §5） | 3 | 决策 #14（无缓存模块）、#34（只读本地文件）、#35（canonical 已规范化）+ §5 列出的 40 余条原文条目无需改动 |
| ⏳ **仍挂起** | 2 | 告警接收端账号信息（M3 联调前给）；SSO 角色映射（对接 SSO 时定） |
| **决策编号变动** | #5/#11/#15/#21/#24/#31/#32/#37/#38 修订；**新增 #40–#59** | 见 §3 |

---

## 1. 🔴 必须修订设计文档正文的条目

### D-01　Agent 目录里的 `internal/buffer/` 与「不补传」冲突

| 项 | 内容 |
|---|---|
| 设计位置 | §4.3（磁盘 ≈ 0）、§4.7（丢弃式）、**§11.2 目录列 `internal/buffer/`（离线环形缓存，有上限）**、决策 #14 |
| 原口径 | §11.2 保留了一个「离线环形缓存」模块 |
| **本轮结论** | ✅ **删除 `internal/buffer/`**；Agent 无任何磁盘缓存，重试仅由 `internal/retry/` 在内存完成当前批次 |
| 理由 | 与 §4.3「磁盘占用 ≈ 0」、§4.7「不缓存不补传」、决策 #14 直接矛盾；保留缓存等于隐性改掉断网策略 |
| 落笔 | 删 §11.2 该行；§4.7 加一句「实现上不存在任何缓存模块」 |
| 依据 | `docs/agent.md` §2（G1）、§11.1 |

### D-02　维度不能只放 `labels`（主键会撞）

| 项 | 内容 |
|---|---|
| 设计位置 | §9 `metrics_raw(agent_id, metric, value, labels, ts) PRIMARY KEY(agent_id, metric, ts)`；同处注释举例 `gpu.0.util` |
| 原口径 | 维度（挂载点/网卡/GPU 序号）语义上放 `labels`，注释里又出现 `gpu.0.util` 这种把序号写进 metric 名的写法 |
| **本轮结论** | ✅ **维度写进指标名**：`disk.used_pct{mount=/}`、`disk.used_pct{device=sda1,mount=/data}`、`net.rx_bps{device=eth0}`、`gpu.util{index=0}`、`cpu.core.usage{core=3}`；主键 `(agent_id, metric, ts)` **不变**；`labels` 降级为由全名反解的**便利副本**（非权威）；⛔ `gpu.0.util` 写法作废 |
| 理由 | 同机两个挂载点在同一时刻会产生相同 `(agent_id, metric, ts)` → 主键冲突互相覆盖；`JSONB` 无法进 PG 主键 |
| 落笔 | 改 §9 该表注释；**新增一节「指标命名与维度转义规范」**（维度键字母序、`%`/`{}`/`=`/`,`/空白 → 百分号编码且 `%` 必须一起转义、无维度不带花括号、全名 ≤ 200 字符、两端共用 `buildMetric/parseMetric` + 测试向量） |
| 依据 | `docs/database.md` §5.7.1–§5.7.2（R5） |
| 连带 | 告警规则 `metric` 支持**基名**（逐维度序列分别判定）/ **全名**（单序列）；`alert_events.metric` 记触发序列全名（`docs/database.md` §5.11/§5.12、R8） |

### D-03　降采样层「超期同样按分区 Drop」不成立

| 项 | 内容 |
|---|---|
| 设计位置 | §9 保留与降采样；决策 #38 |
| 原口径 | 「1m 存 90 天、5m 存 1 年；超期同样按分区 Drop」 |
| **本轮结论** | ✅ `metrics_1m` / `metrics_5m` **不分区**，超期走**每日分批 DELETE**（每批 1 万行，每次只删刚过期那一天：1m ≈36 万行、5m ≈7.2 万行），依赖 autovacuum 回收 |
| 理由 | 只有 `metrics_raw` 按天分区；对 5 台规模给降采样表建分区（一年 365 个）是过度设计，且每日增量删除量很小 |
| 落笔 | 改 §9 措辞与 #38 |
| 依据 | `docs/database.md` §5.8、§8.1、§8.2（R14） |

### D-04　凭证「新旧并存轮换」不实现

| 项 | 内容 |
|---|---|
| 设计位置 | §6.1「支持：创建、吊销、**轮换（新旧并存过渡）**、禁用」；§9 `agents` 只有 `agent_key_hash` / `agent_secret_hash` 各一列 |
| 原口径 | 轮换时新旧并存过渡 |
| **本轮结论** | ✅ **不做并存/自动轮换**：一个 Agent 任一时刻只有**一套**凭证；`agents` 单列足够（**不需要 `agent_keys` 多 key 表**）；轮换 = 管理员在面板显式操作 → 旧凭证**立即失效**（无宽限期）→ 因中心不能下发新 key，**必须人工上机替换**后 `reload`/`restart`；遗忘轮换不会失效，靠**面板徽标 + 每日一次通知**驱动（阈值 `credential_rotate.reminder_days`，默认 90，可配） |
| 理由 | 单向宗旨下「自动并行期」既无下发通道也需要额外表；监控可用性由离线告警覆盖 |
| 落笔 | 改 §6.1 措辞；§9 `agents` 加 `rotate_reminder_at`（提醒去重）、`public_slug`（见 D-05）；新增「凭证到期提醒」定时任务到 §9 定时任务描述 |
| 依据 | `docs/database.md` §5.1/§5.2（R1/R6）、`docs/api.md` §4.4、`docs/frontend.md` §4.6 |

### D-05　公开接口的 `:id` 与「绝不泄露内部 ID」冲突

| 项 | 内容 |
|---|---|
| 设计位置 | §5.4「绝不泄露 key/内部 ID」；§10.2 `GET /api/public/hosts/:id/now`；决策 #21 |
| 原口径 | 公开接口用 `:id`（易被理解为内部 UUID） |
| **本轮结论** | ✅ 明文定：公开接口用**独立 `public_slug`**（`agents.public_slug`，创建时生成的随机短 ID、UNIQUE、不随改名变化），`:id` 即 slug；⛔ 公开响应与 URL **不含内部 UUID** |
| 理由 | 满足 §5.4 的隐私要求，同时保留未来公开链接的稳定性 |
| 落笔 | §10.2 把 `:id` 写成 `:slug`；§9 `agents` 加 `public_slug TEXT UNIQUE NOT NULL` |
| 依据 | `docs/database.md` §5.1（R9）、`docs/api.md` §3.1/§3.2 |

### D-06　WS 客户端消息集合自相矛盾

| 项 | 内容 |
|---|---|
| 设计位置 | §18.2「客户端 → 服务端方向**仅允许 subscribe / ping**」，同段又写「服务端定时 ping / 客户端 pong」；§18.3 单向一致性约束 |
| 原口径 | 允许集合既说两项、又要求客户端发 pong |
| **本轮结论** | ✅ **应用层只允许 `subscribe`**；保活改用 **RFC6455 协议层 ping/pong 帧**（服务端发 ping 帧，浏览器自动回 pong，JS 不参与；服务端用 `ws` 的 `pong` 事件判活）；⛔ 收到任何其它应用层消息 → 关闭连接 `1008` 并记审计 |
| 理由 | 把客户端→服务端的应用层消息面收敛为一条，最贴合「WS 不得成为下发通道」；同时消除设计文档措辞冲突 |
| 落笔 | 改 §18.2/§18.3 措辞（把 ping/pong 明确为协议层） |
| 依据 | `docs/api.md` §5.2/§5.3（A7）、`docs/frontend.md` §5.3 |

### D-07　签名串未指定分隔符

| 项 | 内容 |
|---|---|
| 设计位置 | §6.2 `signature = HMAC_SHA256(secret, method + path + timestamp + nonce + sha256(body))` |
| 原口径 | 四项直接拼接，无分隔符，也未说 path 是否含 query |
| **本轮结论** | ✅ canonical 固定为 `method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(raw_body)`（LF 分隔 4 处、末尾不加换行）；`path` 仅路径，⛔ 不含 host/query；`timestamp` 为十进制 ASCII unix 毫秒；要求 Agent 与 core 配**共享测试向量** |
| 理由 | 裸拼接存在边界歧义（`path` 尾部数字与 `timestamp` 粘接可被构造） |
| 落笔 | 改 §6.2 代码块与说明；决策 #35 补一句「canonical 已规范化」 |
| 依据 | `docs/api.md` §2.1（A1）、`docs/agent.md` §6.2 |

### D-08　「异常」态与 `agents.status` 三值不一致

| 项 | 内容 |
|---|---|
| 设计位置 | §5.3「状态：在线 / 离线 / **异常** + 最后在线时间」；§9 `agents.status` 注释 `online/offline/disabled` |
| 原口径 | 正文出现第三种状态「异常」，表中没有 |
| **本轮结论** | ✅ **不引入 `abnormal`**：状态只有 `online` / `offline` / `disabled`；「有告警 / 时钟漂移 / IP Flapping」一律用**派生徽标与计数**表达（`clock_drift_ms`、`agents.ip_flapping`、firing 事件数） |
| 理由 | 「异常」语义模糊（是告警态？数据可疑态？），引入后会与告警引擎、漂移、Flapping 三套来源重复且难同步 |
| 落笔 | 改 §5.3 的状态描述 |
| 依据 | `docs/database.md` §5.1（R18）、`docs/frontend.md` §4.3 |

### D-09　决策 #37（key 传递）修订 —— 面板可给带 key 的一键命令

| 项 | 内容 |
|---|---|
| 设计位置 | §12.2 安全提示、§15 决策 #37、§13 安全清单「key 不经命令行；安装后即时清理」 |
| 原口径 | 「**禁用**命令行 `--key`；**优先**交互式/stdin，其次 `VANTAGE_KEY`/`--key-file`」——即把 env 形式列为次选 |
| **本轮结论（Owner 明确修订）** | ✅ 面板**默认给出一条带 key 的一键命令**，使用 **`VANTAGE_KEY=<key>` 环境变量内联**形式；同时**再单独展示一次** `agent_key`/`agent_secret` 明文；并一并给出**交互式/stdin** 与 `--key-file` 两种更安全形式供选择；⛔ **仍然禁止 `--key <明文>` 参数**（`ps` / `/proc/$PID/cmdline` 可见）；⚠️ 面板必须标注风险与善后：env 形式会进 **shell history**、root 可读 `/proc/$PID/environ`，脚本落地后即时 `unset`，建议 `history -d` 清理或改用 `--key-file` |
| 理由 | Owner 选择「便利优先 + 单独展示一份」的组合；保留 `--key` 参数禁令以不放弃最危险的那条 |
| 落笔 | 改 §12.2 安全提示、§13 安全清单该条、§15 决策 #37；§12.3 上线流程第 2 步同步（命令含 env key） |
| 依据 | `docs/api.md` §4.4「决策 #37 修订」/A8、`docs/agent.md` §6.1/§12.1 |

### D-10　`GET /api/v1/agents` 的轮换提醒字段

| 项 | 内容 |
|---|---|
| 设计位置 | §10.2 接口清单（未涉及凭证年龄/提醒） |
| **本轮结论** | ✅ 列表返回 `credential_age_days`、`rotate_recommended`，响应根级附 `rotate_policy: { days, notify }`（阈值由后端下发，前端不硬编码） |
| 落笔 | 补 §10.2 |
| 依据 | `docs/api.md` §4.4、`docs/frontend.md` §4.6 |

### D-11　上报体积与重试参数（原文只提「防 zip bomb」）

| 项 | 内容 |
|---|---|
| 设计位置 | §6.6「解压前判 `Content-Length` 上限，解压时限制输出字节数」；§4.7「有限次快速重试（如 3 次/几十秒）」 |
| **本轮结论** | ✅ 中心：压缩前上限 **1MB**、解压输出上限 **4MB**（超限 413，⛔ 不进入 `JSON.parse`）；Agent：单批压缩前 **256KB** 熔断（裁剪顺序：`process.top` 截半 → 丢 GPU 次要指标 → 丢 `net.err/drop`、`disk.latency_ms`；仍超限则丢弃该批并记日志）；重试 **最多 3 次 / 2s 起指数 / 总时长 ≤ 30s** |
| 落笔 | §6.6 补具体数值；§4.7 补重试参数与裁剪顺序 |
| 依据 | `docs/api.md` §2.1（A4）、`docs/agent.md` §5.2/§5.3（G2） |

### D-12　能力声明在 §10.1 上报体里没有落点

| 项 | 内容 |
|---|---|
| 设计位置 | §4.9「每个采集器带能力声明」；§10.1 上报体未列该字段 |
| **本轮结论** | ✅ 能力声明放 **`host.capabilities`**（布尔键值：`disk.inode`、`disk.io`、`net.conn_count`、`gpu.nvidia`、`gpu.amd`、`process.top`、`probe.ping`、`probe.http`、`probe.tcp`、`docker`），**首次上报与能力变化时必填**、其余可省；⛔ 白名单外的键拒绝；中心落 `agents.capabilities`，面板据此隐藏不支持的图表/列 |
| 落笔 | §10.1 上报体补 `host.capabilities`；§4.9 补「随上报携带」 |
| 依据 | `docs/api.md` §2.1（G5）、`docs/database.md` §5.1、`docs/agent.md` §3 |

---

## 2. 🟡 设计文档需要补的章节 / 表（原文空白）

| # | 补什么 | 放在哪 | 关键内容 | 依据 |
|---|---|---|---|---|
| D-13 | **`settings` 表** + 面板设置接口 | §9 表清单、§10.2 接口 | key 白名单（`public_view.enabled`、`security.require_2fa`、`credential_rotate.reminder_days`、`credential_rotate.notify`）+ JSONB value；`PATCH /api/v1/settings` **立即生效**（Redis 缓存 30s + 变更失效）、缺行取代码默认值、每次变更写审计；⛔ 不放密钥 | §5.4「可整体开关」原本无落点；`docs/database.md` §5.4（R16）、`docs/api.md` §4.10 |
| D-14 | **`channels` 表**（通知通道） | §9 | 通道是**凭证与模板的唯一归属方**（`config` 敏感项加密）；规则只存 `channels.id` 数组，⛔ 不内联参数；通道 `enabled=false` 时跳过发送（记 `channel_disabled`）；删除被引用通道 → 409 `channel_in_use` | §7.2「每通道独立模板/可开关/可测发送」原本无表；`docs/database.md` §5.4（R11） |
| D-15 | **`silences` 表**（静默窗口/维护期） | §9 | `target` 与规则 `target` 同构；过期后 7 天清理 | §7.1「支持静默窗口/维护期」原本无表；`docs/database.md` §5.4 |
| D-16 | **`user_recovery_codes` 表** | §9、§6 | 10 个一次性恢复码（只存哈希、用后作废、重新生成即作废旧码）；配合两条恢复渠道 | 本轮新增（见 §3 #44）；`docs/database.md` §5.4 |
| D-17 | **`users` 表结构**（含权限与 SSO 预留） | §9 | `role`（**暂时两级** `admin`/`user`）、`email`、`password_hash`（SSO-only 可为 NULL）、`totp_secret_enc`/`totp_enabled`/`totp_bound_at`、`oidc_issuer`/`oidc_subject`/`oidc_email`/`oidc_linked_at`/`oidc_last_sync_at`、`status`、`last_login_*` | 决策 #31 只说「用户账号在 PG `users`」；`docs/database.md` §5.3（R3/R4） |
| D-18 | **指标命名与维度转义规范**（新章节） | 建议插在 §9 之前或 §10.1 之后 | 见 D-02；含完整指标清单与单位、`cpu.core.usage{core=n}` 取代 `cpu.core.<n>.usage` | `docs/database.md` §5.7.2 |
| D-19 | **保留期矩阵（补全）** | §9「保留与降采样」 | 在原有（原始 15d／1m 90d／5m 1y／IP 变更与告警事件永久）之外补：`probe_results` **90d**、`process_snapshots` **30d**、`agent_ip_history` **180d**、`notification_log` **180d**、`audit_logs` **365d**、`silences` 过期 7d 清；并新增**每日清理定时任务**（分批 DELETE） | 决策 #11 只覆盖指标与事件；`docs/database.md` §8.1/§8.2（R10） |
| D-20 | **定时任务清单（补全）** | §9 | 建分区（预建 7 天，含 DEFAULT 分区兜底）、Drop 15 天前分区、聚合 1m/5m（回看 3 桶）、清理降采样、清理非时序表、离线判定（防抖）、Flapping 恢复、**凭证到期提醒（每日一次）**；全部**单实例执行**（PG advisory lock / Redis 锁）；⛔ 失败必须告警 | §9 只说「定时任务」；`docs/database.md` §8.2（R13/R14/R6） |
| D-21 | **Redis 键空间补全 + 策略** | §9 Redis 键空间 | 补 `ratelimit:login:<ip>`、`ratelimit:public:<ip>`、`snapshot:agent:<id>`、`ip:recent:<agent_id>`、`notify:tokenbucket:<channel_id>`、`settings:cache`；✅ 单实例 + 键名前缀区分 + **`maxmemory-policy noeviction`**（⛔ 不拆 DB index/实例），监控 `used_memory` 与 `evicted_keys`（须恒为 0） | 防 nonce/幂等被驱逐导致重放窗口重开；`docs/database.md` §7（R15） |
| D-22 | **Flapping 事件的承载** | §8、§9 | `ip_change_events` 扩列 `source` / `kind`（`change`/`flapping`）/ `change_count`；`agents` 增 `ip_flapping`、`flapping_since`、`clock_drift_ms`、`reported_ip`、`host_info`、`capabilities` | §8 说「只记一条 `ip_flapping` 事件」但 §9 无对应列；`docs/database.md` §5.1/§5.6 |

---

## 3. 🟢 决策表（§15）需修订与新增的条目

### 3.1 需修订

| 编号 | 原决策 | 修订后 |
|---|---|---|
| #37 | Key 传递：禁用命令行，优先交互/stdin，其次 env/`--key-file` | ✅ **面板默认给带 `VANTAGE_KEY` 的一键命令** + key 单独展示一次，同时给交互式/stdin 与 `--key-file` 两种形式；⛔ 仍禁 `--key` 参数；⚠️ 需写清 history/environ 风险与善后（见 D-09） |
| #38 | 指标存储与保留：原始按天分区 15 天 + 降采样 1m/5m，**超期同样按分区 Drop** | ✅ 原始层不变；**降采样层不分区**，超期走每日分批 DELETE（见 D-03）；保留期矩阵扩到全部表（D-19） |
| #11 | 数据保留：原始 15 天／1m 90 天／5m 1 年／IP 变更与告警事件永久 | ✅ 追加：探活 90 天、进程快照 30 天、IP 区间 180 天、通知日志 180 天、审计 365 天、静默过期 7 天清 |
| #21 | 公开视图隐私：默认隐藏 IP/内网 | ✅ 追加：公开标识用独立 **`public_slug`**（⛔ 不含内部 UUID，见 D-05） |
| #31 / #32 | 面板有状态会话；会话策略 | ✅ 追加：权限**暂时两级** `admin`/`user`（`user` 纯只读）；2FA **面板自助** + 一次性恢复码 + 管理员重置；会话机制本身不变 |
| #34 | Agent SIGHUP 热重载 | 🟢 不变；补一句「重载只读本地文件，⛔ 不存在从中心拉配置的路径」 |
| #14 | 断网丢弃式 | 🟢 不变；补一句「实现上无任何缓存模块」（见 D-01） |
| #35 | 签名校验顺序 | 🟢 不变；补 canonical 已规范化（见 D-07） |

### 3.2 建议新增（#40 起）

| 编号 | 议题 | 决策 |
|---|---|---|
| #40 | 指标维度落库 | **维度写进指标名**（方案 A），主键不变，`labels` 降为副本（D-02） |
| #41 | 公开接口主机标识 | 独立 **`public_slug`**（即决策 #21 的落地细化，见 D-05） |
| #42 | 凭证轮换 | **不并存**：单套凭证、旧凭证立即失效、人工上机替换；靠面板徽标 + 每日一次提醒驱动（阈值可配，默认 90 天）（D-04） |
| #43 | 面板开关存储 | PG **`settings` 表**（白名单 key + JSONB），面板可改、**立即生效**、变更写审计（D-13） |
| #44 | 2FA 与恢复 | 面板自助绑定/解绑；**一次性恢复码**（10 个/哈希/用后作废/可重生成）+ **管理员后台重置某用户 2FA**（清绑定 + 作废恢复码 + 踢下线 + 审计）；`security.require_2fa` 可强制（D-16） |
| #45 | WS 客户端消息 | 应用层**只允许 `subscribe`**；保活走**协议层 ping/pong 帧**；其它消息关闭 `1008`（D-06） |
| #46 | 签名 canonical | 固定 `\n` 分隔 + path 仅路径 + 共享测试向量（D-07） |
| #47 | 上报体积与重试 | 1MB/4MB（中心）、256KB 熔断 + 3 次/2s 指数/≤30s（Agent）（D-11） |
| #48 | 非时序表保留期 | 探活 90d／进程 30d／IP 区间 180d／通知 180d／审计 365d／静默过期清（D-19） |
| #49 | 降采样层分区 | **不分区**，每日分批 DELETE（D-03） |
| #50 | 分区维护归属 | **core 内置任务 + 分布式锁**；DDL 走独立 migrator 连接，运行时 DML 用最小权限角色（D-20） |
| #51 | Redis 隔离 | 单实例 + 键名前缀 + **`noeviction`**（D-21） |
| #52 | 面板权限 | **暂时两级** `admin`/`user`；`user` **纯只读**（写操作仅 `admin`） |
| #53 | 公开视图默认值 | **默认开启**（配套：严格限流 + 严格脱敏 + 设置页醒目状态与一键关闭）（D-13） |
| #54 | Agent 缓存模块 | **删除 `internal/buffer/`**（D-01） |
| #55 | 能力声明位置 | `host.capabilities`（布尔白名单，首次与变更时必填）（D-12） |
| #56 | 前端组件库 | **Element Plus** + 按需引入（禁全量 import）+ CSS 变量定制 |
| #57 | 主机状态机 | 只有 `online`/`offline`/`disabled`，⛔ 不加 `abnormal`（D-08） |
| #58 | 维度值变化（设备重命名） | **不迁移历史**：视为新序列，曲线自然断开；面板同时列出新旧序列 |
| #59 | 告警字段口径 | 规则 `channels` 只存**通道 id 数组**（通道是凭证/模板的唯一归属方）；非阈值类参数统一 **`params` JSONB + 按 `kind` 白名单**；规则 `metric` 支持**基名（逐维度序列分别判定）/ 全名（单序列）**；事件用 `alert_events.metric` 记触发序列全名；静默落 `silences` 表；⛔ **不做事件 `ack`**（由 `silences` + `cooldown` 覆盖） |

---

## 4. 设计文档 §15 末尾「仍待 Owner 拍板」四项的裁定

| 原挂起项 | 结果 |
|---|---|
| 具体告警接收端（SMTP 账号、企微/钉钉/飞书 Webhook、标准接口端点） | ⏳ **仍挂起**——需你提供账号/机器人地址；技术上已就绪：`channels` 表 + 「测试发送」（D-14） |
| 面板多用户与 RBAC 角色划分细节 | ✅ **已裁**：暂时两级 `admin`/`user`，`user` 纯只读（#52）；SSO 角色映射留到对接 SSO 时定 |
| 采集频率最终取值 | ✅ **已裁**：15s；⚠️ 2026-10-04 由 **G3** 修订为 **30s**（Agent 侧 `report.interval` 默认值，采集周期同步对齐；中心离线阈值 = 3×30s = **90s**），以代码为准，见 `agent/internal/config/config.go`、`docs/agent.md` G3 |
| 公开视图默认开还是关 | ✅ **已裁**：**默认开**（#53） |

---

## 5. 拆分时确认「无需改动」的设计条目（供你放心跳过）

以下原文与结论一致，**不需要改**：§2.1 单向宗旨、§3 技术栈、§4.3 资源硬指标、§4.4 非 root（含非特权 ICMP + opt-in `setcap`）、§4.5 调度周期、§4.6 探活闭环、§4.7 丢弃式策略、§4.8 采集过滤、§5.2 中间件顺序、§5.4 访问分级矩阵、§6.3–§6.5（TLS/权限/时间权威）、§6.6 验签顺序（先解压后验签、`JSON.parse` 前）、§7.1 受控阈值 DSL（零 RCE、`expr` 仅扩展位）、§7.3 告警风暴防护、§8 防抖与 Flapping 判据、§12.4 升级、§13 安全清单其余条目、§17 跨平台路线、§18.1 会话机制、§18.2 快照+增量与 Pub/Sub 扇出、决策 #1–#10、#12–#13、#15–#20、#22–#30、#33、#36、#39。

> ⚠️ 2026-10-05 复核补充（结论不变，仅口径/引用修正）：§13「key/secret 只存哈希」与 §9 `agent_secret_enc`（AES-256-GCM 密文）冲突 → 已就地改为「key 哈希 + secret 密文」；§4.1 `reporter/` 残留的「离线缓存」属 D-01 漏改 → 已删；§18.2「§14 丢弃式」为失效交叉引用 → 已改为「§4.7 / 决策 #14」；§4.5 的 15s 设计目标与 G3 的 30s 实现默认已并排标注。

---

## 6. v0.8 变更记录（已写入设计文档头部）

> - v0.8：**拆分与拍板收敛** —— ① 拆分出 `docs/{database,api,frontend,agent}.md` 四份专项文档，本文只保留宗旨与架构级决策；② 修正三处内部矛盾：Agent 目录的离线缓存模块删除（纯内存重试）、指标维度写进序列全名（主键不变）、WS 应用层只允许 `subscribe`（保活走协议层帧）；③ 补齐原文空白：`settings` / `channels` / `silences` / `user_recovery_codes` / `users` 表、指标命名与转义规范、全表保留期矩阵与清理任务、Redis 键空间与 `noeviction`、能力声明落点；④ 修订决策 #37（面板默认给带 `VANTAGE_KEY` 的一键命令，仍禁 `--key` 参数）、#38（降采样层不分区）、#11（保留期扩表）、#21（公开标识改 `public_slug`）、#31/#32（权限暂时两级、2FA 自助 + 双恢复渠道）；⑤ 新增决策 #40–#59。汇总见 `docs/design-deltas.md`。
（以上文案已原样写入设计文档 v0.8 头部）

---

## 7. 未决与后续

| 项 | 说明 |
|---|---|
| ⏳ 告警接收端配置 | 需要你提供 SMTP 账号、企微/钉钉/飞书机器人 Webhook、标准接口端点（可后置到 M3 联调时给） |
| ⏳ SSO 角色映射 | 对接 OIDC 时再定：是否允许自助注册、IdP 的 group/role claim 如何映射到 `admin`/`user`（`docs/database.md` §12.2 N3） |
| 📌 设计文档 → v0.8 | ✅ **已完成（2026-09-26）**：设计文档正文与决策表已按 §1/§2/§3 落笔并升 v0.8；四份专项文档中的「本轮决策」标注继续保留，与设计 v0.8 一致 |
| 📌 指标清单待实测复核 | 5 台约 50 序列/台是按设计 §9 的 144 万行/天反推的，投产前请用真实序列数复核容量（`docs/database.md` §9） |

---

## 8. M1（Agent 上报链路）实现期的修订与发现

> 状态：✅ **已实现并真机验证（2026-09-26）**。代码在 `server/src/{middleware,models,repositories,services,routes}`，
> 详细实现说明与"坑表"见 `server/README.md` §4，验证结果见 §8.3。
> 本节只记录**与文档口径相关**的改动与发现，供后续一致性复核。

### 8.1 文档已就地修订的两处（§2.1 与 §5.7.2 不一致）

| # | 文档位置 | 原文 | 修订后 | 理由 |
|---|---|---|---|---|
| E-01 | `docs/api.md` §2.1（metrics 表） | `disk[]` = `{ mount, total, used, inode_used, read_bps, write_bps, iops?, latency_ms? }` | `disk[]` 增加可选 **`device?`**；`iops?` 拆成 **`read_iops?` / `write_iops?`** | §5.7.2 登记的序列维度是 `{device,mount}`、指标是 `disk.read_iops`/`disk.write_iops`：单个 `iops` 无法映射到任一序列，缺 `device` 则维度对不上 |
| E-02 | `docs/api.md` §2.1（metrics 表） | 未说明 `mem.used_pct` / `swap.used_pct` / `disk.used_pct` 由谁计算 | 明确为**中心派生**（用同一批的分子分母），分母缺失或为 0 时**不产出**该序列 | §5.7.2 的指标清单里有这三个百分比，但 §2.1 的字段表里没有对应字段；两端各算一份必然漂移 |
| E-03 | `docs/api.md` §1.5 | 中间件顺序未涉及 nonce 与幂等的先后、以及写库失败后的占位释放 | 补三条 ✅ 已定：幂等先于 nonce；失败时**同时**释放 batch 与 nonce；依赖不可用即 503 拒收 | 见 §8.2 的 F-01/F-02 |

⛔ 这三处都**只动口径、不动结论**：主键 `(agent_id, metric, ts)`、维度写进名字、单向宗旨、响应体只允许 `{ok, server_ts}` 全部保持不变。

### 8.2 M1 实现期发现的坑（文档层面值得留痕）

| # | 坑 | 症状 | 处理 | 归入 |
|---|---|---|---|---|
| F-01 | 幂等先于 nonce | 若按 §6.1 的字面顺序（先 nonce 后幂等），Agent 重试**同一份签名**会被判 409，批次永远补不上 | 幂等优先；真正重放（同 nonce + 不同 batch）仍 409 | `docs/api.md` §1.5（E-03） |
| F-02 | 失败只释放 batch 键 | 留下"已烧毁"的 nonce → 同签名重试 409 | 两个键一起释放 | `docs/api.md` §1.5（E-03） |
| F-03 | `INET` 的文本输出带掩码 | `SELECT ip::text` 得到 `203.0.113.7/32`（实测 PG 18.4）。若在 JS 里比较 IP 文本，**真 IPv6 场景每次上报都会被判成 IP 变化** → 必然误触发 Flapping | 变化判定一律交给 SQL 的 `IS DISTINCT FROM $2::inet`；展示/断言用 `host(ip)` | `docs/database.md` §5.5 建议补一句"IP 比较必须在 SQL 层做" |
| F-04 | Node 双栈监听的 `::ffff:` 写法 | 同一台机在 `::ffff:10.0.0.5` 与 `10.0.0.5` 之间被反复判成"IP 变化" | `normalizeIp()` 归一（含 zone id `%eth0` 剥离，⛔ PG 的 INET 不接受 zone id） | 同上 |
| F-05 | Fastify 的 Content-Length 一致性校验 | 在 `preParsing` 里把"解压后字节流"交回解析器后，**凡真被压缩过的报文全部 400** | 交回的流上设 `receivedEncodedLength`（压缩后字节数） | 工程实现，见 `server/README.md` §4.2 |
| F-06 | 固定窗口限流的 EXPIRE 写法 | 每次请求都续期 TTL → 计数器永不清零 → **稳定合法速率下也会永久 429** | Lua：`INCR` 且仅当 `n == 1` 时 `EXPIRE` | 工程实现 |

### 8.3 真机验证结论（2026-09-26，PostgreSQL 18.4 + Redis 8.8）

> ⚠️ **版本口径提醒**：本节（与 §9.4）的验证跑在 **PG 18.4 + Redis 8.8** 上，而设计选型与部署目标是 **PG 16 + Redis 7**（`deploy/docker-compose.yml`）。下表结论对目标版本**尚未复核**；首次在 PG 16 / Redis 7 上部署前，应按 `server/migrations/README.md` §7 重跑一次 `npm run migrate` 与 `VANTAGE_LIVE_TEST=1 npm test`。

| 验证项 | 结果 |
|---|---|
| 单元/路由用例 | **190 通过 / 0 失败**（`npm test`，全部离线可跑） |
| 真机联调用例 | **7 通过 / 0 失败**（`VANTAGE_LIVE_TEST=1`，真实 PG + Redis，自动清理） |
| 落库 | 一批 34 个序列 → `metrics_raw` 34 行，`ts` 全部等于响应里的 `server_ts`，落在当日分区（非 DEFAULT 兜底分区） |
| 派生指标 | `mem.used_pct=50`、`disk.used_pct{device=nvme0n1p2,mount=/}=50` 与输入自洽；`swap.total=0` 时不产出 `swap.used_pct` |
| 幂等 | 同 `batch_id` 连发两次 → 第二次 200 且行数不变 |
| 防重放 | 同 nonce 不同 batch → 409 `nonce_reused`，键 TTL 落在 600s 内 |
| 限流 | 阈值设为 3 时第 4 次 429 + `Retry-After`（Lua 在真实 Redis 上生效） |
| 越权 | `body.agent_id ≠ X-Agent-Id` → 400 且 `audit_logs` 落一条 `agent.report.identity_mismatch` |
| 单向宗旨 | `/api/v1/agent/config`、`/api/v1/agent/tasks`、`/api/v1/agent/command` 全部 404；响应体键集合恰为 `{ok, server_ts}` |
| 测试残留 | 库内 0 行、Redis 0 键 |

### 8.4 M1 的开放项（需 Owner 拍板，不阻塞联调）

| 编号 | 事项 | 现状 | 建议 |
|---|---|---|---|
| M-5 | `host.boot_time` 的口径（秒 / 毫秒 / RFC3339） | ✅ **已闭环**：schema 已锁死为**整数 unix 秒**（`server/src/models/report.js:85`），字符串形态按 400 拒绝 | —（无需再定） |
| M-6 | `disk[].device` 是否必需 | 可选；缺失时序列只带 `mount` 维度 | 若 Agent 能稳定提供，改为必填并写进 §2.1 |
| M-7 | IP 历史的"私网过滤"范围 | 只过滤回环/链路本地/未指定/组播，**私网保留** | 若确定只公网部署，加开关收紧到"仅公网"。⚠️ 一刀切过滤私网会让**内网部署**的 IP 历史整表为空、Flapping 永不生效 |
| M-8 | `ip_change_events.same_subnet` / `subnet_prev` / `subnet_next` | 一律 NULL（缺前缀长度策略） | M3 的 `ip_change.mode='subnet'` 规则依赖它，**必须在 M3 之前定策略**（IPv4 /24？IPv6 /64？） |
| M-9 | 首次上报即记一条 IP 变化事件（`old_ip = NULL`） | 按 §5.6 的列注释实现 | M3 需决定该类事件是否触发 `ip_change` 告警（否则每台新机上线都会告警一次） |
| M-10 | `STALE_REPORT_HOURS`（6h） | M1 未使用（5min 硬上限已覆盖该区间） | 更适合作为 M3 离线判定的"确定离线"阈值，或在文档里删掉该配置 |

---

## 9. M1.5（分区维护 / 降采样 / 保留期清理）实现记录

> 状态：✅ **已实现并真机验证（2026-09-26）**。代码在 `server/src/services/{partition,downsample,retention,cron}.service.js`
> 与 `server/scripts/partitions.js`，说明见 `server/README.md` §4.5/§4.6。
> **为什么从 M3 提前**：见 §9.1 —— 这是一个**带死线**的问题，等不到 M3。

### 9.1 提前的原因：分区提前量会耗尽，且事后不可逆（实测）

| 事实 | 实测证据 |
|---|---|
| 迁移只预建「今天 +7」天分区 | 首次上真库时为 8 个（`2026-09-26` → `2026-10-03`） |
| 覆盖范围外的行落进 `metrics_raw_default` | 模拟未来 30 天的行 → `tableoid = metrics_raw_default` |
| 该日期**无法事后补建**分区 | `vantage_ensure_metrics_raw_partition()` → `23514 updated partition constraint for default partition "metrics_raw_default" would be violated by some row` |
| 15 天保留期会静默失效 | `Drop 过期分区` 只识别 `metrics_raw_YYYYMMDD`（`vantage_metrics_raw_partitions()` 有意排除兜底分区）→ 兜底分区里的数据**永不清理**，磁盘持续增长 |

**后果**：迁移后第 8 天起，所有上报进兜底分区；分区裁剪失效、原始数据永不删除；
想补救必须先删掉该日数据（= 丢数据）。
**因此**：把 `建分区`、`降采样`、`删分区`、`保留期清理` 四项从 M3 提前，一次做完
（只做"建"会让 15 天清理继续不生效；只做"建 + 删"会在降采样缺失时**丢历史**）。

### 9.2 与文档口径相关的修订

| # | 位置 | 修订 | 理由 |
|---|---|---|---|
| E-04 | `docs/database.md` §8.2 表格 | 标注四项任务**已实现**（M1.5），并补两处实现差异说明 | 避免后续按"未实现"重复排期 |

### 9.3 M1.5 实现期发现的坑

| # | 坑 | 症状 | 处理 |
|---|---|---|---|
| F-10 | 用 `pg_class.reltuples` 判断"分区是否为空" | 刚写入的分区在 autovacuum/ANALYZE 之前 `reltuples` 仍是 **0/-1** → 被当成"空分区"直接删掉 = **静默丢数据** | 删除安全性一律走 `wasDayAggregated()` 的 `EXISTS` 精确判断；`rows` 仅用于展示，注释与测试双双锁死 |
| F-11 | 只做"全局降采样健康检查"不够 | 聚合坏 20 天后刚修好：最近桶有数据（健康检查通过），但 15–20 天前那几天**从没被聚合** → 删掉就是永久空洞 | 增加**逐分区**门禁：该日有原始行、降采样层却一行都没有 → 拒绝删除该分区 |
| F-12 | `date_trunc('minute', timestamptz)` 按**会话时区**截断 | 任何一处 `SET timezone` 都会让桶边界整体偏移；写进 `(agent_id, metric, bucket)` 主键就是错桶 → 曲线错位且不报错 | 改用 `to_timestamp(floor(extract(epoch from ts)/N)*N)`（绝对秒取整，天然 UTC）。两种算法在 UTC 下逐位等价 |
| F-13 | Redis 锁的释放必须"比对持有者" | 任务耗时超过锁 TTL 时，朴素的 `DEL` 会删掉**别人**刚拿到的锁 | Lua：GET 与期望 token 相等才 DEL |
| F-14 | 维护任务的锁要 **fail-open** | Redis 挂掉时若 fail-closed，则"分区永远建不出来 → 23514 → 丢数据"；而 fail-open 最坏只是多跑一遍（任务全幂等） | 区分"锁被别人持有"（跳过）与"Redis 不可用"（照跑 + warn） |
| F-15 | PGlite 与 node-pg 的两处 API 差异 | `exec()` 返回**结果数组**、行数叫 `affectedRows`；不抹平会让分批 DELETE 永远读到 0（**测试假通过**） | 测试侧适配器统一成 `{rows, rowCount}`（`test/cron.test.js` 顶部有说明） |

### 9.4 真机验证结论（2026-09-26，PostgreSQL 18.4 + Redis 8.8）

> ⚠️ 版本口径同 §8.3：验证环境是 PG 18.4 + Redis 8.8，部署目标是 PG 16 + Redis 7，结论待目标版本复核。

| 验证项 | 结果 |
|---|---|
| 单元/真 SQL 用例 | **218 通过 / 0 失败**（`npm test`；其中 `test/cron.test.js` 27 条跑在真 PostgreSQL（PGlite）上） |
| 真机联调用例 | **15 通过 / 0 失败**（`report.live` 7 + `cron.live` 8） |
| 聚合语义 | 4 个样本 [10,20,30,40] → `avg=25 / min=10 / max=40 / v_last=40 / n=4`，桶起点落在真实 UTC 整分 |
| 重入 | 重复聚合不产生新行；补一个迟到点后 `n: 4→5`、`v_last: 40→99`（自愈） |
| 时区无关 | 会话时区改成 `Asia/Shanghai` 后桶起点仍是 UTC 整分 |
| 分批清理 | 7 行 / 每批 3 行 → 3 批删净、未过期行保留；达到批次上限时标记 `truncated` |
| 白名单 | ⛔ `agents` / `metrics_raw` 等不在白名单的表一律拒绝删除 |
| 分区安全 | 兜底分区与父表**永不被删**；非 `metrics_raw_YYYYMMDD` 形状的名字一律拒删 |
| 逐分区门禁 | 造一个"40 天前有数据、从未聚合"的分区 → 真机 cron 拒绝删除，分区确认仍在 |
| 分布式锁 | 真 Redis 上锁可获取可释放；他人持有锁时跳过且不误删 |
| 提前量 | 91 个分区覆盖 `2026-09-26 → 2026-12-25`（剩 90 天），兜底分区 0 行 |
| 测试残留 | 库内 0 行、Redis 0 键；临时造的 40 天前分区已删；110 张表 = 17 业务表 + 91 日分区 + 父表 + 兜底 |

### 9.5 M1.5 的开放项

| 编号 | 事项 | 现状 | 建议 |
|---|---|---|---|
| M-11 | 上报周期与降采样档位 | 实际默认 **30s**（G3 修订，原设计 15s）→ 1 分钟桶含 **2** 样本，1m 档仍有意义 | 若上报周期改为 **≥60s**，1m 档退化成"原样拷贝"，应改为 **5m + 1h** 两档（需加一张表 = 一次迁移）。⛔ 采集周期是 Agent 本地配置，中心无权下发（单向宗旨） |
| M-12 | 兜底分区的处理 | 靠"每日 + 每次启动预建"避免用到它；`checkPartitionHealth` 在它非空时打 error 日志 | 把该信号接进 M3 的告警/面板徽标；另可考虑给"提前量不足"单列一条系统级告警 |
| M-13 | 原始层保留期是否延长 | 当前 15 天（配置化，任务读配置而非写死） | 若希望"30 天内也保持 15 秒全精度"，把 `RETENTION_METRICS_RAW_DAYS` 改成 30（多占约 2GB/5 台规模），删除任务会自动跟着走 |
