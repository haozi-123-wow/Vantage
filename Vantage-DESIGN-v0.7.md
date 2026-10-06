# Vantage — 服务器监控系统 · 技术方案文档（v0.8，不含代码）

> 项目名：Vantage（望楼）。一处高台俯瞰所有机器：Agent 只上报，中心不发令。
> 组成：Go Agent + Node.js 中心 + PostgreSQL + Redis + Vue 面板。
> 状态：v0.8 定稿。核心宗旨与全部技术决策已定（§15 决策表共 59 条）。M1（上报链路）与 M1.5（分区 / 降采样 / 保留期）已落地并完成真机验证，各部分实现状态见下方状态表。
> 文档分工：本文保留宗旨与架构级决策，四份专项文档承载细节与字段契约 —— `docs/database.md`（主控库表 / Redis 键空间 / 分区与保留）、`docs/api.md`（上报协议 / 面板 API / WS / 错误码）、`docs/frontend.md`（Vantage Console 页面与数据层）、`docs/agent.md`（采集 / 探活 / 上报 / 配置 / 运维）。
> 注：本文件名保留 `v0.7` 以维持既有引用，内容已升为 v0.8；v0.7 到 v0.8 的逐条修订见 `docs/design-deltas.md`。
>
> 版本沿革：
> - v0.8：拆出四份专项文档；修正三处内部矛盾（删除 Agent 离线缓存模块、指标维度写进序列全名、WS 应用层只允许 `subscribe`）；补齐 `users`/`settings`/`channels`/`silences`/`user_recovery_codes` 表、指标命名与转义规范（§9.1）、保留期矩阵与清理任务（§9）、Redis 键空间与 `noeviction`（§9）、能力声明落点（§4.9）；修订决策 #11、#21、#31、#32、#37、#38，新增决策 #40–#59。
> - v0.7：六项健壮性修复 —— Agent SIGHUP 配置热重载；签名与压缩的落地顺序（验签在 `JSON.parse` 之前、gzip 解压之后，取原始 JSON 字节）；nonce TTL 由 120s 改为 600s；key 弃用命令行改环境变量/stdin；指标日分区 + 保留期 Drop + 降采样（1m/5m）；IP 变化防抖与 Flapping 检测。
> - v0.6：面板会话与实时通道定案。登录用有状态会话（Cookie 仅存不透明 `sid`，状态在 Redis；滑动 30min、绝对 24h、限并发、IP/UA 只记录）；实时通道选 WebSocket，Redis Pub/Sub 扇出，先快照后增量；未登录可连只读脱敏 WS。
> - v0.5：跨平台路线 —— Agent 采用平台适配层 + 能力声明，Linux 优先（M1–M5），Windows/macOS 排到 M6，中心侧完全复用。
> - v0.4：定稿。面板中文优先并预留 i18n；基础响应式；许可 AGPL-3.0。
> - v0.3.9：Agent 安装与管理统一到 `vantage.sh`（install/upgrade/uninstall/start/stop/restart/status）；二进制从 GitHub Releases 或镜像站下载，不经中心；安装时传 `--center`、`--agent-id`、`--key`，其余细节手动编辑配置。
> - v0.3.8：通知通道采用队列 + 令牌桶限速 + 同类合并 + 静默期 + 恢复通知，避免告警风暴导致机器人被限流封禁。
> - v0.3.7：告警规则采用受控阈值 DSL（表单化，零 RCE），保留 `expr` 扩展位。
> - v0.3.6：公开视图默认隐藏 IP 与内网信息，仅展示别名、状态与指标概览，支持自定义显示名。
> - v0.3.5：磁盘与网卡在 Agent 端默认过滤伪文件系统与虚拟网卡，支持本地白名单/黑名单。
> - v0.3.4：签名针对 gzip 之前的原始 JSON 字节，压缩仅作传输层。
> - v0.3.3：幂等键定为 `batch_id`（ULID），Redis `SETNX` 判重，TTL 10 分钟。
> - v0.3.2：时间与时钟策略 —— 存储时间以 `server_ts` 为权威，`agent_ts` 做漂移检测；签名窗口可配（默认 300s，硬上限 5min）；新增 `clock_drift` 告警；默认接受 + 修正 + 告警，严格拒收为 opt-in。
> - v0.3.1：确定规模（当前 5 台，设计留扩展余量）；Agent 在宿主机运行，Docker 暂缓；断网即丢弃、不补传，由中心按离线告警；key 落地方式为中心生成并拼装安装命令。
> - v0.3：命名 Vantage；存储定为 PostgreSQL、缓存定为 Redis、前端定为 Vue；Agent 极低占用并支持非 root 运行；新增本地探活（ping/HTTP/TCP）与告警引擎、多通道通知（SMTP/企业微信/钉钉/飞书/标准 Webhook）；面板支持免登录查看基础状态，历史需登录。
> - v0.2：确立通信严格单向宗旨，填入默认技术决策。
> - v0.1：初稿（架构 / 采集 / 鉴权 / IP 追踪 / 数据模型 / 目录结构 / 里程碑）。

## 实现状态

下表按组件汇总当前实现程度，正文不再逐句重复状态。里程碑的详细交付与偏差记录见 `docs/design-deltas.md` §8/§9、`docs/agent-status.md` 与 `server/README.md`。

| 部分 | 状态 | 说明 |
|---|---|---|
| Agent 采集与上报（M1） | 已实现 | 六类采集器齐备，组包、签名、上报通路完成 |
| Agent 安装与管理脚本（M2） | 部分实现 | `vantage.sh`、systemd unit 与配置模板已落地，真机负例验证待做 |
| Agent 本地探活与心跳（M3） | 已实现 | ping/http/tcp 与心跳节流完成，测试已运行 |
| Agent 热重载与非 root 加固（M4） | 部分实现 | SIGHUP 热重载、GPU 降级、Top-N 完成；`setcap` 与出站白名单运维文档待补 |
| Agent Docker 采集（M5） | 未实现 | 配置层显式拒绝开启，留待 M5 |
| Agent 跨平台（M6） | 未实现 | 非 Linux 平台启动即拒绝，符合既定路线 |
| 中心接入与鉴权 | 已实现 | key + HMAC 验签、nonce/幂等、限流、schema 校验 |
| 中心存储与保留 | 已实现 | 按天分区、Drop 分区、1m/5m 降采样与保留清理任务 |
| 中心公开视图与面板 API | 已实现 | `/api/public/*` 与需登录的 `/api/v1/*` 端点均已提供 |
| 中心面板会话与 2FA | 已实现 | 有状态会话、限并发、TOTP 自助绑定与一次性恢复码 |
| 中心告警引擎与多通道通知 | 暂未实现 | `alert_events` 等表结构已建，规则引擎与通知发送待开发 |
| 面板前端（Vantage Console） | 部分实现 | 公开状态页、主机列表与详情、实时 WS 数据层已可用，配置类页面随告警引擎推进 |

---

## 0. 命名与组件

| 项 | 名称 | 说明 |
|---|---|---|
| 项目/仓库 | `vantage` | 主仓库 |
| 被监控端二进制 | `vantage-agent` | Go 单文件，跑在每台被监控机 |
| 中心服务 | `vantage-core` | Node.js + Fastify |
| Web 面板 | Vantage Console | Vue3 前端 |
| 数据库 | PostgreSQL 16 | 主存储 |
| 缓存 | Redis 7 | 限流 / nonce / 会话 / 去重 / 实时扇出(Pub/Sub) |

---

## 1. 目标与范围

### 1.1 核心目标
- 多机 → 单中心，Agent 主动出站上报，中心不开放公网采集端口。
- Web 面板：主机列表、实时/历史指标曲线、告警、探活状态。
- 每台 Agent 独立鉴权凭证（独立 key）；支持吊销 / 禁用，手动轮换（不新旧并存，见 §6.1）。
- 中心记录并追踪 Agent 的 IP 变化。
- Agent 极低占用，并支持以非 root 权限运行。
- 灵活的自定义告警，多通道送达。
- 面板免登录可看基础状态，敏感与历史内容需登录。
- 安全优先：全链路 TLS、独立凭证、RBAC、审计、2FA。

### 1.2 监控项（本期）
- CPU：整体/各核使用率、负载(1/5/15)、上下文切换。
- 内存：总量/已用/可用、swap、缓存/缓冲。
- 硬盘：分区容量、inode、读写 IOPS/吞吐/延迟。
- 网络：各网卡上下行速率、累计流量、连接数、错误/丢包。
- GPU：利用率、显存、温度、功耗（NVIDIA 优先，AMD 预留）。
- 进程：总数、Top-N（CPU/内存）、关键进程存活检测。
- 本地探活：Ping(ICMP)、HTTP(S)、TCP 端口 —— 由 Agent 在本机执行并按配置上报结果。

### 1.3 后续扩展（预留）
- Docker/容器监控、日志采集、自定义脚本指标、URL 内容断言。

### 1.3.1 规模与部署（现状）
- 当前规模：5 台被监控机；架构按可平滑扩展到几十台设计，但不为虚增规模加复杂度。
- Agent 一律跑在宿主机（非容器）；Docker/容器监控本期暂缓，仅保留接口。

### 1.4 非目标（本期不做）
- 分布式存储/多中心、跨国联邦、APM/链路追踪、日志全文检索。

---

## 2. 总体架构

```
┌──────────────┐        HTTPS (JSON, gzip)        ┌────────────────────────────────┐
│ vantage-agent │  ── 出站，带 X-Agent-Key + HMAC ──▶ │  vantage-core (Node/Fastify)   │
│  被监控机     │                                    │  ├─ 接入层/鉴权/校验/限流(Redis)  │
│  ├ CPU/内存   │  ◀── 仅 ACK(ok/ts)，不下发任何内容 ── │  ├─ 服务层(聚合/告警/IP追踪/探活) │
│  ├ 硬盘/网络  │                                    │  ├─ 数据层(PostgreSQL)          │
│  ├ GPU/进程   │                                    │  ├─ 查询 API + WebSocket        │
│  └ 本地探活   │                                    │  └─ Vantage Console(Vue 静态)    │
└──────────────┘                                    └────────────────────────────────┘
                                                            │
                          ┌──────────────┬──────────────────┼──────────────┬─────────────┐
                          ▼              ▼                  ▼              ▼             ▼
                     PostgreSQL        Redis            告警通道      反向代理      免登录视图
                     (主存储)      (限流/nonce/会话)  SMTP/企微/钉钉  Caddy/Nginx   (公开只读)
                                                        飞书/Webhook  HTTPS+2FA
```

