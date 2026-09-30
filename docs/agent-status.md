# Vantage Agent 开发状态（`vantage-agent` / Go）

> **文档性质**：**进度快照**，不是行为契约。采集/探活/上报/鉴权/配置该怎么做，一律以
> [`docs/agent.md`](agent.md) 为准；上报字段以 [`docs/api.md`](api.md) §2 为准；指标与单位以
> [`docs/database.md`](database.md) §5.7.2 为准。本文只回答一个问题：**「现在做到哪了」。**
>
> **核验基准**：工作区 `D:\phpstudy_pro\WWW\Vantage`，`HEAD = 9a091da`（git 历史仅此 1 个提交，
> 为 `vantage-core` 落地提交；**Agent 全部代码目前只在暂存区**）。
>
> **核验时间**：2026-09-28。
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
| 1 | **Agent 主体已实现**：采集 / 探活 / 组包签名 / 上报重试 / 配置校验 / SIGHUP 热重载全部落地 | 非测试代码 **6736 行 / 30 个文件**，测试 **3306 行 / 9 个文件**（`agent/**` 共 39 个 `.go`） |
| 2 | `go build ./...` 与 Linux 静态交叉编译**通过**，产出 7.3MB 单文件静态二进制（符合 `docs/agent.md` §10） | 见 §5 实测记录 |
| 3 | ⛔ **唯一阻塞项**：`internal/prober/ping_test.go:57` 有一个 ASCII 引号笔误 → **整个 prober 包测试无法编译**，`go test ./...` 退出码 1 | 见 §8 R-01 |
| 4 | **文档口径落后于代码**：README 组件表仍写 Agent「未开工」、§3.2 仍写「Go Agent 尚未开工」、§7 里程碑整列 ⏳ | 见 §6 D-01/D-02 |
| 5 | **M5 / M6 真未开工**：Docker 采集（配置层显式拒绝）、Windows/macOS（启动即拒绝） | 见 §4、§7 |
| 6 | **M2 部署侧未开工**：仓库内没有任何 `.sh` / `.service` 文件 —— `vantage.sh`、systemd unit、`setcap` 运维文档全缺 | 见 §7 |
| 7 | 全部 Agent 实现（95 文件 / +19002 行，含 contracts 与 server 测试）**尚未提交**，仅在 git 暂存区 | §5 实测记录 |

**一句话**：**M1–M4 的核心代码路径基本齐了，卡在「测试红 + 部署侧空白 + 文档没跟上 + 没提交」这四件事上。**

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
| `internal/prober` | 8 | ✅ 3（当前**编译失败**） | `ping`（非特权 ICMP + TCP 降级）/ `http(s)` / `tcp` | §4 |
| `internal/reporter` | 4 | ✅ 2 | 组包 → 签名 → gzip → POST → 重试 → 超限裁剪 | §5 |
| `internal/scheduler` | 1 | ❌ | 采集/上报调度、心跳节流、SIGHUP 整代重启、自监控 | §7、§10 |
| `internal/ulid` | 1 | ❌ | `batch_id`（幂等键）生成 | §5.2 |
| `internal/version` | 1 | ❌ | 版本号与 `User-Agent` | §2 |
| ~~`internal/retry`~~ | 0 | — | **文档 §2 列了这个包，实际不存在**：重试内联在 `internal/reporter/reporter.go:370-418` | §2、§5.2 |
| ~~`internal/buffer`~~ | 0 | — | ✅ 按决策 G1 已删除（无磁盘缓存、不补传） | §2 |
| `agent/tmp_cksum_check` | 1 | ❌ | ⚠️ **临时草稿**（写 ping 测试时的独立校验和验证程序），**已被 `git add`** | — |

**统计**：39 个 `.go` 文件（9 个测试文件）；非测试 **6736** 行，测试 **3306** 行；`collector/testdata` 夹具 **21** 个文件。

**有测试的包**：`auth` `config` `metric` `model` `prober`(✗) `reporter`
**无测试的包**：`cmd/agent` `collector` `logging` `scheduler` `ulid` `version` `tmp_cksum_check`

---

## 3. 与 `docs/agent.md` 的一致性核对

图例：✅ 一致 / 🟡 部分或口径漂移 / ❌ 未实现 / ⛔ 红线项（已确认守住）

