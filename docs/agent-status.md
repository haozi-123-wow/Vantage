# Vantage Agent 开发状态（`vantage-agent` / Go）

> **文档性质**：**进度快照**，不是行为契约。采集/探活/上报/鉴权/配置该怎么做，一律以
> [`docs/agent.md`](agent.md) 为准；上报字段以 [`docs/api.md`](api.md) §2 为准；指标与单位以
> [`docs/database.md`](database.md) §5.7.2 为准。本文只回答一个问题：**「现在做到哪了」。**
>
> **核验基准**：工作区 `D:\phpstudy_pro\WWW\Vantage`。
> 首次核验 2026-09-28（`HEAD = 9a091da`，Agent 代码仅在暂存区）；
> **最近核验 2026-10-01（`HEAD = ab83d7f`）**：P0/P1 完成，`go vet ./...` 与 `go test ./... -count=1`
> **首次全绿**，Agent 实现已进版本历史（`8737820`），测试修复与清理见 `1c6dd9a`，
> 改动全记录见 [`docs/agent-changes-2026-10-01.md`](agent-changes-2026-10-01.md)。
>
> **核验方式**（全部实跑，非阅读推断）：静态清点 `agent/**` + `go build ./...` + `go vet ./...` +
> `go test ./...`（含 `-count=1`）+ `CGO_ENABLED=0 GOOS=linux go build` + `server/ npm test`。
>
> **维护约定**：Agent 侧每完成一个里程碑项、或修复一项「§6 已知偏差」，就更新对应行并在
> 文末「§9 变更记录」加一条。⛔ 不要把本文件当成设计文档改口径 —— 口径要改就去改 `docs/agent.md`，
> 再回来更新本文的「一致性」列。

---

## 1. 结论摘要

| # | 结论 | 证据 |
|---|---|---|
| 1 | **Agent 主体已实现**：采集 / 探活 / 组包签名 / 上报重试 / 配置校验 / SIGHUP 热重载全部落地 | 非测试代码 **~6700 行 / 29 个文件**，测试 **3306 行 / 9 个文件**（`agent/**` 共 38 个 `.go`，不含已删草稿） |
| 2 | `go build ./...` 与 Linux 静态交叉编译**通过**，产出 7.3MB 单文件静态二进制（符合 `docs/agent.md` §10） | 见 §5 实测记录（2026-09-28、2026-10-01 两次） |
| 3 | ✅ **测试已全绿（2026-10-01）**：R-01 引号笔误修复后 prober 测试首次真正运行，暴露的 9 个失败用例已逐一定性处理（2 个代码缺陷修复、1 个测试向量纠正、2 个环境用例明确 skip） | `go vet ./...` / `go test ./... -count=1` exit 0；见 §5.1 与变更说明 §2 |
| 4 | ✅ **文档口径已对齐（2026-10-01，`ab83d7f`）**：README 组件表/§3.2/§7 与 `docs/agent.md` §2 模块表（retry 内联、补 4 包）均已纠正；D-01/D-03 关闭 | 见 §6 与变更说明 §3 |
| 5 | **M5 / M6 真未开工**：Docker 采集（配置层显式拒绝）、Windows/macOS（启动即拒绝） | 见 §4、§7 |
| 6 | **M2 部署侧未开工**：仓库内没有任何 `.sh` / `.service` 文件 —— `vantage.sh`、systemd unit、`setcap` 运维文档全缺 | 见 §7 |
| 7 | ✅ **Agent 实现已提交（`8737820`，2026-09-30，98 文件 / +17858 行）**；其顺序偏差（红测试与草稿入库）已由 `1c6dd9a` 补救 | `git log`；§5.3 |

**一句话（2026-10-01）**：**测试绿了、文档对齐了、代码进了历史；剩下的就是「补测试覆盖（A-T06/07/08）、真机 E2E 留痕（A-T09）、部署侧（A-T10～T13）」三件事。**

---

## 2. 代码清点

`agent/` 目录结构（✅ = 有测试文件）：