### 关键设计原则
0. 通信严格单向（宗旨，不可违背）：中心永远不能向 Agent 下发任何指令、配置、脚本或命令；Agent 配置只由被监控机本地文件管理。中心对上报只回 ACK，不带任何可被执行的内容。详见 2.1。
1. 出站上报：Agent 只发起出站连接；中心仅对公网暴露面板端口（经反代），采集接口只对内网/白名单开放。
2. 默认拒绝：未鉴权、未过 schema 校验、超限的请求一律拒绝。
3. 每机独立凭证：一个 Agent 一个 key，泄露只影响单机，可单独吊销。
4. 无状态接入 + 有状态存储：接入层可横向扩，数据落 PG。

### 2.1 单向通信宗旨（落地要点）
- 配置只在本地：Agent 的一切行为（中心地址、采集项、采集频率、探活目标、日志级别等）由本机 `config.yaml` 决定，中心无法覆盖、无法远程修改。Agent 侧也不存在任何缓存模块，连缓冲大小这样的参数都没有（见 §4.7）。
- 中心对 Agent 无写权限：不存在下发配置、远程执行、重启、改频率、改探活目标这类接口，响应体也不能夹带任何可执行字段。
- 响应体极简：上报响应只含 `{ ok, server_ts }`，Agent 只判断成功与否。
- 改配置只能上机：新增或修改监控与探活，用户必须登录目标机修改本地文件并重启 `vantage-agent`，这是唯一路径（见 4.6 探活闭环）。
- 中心被动只读：中心只做收数据、存储、展示、告警。
- 好处：Agent 攻击面极小；即便中心被入侵，也无法通过监控通道操控任何机器，因为这条路径根本不存在。

---

## 3. 技术栈

| 组件 | 选型 | 说明 |
|---|---|---|
| Agent | Go 1.22+ | 单文件静态二进制、跨平台、极低占用、可非 root 运行 |
| 中心 | Node.js 22 LTS + Fastify | 高并发 I/O，内置 schema 校验 |
| 传输 | HTTPS + JSON（gzip） | 预留编码器接口，后续可换 Protobuf |
| 数据库 | PostgreSQL 16 | 主存储；原始时序层按天分区；不必需扩展（Timescale 可选） |
| 缓存 | Redis 7 | 限流、nonce 防重放、面板会话、去重 |
| 前端 | Vue 3 + ECharts + Element Plus | Vantage Console；组件库按需引入（见 §15 决策 56） |
| 实时 | WebSocket（主，SSE 备选） | 快照 + 增量推送；Redis Pub/Sub 扇出；公开只读频道脱敏 |
| 部署 | Docker Compose + systemd | 中心 Compose；Agent 二进制 + systemd 加固 |
| 反代 | Caddy / Nginx | TLS 终止、面板认证前置、IP 白名单 |

---

## 4. Agent 设计（`vantage-agent`，Go）

### 4.1 模块划分
- `collector/`：采集器统一接口（gopsutil 为主）
  - `cpu` `mem` `disk` `net` `gpu` `process`（后续 `docker`）
- `prober/`：本地探活（ping / http / tcp），按本地配置执行（见 4.6）
- `scheduler/`：采集与探活调度（不同任务不同频率）
- `reporter/`：组包、gzip、签名、上报、重试（无离线缓存模块，见 4.7）
- `auth/`：加载本机 key，生成 HMAC 签名
- `config/`：读取并校验 `config.yaml`
- `retry/`：内存级重试（仅当前批次，数分钟内重试几次）；不做跨断网的持久化补传（见 4.7）。原离线环形缓存模块已在 v0.8 删除（见 §11.2）。

### 4.2 采集实现要点
- CPU：`gopsutil/cpu.Percent` + `Load`；按核输出。
- 内存：`mem.VirtualMemory()`、`SwapMemory()`。
- 硬盘：`disk.Partitions()` + `disk.Usage()`；IO 读 `/proc/diskstats`。
- 网络：`net.IOCounters(pernic=true)`，速率 = 差值/时间。
- GPU：NVIDIA 优先 `nvidia-smi --query-gpu ... --format=csv`；AMD `rocm-smi`；无卡则跳过不报错。
- 进程：`process.Processes()` → 总数 + Top-N + 关键进程白名单存活。
- 指标命名（v0.8 新增）：所有序列名与维度转义遵循 §9.1（如 `disk.used_pct{mount=/}`）；Agent 产生、中心校验、API 解析必须同源实现，共用测试向量。
- Docker（预留）：读 `docker.sock`（需用户加入 docker 组，非 root 可用）。

### 4.3 极低占用设计（硬指标）
- 内存：空闲目标 < 20–30MB；设 `GOMEMLIMIT`（如 48MB）封顶；避免每周期新建大对象。
- CPU：空闲 < 0.5%；采集批次间事件驱动 sleep，无忙轮询；单次采集 <50ms（GPU 调用除外）。
- 磁盘：不做容灾补传缓存，无磁盘占用（断网策略见 4.7）；仅内存当前批次重试。
- 网络：批量 + gzip，单次上报目标 <20KB；无变更时可只报心跳。
- 二进制：静态编译单文件，体积小，无运行时装依赖。
- 并发：固定少量 goroutine（每采集器一条 + 上报一条），不随主机规模膨胀。

### 4.4 非 root 运行（一等公民）
- 默认不要求 root，以专用低权用户（如 `vantage`）运行。
- ICMP Ping 无特权：优先用 Go 的非特权 ICMP（IPv4 udp4 "ping" socket / `golang.org/x/net/icmp`）；若内核或环境不支持，提供两种回退：
  1. 退化为 TCP 连通探测（`tcp` 类型）；
  2. 可选 `setcap cap_net_raw+ep`（文档给出，属 opt-in，非必需）。
- 不监听 <1024 特权端口；不写系统目录；所有数据与缓存写在用户可写的运行目录。
- systemd 加固示例（随包提供）：`User=vantage`、`NoNewPrivileges=true`、`ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`、`ReadWritePaths=<数据目录>`。
- 缺失权限时优雅降级并留明确日志（如 GPU 工具不存在、`docker.sock` 不可读），绝不崩溃。

### 4.5 调度与开销目标
- 默认周期：核心指标 15s；磁盘/进程 30–60s；GPU 10–15s；探活按各自配置（如 30s）。
- 需要说明一处设计与实现的差异：Agent 侧 `report.interval` 默认值已修订为 30s（采集周期对齐为 cpu/mem/net/gpu 30s、disk/process 60s，中心离线阈值 = 3×30s = 90s），而上一行的 15s 是 v0.8 的设计目标值。该修订与 `docs/agent.md` G3 及 `agent/internal/config/config.go` 一致，属于实现期调整，不是设计变更。
- 所有周期、开关、探活目标均由本地 `config.yaml` 控制。

### 4.6 本地探活闭环（关键：中心不下发命令）
设计前提：中心不能给 Agent 发指令，所以探活目标只能在 Agent 本地配置。
- `config.yaml` 中 `probes:` 列表，示例：
  ```yaml
  probes:
    - name: "site-health"
      type: http
      url: "https://example.com/healthz"
      method: GET
      expect_status: [200]
      body_contains: "ok"      # 可选
      timeout: 5s
      interval: 30s
    - name: "public-gw"
      type: ping
      host: "1.1.1.1"
      timeout: 2s
      interval: 30s
    - name: "db-port"
      type: tcp
      host: "10.0.0.5:5432"
      timeout: 3s
      interval: 30s
  ```
- Agent 本地执行探活，把结果（up/down、延迟、状态码、错误、`checked_at`）随同其它指标一并上报给中心。
- 中心只存结果、判定与告警，不反向改探活配置。
- 用户操作闭环：在中心面板看到某机后（或直接登录机器）→ 到那台机改 `config.yaml` 加探活项 → `systemctl restart vantage-agent` → 新探活结果随上报出现在中心。
- 支持类型：`ping`、`http`/`https`、`tcp`；可扩展 `dns`。

### 4.7 断网策略（丢弃式，明确不做补传）
- 原则：断网即丢弃，不缓存、不补传。
- 上报失败：只在内存中对当前批次做有限次快速重试（见 §15 决策 47：最多 3 次、退避 2s 起指数、总时长 ≤30s）；仍失败则丢弃该批，继续下一周期。
- 实现上不存在任何缓存模块（原 §11.2 的 `internal/buffer/` 已在 v0.8 删除）：Agent 磁盘占用恒为 ≈0，不存在"断网期间攒下来的数据"。
- 进程重启：不保留断网期间数据；不写磁盘缓存。
- 断网期间，中心会因超过阈值收不到数据而把该机判为离线并触发离线告警；恢复联网后不补旧数据，从当前时刻重新上报。
- 代价是断网期间的数据永久丢失，这对监控场景可以接受，且离线告警已经覆盖了该事件。

### 4.8 采集过滤（磁盘/网卡）
- Agent 端默认过滤：排除伪文件系统（`tmpfs/devtmpfs/proc/sysfs/overlay/squashfs/cgroup*` 等）与虚拟网卡（`lo/docker*/veth*/br-*/virbr*`）。
- 本地可覆盖（`config.yaml`）：支持白名单（"只看 `/` 和 `/data`"）或黑名单；纯本地配置，符合单向宗旨。

### 4.9 平台适配层（为跨平台预留，不返工）
- `collector/` 采用接口 + 每 OS 一份实现：`cpu_linux.go / cpu_windows.go / cpu_darwin.go`（Go 构建标签分发）。
- 每个采集器带能力声明：本平台支持哪些指标；不支持的置空或省略而非报错（如 Windows 无 inode、macOS 无 NVIDIA GPU）。能力声明随上报携带在 `host.capabilities`（布尔白名单，首次与能力变化时必填，见 §15 决策 55），中心落 `agents.capabilities`，面板据此隐藏不支持的图表与列。
- 主机信息（`host.os`/`host.arch`）随上报，中心侧统计与展示可按平台区分。

---

### 4.10 配置热重载（SIGHUP，免重启）
- 问题：改 `config.yaml` 若靠 `systemctl restart`，短采集周期下会反复上下线，可能误触离线告警（离线阈值 ≈ 3×周期，重启稍慢即触发）并造成曲线断层。
- 方案：Agent 监听 `SIGHUP`（systemd `ReloadSignal=SIGHUP`），收到后重新读取并校验 `config.yaml`，原子替换内存配置（指针切换，读侧无锁），保留进程、连接与鉴权/签名状态。
- 失败安全：校验不过则保留旧配置，记日志并上报 `config_reload_failed` 告警，绝不进入半配置状态。
- 管理入口：`vantage.sh reload`（等价于 `systemctl reload vantage-agent`），与 install/upgrade 等统一。
- 不支持远程下发配置（单向宗旨）；Windows/macOS（M6）用各自的 reload 机制。
- 重载只读本机 `config.yaml`，代码中不存在从中心拉配置的路径；未知配置字段一律拒绝（启动失败，或重载时保留旧配置，见 `docs/agent.md` §8 的 G7 项）。

