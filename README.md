# Vantage（望楼）

> **一处高台，俯瞰所有机器。Agent 只上报，中心不发令。**
> 轻量服务器监控系统 = **Go Agent** + **Node.js 中心（`vantage-core`）** + **PostgreSQL** + **Redis** + **Vue 面板（Vantage Console）**。

| 项 | 现状 |
|---|---|
| 设计 | **v0.8 定稿**（§15 技术决策表共 59 条）→ [`Vantage-DESIGN-v0.7.md`](Vantage-DESIGN-v0.7.md)（⚠️ 文件名保留 `v0.7` 以维持既有引用，**内容已是 v0.8**） |
| 代码 | **中心 M1 + M1.5 已落地**：`server/` 可跑通「Agent 上报 → gzip 解压 → HMAC 验签 → 幂等 → 单事务落库 → 分区/降采样/保留期清理」 |
| 代码 | 🚧 **Go Agent 主体完成**：采集/探活/签名/上报/配置/热重载 M1–M4 核心代码已落地，`go test ./...` 全绿，并与中心跑通**跨语言契约测试**（`contracts/`）；M2 部署侧（安装脚本、systemd）待补，进度见 [`docs/agent-status.md`](docs/agent-status.md) |
| 未开工 | Vue 面板（`web/`）——目录尚未创建，契约已定稿：`docs/frontend.md` |
| 许可 | **AGPL-3.0**（决策 #28；⚠️ 仓库尚未放入 `LICENSE` 文件，正式开源前需补） |

---

## 0. 最高宗旨：通信严格单向 ⛔

**中心永远不能向 Agent 下发任何指令、配置、脚本或命令。** Agent 的一切行为（中心地址、采集项、频率、**探活目标**、过滤规则）只由被监控机本地的 `config.yaml` 决定。

落到代码上的四条硬约束：

1. 上报响应体**恒定极简**：`{ ok, server_ts }`，不含任何可执行/配置字段；
2. ⛔ 不存在 `GET /agent/config`、`/agent/command`、`/agent/tasks` 之类端点（中心代码零下发路径，纳入安全复核）；
3. Agent 运行时**无缓存模块**（连缓冲大小都不存在）——断网即丢弃、不补传，由中心判离线并告警；
4. WS 是**浏览器 ↔ 中心**的通道，不是中心 ↔ Agent 的通道；客户端应用层消息只允许 `subscribe`，保活走协议层 ping/pong 帧。

> 好处：Agent 攻击面极小；即便中心被入侵，也无法经监控通道操控任何一台机器——**这条路径不存在**。

## 1. 架构

```
┌──────────────┐        HTTPS (JSON, gzip)        ┌────────────────────────────────┐
│ vantage-agent│  ── 出站，带 X-Agent-Key + HMAC ──▶│  vantage-core (Node/Fastify)   │
│  被监控机     │                                   │  ├─ 接入层/鉴权/校验/限流(Redis) │
│  ├ CPU/内存   │  ◀── 仅 ACK(ok/ts)，不下发任何内容 ─│  ├─ 服务层(聚合/告警/IP追踪/探活)│
│  ├ 硬盘/网络  │                                   │  ├─ 数据层(PostgreSQL)          │
│  ├ GPU/进程   │                                   │  ├─ 查询 API + WebSocket        │
│  └ 本地探活   │                                   │  └─ Vantage Console(Vue 静态)   │
└──────────────┘                                   └────────────────────────────────┘
                                                        │
                      ┌──────────────┬──────────────────┼──────────────┬─────────────┐
                      ▼              ▼                  ▼              ▼             ▼
                 PostgreSQL        Redis            告警通道      反向代理      免登录视图
                 (主存储)      (限流/nonce/会话)  SMTP/企微/钉钉  Caddy/Nginx   (公开只读)
                                                     飞书/Webhook  HTTPS+2FA
```

| 组件 | 名称 | 技术选型 | 状态 |
|---|---|---|---|
| 被监控端 | `vantage-agent` | **Go 1.22+** 单文件静态二进制，极低占用、**非 root 可运行** | 🚧 M1–M4 代码完成（部署脚本待补，见 `docs/agent-status.md`） |
| 中心服务 | `vantage-core` | **Node.js ≥ 22 + Fastify 5** | ✅ M1 / M1.5 |
| Web 面板 | Vantage Console | **Vue 3 + ECharts + Element Plus**（按需引入） | 未开工 |
| 主存储 | PostgreSQL | **16**（原始时序层按天分区） | ✅ 8 个迁移 |
| 缓存 | Redis | **7**（限流 / nonce / 会话 / 幂等 / Pub/Sub 扇出） | ✅ |
| 实时 | WebSocket | `/ws/public`（免登录脱敏）、`/ws/live`（需登录） | ⏳ M3 |