| 包 | 文件数 | 测试 | 职责 | 对应 `docs/agent.md` |
|---|---|---|---|---|
| `cmd/agent` | 1 | ❌ | 启动、信号、优雅退出、`--check` / `--once` / `--print-body` | §2、§7 |
| `internal/auth` | 3 | ✅ 1 | 凭证文件加载（`vk_`/`vs_` 前缀、0600、两文件不得同路径）+ HMAC 签名 | §6 |
| `internal/collector` | 12 | ❌（有 21 个 `testdata` 夹具） | `cpu` `mem` `disk` `net` `gpu` `process` + `/proc` 解析 + 速率计算 | §3 |
| `internal/config` | 2 | ✅ 1 | `config.yaml` 读取与严格校验（未知键拒绝） | §8 |
| `internal/logging` | 1 | ❌ | slog，`text`/`json`，文件轮转 | §8 |
| `internal/metric` | 2 | ✅ 1 | 指标全名拼接与维度转义（消费 `contracts/metric-names.json`） | §3 |
| `internal/model` | 2 | ✅ 1 | 上报体 / 心跳结构与本地校验（消费 `contracts/wire/*.json`） | §5 |
| `internal/prober` | 8 | ✅ 3 | `ping`（非特权 ICMP + TCP 降级）/ `http(s)` / `tcp`；2026-10-01 起另含 `errclass_{linux,windows,other}.go` 平台错误码 | §4 |
| `internal/reporter` | 4 | ✅ 2 | 组包 → 签名 → gzip → POST → 重试 → 超限裁剪 | §5 |
| `internal/scheduler` | 1 | ❌ | 采集/上报调度、心跳节流、SIGHUP 整代重启、自监控 | §7、§10 |
| `internal/ulid` | 1 | ❌ | `batch_id`（幂等键）生成 | §5.2 |
| `internal/version` | 1 | ❌ | 版本号与 `User-Agent` | §2 |
| ~~`internal/retry`~~ | 0 | — | **文档 §2 已于 2026-10-01 纠正**（A-T05）：重试内联在 `internal/reporter/reporter.go`，无独立包 | §2、§5.2 |
| ~~`internal/buffer`~~ | 0 | — | ✅ 按决策 G1 已删除（无磁盘缓存、不补传） | §2 |
| ~~`agent/tmp_cksum_check`~~ | 0 | — | ✅ 临时草稿已删（2026-10-01，`1c6dd9a`）；`.gitignore` 已兜底 `agent/tmp_*/`（A-T23） | — |

**统计（2026-10-01，不含已删草稿）**：38 个 `.go` 文件（9 个测试文件）；非测试 **~6700** 行，测试 **3306** 行；`collector/testdata` 夹具 **21** 个文件。

**有测试的包**：`auth` `config` `metric` `model` `prober` ✅ `reporter`
**无测试的包**：`cmd/agent` `collector` `logging` `scheduler` `ulid` `version`（对应待办 A-T06/A-T07/A-T08）

---

## 3. 与 `docs/agent.md` 的一致性核对

图例：✅ 一致 / 🟡 部分或口径漂移 / ❌ 未实现 / ⛔ 红线项（已确认守住）