---

## 5. 中心服务器设计（`vantage-core`，Node.js）

### 5.1 分层
```
接入层 (routes/middleware)  →  服务层 (services)  →  数据层 (repositories/PG) + Redis
   ├ TLS/mTLS                  ├ 指标聚合/降采样        ├ 表 CRUD
   ├ Agent 鉴权(Key+HMAC)       ├ 告警规则引擎           ├ 批量写入
   ├ schema 校验(白名单)         ├ IP 变化追踪            ├ 时序查询
   ├ 限流/nonce(Redis)          ├ 探活结果判定
   └ 审计日志                   ├ Agent 心跳/离线判定
                               └ WebSocket 推送(Redis Pub/Sub 扇出)
```

### 5.2 关键中间件（顺序固定）
1. `tls`：可选 mTLS（校验客户端证书）。
2. `authAgent`：校验 `X-Agent-Id` + `X-Agent-Key` + `X-Signature`(HMAC-SHA256) + `X-Timestamp`。
3. `schemaValidate`：JSON Schema，字段白名单 + 数值范围 + 数组长度上限。
4. `rateLimit`：按 Agent 维度限流（Redis）。
5. `audit`：记录谁在何时上报/访问了什么。

> 体积上限（见 §15 决策 47）：压缩前 ≤ 1MB、解压输出 ≤ 4MB。超限返回 413，且不进入 `JSON.parse`，以防 zip bomb。Agent 侧单批熔断阈值为 256KB（裁剪顺序见 `docs/agent.md` §5.3）。

### 5.3 心跳与离线判定
- 每次上报即心跳，更新 `last_seen_at`、`last_ip`。
- 离线：`now - last_seen_at > 阈值(如 3×上报周期)` → 标记离线 → 触发离线告警。
- 状态只有在线 / 离线 / 禁用三种（见 §15 决策 57：不引入"异常"态，"有告警 / 时钟漂移 / IP Flapping"一律用派生徽标与计数表达，避免与告警引擎重复且难同步），另记最后在线时间。
- 过期上报拒绝：中心丢弃 `ts` 迟于 N 小时（建议 6h）的上报，防时钟错乱与异常重放，符合断网丢弃策略。

### 5.4 面板访问分级（免登录可看基础状态）
| 内容 | 免登录（公开） | 需登录 |
|---|---|---|
| 主机列表 + 当前在线/离线状态 | 可见 | |
| 当前指标快照（最新 CPU/内存/磁盘/网络/GPU） | 可见 | |
| 探活当前 up/down 概览 | 可见 | |
| 汇总计数（在线数/离线数/告警数） | 可见 | |
| 历史曲线 / 历史状态查询 | 不可见 | 可见 |
| IP 变更历史、进程 Top、审计日志 | 不可见 | 可见 |
| 告警规则配置、Agent 管理、密钥操作 | 不可见 | 可见 |
- 实现：公开命名空间 `GET /api/public/*`（只读、只返回"当前值"快照，带缓存与限流）；其余接口走认证中间件。
- 公开接口的主机标识使用独立的 `public_slug`（`agents.public_slug`，随机短 ID、UNIQUE、不随改名变化，见 §15 决策 41），`/api/public/hosts/:slug/now` 的 `:id` 即 slug；公开响应与 URL 不含内部 UUID。
- 实时：公开视图可通过只读脱敏 WS（`/ws/public`）订阅实时状态，payload 脱敏（隐藏 IP 与内网信息）、严格限流；全量频道 `/ws/live` 需登录。详见 §18。脱敏口径与公开 REST 完全一致，包括设备名泛化（如"磁盘 1/2""网卡 1/2"）。
- 公开视图可整体开关（`public_view.enabled`），并对公开接口做严格限流与只读校验，绝不泄露 key 与内部 ID。该开关存 `settings` 表（面板可改、立即生效、变更写审计，见 §15 决策 43），默认开启，配套要求是严格按 IP 限流、严格脱敏、设置页醒目状态与一键关闭（见 §15 决策 53）。

---

## 6. 鉴权机制（每 Agent 独立 Key）

### 6.1 凭证模型
- 中心为每台 Agent 生成：`agent_id`(UUID) + `public_slug`（对外标识，见 §5.4）+ `agent_key`（只存哈希，明文仅创建与轮换时返回一次）+ `secret`(HMAC，独立于 key)。
- 支持创建、禁用、启用、吊销、手动轮换。
- 轮换不做"新旧并存过渡"（见 §15 决策 42）：每个 Agent 任一时刻只有一套凭证，`agents` 的 `agent_key_hash` / `agent_secret_enc` 两列足够，不需要多 key 表。轮换 = 管理员在面板显式操作 → 新凭证明文仅展示一次 → 旧凭证立即失效（无宽限期）→ 因中心无法下发新 key，必须人工登录该机替换 key 文件并 `reload`/`restart`；替换窗口内上报返回 401，由离线告警兜底（建议在维护窗口执行）。
- 遗忘轮换不会自动失效，改由面板"建议轮换"徽标加每日一次通知管理员驱动；阈值 `credential_rotate.reminder_days`（可配置，默认 90 天，存 `settings` 表，见 §9）。

### 6.2 请求签名（防篡改 + 防重放）
```
canonical = method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(raw_body)
signature = HMAC_SHA256(secret, canonical)
Header: X-Agent-Id / X-Timestamp(unix_ms) / X-Nonce / X-Signature(hex)
说明：sha256_hex(raw_body) 针对 gzip 之前的原始 JSON 字节（见 9.3）。

见 §15 决策 46：固定用 `\n`（LF）分隔这 4 处、末尾不加换行；`path` 仅路径（不含 host/query）；
   `timestamp` 为十进制 ASCII unix 毫秒。Agent 与中心必须配共享测试向量（固定 secret/body/ts/nonce → 期望签名值），
   避免"实现都对但拼法不同"导致 401。
```
中心校验：① `agent_id` 存在且启用；② `|now-ts| <= 签名窗口`（默认 300s，可收紧至 60s，硬上限 5min）；③ nonce 未用过（Redis 去重，TTL ≥ 签名窗口，默认 600s）；④ 重算签名一致。

### 6.5 时间与时钟策略
- 权威时间 = `server_ts`（中心接收时间），写入时序与排序以它为准；`agent_ts` 作为附加字段保留，仅用于漂移检测与展示。即使某机时钟偏，数据依然正确入库、正常出图。
- 时钟漂移 = `agent_ts − server_ts`；超阈值（默认 60s）→ 发 `clock_drift` 告警（复用现有通道）；主机详情页标"时钟漂移"角标。
- 默认策略：接受 + 修正 + 告警（不丢弃）。严格模式（超窗即拒）作为 opt-in 开关，默认关。
- Agent 本地可配（符合单向宗旨）：是否用 `server_ts` 校正自身展示与探活记录时间（默认开）。
- 安全上限：签名窗口绝不无限放宽；漂到 >5min 一律拒收（防重放），而此时早已被 `clock_drift` 告警捕获，上机 `timedatectl` 校准即可。

### 6.3 传输层
- 全链路 HTTPS。可选强化：mTLS（每机独立客户端证书），与 HMAC 组成"双保险"。

### 6.4 权限
- Agent 只能写入自己的数据；禁止跨机访问；中心不向 Agent 返回任何配置或指令（单向宗旨）。

---

### 6.6 签名校验与压缩的落地顺序（实现要点）
- 目标：签名针对中心收到、gzip 解压之后的原始 JSON 字节；JSON 解析与重序列化会改变字段顺序与空格，绝不能用解析后的对象重算签名。
- Agent 端：`序列化 JSON → 计算 sha256/HMAC → gzip 传输`，签名用的字节与发送的字节同源（只序列化一次）。
- 中心端（Fastify）顺序：`收包 → 限流/大小上限 → (若有)gzip 解压 → 取原始 JSON Buffer → sha256+HMAC 校验 → 通过后 JSON.parse → schema 校验`。
  - 实现：用 `preParsing` 钩子（或自定义 content-type parser）截获解压后的原始 buffer，在 `JSON.parse` 之前完成验签；不要走默认 JSON parser 后再验签。
  - 顺序说明：因签名针对解压后字节，必须先解压、再验签。v0.6 的措辞易被误读为"解压前验签"，此处纠正。
- 防 zip bomb：解压前先判 `Content-Length` 上限，解压时限制输出字节数，超限直接拒绝。定值为压缩前 1MB / 解压后 4MB（见 §15 决策 47）。

---

## 7. 告警系统（自定义规则 + 多通道）

### 7.1 规则模型（用户可自定义）
- 阈值类：某指标（如 `cpu.usage`、`mem.used_pct`、`disk.used_pct`）`> / >= / <` 阈值，持续 `duration`（如 5m）触发。
- 离线类：Agent 下线（超过 N 个上报周期无数据）。
- IP 变化类：任意变化 / 跨网段变化 / 短时间内频繁变化。
- 探活类：`ping/http/tcp` 目标 down、响应超时、状态码不符。
- 时钟漂移类：`|agent_ts − server_ts| > 阈值`（默认 60s）→ 告警，提醒上机校准。
- 规则字段：`target`(单机/按标签/全体)、`metric/cond`、`threshold`、`for`(持续时长)、`severity`(info/warn/critical)、`channels`、`cooldown`(静默期)、`enabled`。`channels` 存通道 id 数组（通道是凭证与模板的唯一归属方，见 §7.2）；非阈值类规则（探活/IP 变化/离线/时钟漂移）的附加参数统一放 `params` JSONB 并按 `kind` 白名单校验（未知键直接 400），避免列随规则类型膨胀（见 §15 决策 59）。
- 规则表达方式为受控阈值 DSL（表单化）：`指标 + 比较符 + 阈值 + 持续时长 + 作用对象`，中心只做数值比较，不使用 eval、不执行用户代码；架构保留 `expr` 扩展位，未来可选接入沙箱表达式引擎（CEL/expr-lang）。`metric` 可写基名（`disk.used_pct` → 对每个维度序列分别判定，各自产生事件）或全名（`disk.used_pct{mount=/data}` → 只判该单序列）；`alert_events.metric` 记录触发序列全名以区分同规则的不同挂载点；事件列表按 `metric` 过滤。
- 支持静默窗口 / 维护期、告警恢复通知（resolved）、去重合并。
- 静默窗口与维护期落 `silences` 表（`target` 与规则同构，过期后 7 天清理）；不引入事件 `ack`（认领）语义 —— "别再报"用静默窗口与规则 `cooldown` 覆盖，同一序列同一规则同时只允许一条 firing 事件，靠部分唯一索引保证。