### 监控项（本期）
CPU（整体/各核/负载/上下文切换）· 内存与 swap · 磁盘（容量/inode/IOPS/吞吐/延迟）· 网络（速率/累计/连接数/错误丢包）· GPU（NVIDIA 优先，AMD 预留）· 进程（总数/Top-N/关键进程存活）· **本地探活**（ping / HTTP(S) / TCP，由 Agent 在本机执行后上报结果）。

## 2. 仓库结构

```
Vantage/
├── README.md                    # 本文件：项目总览与上手入口
├── Vantage-DESIGN-v0.7.md       # 🧭 上位设计文档（内容 = v0.8，宗旨与架构级决策）
├── docs/                        # 四份专项契约 + 修订清单
│   ├── database.md              #   主控库表 / Redis 键空间 / 分区与保留期
│   ├── api.md                   #   上报协议 / 面板 API / WS / 错误码
│   ├── agent.md                 #   采集 / 探活 / 上报 / 配置 / 安装脚本
│   ├── frontend.md              #   Vantage Console 页面与数据层
│   └── design-deltas.md         #   v0.7→v0.8 逐条修订 + 实现期记录（D-01…D-12、R1…R19）
├── contracts/                   # ⛔ 两端共享的**接口契约**：签名/命名向量 + 线上黄金字节（见其 README）
├── server/                      # ✅ vantage-core（Node.js）：见 server/README.md
├── deploy/
│   └── docker-compose.yml       # 本地/单机 PG 16 + Redis 7（端口只绑 127.0.0.1）
├── agent/                       # 🚧 vantage-agent（Go，M1–M4 代码完成；部署脚本待补）
└── web/                         # ⏳ Vantage Console（未创建）
```

> ⛔ `server/src/` 内不得出现任何向 Agent 下发配置/命令的代码路径；该约束并入安全清单复核。
>
> ⛔ `server/test/` 与 `agent/` 下的测试**都会随仓库上传**，因此 ⛔ 测试里只能出现文档用的保留地址
> （`203.0.113.x`、`example.com`、`127.0.0.1`）与明显是假的凭证；⚠️ 真实地址/账号/IEC 一律不进测试文件。
>
> 两端共享的**接口契约**（签名与命名向量、线上黄金字节）单独放在 `contracts/` —— 它们是接口定义
> 而不是测试代码，两侧测试都读同一份文件，规则见 [`contracts/README.md`](contracts/README.md)。

## 3. 本机开发（先把中心跑起来）

前置：**Node.js ≥ 22**（开发机为 24.9.0）、**Docker**（跑 PG/Redis；也可用本机已装的 PG 16 / Redis 7）。

```bash
# ① 起依赖（PG + Redis，端口只绑 127.0.0.1）
cd deploy && docker compose up -d && cd ..

# ② 装依赖 + 配置
cd server
npm install
cp .env.example .env
```

`.env` 里**必填两项**：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 形如 `postgres://vantage_app:...@127.0.0.1:5432/vantage` |
| `SECRET_KEY` | `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`；⚠️ 一旦有数据入库**不可更换** |

```bash
npm run migrate:status   # 看迁移状态
npm run migrate          # 建表（首次执行前确认连的是空库）
npm start                # 默认 http://127.0.0.1:8787
curl -s http://127.0.0.1:8787/readyz     # {"ok":true,...}
```

生产部署请按 `server/scripts/init-db.sql` 建三角色（`vantage_migrator` / `vantage_app` / `vantage_ro`）：**运行时连接不带 DDL 权限**，分区维护走 `MIGRATOR_DATABASE_URL`（决策 #50 / R13）。

### 3.1 本机开发注意事项