| 文档条目 | 要求 | 实现位置 | 状态 |
|---|---|---|---|
| §1.2 单向宗旨 | ⛔ 只出站、不监听、不解析响应中除 `{ok, server_ts}` 外的内容 | `main.go` 全文无 `Listen`/`Serve`；`reporter.go:457-500` 只读 `ok`/`server_ts` | ⛔ ✅ |
| §1.1 单文件静态二进制 | Go 1.22+，无运行时依赖 | `CGO_ENABLED=0` 交叉编译产出 7.3MB 单文件 | ✅ |
| §2 模块划分 | `cmd/agent`、`config`、`collector`、`prober`、`scheduler`、`reporter`、`auth`、`version` | 均存在 | ✅ |
| §2 `internal/retry/` | 内存级重试独立模块 | **不存在该包**，功能内联在 `reporter` | ✅ 文档已于 2026-10-01 纠正（A-T05，D-03 关闭） |
| §2 `internal/buffer/` | ⛔ 已定删除 | 确实不存在 | ✅ |
| §3 六类采集器 | `cpu` `mem` `disk` `net` `gpu` `process` | `collector/{cpu,mem,disk,net,gpu,process}.go` | ✅ |
| §3 GPU | `nvidia-smi --query-gpu … --format=csv`；无卡/无工具优雅降级 | `gpu.go`：静态探测 + `[N/A]` 容错 + 连续失败回落 `gpu.nvidia=false` | ✅ |
| §3 指标命名硬契约 | 维度写进序列全名、转义单射、≤200 字符 | `internal/metric/`，消费 `contracts/metric-names.json`，两侧同源测试 | ✅ |
| §3 能力声明 `host.capabilities` | 白名单键、首次与变化时必填 | `collector.go:87-153`（白名单）+ `scheduler` 首报/变化重报 | ✅ |
| §3 单次采集 <50ms（GPU 除外） | 超时只 WARN 不中断 | `scheduler.go:42` 注释与之对应 | ✅ |
| §4 探活 `ping` | 非特权 ICMP，不可用→自动降级 TCP + WARN（⛔ 不静默、不崩溃） | `prober/{ping,ping_linux,ping_other}.go`，降级同时改 `capabilities["probe.ping"]` | ✅ |
| §4 探活 `http(s)` / `tcp` | 期望码集合、`body_contains`、延迟、超时 | `prober/http.go`、`prober/tcp_test.go` | ✅ |
| §4 探活 `dns` | 可扩展预留 | 配置层显式拒绝并说明「预留类型」（`config.go:629`） | ✅ 预留 |
| §5.1 上报顺序 | 组包 → 序列化一次 → sha256 → HMAC → gzip → POST | `reporter.go:268-301`（Prepare）+ `370-418`（send） | ✅ |
| §5.1 签名与发送同源字节 | ⛔ 不得 parse 后重序列化 | `reporter.go:376` 对 `raw` 求 sha256，`:386` 对同一 `raw` 签名，gzip 仅用于 `payload` | ⛔ ✅ |
| §5.2 重试规格 | ≤3 次、2s 起指数、总时长 ≤30s、只内存、失败丢弃 | `reporter.go:379-417`；重试换 nonce/ts、复用 `batch_id` | ✅ |
| §5.2 心跳 | 无变更只报心跳 | `scheduler.go:344` 心跳节流 + `reporter.PrepareHeartbeat` | ✅ |
| §5.3 单批 256KB 熔断 + 三级裁剪 | `process.top` 截半 → 丢 GPU 次要 → 丢 `net.err/drop`、`disk.latency_ms` → 仍超限丢批 | `config.go:34`（硬天花 `MaxBatchBytesCeiling`）+ `reporter/trim.go` | ✅ |
| §5.3 TLS / mTLS | 全链路 HTTPS、证书校验默认开、mTLS 可选 | `reporter.go:164-207`（TLS1.2+ / CA / mTLS / Keep-Alive） | ✅ |
| §6.1 ⛔ 禁 `--key <明文>` | 凭证只能来自受限文件 / stdin / env | `main.go` 无任何 key 参数；`auth/credentials.go` 读两个 0600 文件并校验前缀 | ⛔ ✅ |
| §6.2 canonical 拼法 | LF 分隔 4 处、末尾无换行、path 不含 query | `auth/sign.go`，消费 `contracts/agent-signature.json`（Go+Node 双侧同源） | ✅ |
| §7 SIGHUP 热重载 | 完整校验 → 原子替换 → 失败保留旧配置 | `main.go:139-155` + `scheduler.go` 整代重启；`ReloadFailed` 保留旧配置并计 `agent.reload_ok` | ✅ |
| §7 ⛔ 重载只读本地文件 | 无「从中心拉配置」路径 | 全文无此类代码路径 | ⛔ ✅ |
| §8 `config.yaml` 全字段 | `center{tls,allow_insecure_http}` / `agent` / `host` / `collect.*` / `report.*` / `probes` / `filters.*` / `clock` / `resource` / `log` | `config.go` 的 yaml tag 与文档 §8 **逐字段对齐** | ✅ |
| §8 校验规则 | https 强制、UUID、间隔下限、探活名唯一、未知键拒绝、错误指出完整键路径 | `config.go:460-680` | ✅ |
| §10 资源预算 | `GOMEMLIMIT` 封顶、固定 goroutine、磁盘 ≈ 0 | `main.go:99` `debug.SetMemoryLimit`；`scheduler` 每采集器 1 条 + 上报 1 条；无磁盘写入 | ✅ |
| §10 自监控三项 | `agent.mem_rss` / `agent.report_failures` / `agent.reload_ok` | `scheduler.go:456/462`、`model/report.go:180-185` | ✅ |
| §12.1 `vantage.sh` | install / upgrade / uninstall(`--purge`) / start / stop / restart / status / reload | **仓库内无任何 `.sh` 文件** | ❌ |
| §12 systemd 加固 | `User=vantage`、`ProtectSystem=strict`、`ReloadSignal=SIGHUP` 等 | **仓库内无任何 `.service` 文件** | ❌ |
| §13.3 平台路线 | M1–M5 只做 Linux；非 Linux 拒绝启动 | `collector/platform_other.go:23` `Supported=false`，`main.go:78-82` 拒绝启动并说明排期 | ✅ 设计如此 |
| §14 M5 Docker 采集 | 预留转正 | `config.go:543` 开启 `collect.docker.enabled` 直接报错「排在 M5」 | ❌ 未开工 |
| §14 M6 Win/macOS | 采集器 + 安装脚本 + reload 机制 | 无 `_windows.go` / `_darwin.go` 实现 | ❌ 未开工 |