### 7.2 通知通道（全部支持）
| 通道 | 说明 |
|---|---|
| SMTP | 标准邮件，支持 TLS/STARTTLS、多收件人 |
| 企业微信 | 群机器人 Webhook（markdown/text） |
| 钉钉 | 群机器人 Webhook（加签 secret） |
| 飞书 | 自定义机器人 Webhook（加签 secret） |
| 标准通知接口 | 通用 Webhook：POST JSON，支持 HMAC 签名头，适配自建系统 |
- 每通道独立模板；通道可开关、可测发送；失败重试 + 结果记录。
- 通道落 `channels` 表（`kind`/`config`/`template`/`rate_limit`/`enabled`，见 §15 决策 59），是凭证与模板的唯一归属方（`config` 敏感项加密存储，读接口只回遮罩值）；规则只引用其 id，不内联通道参数；通道被禁用 → 规则保留关联但跳过发送（`notification_log` 记 `channel_disabled`）；删除仍被规则引用的通道 → 409 `channel_in_use`，不级联删规则。

### 7.3 告警风暴防护
- 队列 + 令牌桶限速：每通道按自己的速率发送，防止被钉钉/企微/飞书群机器人限流封号。
- 同类合并：同一机、同一规则短时间重复触发 → 合并为一条"持续中"通知，不刷屏。
- 静默期(cooldown) + 恢复通知：触发后 N 分钟内不重复；恢复时发一条 `resolved`。
- 失败重试 + 结果写入 `notification_log`。

---

## 8. IP 变化追踪

- 来源：中心取连接 `remoteAddress`（真实 IP 靠反代 `X-Forwarded-For`/`X-Real-IP`，配置可信代理）；Agent 亦可上报自身探测的出口 IP，双源比对以识别 NAT。
- 判定：每次上报与 `agents.last_ip` 比较；相同更新 `last_seen`；不同则写历史、更新当前 IP、生成 IP 变化事件（旧 IP、新 IP、时间、是否同网段、来源）。
- 展示：详情页显示当前 IP 与变更时间线（需登录）。
- 防抖 / Flapping 检测：复杂 NAT 或多出口（每次上报出口 IP 交替）会刷爆 `ip_change_events` 并引发告警风暴。规则为同一 Agent 在 10 分钟内变化 > 3 次判定为 Flapping 态，暂停 IP 变化类告警（只记一条 `ip_flapping` 事件）并进入静默冷却，恢复稳定后自动解除。承载落定为 `ip_change_events.kind`(`change`/`flapping`) + `change_count` + `source`，Flapping 态标在 `agents.ip_flapping` / `flapping_since`（见 §9）。
- 只跟踪主出口：忽略私网、回环与虚拟网卡地址；判定变化前要求新 IP 稳定持续 ≥ N 秒（迟滞），避免抖动误报。
- 告警：接 7.1 的 IP 变化类规则（受上述防抖约束）。

---

## 9. 数据模型（PostgreSQL 16）

```sql
agents(
  id UUID PK, name TEXT,
  public_slug TEXT UNIQUE,          -- v0.8：公开接口标识（随机短 ID），公开响应不含内部 UUID
  agent_key_hash TEXT,              -- agent_key 的 HMAC-pepper 哈希（不可逆）
  agent_secret_enc TEXT,            -- HMAC secret 必须可逆（验签要重算），故存 AES-256-GCM 密文而非哈希；明文仍不入库
  tags JSONB, display_name TEXT,
  status TEXT,                      -- online/offline/disabled（无 abnormal，见 §5.3）
  last_ip INET, reported_ip INET, last_seen_at TIMESTAMPTZ,
  last_agent_ts BIGINT, clock_drift_ms BIGINT,
  host_info JSONB, capabilities JSONB,   -- host_info/os/kernel/arch + 能力声明（决策 55）
  ip_flapping BOOL, flapping_since TIMESTAMPTZ,
  created_at, rotated_at, rotate_reminder_at, disabled_at
)

agent_ip_history(
  id BIGSERIAL PK, agent_id UUID FK, ip INET,
  source TEXT,                      -- remote/agent_reported
  first_seen TIMESTAMPTZ, last_seen TIMESTAMPTZ
)

ip_change_events(
  id BIGSERIAL PK, agent_id UUID FK,
  old_ip INET, new_ip INET, same_subnet BOOL, changed_at TIMESTAMPTZ,
  source TEXT,                      -- remote/agent_reported（§8 双源）
  kind TEXT,                        -- change/flapping（决策 39：Flapping 只记一条）
  change_count INT                  -- 触发 Flapping 判定时 10 分钟窗口内的变化次数
)

-- 指标原始层：按【天】分区（15s 粒度 → 5 台约 144 万行/天，1 年约 5.25 亿行）
-- 实现说明：Agent 的 report.interval 默认值已修订为 30s（见 §4.5 的说明），
--    实际行数约为上述推算的一半；保留期与分区策略不变，重算见 docs/database.md §9。
metrics_raw(
  agent_id UUID, metric TEXT,       -- 序列全名：cpu.usage / disk.used_pct{mount=/} / gpu.util{index=0}（见 §9.1）
  value DOUBLE PRECISION, labels JSONB,   -- labels 是由全名反解的"便利副本"，非权威
  ts TIMESTAMPTZ,
  PRIMARY KEY(agent_id, metric, ts)      -- 分区键 ts 已含在主键（PG 分区要求）
) PARTITION BY RANGE (ts);               -- 每日一分区 metrics_raw_YYYYMMDD

-- 降采样层（定时任务聚合写入；前端长周期图表只查这两张）
-- 这两张表【不分区】，超期走每日分批 DELETE（见下方"保留与降采样"，决策 49）
metrics_1m(agent_id UUID, metric TEXT, bucket TIMESTAMPTZ, v_avg DOUBLE PRECISION, v_min DOUBLE PRECISION, v_max DOUBLE PRECISION, v_last DOUBLE PRECISION, n INT, PRIMARY KEY(agent_id,metric,bucket))  -- 保留 90 天
metrics_5m(agent_id UUID, metric TEXT, bucket TIMESTAMPTZ, v_avg DOUBLE PRECISION, v_min DOUBLE PRECISION, v_max DOUBLE PRECISION, v_last DOUBLE PRECISION, n INT, PRIMARY KEY(agent_id,metric,bucket))  -- 保留 1 年

process_snapshots(agent_id UUID, ts TIMESTAMPTZ, total INT, top JSONB)

-- 探活结果
probe_results(
  id BIGSERIAL PK, agent_id UUID FK,
  probe_name TEXT, probe_type TEXT,  -- ping/http/tcp
  target TEXT, up BOOL, latency_ms DOUBLE PRECISION,
  status_code INT, error TEXT, checked_at TIMESTAMPTZ
)

-- 告警
alert_rules(
  id, name, target JSONB, kind TEXT, expr TEXT, threshold DOUBLE PRECISION,
  duration INT, severity, channels JSONB, cooldown INT, enabled BOOL
)
alert_events(
  id, rule_id, agent_id, value, started_at, resolved_at, status, notified_at
)
notification_log(id, event_id, channel, target, ok BOOL, error TEXT, ts)

audit_logs(id, actor, actor_type, action, target, ip, detail JSONB, ts)

-- ===== v0.8 新增表（完整列定义见 docs/database.md §5.3/§5.4）=====
users(id UUID PK, username TEXT UNIQUE NOT NULL, display_name TEXT, email TEXT,
      password_hash TEXT,                          -- Argon2id；SSO-only 用户可为 NULL
      role TEXT NOT NULL,                          -- admin/user（决策 52：暂时两级）
      totp_secret_enc TEXT, totp_enabled BOOL, totp_bound_at TIMESTAMPTZ,
      oidc_issuer TEXT, oidc_subject TEXT, oidc_email TEXT,   -- SSO(OIDC) 预留字段
      oidc_linked_at TIMESTAMPTZ, oidc_last_sync_at TIMESTAMPTZ,
      status TEXT, last_login_at TIMESTAMPTZ, last_login_ip INET, last_login_method TEXT,
      created_at, updated_at, disabled_at)

user_recovery_codes(id UUID PK, user_id UUID FK, code_hash TEXT NOT NULL,
      used_at TIMESTAMPTZ, created_at TIMESTAMPTZ)
      -- 2FA 一次性恢复码：10 个/次、只存哈希、用后作废、可整批重生成（决策 44）

settings(key TEXT PK, value JSONB NOT NULL, updated_by UUID, updated_at TIMESTAMPTZ)
      -- 面板可改的系统开关：public_view.enabled / security.require_2fa /
      -- credential_rotate.reminder_days / credential_rotate.notify（决策 43，白名单 + 立即生效 + 审计）

channels(id UUID PK, kind TEXT, name TEXT, config JSONB, template JSONB,
      rate_limit JSONB, enabled BOOL, created_at, updated_at)
      -- 通知通道（SMTP/企微/钉钉/飞书/Webhook）：凭证与模板的唯一归属方，敏感项加密（决策 59）

silences(id UUID PK, name TEXT, target JSONB, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ,
      created_by UUID, created_at TIMESTAMPTZ)
      -- 静默窗口 / 维护期，target 与规则 target 同构（决策 59）
```

保留与降采样（vantage-core 定时任务；见决策 48/49/50）

| 数据 | 粒度 | 保留 | 清理方式 |
|---|---|---|---|
| `metrics_raw` | 15s | 15 天 | 分区级 `DROP TABLE metrics_raw_YYYYMMDD`（秒级、无 VACUUM 压力） |
| `metrics_1m` | 1min | 90 天 | 不分区：每日分批 `DELETE`（1 万行/批）+ autovacuum |
| `metrics_5m` | 5min | 1 年 | 同上 |
| `ip_change_events` / `alert_events` | 事件 | 永久 | — |
| `probe_results` | 30s/目标 | 90 天 | 分批 DELETE |
| `process_snapshots` | 30–60s | 30 天 | 分批 DELETE（该表 `top` 为 JSONB，最占空间） |
| `agent_ip_history` | 区间 | 180 天 | 分批 DELETE |
| `notification_log` | 每次发送 | 180 天 | 分批 DELETE |
| `audit_logs` | 操作 | 365 天 | 分批 DELETE |
| `silences` | — | 过期 7 天后清 | `DELETE WHERE ends_at < now()-7d` |

