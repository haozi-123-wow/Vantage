# Vantage 中心服务（`vantage-core`）

> 上位文档：`../Vantage-DESIGN-v0.7.md`（**内容已是 v0.8**，文件名保留以维持引用）
> 专项文档：`../docs/api.md`（接口契约）、`../docs/database.md`（数据契约）
> 本目录**不含任何下发能力**：⛔ 中心永不向 Agent 推送配置或命令（设计 §2.1 单向宗旨）。

## 1. 技术栈与目录

| 项 | 选型 |
|---|---|
| 运行时 | Node.js ≥ 22（当前开发机为 24.9.0） |
| Web 框架 | Fastify 5 |
| 数据库 | PostgreSQL 16（`pg` 驱动，DML/DDL 两条连接池） |
| 缓存 | Redis 7（`ioredis`；✅ R15：单实例 + 键名前缀 + `maxmemory-policy noeviction`） |
| 日志 | pino（结构化 JSON，内置凭证脱敏） |
| 测试 | node:test + PGlite（在进程内跑真 PostgreSQL，无需 Docker） |

```
server/
├── src/
│   ├── index.js            启动入口：配置 → 日志 → 连接 → 自检 → 监听 → 优雅退出
│   ├── app.js              Fastify 装配：错误模型 / 请求 ID / 安全响应头 / 路由挂载清单
│   ├── config/index.js     环境变量加载与校验（快速失败，一次列出全部问题）
│   ├── db/{pg.js,redis.js} PG / Redis 客户端、批量 PUBLISH、健康检查
│   ├── middleware/         authAgent（解压+体积+验签）· authPanel（会话/CSRF）· rateLimit（Lua 固定窗口）
│   │                       publicView（公开视图总开关）
│   ├── models/report.js    上行报文 JSON Schema（字段白名单 / 数值范围 / 数组上限）
│   ├── repositories/       agents · ipTrack · metric · probe · audit · user（只写 SQL）
│   ├── services/           ingest（批次编排）· metrics · heartbeat · ipTrack · probe
│   │                       partition（分区建/删）· downsample（1m/5m 聚合）
│   │                       retention（保留期分批清理）· cron（调度 + 单实例锁）
│   │                       offline（离线点名）· status（状态推导，公开/私有共用）
│   │                       agentAdmin（Agent 与凭证管理）· auth · session · captcha · settings
│   ├── routes/             health.js（探针）· agent.report.js（✅ M1 上报与心跳）
│   │                       auth.js（✅ 认证会话）· public.js（✅ 公开状态）· hosts.js（✅ 主机）
│   │                       agents.js（✅ 添加 Agent / 凭证签发）
│   └── utils/              crypto · sign · metric · ip · ulid · errors · log · redisKeys
├── migrations/             版本化 SQL（只前进不回滚）→ 见 migrations/README.md
├── scripts/
│   ├── migrate.js          迁移运行器（advisory lock + 校验和 + --status）
│   ├── create-agent.js     Agent 凭证签发/轮换/列表（M2 之前的手工替代品）
│   ├── create-user.js      首管员创建 / 离线救援（--reset-2fa）
│   ├── partitions.js       分区运维兜底（--list / --ensure / --drop-expired --dry-run）
│   ├── run-tests.js        测试入口（进程内加载，规避受限环境的 spawn 限制）
│   └── init-db.sql         建库与建角色（DBA 执行一次）
├── test/                   430+ 个用例，含"真库"结构验证与可选的真机联调
└── .env.example            全部环境变量说明
```

已实现 vs 待实现的路由清单见 `src/app.js` 顶部的「路由挂载清单」。

## 2. 快速开始

```bash
cd server
npm install
cp .env.example .env
# 必填两项：
#   DATABASE_URL          形如 postgres://vantage_app:...@127.0.0.1:5432/vantage
#   SECRET_KEY            node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"

npm run migrate:status   # 看迁移状态
npm run migrate          # 建表（首次执行前请确认连的是空库）
npm start                # 启动，默认 http://127.0.0.1:8787
curl -s http://127.0.0.1:8787/readyz   # {"ok":true,...}
```