---

## 4. 里程碑状态（对照 `docs/agent.md` §14）

| 阶段 | 文档要求的 Agent 产出 | 状态 | 说明 |
|---|---|---|---|
| **M1** | `cpu/mem/disk/net/gpu/process` 采集 + 组包上报 + 出站通路 | **✅ 代码完成** | 六类采集器齐备；`--once` 提供单次联调；构建通过 |
| **M2** | key+HMAC、TLS、限流/幂等配合、单向性复核 + **安装脚本** | **🟡 代码齐 / 脚本缺** | 签名·TLS·mTLS·nonce/batch 语义齐；`vantage.sh`、systemd unit、`setcap` 文档全缺 |
| **M3** | 探活三种完整 + 告警相关字段（漂移、离线心跳） | **🟡 代码齐 / 测试红** | ping/http/tcp 与心跳节流已实现；prober 测试因语法错误未运行，等于**未验证** |
| **M4** | GPU/进程完善、非 root 打磨、SIGHUP 热重载、`setcap` 文档 | **🟡 部分** | 热重载 ✅、GPU 降级 ✅、Top-N ✅；`collect.process.watch` 不产出指标、非 root/systemd/`setcap` 未落地 |
| **M5** | Docker 采集（预留转正）、systemd 加固打磨 | **❌ 未开工** | 配置层显式拒绝；无部署单元 |
| **M6** | Windows / macOS 采集器 + 安装脚本与 reload 机制 | **❌ 未开工** | 非 Linux 启动即拒绝（符合路线，非缺陷） |

---

## 5. 实测验证记录（2026-09-28 首测；2026-10-01 复测）

### 5.0 复测记录（2026-10-01，`HEAD = ab83d7f`）

| 命令 | 结果 |
|---|---|
| `go vet ./...` | ✅ exit 0（首测 exit 1，R-01 已修） |
| `go test ./... -count=1` | ✅ **全绿 exit 0**：`auth` 0.33s / `config` 0.34s / `metric` 0.34s / `model` 0.27s / `prober` 2.83s / `reporter` 0.72s；其余 6 包无测试文件 |
| `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath ./cmd/agent` | ✅ 通过 |

prober 测试首次真正运行后暴露 9 个失败用例，定性为 2 个代码缺陷（`splitHostPort` 歧义判定、
Windows errno 伪值分类）、1 个测试向量错误（校验和属性用例 4 字节向量）、2 个环境依赖用例
（UDP+IPAddr 仅 Linux、DNS 劫持环境），处置见 [`docs/agent-changes-2026-10-01.md`](agent-changes-2026-10-01.md) §2。
Windows 跑测试的预期 skip 与 WARN 对照表见 [`docs/agent-testing.md`](agent-testing.md) §4。

### 5.0.1 真机 E2E 记录（2026-10-01，A-T09 ✅，`90e81e8`）