- 降采样：每 1 分钟把原始聚合成 `metrics_1m`（avg/min/max/last + n），每 5 分钟聚合成 `metrics_5m`；`INSERT ... ON CONFLICT DO UPDATE` 幂等可重入（决策 38）；聚合任务回看重算最近 3 个桶以吸收迟到数据。
- 其余定时任务：建分区（启动时 + 每日，预建未来 7 天、另留 DEFAULT 分区兜底）、Drop 超期分区、清理降采样、清理上表、离线判定（防抖，只在 online→offline 时发告警）、Flapping 恢复、凭证轮换提醒（每日一次）。
- 全部定时任务在 core 内执行并加分布式锁（PG advisory lock 或 Redis `cron:lock:*`）保证多实例只跑一次（决策 50）；分区维护的 DDL 走独立的 `vantage_migrator` 连接，运行时 DML 仍用最小权限角色。任务失败必须告警，否则会出现"原始已 Drop、降采样缺失"的永久空洞。
- 索引：`(agent_id, metric, ts)` 主键已可反向扫描满足 `ts DESC`，额外 DESC 索引多半冗余；`ts` 上可加 BRIN 省空间。
- 容量参考（5 台）：时序层 ≈5–8GB，非时序表 ≈0.7GB → PG 总计 ≈6–9GB（不含 WAL/备份；序列数按设计 §9 的 144 万行/天反推 ≈50 序列/台，投产前请按实测复核）。
- 可选：TimescaleDB 超表 + 连续聚合 + 压缩（保留为可选扩展，非必需）。

Redis 键空间（v0.8 补全并定策略，见决策 51）：
- `ratelimit:agent:<id>`、`ratelimit:ws:<ip>`（WS 连接限流）、`ratelimit:login:<ip>`、`ratelimit:public:<ip>`（公开接口/公开 WS 严格限流）
- `nonce:<agent_id>:<nonce>`（TTL 600s，≥ 签名窗口）、`batch:<batch_id>`（幂等，TTL 10min）
- 会话：`session:<sid>`（hash，滑动 30min / 绝对 24h）、`user_sessions:<uid>`（该用户全部 sid 的集合）
- `alert:cooldown:<rule_id>:<agent_id>`、`notify:tokenbucket:<channel_id>`（通道令牌桶）
- `snapshot:agent:<id>`（公开"当前值"快照缓存，TTL 5–15s）、`settings:cache`（设置项缓存，TTL 30s，变更即失效）、`ip:recent:<agent_id>`（Flapping 判定窗口）
- 实时扇出：Pub/Sub 频道 `live:metrics`（不持久化）
- 策略：单实例 + 键名前缀区分 + `maxmemory-policy noeviction`（不拆 DB index、不拆实例）——否则 nonce 与幂等键被驱逐会重新打开重放窗口；监控 `used_memory` 与 `evicted_keys`（须恒为 0）。

---

## 9.1 指标命名与维度转义规范（v0.8 决策 40 新增）

为什么需要这层规范：`metrics_raw` 主键是 `(agent_id, metric, ts)`，而一台机有多个挂载点、网卡、GPU。若维度只放 `labels`，同一时刻的多条 `disk.used_pct` 会主键冲突互相覆盖（且 `JSONB` 无法进入 PG 主键）。因此定案：维度编码进 `metric` 字符串（"序列全名"），主键保持不变；`labels` 降级为由全名反解的便利副本，不参与唯一性。

命名形式：`基名` 或 `基名{维度=值,维度=值}`

| 规则 | 说明 |
|---|---|
| 维度键 | 仅小写字母/数字/下划线（`mount` / `device` / `index` / `core`） |
| 维度顺序 | 按键名字母序升序拼接（保证同一序列只有一种写法，避免 `{a=1,b=2}` 与 `{b=2,a=1}` 变成两条） |
| 分隔 | 多维度用 `,` 分隔、无空格；`=` 连接键值 |
| 保留原样 | 可读字符 `/` `:` `-` `.` `@` `+` 无需转义（如 `mount=/data`、`device=eth0`） |
| 必须转义 | `%` `{` `}` `=` `,` 及空白 → 百分号编码（`%`→`%25`、`{`→`%7B`、`}`→`%7D`、`=`→`%3D`、`,`→`%2C`、空格→`%20`）。`%` 必须一起转义，否则编码不是单射，不同维度会撞成同一序列名 |
| 无维度 | 不带花括号（`cpu.usage`，而不是 `cpu.usage{}`） |
| 大小写 | 基名与维度键全小写；维度值保留原始大小写（`Eth0` ≠ `eth0`，建议 Agent 侧统一小写设备名） |
| 长度 | 全名 ≤ 200 字符，超限由 schema 校验拒绝（防异常挂载点/设备名撑爆索引） |
| 同源实现 | Agent 产生、中心校验、API 解析必须共用 `buildMetric()` / `parseMetric()` + 共享测试向量 |

示例：`cpu.usage`、`cpu.core.usage{core=3}`、`mem.used_pct`、`disk.used_pct{mount=/}`、`disk.used_pct{device=sda1,mount=/data}`（字母序 device 在前）、`net.rx_bps{device=eth0}`、`gpu.util{index=0}`。

指标清单与单位（完整表见 `docs/database.md` §5.7.2）：`cpu.usage`(%)、`cpu.core.usage{core=<n>}`(%)、`cpu.load1|5|15`、`cpu.ctx_switch`(次/s)；`mem.total|used|available|cached|buffers`(bytes)、`mem.used_pct`(%)、`swap.*`；`disk.total|used|used_pct|inode_used_pct|read_bps|write_bps|read_iops|write_iops|latency_ms{device,mount}`；`net.rx_bps|tx_bps|rx_total|tx_total|conn_count|err|drop{device}`；`gpu.util|mem_used|mem_total|temp|power{index}`；`process.count`。
> 上报体里的嵌套/数组结构（`cpu.cores`、`mem.swap`、`disk[]`、`net[]`、`gpu[]`）在落库时必须摊平成上述全名序列，否则"指标 + 比较符 + 阈值"的受控 DSL 无法引用。
> 点号序号写法（`gpu.0.util`、`cpu.core.<n>.usage`）作废，会丢维度语义，统一改为 `gpu.util{index=0}`、`cpu.core.usage{core=3}`。

维度值变化（设备重命名 / 挂载点调整）：视为新序列（见决策 58）——不迁移历史数据、不做别名映射；曲线自然断开但历史仍可查；面板的维度选择器应同时列出新旧序列（如 `disk.used_pct{mount=/data}` 与 `{mount=/data1}`）。

---

## 10. 上报 API 协议（草案）

### 10.1 上报
```
POST /api/v1/agent/report
Headers: X-Agent-Id, X-Timestamp, X-Nonce, X-Signature, Content-Encoding: gzip
Body(JSON, gzip):
{
  "agent_id": "uuid",
  "batch_id": "01J...ULID",           // 幂等键，每批唯一
  "ts": 1758800000000,
  "seq": 12345,
  "host": { "hostname": "...", "os": "linux", "kernel": "...", "arch": "amd64", "boot_time": 0,
            "capabilities": { "disk.inode": true, "gpu.nvidia": false, "probe.ping": true } },
            // 能力声明随上报携带（布尔白名单，首次与能力变化时必填，见 §15 决策 55）
  "reported_ip": "1.2.3.4",
  "metrics": {
    "cpu": { "usage": 12.3, "cores": [...], "load": [0.1,0.2,0.3] },
    "mem": { "total": .., "used": .., "available": .., "swap": {...} },
    "disk": [ { "mount":"/", "total":.., "used":.., "inode_used":.., "read_bps":.., "write_bps":.. } ],
    "net":  [ { "device":"eth0", "rx_bps":.., "tx_bps":.., "rx_total":.., "tx_total":.. } ],
    "gpu":  [ { "index":0, "util":.., "mem_used":.., "mem_total":.., "temp":.., "power":.. } ],
    "process": { "count": 234, "top": [ {"pid":1,"name":"..","cpu":..,"mem":..} ] },
    "docker": null
  },
  "probes": [                      // 本地探活结果（配置来自 Agent 本地文件）
    { "name":"site-health", "type":"http", "target":"https://example.com/healthz",
      "up": true, "latency_ms": 123.4, "status_code": 200, "error": null }
  ]
}
Response: { "ok": true, "server_ts": ... }   // 固定极简，绝不含可执行/配置字段
                                             // 幂等命中也不附加任何字段，响应形态恒定（决策 A3）
```

### 10.3 幂等与压缩
- 幂等键 = `batch_id`（ULID，每批唯一）；中心 Redis `SETNX batch:<batch_id>`，已存在则直接忽略（重复批次不再入库），TTL 10 分钟。
- 压缩：body 构造为原始 JSON → 计算其 sha256 用于签名 → 再 gzip 传输。签名针对 gzip 之前的原始 JSON 字节，压缩仅作传输层（压缩算法可换，不影响签名）。

### 10.2 其他接口（v0.8 补全；逐条字段与错误码见 `docs/api.md`）
- `POST /api/v1/agent/heartbeat`（无变更时只报心跳；限流共用 Agent 桶，决策 A5）
- 不存在 `GET /agent/config` / `/agent/command` 之类任何下发或执行接口（单向宗旨；中心代码零下发路径，纳入 §13 复核）
- 公开（免登录，`public_slug` 作标识）：`GET /api/public/summary`、`/api/public/hosts`、`/api/public/hosts/:slug/now`、`/api/public/probes`
- 需登录（面板）：`GET /api/v1/hosts`、`/hosts/:id`、`/hosts/:id/metrics`、`/hosts/:id/probes`、`/hosts/:id/ip-history`、`/hosts/:id/processes`、`/alert-rules`(CRUD)、`/alert-events`、`/channels`(CRUD + `POST /channels/:id/test`)、`/silences`、`/audit-logs`、`/settings`(GET/PATCH)、`/agents`(创建/轮换/禁用/吊销)、`/users`(含 `POST /users/:id/2fa/reset`)
- 认证：`POST /api/v1/auth/login`、`/auth/2fa/verify`、`/auth/2fa/setup|enable|disable`、`/auth/2fa/recovery/regenerate|verify`、`/auth/logout`、`/auth/logout-all`、`GET /auth/me`
- WS 频道：`/ws/public`（免登录、只读脱敏）、`/ws/live`（需登录、全量）
- 关键约定（v0.8）：时序查询 `metrics` 参数接受基名或全名（§9.1），`step` 仅 `auto/15s/1m/5m` 且各档有最大范围限制；`GET /api/v1/agents` 返回 `credential_age_days` / `rotate_recommended`（+ 根级 `rotate_policy`）。

---

## 11. 目录结构（草案）

### 11.1 仓库总览
```
vantage/
├── README.md
├── DESIGN.md                 # 本文档
├── docs/{database.md,api.md,frontend.md,agent.md,design-deltas.md}
├── agent/                    # Go  → vantage-agent
├── server/                   # Node.js → vantage-core
├── web/                      # Vue3 → Vantage Console
├── deploy/
│   ├── docker-compose.yml
│   ├── reverse-proxy/        # Caddy/Nginx
│   └── systemd/vantage-agent.service
└── scripts/                  # 建库、生成 agent key、安装脚本
```