数据库与角色准备见 `scripts/init-db.sql`（建库 → 建 `vantage_migrator`/`vantage_app`/`vantage_ro` → 授权）。
⚠️ 运行时连接（`DATABASE_URL`）**不应具备 DDL 权限**：分区维护走 `MIGRATOR_DATABASE_URL`（✅ R13）。

### 2.1 发一套 Agent 凭证并上报一次（M1 联调）

```bash
node scripts/create-agent.js --name web-01 --tag prod   # ⛔ 明文只显示一次
node scripts/create-agent.js --list                    # 查看已有 Agent（不含明文）
node scripts/create-agent.js --rotate <agent_id>       # 轮换：旧凭证**立即失效**，无宽限期
```

`create-agent.js` 会顺带打印一段可直接粘贴的 Node 上报示例（含 canonical 拼装与 gzip）。
上报链路的完整顺序与错误码见 `docs/api.md` §2.1/§2.2，字段白名单见 `src/models/report.js`。

```bash
# 真机联调（连真实 PG + Redis，会写测试数据并自动清理）
VANTAGE_LIVE_TEST=1 npm test
# PowerShell:  $env:VANTAGE_LIVE_TEST='1'; npm test
```

### 2.2 连接口令怎么给（Redis / PG 同一套规则）

**口令若含 `@ : / # ? %` 或空格，写在 URL 里必须百分号编码**（`@`→`%40`、`:`→`%3A`、`/`→`%2F`、`#`→`%23`、`?`→`%3F`、`%`→`%25`）。

原因很硬：`ioredis` 与 `pg-connection-string` 内部都用 WHATWG `new URL()` 解析连接串——

- 裸 `/` 或 `#` → 直接抛 `Invalid URL`（**进程启动即崩**，报错还看不出是口令问题）；
- 裸 `#` / `?` 在部分形态下会被当成 fragment / query → **静默连错库**，最难排查。

因此：

| 目标 | 推荐给法 | 说明 |
|---|---|---|
| Redis | `REDIS_URL=redis://127.0.0.1:6379/0` + `REDIS_PASSWORD=...`（可选 `REDIS_USERNAME`，Redis 6+ ACL） | 分立变量**不需要编码**，适合随机口令 |
| Redis（简单口令） | `REDIS_URL=redis://:pw@host:6379/0` | 必须编码 |
| PostgreSQL | `DATABASE_URL=postgres://user:pw@host:5432/vantage` | 目前只有 URL 形式，必须编码 |

⛔ **不要两边同时给 Redis 凭据**：ioredis 的 `parseOptions()` 用 `lodash.defaults` 按参数顺序填充，**URL 里的凭据会压过 `REDIS_PASSWORD`**（与直觉相反）。代码检测到冲突时会丢弃 URL 中的凭据并打 warn（`src/db/redis.js` 的 `resolveRedisTarget()`）。

配置层会对这两种连接串做**前置校验**：非法 URL 会在启动时报「不是合法 URL + 编码对照表」，并且消息里的口令已被 `redactUrl()` 脱敏。

## 3. 测试

```bash
npm test              # 全部用例（进程内执行，受限沙箱也能跑）
npm run test:isolated # 每个测试文件一个子进程（CI / Linux 推荐，能捕获跨文件污染）
```

测试分五类：

