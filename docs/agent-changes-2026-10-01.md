# Vantage Agent 改动说明（2026-10-01）

> **文档性质**：**一次开发轮次的改动记录**，回答「这次动了什么、为什么这么动、怎么验证的」。
> 行为口径以 [`docs/agent.md`](agent.md) 为准；累计进度以 [`docs/agent-status.md`](agent-status.md) 为准；
> 待办以 [`docs/agent-todo.md`](agent-todo.md) 为准。测试怎么跑见 [`docs/agent-testing.md`](agent-testing.md)。
>
> **范围**：两个提交 —— `1c6dd9a`（P0：修复测试与清理）、`ab83d7f`（P1：文档口径对齐）。
> 待办编号（A-Txx）均指 [`docs/agent-todo.md`](agent-todo.md) 里的条目。

---

## 1. 一句话总览

**修好了 `go test ./...`（项目历史上首次全绿），并让 README / 契约文档的 Agent 状态口径与代码事实一致。**
过程中定性并处理了 5 类被「测试编译失败」掩盖的问题（2 个代码缺陷、1 个测试向量错误、2 个环境依赖用例）。

| 提交 | 内容 | 对应待办 |
|---|---|---|
| `1c6dd9a` | 修 prober 测试编译错误 + 处理其暴露的 9 个失败用例 + 删临时草稿 + gitignore 兜底 | A-T01、A-T02、A-T23 |
| `ab83d7f` | README 与 `docs/agent.md` 的 Agent 状态口径、模块表、文档索引、依赖许可 | A-T04、A-T05、A-T24 |

---

## 2. `1c6dd9a`：修复测试与清理（P0）

### 2.1 A-T01：引号笔误（唯一阻塞项）

`agent/internal/prober/ping_test.go:57` 的 `why:` 字符串里内层用了 ASCII `"`，Go 把字符串提前截断，
整个 **prober 包测试无法编译**（`go vet` / `go test` 退出码 1）——即状态文档登记的 R-01。
修复：内层引号改为「」。**这是自该测试文件写下以来，prober 测试第一次真正运行。**

### 2.2 编译修复后暴露的 9 个失败用例 → 5 个根因

按 A-T01 验收标准的约定（「新增失败用例单独定性，⛔ 不许为变绿改断言」），逐一定性如下：

| # | 根因 | 定性 | 处置 |
|---|---|---|---|
| 1 | `splitHostPort` 与自身文档注释矛盾：文档明确「`dns.example.com:443` 这类主机名:端口写法必须判为歧义返回 ok=false」，代码却在 `net.SplitHostPort` 成功后直接放行 | **代码缺陷**（连带导致 `TestSplitHostPort`、`TestTCPTargetsForHost`、`TestResolveProbeIP`、`TestPingAmbiguousHostGivesActionableError` 4 个用例失败；歧义配置会被静默探测一个猜出来的目标） | 修 `ping.go`：拆分成功且主机部分非 IP 字面量、又没用方括号包起来 → 判歧义返回 false。方括号写法 `[主机名]:443` 意图明确，放行 |
| 2 | Windows 上 `syscall.ECONNREFUSED` 是 Go 内部伪 errno（APPLICATION_ERROR 段，值 536870934），真实拨号错误携带的是 **WSAECONNREFUSED(10061)**，`errors.Is` 永远判不上 —— 实测证据：`errors.Is(err, syscall.ECONNREFUSED) = false`、`errno in err = 10061` | **跨平台缺陷**（连累 `TestHTTPProbeConnRefused`、`TestTCPProbeRefused`、`TestClassNetErrOnRealConnRefused`；「连接被拒绝」的分类在 Windows 上全部失配成含糊网络错误） | 新增 `errclass_linux.go` / `errclass_windows.go` / `errclass_other.go` 三个带构建标签的文件按平台定义真值（Linux 用 syscall 原值，Windows 用 WSA 数值），`http.go` 不再直接引用 syscall 常量。**Linux 生产路径行为不变** |
| 3 | `TestICMPChecksumVerifyProperty` 用了 4 字节向量，而 `verifyICMPChecksum` 的前置条件是 `len ≥ icmpHeaderLen(8)`，短输入短路返回 false | **测试向量错误**（向量违反被测函数文档化前置条件，任何正确实现都过不了；非平台问题，Linux 上同样失败） | 向量补足为 8 字节（全零 / 全 ff 各一组），保留「零值 / 全 ff 边界」的测试意图，用例内加注释说明 |
| 4 | `TestPingNoAnswerIsResultNotDegradation` 用本地 UDP 模拟 ICMP socket，向 `net.IPAddr` 目标 `WriteTo` 只有 Linux 的 sendto 容忍；Windows 直接 `WSAEINVAL`，写侧就失败，测不到「读 deadline 生效、超时翻成超时文案」 | **环境依赖用例**（设计如此：`ping.go` 分层注释明确「ICMP socket 怎么开」是平台层） | 非 Linux 明确 `t.Skip` 并写明原因；Linux CI 上照常执行 |
| 5 | `TestHTTPProbeDNSFailure` 在本机拿到 502 响应而非解析失败 —— 本机 DNS/安全软件把 `.invalid` 也解析成功了 | **环境属性**（不是被测代码缺陷；Linux CI 无劫持时断言照常执行） | 用例自检「收到了 HTTP 响应（`StatusCode != nil`）」即 skip 并说明；**断言一字未改** |