### 11.2 Agent（Go）
```
agent/
├── cmd/agent/main.go
├── internal/
│   ├── config/           # 配置加载/校验（含探活目标）
│   ├── collector/{collector.go,cpu.go,mem.go,disk.go,net.go,gpu.go,process.go,docker.go}
│   ├── prober/{prober.go,ping.go,http.go,tcp.go}
│   ├── scheduler/
│   ├── reporter/         # 组包/gzip/签名/上报/重试
│   ├── auth/             # key + HMAC
│   ├── retry/            # 仅内存当前批次重试（原 buffer/ 离线环形缓存已删除，见 §4.7）
│   └── version/
├── configs/config.example.yaml
├── Makefile
└── go.mod
```

### 11.3 中心（Node.js / Fastify）
```
server/
├── src/
│   ├── app.js
│   ├── config/
│   ├── routes/{agent.report.js,public.js,hosts.js,probes.js,alerts.js,auth.js,
│   │           agents.js,channels.js,silences.js,settings.js,users.js}   -- v0.8 补全
│   ├── middleware/{tls.js,authAgent.js,authUser.js,csrf.js,schema.js,rateLimit.js,audit.js}
│   ├── services/{metrics.service.js,alert.service.js,notify.service.js,
│   │             ipTrack.service.js,probe.service.js,heartbeat.service.js,ws.service.js,
│   │             settings.service.js,auth2fa.service.js,cron.service.js,partition.service.js}   -- v0.8 补全
│   ├── notify/{smtp.js,wecom.js,dingtalk.js,feishu.js,webhook.js}
│   ├── repositories/
│   ├── models/
│   └── utils/{crypto.js,sign.js,metric.js,log.js}   -- metric.js = buildMetric/parseMetric（§9.1）
├── migrations/
├── test/
├── package.json
└── .env.example
```

### 11.4 前端（Vue3）— Element Plus + 按需引入（决策 56；完整目录见 `docs/frontend.md` §2）
```
web/
├── src/
│   ├── views/{PublicStatus.vue,HostList.vue,HostDetail.vue,Alerts.vue,Settings.vue,Login.vue,NotFound.vue}
│   ├── components/{MetricChart.vue,StatusCard.vue,ProbeTable.vue}
│   ├── api/{public.js,private.js,ws.js}
│   ├── store/{auth.js,realtime.js}  router/
├── package.json
└── vite.config.js
```

---

## 12. 部署方案

### 12.1 中心（Docker Compose）
- 服务：`vantage-core`、`postgres`、`redis`、`caddy`(反代+TLS)、`web`(静态)。
- 数据卷：PG 数据、Redis 数据、证书。
- 面板：Caddy 自动 HTTPS；2FA 在应用层；公开视图单独限流。

### 12.2 Agent 安装与管理脚本（`vantage.sh`）
- 一个脚本全部搞定：`install / upgrade / uninstall / start / stop / restart / status`。
- 二进制来源：从 GitHub Releases 或镜像站下载，不经中心服务器；必须校验 sha256（能上签名更好）。
- 安装时传参：`--center`（中心地址）、`--agent-id`，可选 `--version / --source / --data-dir / --user`。`--key <明文>` 永久禁止（`ps` 与 `/proc/$PID/cmdline` 可被同机低权限用户读取）。作为替代（见 §15 决策 37），面板默认给出一条带 key 的一键命令（`VANTAGE_KEY` 环境变量内联形式，见下），并同时单独展示一次 `agent_key`/`agent_secret`；另给 stdin / 交互式输入与 `--key-file`（0600）两种更安全形式供选择。
- 其余细节：安装完成后由用户手动编辑 `config.yaml`（采集项、频率、探活、过滤规则等），然后 restart 生效。
- 服务以非 root 用户运行，systemd 加固；key 写入受限文件（`chmod 600`，归运行用户）。

```bash
# 形式①（面板默认给出，复制即用；会进 shell history）
VANTAGE_KEY=<key> sh -c 'curl -fsSL https://<github-or-mirror>/vantage.sh | sudo -E sh -s -- install \
  --center https://vantage.example.com --agent-id <uuid> [--version v0.1.0] [--source <mirror>]'

# 形式②（最安全）：交互式 / stdin
curl -fsSL https://<github-or-mirror>/vantage.sh | sudo sh -s -- install \
  --center https://vantage.example.com --agent-id <uuid>      # 执行后交互提示输入 key

# 形式③（长期方案）：key 文件 0600
  ... --key-file /etc/vantage/agent.key

# 任何形式都不得使用 --key <明文>

# 管理
sudo vantage.sh {start|stop|restart|reload|status|upgrade|uninstall [--purge]}
```

> 安全提示（v0.8 修订，取代 v0.7 口径）：任何形式都不得把 key 放进进程命令行参数（`--key`）。面板默认给出的一键命令使用 `VANTAGE_KEY=<key>` 环境变量内联形式，便于复制即用，并在 key 写入 `chmod 600` 受限文件后立即 `unset VANTAGE_KEY` 并清理临时缓冲。使用该形式必须向用户标注代价：会进 shell history，且 root 可经 `/proc/$PID/environ` 读取，因此建议执行后用 `history -d` 清理，或改用交互式/stdin（最安全）与 `--key-file`（长期方案）两种形式；面板同时单独展示一次 `agent_key`/`agent_secret` 明文供手工写入。详见 `docs/api.md` §4.4 与 `docs/agent.md` §6.1/§12.1。

### 12.3 上线流程
1. 中心建 Agent → 生成 key（明文仅一次）。
2. 在目标宿主机执行安装脚本，传 `--center / --agent-id`（key 不进口令行：面板默认给 `VANTAGE_KEY` 内联的一键命令，或走交互式/stdin 与 `--key-file`；二进制从 GitHub/镜像下载）。
3. 首次上报成功 → 面板出现该机 + 首次 IP。
4. 需要探活或采集细节 → 手动编辑 `config.yaml` → `restart`。
5. 配置告警规则与通道（SMTP/企微/钉钉/飞书/Webhook）。

### 12.4 升级（单向宗旨下）
- 升级 = 用户主动执行 `vantage.sh upgrade`：下载新二进制（GitHub/镜像）→ 校验 → 替换 → restart，配置保留。
- 中心不参与分发、不推送，恪守中心零下发。

---

## 13. 安全清单（自研必做）

| 安全要求 | 状态 |
|---|---|
| 全链路 HTTPS；敏感接口可选 mTLS | 待部署 |
| 每 Agent 独立 key + HMAC + 时间戳/nonce（Redis）防重放 | 已实现 |
| key 只存哈希；secret 因验签需重算而存 AES-256-GCM 密文（见 §9），明文仅在创建与手动轮换时各展示一次，之后永不可再取 | 已实现 |
| 严格 schema 校验 + 数值范围 + 大小限制 | 已实现 |
| 按 Agent 与来源限流（Redis）+ 幂等去重 | 已实现 |
| 公开视图：只读、只返回当前快照、严格限流、不泄露 key 与内部 ID；可整体关闭 | 已实现 |
| 面板：登录 + 2FA(TOTP) + 有状态会话（Redis，不透明 `sid`）+ 登录限速 + IP 白名单(可选) | 已实现 |
| 会话：`sid` 随机 256-bit；Cookie `HttpOnly+Secure+SameSite=Lax`；登录与提权轮换 sid 防固定；登出即删并支持全部下线 | 已实现 |
| WS：握手校验 `Origin` 白名单；`/ws/public` 脱敏 + 严格限流；客户端到服务端应用层仅允许 `subscribe`（其它消息关闭 `1008`），保活走协议层 ping/pong 帧，不得成为下发通道 | 已实现 |
| RBAC：目前两级（`admin` / `user`，`user` 纯只读）；操作留审计日志 | 已实现 |
| 可信代理解析（`X-Forwarded-For` 白名单），防伪造来源 IP | 已实现 |
| 数据库只监听本地；定期备份 | 部分实现：数据库只监听本地已做到，定期备份未落地（规格见 `docs/database.md` §10） |
| 依赖锁版本 + 定期 `npm audit` / `govulncheck` | 部分实现：依赖锁版本已做到，定期审计尚未落成脚本 |
| Agent 非 root 运行 + systemd 加固；出站白名单 | 部分实现：非 root 运行与 systemd 加固已做到，出站白名单未落地 |
| 单向性复核：中心代码零下发路径；上报响应不夹带可执行字段 | 已实现 |
| 签名顺序：验签在 `JSON.parse` 之前、gzip 解压之后；解压前判大小上限（防 zip bomb） | 已实现 |
| nonce TTL ≥ 签名窗口（默认 600s），消除重放窗口 | 已实现 |
| key 不进进程命令行（禁用 `--key`）；面板默认给 `VANTAGE_KEY` 内联的一键命令 + 单独展示一次明文，落地后即时 `unset` 并提示 `history -d` 或改用 `--key-file` | 已实现 |
| 分区保留：原始按天分区 + 定期 Drop；降采样层不分区走每日分批 DELETE，非时序表按 §9 保留矩阵分批清理；聚合任务幂等可重入且回看 3 桶 | 已实现 |
| 分区与清理任务由 core 内置并加分布式锁；DDL 走独立 migrator 连接，运行时 DML 用最小权限角色；任务失败必须告警 | 已实现 |
| Redis 单实例 + `maxmemory-policy noeviction`；监控 `used_memory` 与 `evicted_keys`（须恒为 0），防 nonce 与幂等键被驱逐而重开重放窗口 | 已实现 |
| 面板开关存 `settings` 表（key 白名单 + JSONB），变更必须写审计；任何密钥与加签 secret 不入该表 | 已实现 |
| 2FA 支持面板自助绑定/解绑 + 一次性恢复码（哈希存储、用后作废）+ 管理员后台重置某用户 2FA（清绑定 + 作废恢复码 + 踢下线 + 审计） | 部分实现：面板自助与一次性恢复码已做到，管理员重置他人 2FA 属 M3，尚未落地 |
| 公开接口用独立 `public_slug`，公开响应与 URL 不含内部 UUID 与真实设备名（设备名泛化） | 已实现 |
| 指标序列命名与转义两端同源实现（含转义单射性），共用测试向量；维度变化不迁移历史 | 已实现 |
| 上报体积上限（压缩前 1MB / 解压后 4MB）+ Agent 侧 256KB 熔断；超限请求不进入 `JSON.parse` | 已实现 |
| IP 变化防抖：Flapping 检测，避免告警风暴 | 部分实现：判定侧已落地（按 `ip_change_events` 计数，超阈值置 `agents.ip_flapping` 并只记一条 `kind='flapping'` 事件）；自动解除尚未落地，`flapping_recover` 任务名已预留但未注册到定时任务，`ip:recent:` 键也暂无写入方（见 `docs/database.md` §7） |