| 文件 | 覆盖内容 |
|---|---|
| `test/schema.test.js` | **把 8 个迁移跑在真 PostgreSQL 上**（PGlite/WASM），逐条验证表结构、分区、约束、触发器、外键、权限、保留期删除语句 |
| `test/migrations.test.js` | 迁移文件的静态契约：命名/顺序/表清单/禁止语句/关键决策落地痕迹 |
| `test/sign.test.js` | 上报签名规范，消费**共享测试向量** `contracts/agent-signature.json`（Go Agent 消费同一份 JSON） |
| `test/agentwire.test.js` | **跨语言契约**：把 Go Agent 产出的**线上黄金字节**（`contracts/wire/*.json`）送进真实链路（gzip → 签名 → schema → 摊平 → 落库），钉死「Agent 以为的字段」与「中心要求的字段」是同一套 |
| `test/report.test.js` | **上报链路全量行为**：docs/api.md §6.1 的十条验收用例 + 限流 + 审计 + 事务失败重试（全部用替身，离线可跑） |
| `test/{flatten,ingest,ip,metric,crypto,errors,config,redis,app}.test.js` | 指标展平与派生、批次生命周期与 SQL 形状、IP 规范化、密码学、错误模型、配置校验、键空间契约、HTTP 冒烟 |
| `test/report.live.test.js` | **真机联调**（默认跳过）：真实 PG+Redis 上的落库/分区/幂等/Lua 限流/审计，自动清理测试数据 |
| `test/cron.test.js` | **定时任务（真 SQL）**：聚合语义与桶对齐、迟到数据自愈、分批清理、分区建/删的 3 条防误删规则、**删分区的逐分区门禁**；调度层用替身验单实例锁/fail-open/失败不崩 |
| `test/cron.live.test.js` | **定时任务真机联调**（默认跳过）：真实分区 DDL、真实 Redis 分布式锁、真库聚合与门禁 |

> ⚠️ `server/test/` **会随仓库上传**（公开仓库）：测试里只能出现文档用的保留地址
> （`203.0.113.x`、`127.0.0.1`、`example.com`）与明显是假的凭证，⛔ 真实地址/账号/口令一律不写进去。
> 需要真实环境的是 `*.live.test.js`，它们一律从**环境变量**读连接信息（`VANTAGE_LIVE_TEST=1` 才跑）。
>
> 两端共享的**契约文件**放在仓库根目录 `contracts/`（见 `contracts/README.md`）：
> ⛔ 不要只改一侧 —— 另一侧的测试会立刻红，这正是设计意图。

## 4. M1 上报链路：实现要点与坑（改代码前必读）

### 4.1 中间件顺序（docs/api.md §1.5，⛔ 不可调整）

```
preParsing（middleware/authAgent.js）
  ① Content-Type 必须是 application/json
  ② Content-Encoding 只接受 gzip / identity（其余 415）
  ③ 压缩后字节上限 1MB：先看 Content-Length，再在流内计数（防 chunked 绕过）
  ④ gzip 解压 + 解压输出上限 4MB（zlib 的 maxOutputLength，zip bomb 闸门）
  ⑤ 鉴权头格式 → ⑥ 取 Agent 行 → ⑦ X-Agent-Key 校验（身份）
  ⑧ 解出 agent_secret → HMAC 验签（⚠️ 此时还没 JSON.parse）
  ⑨ 时间窗：仅 >5min 硬上限才拒（≤5min 记漂移并 warn）
  ⑩ 把原始字节交回 Fastify（JSON.parse 与 schema 校验继续走标准路径）
Fastify：JSON.parse → schema 校验（字段白名单 / 范围 / 数组上限）
preHandler：限流（Redis）→ agent_id 一致性（+审计）→ 首次上报必须带 host/capabilities
handler：幂等占位 → 防重放 nonce → 单事务落库（§6.1 六步）→ COMMIT → 扇出 → {ok, server_ts}
```

### 4.2 已踩过并已写进注释的坑