### 2.3 A-T02：删除临时草稿

`agent/tmp_cksum_check/`（写 ping 测试时验证 ICMP 校验和的独立草稿程序）此前已被误提交进 `8737820`。
本次提交将其从仓库删除（`git rm` 生效于历史之后的新提交）。

### 2.4 A-T23：.gitignore 兜底

新增约定 `agent/tmp_*/`：以后草稿目录按此命名即无法被 `git add`（刻意**不用**宽泛的 `tmp*`，避免误伤正式代码）。

---

## 3. `ab83d7f`：文档口径对齐（P1）

### 3.1 A-T04：README 四处状态口径

| 位置 | 改前 | 改后 |
|---|---|---|
| 顶部状态表 | 「🚧 Go Agent 进行中…采集器、配置、调度、探活待完成」 | 「主体完成：M1–M4 核心代码已落地，`go test ./...` 全绿；M2 部署侧待补」并链接 `docs/agent-status.md` |
| §1 组件表 | `vantage-agent` 状态「未开工」 | 「🚧 M1–M4 代码完成（部署脚本待补）」 |
| §2 仓库结构 | `agent/ # 🚧 Go Agent（进行中）` | 标注 M1–M4 代码完成 |
| §3.2 联调 | 「Go Agent 尚未开工，用脚本 + 手工报文联调」 | 补记 Agent 已有 `--check` / `--once --print-body` 联调入口 |
| §7 里程碑 | M1 行只承认「中心侧 ✅（Agent 待做）」；M2 整列 ⏳ | M1 行标注 Agent 侧采集/组包/上报 ✅；M2 标注「Agent 侧鉴权/TLS 代码 ✅，安装脚本、systemd、面板登录未开工」 |

### 3.2 A-T05：`docs/agent.md` §2 模块表

- `internal/retry/` 标注为「**实际无此包**，重试内联于 `internal/reporter/`（只重试当前批次，⛔ 不落盘）」——
  纠正 D-03 口径漂移，且**没有**为对齐文档去建空壳包；
- 补上代码中实际存在但文档未列的 4 个包：`internal/metric`（指标命名转义）、`internal/model`（上报体）、
  `internal/ulid`（幂等键）、`internal/logging`（日志 + 不泄凭证红线）；
- `internal/buffer/` 删除行的「重试只由 internal/retry/ 完成」同步改为 reporter；
- `cmd/agent` 行补 `--check` / `--once`。

### 3.3 顺带发现并登记：gopsutil 口径过时

契约文档 §2/§3 写采集器「gopsutil 为主」，实现实际是 **Linux 直读 /proc**（`go.mod` 仅依赖
`gopkg.in/yaml.v3`，全仓 grep 无 gopsutil）。已把 §2 模块表的 collector 行纠正为现实口径；
**§3 采集器规格表的数据源列**（逐行 gopsutil API 名）属于行为契约正文，涉及面大，
按仓库惯例登记为新待办 **A-T25**（文档收窄，不是改代码），本轮不动。

### 3.4 A-T24：文档索引打通

- README §5 索引加入 `docs/agent-status.md` / `docs/agent-todo.md`；
- `docs/agent.md` 头部「阅读约定」处加「进度与待办见…，口径冲突以本文为准」。

### 3.5 README §8 依赖许可修正

原文写「`gopsutil`(BSD)」——实现并不依赖它。改为 Go 侧仅 `gopkg.in/yaml.v3`（Apache-2.0，
ICMP 走裸 syscall 不引第三方）。

---

## 4. 验证记录（2026-10-01，全部实跑）

| 命令 | 结果 |
|---|---|
| `go vet ./...` | ✅ exit 0（修复前 exit 1） |
| `go test ./... -count=1` | ✅ **全绿**：auth / config / metric / model / prober / reporter 全 ok（prober 约 2.8s），其余 6 包无测试文件；exit 0（修复前 prober `[setup failed]`） |
| `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath ./cmd/agent` | ✅ 通过（Linux 交叉编译不受 Windows 平台文件影响） |
| 修复前的对照实验 | 写临时程序实测 Windows 拨号错误：`errors.Is(err, syscall.ECONNREFUSED) = false`、真实 errno = 10061 —— 根因 #2 的证据 |