主要实现在 `server/src/middleware/`（`authAgent.js`、`rateLimit.js`、`publicView.js`、`authPanel.js`）、`server/src/services/`（`ingest.service.js`、`session.service.js`、`partition.service.js`、`downsample.service.js`、`retention.service.js`、`cron.service.js`、`ipTrack.service.js`、`agentAdmin.service.js`、`settings.service.js`）与 `agent/deploy/vantage.sh`。依赖版本锁定见 `server/package-lock.json` 与 `agent/go.sum`；指标契约的共享测试向量在 `contracts/metric-names.json`。

---

## 14. 里程碑（建议）

| 阶段 | 内容 | 产出 |
|---|---|---|
| M1 | Agent 采 6 类指标 + 中心收/存 + 免登录公开状态页 | 端到端跑通 |
| M2 | 鉴权（key+HMAC）+ TLS + schema/限流(Redis) + 单向性复核 | 安全接入 |
| M3 | 告警引擎（阈值/离线/IP变化）+ 多通道通知 | 告警可用 |
| M4 | 本地探活（ping/http/tcp）+ GPU/进程完善 + 登录态历史面板 + 2FA/RBAC | 完整能力 |
| M5 | Docker 监控、非 root 加固打磨、扩展项 | 扩展 |
| M6 | 跨平台：Windows / macOS 采集器 + 各自安装脚本 | 多平台 |

---

---

## 15. 技术决策（v0.8；新增 #40–#59，另修订 #5/#11/#15/#21/#24/#31/#32/#37/#38）

| # | 议题 | 决策 |
|---|---|---|
| 1 | 项目名 | Vantage（agent=`vantage-agent`，中心=`vantage-core`，面板=Vantage Console） |
| 2 | 上报协议 | JSON(gzip)，预留编码器接口可换 Protobuf |
| 3 | 数据库 | PostgreSQL 16（原始时序层按天分区；Timescale 可选扩展） |
| 4 | 缓存 | Redis 7（限流 / nonce / 面板会话 / 告警静默 / 实时 Pub/Sub 扇出） |
| 5 | 前端 | Vue 3 + ECharts；组件库 Element Plus（按需引入 + CSS 变量定制，见 #56） |
| 6 | Agent 鉴权 | key + HMAC（时间戳+nonce 防重放）为主；mTLS 可选 |
| 7 | Agent 运行 | 极低占用 + 非 root 运行（非特权 ICMP，优雅降级，systemd 加固） |
| 8 | 探活 | ping/http/tcp 由 Agent 本地配置执行并上报结果；中心不下发 |
| 9 | 告警 | 自定义规则（阈值/离线/IP变化/探活）+ 通道：SMTP / 企业微信 / 钉钉 / 飞书 / 标准 Webhook |
| 10 | 面板可见性 | 免登录可看当前状态、探活概览与汇总（含只读脱敏实时 WS）；历史与配置需登录 |
| 11 | 数据保留 | 原始(15s) 15 天；1min 90 天；5min 1 年；IP 变更、告警事件永久。v0.8 扩表：探活 90 天、进程快照 30 天、IP 区间 180 天、通知日志 180 天、审计 365 天、静默过期 7 天清（§9） |
| 12 | 中心代码去命令面 | 中心无任何向 Agent 下发路径；响应仅 `{ok, server_ts}` |
| 13 | 规模与部署 | 当前 5 台，按可扩展到几十台设计；Agent 跑宿主机；Docker 监控暂缓 |
| 14 | 断网策略 | 丢弃式：不缓存不补传；断网由中心判离线并告警；恢复后从当前时刻重报 |
| 15 | Key 落地 | 中心生成 key → 面板给出一键安装命令 + 单独展示一次明文 → 用户在宿主机执行（命令用 `VANTAGE_KEY` 环境变量内联，见 #37） |
| 16 | 时间权威 | `server_ts` 为权威写入/排序；`agent_ts` 做漂移检测 |
| 17 | 时钟漂移 | 可配 + 告警（`clock_drift`，默认阈 60s）；默认"接受+修正+告警"，严格拒收 opt-in；窗口硬上限 5min |
| 18 | 幂等键 | `batch_id`(ULID)；Redis SETNX 判重，TTL 10min |
| 19 | 签名与压缩 | 签名针对未压缩的原始 JSON 字节；gzip 仅传输层，算法可换 |
| 20 | 采集过滤 | Agent 端默认排除伪文件系统与虚拟网卡，支持本地白/黑名单 |
| 21 | 公开视图隐私 | 默认隐藏 IP 与内网结构；仅展示别名 + 状态 + 指标概览；支持自定义显示名。另见 #41：公开标识用独立 `public_slug`，公开响应与 URL 不含内部 UUID；设备名泛化 |
| 22 | 告警规则表达 | 受控阈值 DSL（表单化，零 RCE）；保留 `expr` 扩展位 |
| 23 | 告警风暴防护 | 队列 + 令牌桶限速 + 同类合并 + 静默期 + 恢复通知 |
| 24 | Agent 管理脚本 | 一个 `vantage.sh` 支持 install/upgrade/uninstall/start/stop/restart/reload/status；`uninstall` 默认保留配置/key/日志，`--purge` 才彻底删（#G9） |
| 25 | 二进制分发 | 从 GitHub Releases 或镜像站下载，不经中心；校验 sha256 |
| 26 | 面板语言 | 中文优先，代码预留 i18n（后续可加英文） |
| 27 | 前端适配 | 基础响应式（手机浏览器可看列表/详情），不做 App/PWA |
| 28 | 许可协议 | AGPL-3.0（强 copyleft；如需 GPL-3.0 可调） |
| 29 | 跨平台策略 | Agent 平台适配层 + 能力声明；Linux 优先，Win/Mac 排 M6；中心零改动 |
| 30 | 平台优先级 | 当前仅 Linux；Windows/macOS 后续里程碑 |
| 31 | 面板登录 | 有状态会话（非 JWT）；Cookie 仅存不透明 `sid`，状态在 Redis；用户账号在 PG `users`（`users` 含 `role` 与 OIDC 预留字段，见 #52） |
| 32 | 会话策略 | 滑动 30min + 绝对 24h；同账号限并发（默认 3，超限踢最旧）；IP/UA 只记录不强制校验；登录/提权轮换 sid；支持全部下线。权限暂时两级（`admin`/`user`，`user` 纯只读，见 #52）；2FA 面板自助 + 一次性恢复码 + 管理员后台重置（见 #44） |
| 33 | 实时通道 | WebSocket（主；SSE 备选）；先全量快照后增量；Redis Pub/Sub 扇出；`/ws/public` 免登录只读脱敏，`/ws/live` 需登录 |
| 34 | Agent 配置热重载 | 监听 SIGHUP（systemd `ReloadSignal`），校验后原子替换内存配置，免重启；`vantage.sh reload` 封装；校验失败保留旧配置 |
| 35 | 签名校验顺序 | 签名针对解压后的原始 JSON 字节；中心 `preParsing` 取原始 buffer，先验签再 `JSON.parse`；Agent 只序列化一次；加解压大小上限防 zip bomb |
| 36 | nonce TTL | 由 120s 改为 600s（≥ 签名窗口），消除 120–300s 重放窗口 |
| 37 | Key 传递 | 仍禁用 `--key <明文>` 参数；v0.8 修订为面板默认给出一条带 key 的一键命令（`VANTAGE_KEY` 环境变量内联）+ 单独展示一次 `agent_key`/`agent_secret`，并另给交互式/stdin 与 `--key-file` 两种更安全形式；落地后即时 `unset`，需提示 shell history 与 `environ` 风险（§12.2） |
| 38 | 指标存储与保留 | 原始按天分区，保留 15 天（Drop Partition）；降采样 `metrics_1m`(90d)/`metrics_5m`(1y)；Cron 聚合幂等、回看 3 桶。v0.8 修订：降采样层不分区，超期走每日分批 DELETE（#49） |
| 39 | IP 变化防抖 | Flapping 检测：10min 内变化 >3 次 → 暂停 IP 变化告警 + 静默；只跟踪主出口、迟滞判定 |
| 40 | 指标维度落库 | 维度写进序列全名（`disk.used_pct{mount=/}`），主键 `(agent_id, metric, ts)` 不变；`labels` 降为反解副本；转义规则见 §9.1；点号序号写法作废 |
| 41 | 公开接口标识 | 独立 `public_slug`（随机短 ID、UNIQUE、不随改名变化）；公开响应与 URL 不含内部 UUID |
| 42 | 凭证轮换 | 不做新旧并存：单套凭证、旧凭证立即失效、必须人工上机替换；靠面板"建议轮换"徽标 + 每日一次通知驱动（阈值可配，默认 90 天） |
| 43 | 面板开关存储 | PG `settings` 表（key 白名单 + JSONB value），面板可改、立即生效（Redis 缓存 30s + 变更失效）、缺行取代码默认值、变更写审计；密钥不入表 |
| 44 | 2FA 与恢复 | 面板自助绑定/解绑 TOTP；一次性恢复码（10 个、哈希、用后作废、可重生成）+ 管理员后台重置某用户 2FA（清绑定 + 作废恢复码 + 踢下线 + 审计）；`security.require_2fa` 可强制 |
| 45 | WS 客户端消息 | 应用层只允许 `subscribe`；保活走 RFC6455 协议层 ping/pong 帧（浏览器自动回）；其它消息关闭 `1008` 并记审计 |
| 46 | 签名 canonical | 固定 `\n` 分隔 4 处、末尾不加换行；`path` 仅路径不含 query；两端配共享测试向量 |
| 47 | 上报体积与重试 | 中心：压缩前 1MB / 解压后 4MB（超限 413 且不进入 `JSON.parse`）；Agent：单批 256KB 熔断（裁剪顺序见 `docs/agent.md` §5.3），重试 3 次 / 2s 起指数 / ≤30s |
| 48 | 非时序表保留期 | 探活 90d、进程快照 30d、IP 区间 180d、通知日志 180d、审计 365d、静默过期 7d 清；每日分批 DELETE |
| 49 | 降采样层分区 | 不分区，每日分批 DELETE（1 万行/批，每次只删刚过期那一天）+ autovacuum 回收 |
| 50 | 分区维护归属 | core 内置定时任务 + 分布式锁（PG advisory lock / Redis `cron:lock:*`）；DDL 走独立 migrator 连接，运行时 DML 用最小权限角色；任务失败必须告警 |
| 51 | Redis 隔离 | 单实例 + 键名前缀 + `maxmemory-policy noeviction`（不拆 DB index/实例）；监控 `used_memory`、`evicted_keys`（须恒为 0） |
| 52 | 面板权限 | 暂时两级 `admin` / `user`；`user` 纯只读（所有写操作仅 `admin`）；后续需要时扩多角色 |
| 53 | 公开视图默认值 | 默认开启；配套 = 严格按 IP 限流 + 严格脱敏 + 设置页醒目状态与一键关闭 |
| 54 | Agent 缓存模块 | 删除 `internal/buffer/`（离线环形缓存）：Agent 磁盘占用恒为 ≈0，重试仅内存当前批次 |
| 55 | 能力声明位置 | 随上报携带在 `host.capabilities`（布尔白名单；首次与能力变化时必填），中心落 `agents.capabilities`，面板据此隐藏不支持的图表/列 |
| 56 | 前端组件库 | Element Plus（按需引入，禁全量 import；CSS 变量定制 + `html.dark` 暗色） |
| 57 | 主机状态机 | 只有 `online` / `offline` / `disabled`，不加 `abnormal`；"有告警、时钟漂移、IP Flapping"用派生徽标与计数表达 |
| 58 | 维度值变化 | 设备重命名/挂载点调整 → 视为新序列：不迁移历史、不做别名映射；曲线自然断开但历史可查；选择器同时列新旧序列 |
| 59 | 告警字段口径 | 规则 `channels` 只存通道 id 数组（通道是凭证/模板唯一归属方）；非阈值类参数统一 `params JSONB` + 按 `kind` 白名单；规则 `metric` 支持基名（逐维度序列分别判定）与全名（单序列），事件用 `alert_events.metric` 记触发序列全名；静默落 `silences` 表；不做事件 `ack` |