| 坑 | 症状 | 处理 |
|---|---|---|
| Fastify 的 Content-Length 一致性校验 | 在 `preParsing` 里换成"解压后字节流"后，**凡是真被压缩过的报文全部 400**（`FST_ERR_CTP_INVALID_CONTENT_LENGTH`），小报文反而正常 | 交回的流上设 `receivedEncodedLength = 压缩后字节数`（@fastify/compress 用的同一机制） |
| `@fastify/compress` 的请求解压无输出上限 | zip bomb 在 `JSON.parse` 之前就把内存吃掉 | `globalDecompression: false`，解压自管（响应压缩不受影响） |
| `zlib.gunzip` 的 `maxOutputLength` | 需要在**解压过程中**就截断，而不是先分配再判断 | 超限抛 `ERR_BUFFER_TOO_LARGE` → 413；`Z_DATA_ERROR` → 400 |
| ioredis 的 URL 凭据压过显式选项 | 改了 `REDIS_PASSWORD` 却毫无效果 | `resolveRedisTarget()` 主动摘掉 URL 里的 userinfo 并 warn |
| 限流固定窗口的 EXPIRE 写法 | 每次请求都续期 → 计数器永不清零 → 稳定速率下**永久 429** | Lua 脚本：`INCR`，仅当 `n == 1` 时 `EXPIRE` |
| `INET` 的文本输出带掩码 | `SELECT ip::text` 得到 `203.0.113.7/32`（实测 PG 18.4） | 展示/断言用 `host(ip)`；⛔ **绝不在 JS 里比较 IP 文本**——变化判定交给 SQL 的 `IS DISTINCT FROM` |
| Node 双栈监听的 `::ffff:10.0.0.5` | 同一台机在两种写法间被反复判成"IP 变化"→ 必然误触发 Flapping | `normalizeIp()` 归一（含 zone id 剥离） |
| Redis 占位后事务失败 | 只删 batch 键会留下"已烧毁"的 nonce，Agent 用同一份签名重试立刻 409 | 失败时**同时**删 batch 与 nonce 两个占位 |

### 4.3 M1 的两处刻意取舍（与文档字面不同，已登记）

1. **幂等检查排在 nonce 之前**：完全相同的重传（Agent 重试同一份已签名字节）应得到 `{ok:true}`（数据本来就在库里），而不是 409；真正的重放（同 nonce + 不同 batch）依然 409。
2. **失败时同时释放 batch 与 nonce**：docs/database.md §6.1 的"建议"只提到 batch，实测只删 batch 会让重试陷入 409 死循环。

## 4.5 定时任务（✅ M1.5：分区维护 / 降采样 / 保留期清理）

原计划属 M3，因**分区提前量有硬死线**而提前落地（见 `docs/design-deltas.md` §9）。六项任务：

| 任务 | 频率 | 说明 |
|---|---|---|
| `create_partitions` | 每日 + **每次启动** | 预建未来 `PARTITION_PRE_CREATE_DAYS` 天分区（幂等） |
| `drop_partitions` | 每日 | 删过期整日分区，⛔ **两道门禁**（见下） |
| `aggregate_1m` / `aggregate_5m` | 60s / 300s | 原始层 → 降采样层，回看 N+1 个完整桶 |
| `purge_downsampled` | 每日 | 1m > 90d、5m > 1y 分批 DELETE |
| `purge_non_timeseries` | 每日 | 探活/进程/IP 区间/通知/审计/静默 分批 DELETE |

```bash
node scripts/partitions.js --list                      # 分区覆盖与提前量
node scripts/partitions.js --ensure 90                 # 手工兜底预建
node scripts/partitions.js --drop-expired 15 --dry-run # 只看会删哪些
```

#### ⛔ 为什么"删原始分区"必须过两道门禁

原始层只留 15 天，前提是**降采样已经把它汇总走**。否则删掉 = **永久数据空洞**，而且是静默的
（docs/database.md §8.2 的 ➕ 建议点名了这类故障）。两道门禁缺一不可：

1. **全局健康**：降采样任务近期是否还在产出（容忍 15 分钟 / 60 分钟空档，避免短时抖动把删除永久卡死）；
2. **逐分区健康**（真正的安全线）：用 `EXISTS` 精确判断"**这一天**有原始行、但降采样层一行都没有" → 拒绝删除该分区。
   全局检查证明不了这件事：聚合坏 20 天后刚修好时，最近桶是有的（门禁 1 通过），
   但 15–20 天前那几天从没被聚合过 —— 只靠门禁 1 就会把它们删掉。