- **受限沙箱（DSH / 无网络外写权限）里 npm 需要把 cache 放进工作区**：`npm install --cache .npm-cache`。`.npm-cache/` 已被 `.gitignore` 忽略，⛔ 不要提交。
- 沙箱内**子进程管道可能被拒**（`spawn EPERM`）。因此 `npm test` 走 `scripts/run-tests.js` 在**同一进程内**加载全部测试；`npm run test:isolated`（每文件一子进程）留给 CI / Linux。
- 测试用 **PGlite（WASM）在进程内跑真 PostgreSQL**，因此**不需要 Docker 也能验证表结构、分区、约束与保留期语句**。
- 连接口令含 `@ : / # ? %` 时必须**百分号编码**（`pg` 与 `ioredis` 都用 WHATWG `new URL()` 解析）；Redis 口令推荐用**分立变量** `REDIS_URL` + `REDIS_PASSWORD`，⛔ 不要与 URL 内联口令同时给（URL 里的凭据会压过显式选项，改了没效果）。详见 `server/README.md` §2.2。

### 3.2 联调：发一套 Agent 凭证并上报一次

中心侧用脚本发凭证；Agent 已有 `--check`（只校验配置与凭证）与 `--once --print-body`（采集上报一次并打印报文，⛔ 不含凭证）两个联调入口，真机上可直接验证链路：

```bash
cd server
node scripts/create-agent.js --name web-01 --tag prod   # ⛔ 凭证明文只显示一次
node scripts/create-agent.js --list                    # 查看已有 Agent（不含明文）
node scripts/create-agent.js --rotate <agent_id>       # 轮换：旧凭证立即失效，无宽限期
```

脚本会打印一段可直接粘贴的 Node 上报示例（含 canonical 拼装与 gzip）。
上报链路的完整顺序与错误码见 `docs/api.md` §2.1/§2.2，字段白名单见 `server/src/models/report.js`。

```bash
# 真机联调（连真实 PG + Redis，会写测试数据并自动清理）
VANTAGE_LIVE_TEST=1 npm test
# PowerShell:  $env:VANTAGE_LIVE_TEST='1'; npm test
```

> ⛔ 凭证轮换**不做新旧并存**：旧 key 立即失效，且中心无法下发新 key → **必须人工上机替换**再 `reload`/`restart`，建议在维护窗口执行（决策 #42）。

## 4. 改代码前必读的关键不变量

| 不变量 | 一句话 | 出处 |
|---|---|---|
| 单向宗旨 | 中心零下发路径；上报响应恒为 `{ok, server_ts}` | 设计 §2.1、决策 #12 |
| 签名顺序 | 先 gzip 解压 → 取**原始 JSON 字节**验 HMAC → **再** `JSON.parse` → schema；解压前判 1MB / 解压输出上限 4MB（防 zip bomb） | 决策 #19/#35/#47、设计 §6.6 |
| canonical 拼法 | `method\npath\ntimestamp\nnonce\nsha256_hex(raw_body)`，固定 LF、末尾不加换行、`path` 不含 query；两端共用 `contracts/agent-signature.json` | 决策 #46 |
| nonce 与幂等 | nonce TTL **600s ≥ 签名窗口**；`batch_id`(ULID) 幂等 TTL 10min；失败时**同时**释放 batch 与 nonce 占位（只删一个会让重试陷入 409 死循环） | 决策 #18/#36 |
| 指标命名 | 维度写进**序列全名**（`disk.used_pct{mount=/data}`），主键 `(agent_id, metric, ts)` 不变，`labels` 只是反解副本；转义必须单射（`%` 也要转义） | 决策 #40、设计 §9.1 |
| 时间权威 | 存储/排序一律以 **`server_ts`** 为准；`agent_ts` 仅用于漂移检测（>60s 告警） | 决策 #16/#17 |
| 主机状态机 | 只有 `online` / `offline` / `disabled`，⛔ 不加 `abnormal`；告警/漂移/Flapping 用派生徽标表达 | 决策 #57 |
| Redis | 单实例 + 键名前缀 + **`maxmemory-policy noeviction`**；`evicted_keys` 须恒为 0（驱逐 = 重放窗口重开） | 决策 #51 / R15 |
| 权限 | 面板暂时**两级**：`admin` / `user`（`user` 纯只读）；DDL 与运行时 DML 用不同连接 | 决策 #52 / R13 |
| 公开视图 | 用独立 `public_slug` 标识，⛔ 公开响应/URL 不含内部 UUID 与真实设备名；默认开启但严格限流 + 严格脱敏 | 决策 #21/#41/#43/#53 |
| 保留期 | 原始 15d（Drop 分区）、1m 90d、5m 1y、探活 90d、进程 30d、IP 区间 180d、通知 180d、审计 365d、静默过期 7d 清；**删原始分区必须过两道门禁**（全局健康 + 逐分区健康） | 决策 #11/#48/#49/#50 |
| 定时任务 | core 内置 + 分布式锁（锁 fail-open、任务失败不崩进程但必须告警），理由见 `server/README.md` §4.5 | 决策 #50 |