| 项 | 值 |
|---|---|
| 环境 | Linux 真机（经堡垒机跳转；占位名 `us-e2e-01`），Debian 12 / 内核 6.1 / x86_64 / 8G；**Go 1.27.1 机上构建**（CGO_ENABLED=0）；中心 0.8.0 直跑宿主机（Node v24.21.0） |
| 依赖 | ⚠️ PostgreSQL **18.4**（项目基线 16）：init-db 三角色 + 8 个迁移 + 分区全部通过，`metrics_raw` 真实落库 —— **18 兼容性实测成立**；正式环境仍按基线 16 部署 |
| 中心健康 | `readyz ok=true`；postgres 15ms / redis 3ms / `noeviction` 且 `evicted_keys=0`（决策 #51/R15 真机成立）；`setsid` 分离后在堡垒机会话断开后持续存活 |
| E2E 用例 | `TestE2EWrongSecretIsRejected` / `TestE2ERealCenterAcceptsAgentBytes` / `TestE2EIdempotentReplay` **3/3 PASS**（`ok vantage-agent/internal/reporter 0.757s`） |
| `--once --print-body` | 退出码 0；`server_ts=1790844501013，attempts=1，压缩前 2815B → 实发 1179B`；**报文 grep 无 `vk_`/`vs_`**（红线 ✓） |
| 首次上报 | `host.capabilities` 随首报携带：`disk.inode/io=true、net.conn_count=true、gpu.nvidia=false（无 N 卡优雅降级）、process.top=true`；hostname 取自真机 |
| 落库 | `metrics_raw` 149 行 / `agents` 1 行（库 `vantage_e2e`，三角色按 init-db.sql 创建） |
| **常驻模式** | Owner 决定保留运行：agent 转常驻调度，**连续两个周期 30s 整点上报成功**（batch_id 轮换、attempts=1），`metrics_raw` 149→336 行，中心面板状态 `online`、`last_seen` 实时更新 —— 心跳节流/调度/落库的常驻语义真机成立 |

**真机首跑抓到并修复的缺陷（A-T26）**：`--once` 单轮采集永远产不出 `metrics.cpu`（差分指标需两个
采样点）→ 本地校验必拒。Windows 上不可达（`Supported=false` 提前拒绝）、`cmd/agent` 无测试，
**只有真机首跑才能暴露**。修复：`runOnce` 预热轮（`90e81e8`）。另发现 `server/package-lock.json`
从未入库（npm ci 在克隆机上失败），登记 A-T27。

真机操作方法见 [`docs/agent-testing.md`](agent-testing.md) §7。

以下 §5.1–§5.3 为 2026-09-28（`HEAD = 9a091da`，Agent 代码仅在暂存区）的**首测记录**，保留作对照 ——
其中「go vet / go test 失败」的结论已被 §5.0 的复测取代。

### 5.1 Go Agent

```powershell
cd agent
go build ./...                                   # 通过
go vet ./...                                     # 失败（测试文件语法错误）
go test ./... -count=1                           # 失败：1 个包 setup failed
```

| 命令 | 结果 |
|---|---|
| `go build ./...` | ✅ 通过 |
| `go vet ./...` | ❌ exit 1：`internal\prober\ping_test.go:57:45: missing ',' in composite literal` |
| `go test ./... -count=1` | ❌ exit 1；`auth` ✅ / `config` ✅ / `metric` ✅ / `model` ✅ / `reporter` ✅ / `prober` ❌ `[setup failed]` |
| `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" ./cmd/agent` | ✅ 通过，产出 **7,286,968 字节（≈7.3MB）** 单文件静态二进制 |

逐包 `go test` 结果：

```
FAIL   vantage-agent/internal/prober [setup failed]
?      vantage-agent/cmd/agent         [no test files]
ok     vantage-agent/internal/auth     0.278s
?      vantage-agent/internal/collector [no test files]
ok     vantage-agent/internal/config   0.232s
?      vantage-agent/internal/logging  [no test files]
ok     vantage-agent/internal/metric   0.125s
ok     vantage-agent/internal/model    0.128s
ok     vantage-agent/internal/reporter 0.597s
?      vantage-agent/internal/scheduler [no test files]
?      vantage-agent/internal/ulid      [no test files]
?      vantage-agent/internal/version   [no test files]
```

> ⚠️ 真机端到端 `internal/reporter/e2e_test.go` 需 `VANTAGE_E2E_CENTER` / `VANTAGE_E2E_AGENT_ID` /
> `VANTAGE_E2E_KEY` / `VANTAGE_E2E_SECRET` 才会执行，**本次未跑**（且在 Windows 开发机上
> `Supported=false`，`--once` 也会被拦住 —— 真机联调必须在 Linux 上做）。

### 5.2 中心侧（供参照：跨语言契约是否真的通）

```powershell
cd server
npm test
```

结果：**241 用例 / 226 通过 / 0 失败 / 15 跳过 / 26.5s**。其中
`server/test/agentwire.test.js` 把 Agent 产出的**线上黄金字节**（`contracts/wire/*.json`）
送进真实链路（gzip → 验签 → schema → 摊平 → 落库）并全部通过，`sign.test.js` 逐字节消费
`contracts/agent-signature.json` 也通过 —— **两侧共享契约当前是通的**。
（15 个跳过为 live 用例，需真实 PG/Redis。）