⚠️ **绝不要用 `pg_class.reltuples` 判断"分区是不是空的"**：刚写入的分区在 autovacuum/ANALYZE 之前
`reltuples` 仍是 0/-1，拿它当"没数据"会把**有数据的**分区直接删掉（本实现曾犯过，已加注释与测试）。

#### 与 docs/database.md 的两处实现差异（结果等价，已登记）

| 项 | 文档字面 | 实现 | 理由 |
|---|---|---|---|
| 桶对齐 | `date_trunc('minute', ts)`；5m 用 `date_trunc('hour') + floor(minute/5)*5min` | `to_timestamp(floor(extract(epoch from ts)/N)*N)` | `date_trunc` 对 `timestamptz` 按**会话时区**截断：任何一处 `SET timezone` 都会让桶边界整体偏移，而写进 `(agent_id, metric, bucket)` 主键就是**错桶**（曲线错位且不报错）。epoch 取整是绝对秒，天然 UTC |
| 聚合范围 | "上一个完整分钟桶（含回看 N=3 桶）" | 一次覆盖最近 `lookbackBuckets+1` 个完整桶 | 迟到数据会落进**已聚合过**的桶，`ON CONFLICT DO UPDATE` 一次重算即可自愈；无需"当前桶 + 前 N 桶"分开处理 |

### 4.6 定时任务的工程约束

- **DDL 走 `db.migrator ?? db.app`，DML 走 `db.app`**（✅ R13）。单账号部署下 `db.migrator` 是 `null`；
  一旦按 R13 拆成三角色，运行时池**没有** CREATE/DROP 权限，走错池会 42501。
- **任务失败只记 error 日志，绝不让进程崩**：维护任务故障的后果是"悄悄积累"，不是"立刻不可用"。
- **分布式锁 fail-open**：取不到锁（别的实例在跑）→ 跳过；但如果是 **Redis 本身不可用**导致取不到 → **照跑不误**。
  因为所有任务都幂等，最坏情况是多跑一遍；而 fail-closed 的最坏情况是"分区永远建不出来 → 23514 → 丢数据"。
- **删除类任务必须能证明自己安全**：见上面的两道门禁。

### 4.4 开放项（需要 Owner 拍板，不阻塞联调）

| 编号 | 事项 | 现状与建议 |
|---|---|---|
| M-5 | `host.boot_time` 的口径（秒 / 毫秒 / RFC3339） | 设计未钉死；当前两种（整数与字符串）都收、原样落 JSONB。Agent 定型后应**收窄为一**并在 schema 里锁死 |
| M-6 | `disk[].device` 是否必需 | §5.7.2 的维度名含 `device`，§2.1 的字段表没列它。当前设为**可选**：缺失时序列只带 `mount` 维度（同一 Agent 必须保持一致）。建议后续改为「Agent 应尽量提供」并在文档里补上该字段 |
| M-7 | IP 历史的「私网过滤」范围 | §5.5 说"私网在写入前过滤"，但设计同时支持"Agent 与中心同处内网"。当前只过滤回环/链路本地/未指定/组播（私网**保留**），否则内网部署的 IP 历史会整表为空、Flapping 永不生效。若确定只公网部署，可加开关收紧到"仅公网" |
| M-8 | IP 变化事件的 `same_subnet` / `subnet_prev` / `subnet_next` | 需要前缀长度策略（IPv4 /24？IPv6 /64？）才能算，当前一律 NULL。M3 的 `ip_change.mode='subnet'` 规则依赖它，**必须在 M3 之前定策略** |
| M-9 | 首次上报即记一条 IP 变化事件（`old_ip = NULL`） | §5.6 的列注释表明这是设计意图，但 M3 的 `ip_change` 告警会因此在每台新机上线时立即触发一次。届时可考虑对 `old_ip IS NULL` 的事件不告警 |
| M-10 | `STALE_REPORT_HOURS` 的实际用途 | §6.2 说"丢弃 ts 迟于 6h 的上报"，但 5min 硬上限已覆盖该区间，故 M1 未使用该配置。它更适合作为离线判定的"确定离线"阈值（M3 cron） |
| M-11 | 上报周期与降采样档位的关系 | 设计已拍板 **15s** 上报 → 1 分钟桶含 4 个样本，1m 档有意义。若改为 ≥60s，1 分钟档会退化成"原样拷贝一份"，应改为 5m + 1h 两档（**需加一张表 = 一次迁移**）。⛔ 采集周期是 Agent 本地配置，中心无权下发（单向宗旨），改它必须上机改 Agent 配置 |
| M-12 | `metrics_raw_default` 的处理 | 提前量耗尽后数据会落进兜底分区，且**该日期无法事后补建**（23514 实测）。当前靠"每日 + 每次启动预建"避免；`checkPartitionHealth` 会在兜底分区有行时打 error 日志。加分项：把它接进 M3 的告警 |