| 文档条目 | 要求 | 实现位置 | 状态 |
|---|---|---|---|
| §1.2 单向宗旨 | ⛔ 只出站、不监听、不解析响应中除 `{ok, server_ts}` 外的内容 | `main.go` 全文无 `Listen`/`Serve`；`reporter.go:457-500` 只读 `ok`/`server_ts` | ⛔ ✅ |
| §1.1 单文件静态二进制 | Go 1.22+，无运行时依赖 | `CGO_ENABLED=0` 交叉编译产出 7.3MB 单文件 | ✅ |
| §2 模块划分 | `cmd/agent`、`config`、`collector`、`prober`、`scheduler`、`reporter`、`auth`、`version` | 均存在 | ✅ |
| §2 `internal/retry/` | 内存级重试独立模块 | **不存在该包**，功能内联在 `reporter` | 🟡 见 §6 D-03 |
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

## 5. 实测验证记录（2026-09-28）

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
| D-01 | README 组件表与状态表 | README §1 表把 `vantage-agent` 写成**「未开工」**，§顶部又写「🚧 进行中」；§3.2 写「Go Agent 尚未开工，用脚本手工联调」；§7 里程碑 M2–M6 整列 ⏳ | 待办 A-T04 |
| D-02 | README §7 里程碑 | M1 行只承认「中心侧 ✅（Agent 待做）」，与本文 §4 不符 | 待办 A-T04 |
| D-03 | `docs/agent.md` §2 模块表 | 列了 `internal/retry/`，实际无此包（重试内联于 `reporter`）；同时代码新增了文档未列的 `internal/{logging,metric,model,ulid}` | 待办 A-T05（改文档，不是改代码） |
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
| **R-01** | 🔴 阻塞 | `agent/internal/prober/ping_test.go:57` 把中文引号写成了 ASCII `"`：`"…证明"补零在低位"而不是"丢弃末字节""` | 整个 `prober` 包测试无法编译（`ping_test` / `http_test` / `tcp_test` 全部未运行）；`go test ./...` 与 `go vet ./...` 退出码 1，**会挡住 CI** | 待办 A-T01（一行修复） |
| R-02 | 🟡 | `collector` / `scheduler` 两个**最复杂**的包零测试覆盖（`collector` 有 21 个夹具却无测试） | `/proc` 解析、速率差值、调度/心跳/reload 语义无回归保护 | 待办 A-T06 / A-T07 |
| R-03 | 🟡 | Agent 实现未提交，仅在工作区暂存区 | 一次误操作（`git reset --hard`、`checkout`）即丢失；进度无法被 git 追溯 | 待办 A-T03 |
| R-04 | 🟡 | 真机 E2E 从未留痕 | 「签名/TLS/schema 全都对」目前只有假中心 + 中心侧黄金字节测试支撑，没有一次真实握手的记录 | 待办 A-T09 |
| R-05 | 🟢 | `agent/tmp_cksum_check/main.go` 草稿已进暂存区 | 会被当成正式代码提交，并出现在 `go test ./...` 的包列表里 | 待办 A-T02 |
| R-06 | 🟢 | 文档口径漂移（D-01…D-03） | 后续接手者会以为 Agent 未开工、或去找不存在的 `internal/retry` | 待办 A-T04 / A-T05 |

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-28 | 首次建立本状态文档：清点 Agent 代码（39 `.go` / 非测试 6736 行 / 测试 3306 行），实跑构建、交叉编译、`go vet`、`go test` 与 `server/ npm test`，登记 R-01…R-06 与 D-01…D-07 |

---

## 10. 相关文档

| 想了解 | 读这里 |
|---|---|
| Agent 该怎么做（行为契约） | [`docs/agent.md`](agent.md) |
| Agent 还差什么（待办清单） | [`docs/agent-todo.md`](agent-todo.md) |
| 上报协议 / 错误码 | [`docs/api.md`](api.md) §2 |
| 指标命名与单位 | [`docs/database.md`](database.md) §5.7.2 |
| 两端共享契约 | [`contracts/README.md`](../contracts/README.md) |
| 中心服务怎么跑、踩过哪些坑 | [`server/README.md`](../server/README.md) |
| v0.7→v0.8 改了什么、M1/M1.5 实现记录 | [`docs/design-deltas.md`](design-deltas.md) |