### 5.3 仓库状态

| 项 | 值 |
|---|---|
| `git rev-list --count HEAD` | **1**（仅 `9a091da feat: 新增 vantage-core 核心服务完整实现及基础设施`） |
| 暂存区规模 | **95 文件 / +19002 行**（Agent 全部实现 + `contracts/` + server 测试） |
| 未暂存改动 | 无（`git diff --stat` 为空） |
| 结论 | **Agent 代码尚未进版本历史**，只存在于暂存区 |

---

## 6. 已知偏差（文档 ↔ 代码）

| # | 偏差 | 细节 | 处置 |
|---|---|---|---|
| D-01 | README 组件表与状态表 | README §1 表把 `vantage-agent` 写成**「未开工」**，§顶部又写「🚧 进行中」；§3.2 写「Go Agent 尚未开工，用脚本手工联调」；§7 里程碑 M2–M6 整列 ⏳ | ✅ 已解决（2026-10-01，A-T04，`ab83d7f`） |
| D-02 | README §7 里程碑 | M1 行只承认「中心侧 ✅（Agent 待做）」，与本文 §4 不符 | 待办 A-T04 |
| D-03 | `docs/agent.md` §2 模块表 | 列了 `internal/retry/`，实际无此包（重试内联于 `reporter`）；同时代码新增了文档未列的 `internal/{logging,metric,model,ulid}` | ✅ 已解决（2026-10-01，A-T05，`ab83d7f`）；新发现的 §3 数据源列 gopsutil 口径登记为 A-T25 |
| D-04 | `docs/agent.md` §3 能力声明 | 文档说「首次上报与能力变化时必填」；`gpu.go` 的"连续失败后回落 `gpu.nvidia=false`"会触发**能力变化重报**，是文档未描述的额外上报量来源（代码已在注释中记录） | 观察项，暂不改 |
| D-05 | `docs/agent.md` §3 `collect.process.watch` | 配置项存在且校验，但**上报格式无承载字段**，`process.go:99-105` 自注为「本期只记录、不产出指标」，启动时打一次 WARN | 待办 A-T14（属契约变更，需先改文档） |
| D-06 | 中心侧 M-05 / M-06 | `host.boot_time` 口径（秒/毫秒/RFC3339）与 `disk[].device` 是否必填，中心 `server/README.md` 明确「等 Agent 定型后收窄为一」 | 待办 A-T15 / A-T16 |
| D-07 | `internal/collector` 测试 | `testdata/proc/**`（21 个夹具）已备好，但**没有任何 `_test.go`**，夹具白建 | 待办 A-T06 |

---

## 7. 未实现 / 预留清单

| 项 | 状态 | 位置 | 备注 |
|---|---|---|---|
| `vantage.sh` 安装/升级/卸载/控制脚本 | ❌ 未开工 | — | M2 交付物；含三种 key 传递形式 |
| systemd unit + 非 root 加固 | ❌ 未开工 | — | M2/M5；`ReloadSignal=SIGHUP` 是热重载的运维入口 |
| `setcap cap_net_raw+ep` 运维文档 | ❌ 未写 | `docs/agent.md` §4/§9 已提，仓库无落地文档 | opt-in，非必需 |
| 出站防火墙白名单示例 | ❌ 未写 | `docs/agent.md` §9「➕ 建议」 | 文档级 |
| `collect.process.watch` 关键进程存活 | 🟡 配置可用、不产出指标 | `collector/process.go:99-105` | 需中心 schema 承载字段 |
| `docker` 采集 | ❌ 未开工（M5） | `config.go:543` 拒绝开启 | 上报体 `metrics.docker` 恒为 `null` |
| GPU AMD / `rocm-smi` | ❌ 预留 | `collector/gpu.go`（仅 NVIDIA） | 配置 `provider` 字段已留 |
| 探活 `dns` | ❌ 预留 | `config.go:629` 显式拒绝 | — |
| Windows / macOS 采集器 | ❌ 未开工（M6） | `collector/platform_other.go` | 主干与中心侧零改动即可接入 |
| `LICENSE`（AGPL-3.0） | ❌ 缺 | README §8 已自注 | 正式开源前必补 |