## 5. 关键设计取舍（改代码前请先读）

| 取舍 | 原因 |
|---|---|
| Agent 凭证：`agent_key` 用 HMAC-pepper 哈希、`agent_secret_enc` 用 AES-256-GCM 密文 | HMAC 验签要求中心能**解出** secret 重算签名，所以 secret 必须可逆存储；`agent_key` 无需可逆故只存哈希（本轮实现期修订，文档已同步） |
| `agent_secret_enc` 的 AAD 绑定 `agent_id` | 否则密文可被跨行搬运（A 机的密文抄给 B 机 = B 机获得 A 机的签名能力），且 `agent_key_hash` 各归各的、表面看不出来 |
| 面板密码用 Argon2id，Agent 凭证**不用** | 上报是高频路径，Argon2 的数十毫秒会直接吃掉吞吐；Agent 凭证是 256 位随机值，本无需慢哈希 |
| 先验签、后 `JSON.parse` | 签名针对 gzip 解压后的原始字节（决策 #35/#19）；重序列化会改变字节 |
| 维度写进指标名，`labels` 只是副本 | 主键是 `(agent_id, metric, ts)`，同机两个挂载点在同一时刻会撞主键；JSONB 无法进主键（✅ R5）。⚠️ JSONB **不保留键顺序**，故 `labels` 的键序与全名里的顺序可能不同，两者以全名为准 |
| 失败即拒收（Redis/PG 不可用 → 503） | 限流/nonce/幂等全依赖 Redis，它挂了还继续收数据 = 在没有任何防护的状态下写库 |
| `/healthz` 与 `/readyz` 分离 | 前者只证明进程活着（不碰依赖），后者证明 PG/Redis 可用；依赖抖动不该触发重启 |
| 5xx 一律折叠为通用消息 | 错误响应不得回显 SQL/约束名/内部路径（docs/api.md §1.3） |
| 时序三表不建外键 | 高写入量路径上外键校验成本高；越权由接入层「body 内 agent_id 必须与签名者一致」保证 |
| 批量写入用 `unnest(数组…)` 而非拼值 | 参数个数恒定 5 个，与批内序列数无关；拼值方式在最坏批次（≈1400 序列）会撞 65535 参数上限 |
| 迁移用独立 migrator 连接 | ⛔ 不把 DDL 权限挂在常规请求路径上（✅ R13） |
| 连接口令支持「URL 内联」与「分立变量」两种，且**互斥** | ioredis 的 URL 凭据会压过显式选项（顺序 defaults），允许并存会变成「改了 .env 没效果」；见 §2.2 |
| `redactUrl()` 不只用一条正则 | 口令含未编码 `/` `?` `#` 时朴素正则会在错误的边界停下 → 脱敏静默失效、口令进日志；现按 authority 边界 + 畸形兜底两步处理 |

## 6. 与文档的对照（溯源）