### 已定宗旨（优先于以上全部）
通信严格单向：Agent 配置仅由本机本地文件管理，中心永不下发任何指令、配置或命令。

### 仍待确定（不阻塞 M1）
- 具体告警接收端：SMTP 账号、企微/钉钉/飞书机器人 Webhook、标准接口端点。技术侧已就绪（`channels` 表 + 测试发送），M3 联调前提供即可。
- SSO(OIDC) 细节：是否允许自助注册、IdP 的 group/role claim 如何映射到 `admin`/`user`。`users` 的 OIDC 预留字段已就位，本期不实现登录流程。

> v0.7 挂起的另两项已裁定：采集频率 15s、公开视图默认开启（决策 #53）；面板多用户与 RBAC 角色划分裁定为暂时两级（决策 #52）。
> v0.8 已把本文与四份专项文档对齐，逐条修订对照见 `docs/design-deltas.md`。

---

## 16. 前端与许可
- 语言：中文优先；代码预留 i18n 结构（文案抽 key），后续可加英文。
- 适配：基础响应式（主机列表/详情在手机浏览器可用），不做专门 App/PWA。
- 组件库（决策 56）：Element Plus，按需引入（`unplugin-vue-components`，禁全量 import）；主题走 CSS 变量 + `html.dark` 暗色；图表仅 `echarts/core` 按需注册。
- 性能预算：公开页首屏 JS ≤150KB、控制台 ≤250KB（gzip）；路由懒加载；全站单 WebSocket 连接复用（切换页面只改订阅）。
- 前端硬约束：公开域只允许调用 `/api/public/*` 与 `/ws/public`（网络层断言）；不读不写 `sid`（会话在 HttpOnly Cookie）；状态变更带 `X-CSRF-Token`；页面隐藏时不暂停 WS 订阅、仅暂停图表渲染。详见 `docs/frontend.md`。
- 许可：项目采用 AGPL-3.0（强 copyleft，适配网络服务形态）。
- 依赖许可干净：`gopsutil`(BSD)、Vue/Fastify/ECharts/Element Plus(宽松)、PostgreSQL/Redis(各自宽松)。

---

## 17. 跨平台路线

### 17.1 难度总览
下表中"支持"表示该平台可直接采集，"部分支持"表示需要平台专用 API 或额外权限，"不支持"表示该指标在该平台不存在或暂不采集。

| 指标 | Linux | Windows | macOS |
|---|---|---|---|
| CPU / 内存 / 进程 | 支持 | 支持 | 支持 |
| 磁盘容量 | 支持 | 支持 | 支持 |
| 磁盘 inode | 支持 | 不支持，无此概念（置空） | 部分支持，平台 API |
| 磁盘 IO/延迟 | 支持 | 部分支持，性能计数器 | 部分支持，IOKit/iostat |
| 网络速率/流量 | 支持 | 支持 | 支持 |
| 网络连接数 | 支持 | 部分支持，不同 API | 部分支持，不同 API |
| GPU(NVIDIA) | 支持，nvidia-smi | 支持，nvidia-smi | 不支持，基本没有 |
| GPU(Apple Silicon) | — | — | 不支持，实现难度大，先跳过 |
| Ping 探活 | 支持，非特权 ICMP | 部分支持，一般需管理员 | 部分支持，可调系统 ping |
| 服务/守护 | 支持，systemd | 部分支持，Windows 服务 | 部分支持，launchd |
| 安装脚本 | 支持，sh | 部分支持，PowerShell/NSIS | 部分支持，launchd（可能需签名） |

### 17.2 策略
- Linux 优先：M1–M5 只做 Linux（覆盖当前服务器），主干与安全模型全在上面验证。
- 适配层先行：从 M1 就按 4.9 的"接口 + 能力声明"写，Win/Mac 日后只是新增采集器与安装脚本，中心侧零改动（上报格式统一）。
- Windows/macOS 放 M6：难点集中在安装、服务、权限与少数指标（inode、GPU、连接数），不在主干。
- 工程量估：以 Linux 为 100%，Windows ≈ +40~60%，macOS ≈ +30~50%。

---

## 18. 面板会话与实时通道（v0.6 定案）

### 18.1 面板登录 = 有状态会话（放弃无状态 JWT）
- Cookie：只放不透明会话 ID `sid`（256-bit 随机，不编码任何用户信息）；属性 `HttpOnly + Secure + SameSite=Lax`（可选 `__Host-` 前缀）。不存密码，也不存用户资料。
- Redis：`session:<sid>` → hash `{ user_id, roles, totp_ok, created_at, last_seen, ip, ua, csrf }`；用户账号本身仍在 PostgreSQL `users` 表，Redis 只放会话状态。
- 生命周期：滑动过期 `idle 30min` + 绝对上限 `24h`；每次命中刷新 `last_seen` 并续期。
- 会话固定防护：登录成功、提权、改密时轮换 sid（旧 sid 立即失效）。
- 并发与会话管理：`user_sessions:<uid>` 追踪该用户全部 sid；同账号默认最多 3 个，超限踢最旧；支持全部下线；登出即 `DEL session:<sid>`。
- IP / UA：仅记录（审计与异常告警用），不做强制校验，避免移动网络、换浏览器导致掉线。
- 2FA：TOTP 待验证时会话标 `totp_ok=false`，仅放行 2FA 校验接口，其余一律拒绝。
- 选有状态会话的核心收益是即时吊销（登出、封禁、全部下线立即生效），与"会话在 Redis"的既有决策天然一致。

### 18.2 实时通道 = WebSocket（SSE 降为备选）
- 两条频道：
  - `/ws/public`：免登录、只读、payload 脱敏（隐藏 IP 与内网信息，仅别名 + 状态 + 指标概览）、严格限流。
  - `/ws/live`：需登录，返回全量（历史与详情所需字段）。
- 握手鉴权：浏览器自动带 Cookie；服务端校验 `Origin` 白名单（防跨站 WS 劫持）；cookie 无效则 `/ws/live` 拒绝。
- 推送语义：连接建立后先推全量快照，之后推增量 delta（单机/单指标粒度）。不做断点续传（掉线期间增量不补，与 §4.7 丢弃式策略、决策 14 一致）。
- 扇出：Agent 上报 → 落库 → `PUBLISH live:metrics`（Redis Pub/Sub）→ 各 WS 连接订阅广播。选 Pub/Sub 是为 core 多实例、多 worker 时零改动；注意 Pub/Sub 不持久化，与不补传相符。
- 保活与判死：服务端定时发送 WebSocket 协议层 ping 帧（RFC 6455），浏览器自动回 pong 帧（JS 不参与，见决策 45）；服务端以协议层 `pong` 判活，超时即断开并清理。不存在应用层 ping/pong 消息。
- 重连：前端指数退避重连，重连成功即重新拉全量快照。
- 反代：Caddy / Nginx 需放行 `Upgrade` 与 `Connection: upgrade`，并确保读超时 > 保活间隔。

### 18.3 与「单向宗旨」的一致性（关键）
- WS 是浏览器与中心之间的通道，不是"中心 ↔ Agent"的通道。
- 客户端到服务端方向仅允许 `subscribe`（决策 45 把应用层消息面收敛为这一条，保活走协议层帧）；中心不得借此下发任何配置或指令。收到其它应用层消息 → 关闭连接 `1008` 并记审计。
- 中心侧对 Agent 依旧零下发路径（§2.1、§12）。此约束并入 §13「单向性复核」。

---

## 19. 评审响应清单（v0.7 六项 + v0.8 复核）
| # | 隐患 | 结论 | 落地位置 |
|---|---|---|---|
| 1 | 改配置靠重启 → 误报警/曲线断层 | 采纳：SIGHUP 热重载 | §4.10、决策 #34 |
| 2 | HMAC 与压缩：验签时点/字节一致性 | 采纳，并更正为须解压后、`JSON.parse` 前验签 | §6.6、决策 #35 |
| 3 | nonce TTL(120s) < 签名窗口(300s) → 重放窗口 | 采纳：TTL 改为 600s | §6.2、§9、决策 #36 |
| 4 | `--key` 命令行泄露（ps/proc） | 采纳：禁命令行，改 env/stdin + 清理。v0.8 修订（决策 #37）：面板默认改给 `VANTAGE_KEY` 环境变量内联的一键命令 + 单独展示明文；仍禁 `--key` 参数，并要求提示 history/environ 风险与善后 | §12.2、决策 #37、`docs/api.md` §4.4 |
| 5 | 指标膨胀/分区/保留/降采样缺失 | 采纳：日分区 + Drop + 1m/5m 降采样；v0.8 修订：降采样层不分区，走每日分批 DELETE（决策 #49） | §9、决策 #38/#49 |
| 6 | NAT/多网卡 IP 抖动刷爆事件 | 采纳：Flapping 防抖 | §8、决策 #39 |
| 7 | v0.8 复核：内部矛盾 5 处（缓存模块 / 维度主键 / WS 消息集合 / "异常"态 / 公开 `:id`）+ 原文空白（表结构、命名规范、保留期、Redis 键空间、能力声明落点） | 全部裁定 | §4.7、§5.3、§5.4、§9、§9.1、§18.2、决策 #40–#59；逐条对照见 `docs/design-deltas.md` |