---

## 8. 阻塞与风险

| # | 级别 | 问题 | 影响 | 处置 |
|---|---|---|---|---|
| **R-01** | 🔴→✅ | ~~`agent/internal/prober/ping_test.go:57` 引号笔误~~ **已解决（2026-10-01，`1c6dd9a`）**：修复后 prober 测试首次运行，暴露的 9 个失败用例已处理，`go vet` / `go test ./...` 恢复通过 | ~~挡 CI~~ 不再阻塞 | 变更说明 §2 |
| R-02 | 🟡 | `collector` / `scheduler` 两个**最复杂**的包零测试覆盖（`collector` 有 21 个夹具却无测试） | `/proc` 解析、速率差值、调度/心跳/reload 语义无回归保护 | 待办 A-T06 / A-T07 |
| R-03 | 🟡→✅ | ~~Agent 实现未提交，仅在工作区暂存区~~ **已解决（2026-09-30，`8737820`）**；其"红测试与草稿一并入库"的顺序偏差由 `1c6dd9a` 补救 | ~~不可追溯~~ 已进版本历史 | 待办 A-T03 完成记录 |
| R-04 | 🟡→✅ | ~~真机 E2E 从未留痕~~ **已解决（2026-10-01，§5.0.1）**：Debian 12 真机 3/3 E2E PASS + `--once` 真实上报落库，顺带抓出并修复 A-T26 | — | 已完成 |
| R-05 | 🟢→✅ | ~~`agent/tmp_cksum_check/main.go` 草稿已进暂存区~~ **已解决（2026-10-01，`1c6dd9a`）**：草稿已删，`.gitignore` 兜底 `agent/tmp_*/` | — | 待办 A-T02/A-T23 |
| R-06 | 🟢 | 文档口径漂移（D-01…D-03） | 后续接手者会以为 Agent 未开工、或去找不存在的 `internal/retry` | D-01/D-03 已解决（A-T04/A-T05）；D-04～D-07 仍在 |

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-28 | 首次建立本状态文档：清点 Agent 代码（39 `.go` / 非测试 6736 行 / 测试 3306 行），实跑构建、交叉编译、`go vet`、`go test` 与 `server/ npm test`，登记 R-01…R-06 与 D-01…D-07 |
| 2026-10-01 | 复测更新：R-01/R-03/R-05 与 D-01/D-03 关闭（提交 `8737820`、`1c6dd9a`、`ab83d7f`）；`go vet` / `go test ./...` **首次全绿**（prober 首次真正运行，9 个暴露用例定性处理：splitHostPort 歧义判定与 Windows errno 分类两个代码缺陷修复、1 个测试向量纠正、2 个环境用例明确 skip）；新增测试手册 `docs/agent-testing.md` 与改动记录 `docs/agent-changes-2026-10-01.md`。新登记 A-T25（`docs/agent.md` §3 数据源列 gopsutil 口径收窄） |
| 2026-10-01(晚) | **A-T09 真机 E2E 完成**（§5.0.1）：Debian 12 真机 3/3 E2E PASS、`--once` 真实上报落库（PG 18.4 实测兼容）、红线检查通过；真机首跑抓出 `--once` 缺 cpu 预热轮的缺陷并修复（A-T26，`90e81e8`）；登记 A-T27（`server/package-lock.json` 未入库，克隆机 `npm ci` 失败）。R-04 关闭 |

---

## 10. 相关文档

| 想了解 | 读这里 |
|---|---|
| Agent 该怎么做（行为契约） | [`docs/agent.md`](agent.md) |
| Agent 还差什么（待办清单） | [`docs/agent-todo.md`](agent-todo.md) |
| **测试怎么跑（本机/真机/契约）** | [`docs/agent-testing.md`](agent-testing.md) |
| **2026-10-01 改了什么** | [`docs/agent-changes-2026-10-01.md`](agent-changes-2026-10-01.md) |
| 上报协议 / 错误码 | [`docs/api.md`](api.md) §2 |
| 指标命名与单位 | [`docs/database.md`](database.md) §5.7.2 |
| 两端共享契约 | [`contracts/README.md`](../contracts/README.md) |
| 中心服务怎么跑、踩过哪些坑 | [`server/README.md`](../server/README.md) |
| v0.7→v0.8 改了什么、M1/M1.5 实现记录 | [`docs/design-deltas.md`](design-deltas.md) |