| 本目录位置 | 文档来源 |
|---|---|
| `src/config/index.js` | docs/api.md §1.2/§1.4、docs/database.md §7/§8、设计 §5.2/§6.2/§18.1 |
| `src/utils/sign.js` | 设计 §6.2/§6.6、docs/api.md §2.1、docs/agent.md §6.2（✅ 决策 #46、#35） |
| `src/utils/metric.js` | docs/database.md §5.7.2（✅ R5/R8） |
| `src/models/report.js` | docs/api.md §2.1/§2.2（字段白名单）、设计 §5.2（数组上限）、决策 #47 |
| `src/middleware/authAgent.js` | docs/api.md §1.5/§2.1、设计 §6.2/§6.6、docs/database.md §6.2（+决策 #17/#35/#55） |
| `src/middleware/rateLimit.js` | docs/api.md §1.4、docs/database.md §7（决策 #23、✅ R15） |
| `src/services/{ingest,metrics,heartbeat,ipTrack,probe}.service.js` | docs/database.md §6.1/§6.2、§5.5/§5.6/§5.9/§5.10、设计 §8（决策 #18/#39） |
| `src/repositories/*` | docs/database.md §5.1/§5.5/§5.6/§5.7/§5.9/§5.10/§5.13 |
| `src/services/partition.service.js` | docs/database.md §5.7.3、§8.2（建/删分区）、§2（DDL 与运行时账号分离）、决策 #50 |
| `src/services/downsample.service.js` | docs/database.md §8.2/§8.3（聚合 1m/5m）、§5.8、决策 #38 |
| `src/services/retention.service.js` | docs/database.md §8.1/§8.2（保留期矩阵与分批清理）、决策 #11/#49 |
| `src/services/cron.service.js` | docs/database.md §8.2（任务清单与单实例执行）、决策 #50 |
| `scripts/partitions.js` | docs/database.md §5.7.3（提前量与 23514 陷阱） |
| `src/utils/redisKeys.js` | docs/database.md §7、§8.2（✅ R13/R15） |
| `src/utils/errors.js` | docs/api.md §1.3（含 `nonce_reused` 409 的口径校正） |
| `src/utils/ip.js` | docs/database.md §5.5、设计 §8（+开放项 M-7） |
| `src/routes/agent.report.js` | docs/api.md §2.1/§2.2/§2.3/§5.3/§6.1 |
| `src/services/status.service.js` + `src/routes/{public,hosts}.js` + `src/middleware/publicView.js` | docs/api.md §3.1/§3.2/§4.2、§1.2 ③；`docs/server-status-api.md`（全部决策与取数策略）；落地记录 `docs/api-status.md` §4.6 |
| `src/utils/time.js` | docs/api.md §1.2 ③（`from`/`to` 的时间格式与范围约束）、§4.3 |
| `src/ws/hub.js` + `src/ws/fanout.js` + `src/routes/ws.js` | docs/api.md §5（频道集合/消息格式/语义约束的**定稿**）、§5.1（限流与 Origin）、落地记录 `docs/api-status.md` §4.9（H1–H9） |
| `src/services/metricQuery.service.js` + `src/repositories/metric.repo.js`（`METRIC_STEPS` + 两个时序查询） | docs/api.md §4.3（档位/`agg`/两道闸门/响应格式的**定稿**）、docs/database.md §5.7/§5.8（`metrics_raw` 与降采样层的列）、落地记录 `docs/api-status.md` §4.8（G1–G10） |
| `src/routes/agents.js` + `src/services/agentAdmin.service.js` | docs/api.md §4.4（含决策 #37 修订的三条硬约束）、docs/agent.md §6.1/§12.1、docs/database.md §5.1/§5.2（✅ R1） |
| `src/services/offline.service.js` | 设计 §5.3、`docs/database.md` §8.2（离线判定 + 防抖）、`docs/api-status.md` §4.4 |
| `migrations/*` | docs/database.md §5 全表 + §8 保留期（✅ R1–R19） |
| `test/schema.test.js` | docs/database.md §5/§6/§8 的可执行化 |