Windows 上跑测试会看到 2 处 `SKIP` 与 ICMP 降级 WARN，均为预期，见
[`docs/agent-testing.md`](agent-testing.md) §4 的对照表。

## 5. 配套文档同步（本提交）

- 新增 [`docs/agent-testing.md`](agent-testing.md)（测试操作手册）与本文件；
- [`docs/agent-status.md`](agent-status.md)：核验基线更新至 2026-10-01，R-01/R-03/R-05 与 D-01/D-03 关闭，
  §2 代码清点（删 tmp_cksum_check 行）、§5 实测记录、§9 变更记录同步；
- [`docs/agent-todo.md`](agent-todo.md)：A-T01/A-T02/A-T03/A-T04/A-T05/A-T23/A-T24 置 ✅ 并附完成日期与提交号，
  新增 A-T25，变更记录同步。

## 6. 本次未动 / 剩余工作

| 项 | 状态 |
|---|---|
| A-T06（collector 测试） | ✅ 已落地（`418b454`，7 个 `_test.go` / 35 条用例）—— 本文件成稿时尚未开始，见下方「后续轮次补充」 |
| A-T07 / A-T08（scheduler / logging+ulid+cmd 测试） | ⬜ 未开始（本轮进行到读取源码阶段即转入文档交付） |
| A-T09（Linux 真机 E2E 留痕） | ✅ 已完成（2026-10-01 晚，见 `docs/agent-status.md` §5.0.1）；本文件成稿时本机为 Windows、尚未执行 |
| A-T10～A-T13（vantage.sh / systemd / key 三形式 / 运维文档） | 🟡 A-T10/A-T11/A-T12 代码已落地、待真机验证；A-T13 未开始（见 `docs/agent-todo.md` §4） |
| A-T14～A-T16（契约收窄） | ⛔ 需先改契约与 Owner 拍板，不在本轮 |
| A-T25（`docs/agent.md` §3 数据源列 gopsutil → /proc 现实口径收窄） | ⬜ 本轮新登记 |
| A-T26 / A-T27 | A-T26 ✅（`90e81e8`）；A-T27 ① ✅（`6b469ad`）② ③ 待办 |
| A-T28（prober HTTPS 证书用例并行偶发超时） | ⬜ 2026-10-05 复测新登记（测试稳定性，非实现缺陷） |

## 7. 后续轮次补充（成稿之后，截至 2026-10-05）

本文件记录的 `1c6dd9a` / `ab83d7f` 一轮之后，仓库继续推进，与本文件**结论直接相关**的变化如下
（细节以 [`docs/agent-status.md`](agent-status.md) §5.0.1/§5.0.2/§9 与
[`docs/agent-todo.md`](agent-todo.md) 各条完成记录为准）：

| 项 | 变化 |
|---|---|
| A-T06 | ✅ collector 单元测试落地（`418b454`）：7 个 `_test.go` / 35 条用例，消费 `testdata/proc/**` 全部 21 个夹具，速率类注入假时钟，覆盖降级与过滤规则；顺带修复测试暴露的 disk 延迟与进程契约缺陷。**§6 表中原写「⬜ 未开始」，已更正** |
| A-T09 | ✅ 真机 E2E 完成（2026-10-01 晚）：3/3 PASS + `--once` 真实上报落库；**§6 表中原写「本机为 Windows，无法执行」，已更正** |
| A-T10～T12 | 🟡 `agent/deploy/` 交付安装脚本 / systemd unit / config 模板 / 打包与发布脚本；`sh -n` 与 11 条负例待 Owner 在真机/容器执行 |
| A-T26 / A-T27 | A-T26 ✅（`--once` 预热轮，`90e81e8`）；A-T27 ① `server/package-lock.json` 已入库（`6b469ad`），`npm ci` 统一化待办 |
| 仓库代码清点 | 由本轮成稿时的 38 个 `.go` / 测试 3306 行，变为 **48 个 `.go`（16 个测试文件）/ 非测试 6775 行 / 测试 4456 行** |
| 新登记 | A-T28：`internal/prober` 的 HTTPS 自签证书用例在并行整包运行时偶发超时失败（`-p 1` 串行全绿），属测试稳定性问题 |

⚠️ 本文件标题与正文（§1–§5）记录的仍是 2026-10-01 那一轮的两个提交，未追溯修改；后续变化集中在本节与 §6 的状态更正。