完整决策表（59 条）见设计文档 §15；实现期的修订与踩坑见 `docs/design-deltas.md` 与 `server/README.md` §4。

## 5. 文档索引

| 想了解 | 读这里 |
|---|---|
| 宗旨、架构、技术决策表、里程碑 | [`Vantage-DESIGN-v0.7.md`](Vantage-DESIGN-v0.7.md) |
| 表结构 / Redis 键空间 / 分区与保留期 | [`docs/database.md`](docs/database.md) |
| 上报协议 / 面板 API / WS / 错误码 | [`docs/api.md`](docs/api.md) |
| Agent 采集 / 探活 / 配置 / 安装脚本 | [`docs/agent.md`](docs/agent.md) |
| **Agent 现在做到哪了（进度快照）** | [`docs/agent-status.md`](docs/agent-status.md) |
| **Agent 还差什么（待办清单）** | [`docs/agent-todo.md`](docs/agent-todo.md) |
| 面板页面 / 数据层 / 性能预算 | [`docs/frontend.md`](docs/frontend.md) |
| v0.7→v0.8 改了什么、M1/M1.5 实现记录 | [`docs/design-deltas.md`](docs/design-deltas.md) |
| 中心服务怎么跑、踩过哪些坑 | [`server/README.md`](server/README.md) |

## 6. 安全清单（摘要，完整版见设计 §13）

- [x] 每 Agent 独立凭证 + HMAC + 时间戳/nonce 防重放（Redis）；`agent_key` 只存哈希、`agent_secret_enc` 用 AES-256-GCM 密文且 AAD 绑定 `agent_id`（防跨行搬运）
- [x] 严格 schema 校验（字段白名单 / 数值范围 / 数组上限）+ 体积上限 + 按 Agent 限流 + 幂等去重
- [x] 验签在 `JSON.parse` 之前、gzip 解压之后；解压输出上限防 zip bomb
- [x] 5xx 一律折叠为通用消息（不回显 SQL / 约束名 / 内部路径）
- [ ] 面板登录 + TOTP 2FA + 有状态会话（Redis 不透明 `sid`，滑动 30min / 绝对 24h / 限并发 3）——M2/M4
- [ ] 公开视图严格限流 + 严格脱敏 + 一键关闭；`/ws/public` Origin 白名单——M2/M3
- [ ] ⛔ Agent key **永不进命令行**（`--key` 永久禁用）：用 `VANTAGE_KEY` 环境变量内联 / stdin / `--key-file 0600`——M2 安装脚本
- [ ] 可信代理解析（`X-Forwarded-For` 白名单，防伪造来源 IP）、数据库只监听本地、定期备份——部署期
- [ ] Agent 非 root 运行 + systemd 加固 + 出站白名单——M2

## 7. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | Agent 采 6 类指标 + 中心收/存 + 免登录公开状态页 | 中心侧 ✅；Agent 侧采集/组包/上报 ✅（公开页待做） |
| M1.5 | 分区维护 / 降采样 1m·5m / 保留期清理 / 单实例锁 | ✅ 提前落地（分区提前量有硬死线） |
| M2 | 鉴权（key+HMAC）+ TLS + schema/限流 + 面板登录 + 公开 API + Agent 安装脚本 | ⏳（Agent 侧鉴权/TLS 代码 ✅；安装脚本、systemd、面板登录未开工） |
| M3 | 告警引擎（阈值/离线/IP 变化/探活）+ 多通道通知 + WS | ⏳ |
| M4 | 探活面板 + GPU/进程完善 + 历史面板 + 2FA/RBAC | ⏳ |
| M5 | Docker 监控、非 root 加固打磨、扩展项 | ⏳ |
| M6 | 跨平台：Windows / macOS 采集器 + 各自安装脚本 | ⏳ |

## 8. 许可

**AGPL-3.0**（强 copyleft，适配网络服务形态）。⚠️ 仓库尚未放入 `LICENSE` 文件，正式开源前需补齐。
依赖许可干净：Vue / Fastify / ECharts / Element Plus（宽松）、Go 侧仅 `gopkg.in/yaml.v3`（Apache-2.0，ICMP 走裸 syscall 不引第三方）、PostgreSQL / Redis（各自宽松）。
