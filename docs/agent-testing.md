# Vantage Agent 测试指南（vantage-agent / Go）

> **文档性质**：**测试操作手册** —— 在本仓库的测试环境（Windows 开发机 + DSH 沙箱，以及 Linux 真机）里，
> 怎么把 Agent 的构建、单测、契约测试、真机联调跑起来、看到什么算通过。
> 行为该是什么以 [`docs/agent.md`](agent.md) 为准；进度以 [`docs/agent-status.md`](agent-status.md) 为准。
> **建立**：2026-10-01（配合提交 `1c6dd9a` 之后的状态，`go test ./...` 首次全绿）。

---

## 1. 环境准备

| 项 | 要求 | 说明 |
|---|---|---|
| Go | **1.22+**（开发机实测 1.25.7 windows/amd64） | `go version` 确认 |
| Node.js | **≥ 22**（跑中心侧契约测试才需要） | `node -v` 确认 |
| 工作区缓存目录 | `.gocache/` `.gomodcache/` `.gopath/` | 已在 `.gitignore` 内，⛔ 不提交 |

**⚠️ DSH 沙箱内必须把 Go 缓存指进工作区**（默认缓存在用户目录，沙箱拒写），每次开新 shell 都要设：

```powershell
$env:GOCACHE   = "D:\phpstudy_pro\WWW\Vantage\.gocache"
$env:GOMODCACHE = "D:\phpstudy_pro\WWW\Vantage\.gomodcache"
$env:GOPATH    = "D:\phpstudy_pro\WWW\Vantage\.gopath"
```

普通 Linux / CI 环境不需要这三行，直接跑即可。Agent 的 Go 依赖只有 `gopkg.in/yaml.v3`，
模块已缓存进工作区后**离线可跑全部单测**。

## 2. 快速验证三连（每次改完必跑）

```powershell
cd D:\phpstudy_pro\WWW\Vantage\agent
go build ./...          # 期望：无输出，exit 0
go vet ./...            # 期望：无输出，exit 0（2026-10-01 起恢复通过）
go test ./... -count=1  # 期望：全部 ok，exit 0
```

`-count=1` 禁用测试结果缓存，保证是真跑。**2026-10-01 实测基线**：

```
ok  	vantage-agent/internal/auth      ~0.3s
ok  	vantage-agent/internal/config    ~0.3s
ok  	vantage-agent/internal/metric    ~0.3s
ok  	vantage-agent/internal/model     ~0.3s
ok  	vantage-agent/internal/prober    ~2.8s
ok  	vantage-agent/internal/reporter  ~0.7s
?   	vantage-agent/cmd/agent     [no test files]（待 A-T08）
?   	vantage-agent/internal/collector  [no test files]（待 A-T06）
?   	vantage-agent/internal/logging    [no test files]（待 A-T08）
?   	vantage-agent/internal/scheduler  [no test files]（待 A-T07）
?   	vantage-agent/internal/ulid       [no test files]（待 A-T08）
?   	vantage-agent/internal/version    [no test files]
```

⏱ 全套约 5–6 秒。**任何一条红都先修再继续**；若出现新增失败用例，按
[`docs/agent-todo.md`](agent-todo.md) A-T01 验收标准的约定：**单独登记待办，⛔ 不许改断言迁就**。

## 3. 分包测试说明

| 包 | 有无测试 | 测什么 | 备注 |
|---|---|---|---|
| `internal/auth` | ✅ | 凭证文件加载（`vk_`/`vs_` 前缀、0600）+ HMAC 签名 | 消费 `contracts/agent-signature.json` |
| `internal/config` | ✅ | config.yaml 严格校验（未知键拒绝、失败安全） | |
| `internal/metric` | ✅ | 指标全名拼接与维度转义 | 与中心同源消费 `contracts/metric-names.json` |
| `internal/model` | ✅ | 上报体本地校验 | 消费 `contracts/wire/*.json` 黄金报文 |
| `internal/prober` | ✅ | ping 校验和/降级、http/tcp 探活、错误分类 | Windows 上有 2 处**预期 skip**，见 §4 |
| `internal/reporter` | ✅ | 组包→签名→gzip→重试→超限裁剪 | 另有真机 E2E（§7） |
| `internal/collector` | ❌ 待补 | `/proc` 解析、速率、降级、过滤 | **A-T06**；夹具已备好（`testdata/proc/**`，21 个文件），设计上**任何平台可测**（`ProcRoot` 注入） |
| `internal/scheduler` | ❌ 待补 | 调度/心跳节流/热重载/自监控 | **A-T07** |
| `internal/logging` | ❌ 待补 | 日志格式 + ⛔ 日志不泄凭证红线 | **A-T08** |
| `internal/ulid` | ❌ 待补 | 幂等键单调/唯一/字符集 | **A-T08** |
| `cmd/agent` | ❌ 待补 | `--version` / `--check` 正常与失败路径 | **A-T08** |

## 4. Windows 开发机上的预期行为（不是故障）

| 现象 | 原因 | 处置 |
|---|---|---|
| `TestPingNoAnswerIsResultNotDegradation` 显示 `SKIP` | 用本地 UDP 模拟 ICMP socket 依赖 Linux 对「UDP socket + IPAddr 目标」sendto 的容忍行为；Windows 在写侧直接 `WSAEINVAL`，测不到读超时语义 | 正常，非 Linux 固定 skip（用例内有注释） |
| `TestHTTPProbeDNSFailure` 显示 `SKIP`（提示"疑似劫持/拦截"） | 本机 DNS/安全软件把 `.invalid` 域名也解析成功，拿到 HTTP 响应而非解析失败 —— 是环境属性 | 正常；用例检测到"收到响应"即自检跳过，**Linux CI 上会真实执行断言** |
| 日志出现 `非特权 ICMP 不可用…将自动降级为 TCP 探测` WARN | Windows 无非特权 ICMP（`ping_other.go` 占位实现），走降级路径正是被测行为 | 正常；Linux 上取决于 `net.ipv4.ping_group_range` |
| `go build ./cmd/agent` 能过，但运行立即退出并提示"本平台暂不支持采集" | `collector.Supported=false`（M1–M5 只做 Linux，✅ §13.3），启动即拒绝是设计行为 | 在 Windows 上只跑单测，不运行二进制 |

## 5. 定向调试

```powershell
# 单个包
go test ./internal/prober/ -count=1 -v

# 单个用例（-run 接正则）
go test -run 'TestICMPChecksum|TestSplitHostPort' ./internal/prober/ -v

# 覆盖率（HTML 报告；cover.out 用完即删，⛔ 不提交）
go test ./internal/prober/ -coverprofile=cover.out
go tool cover -html=cover.out
```

## 6. 交叉编译验证（不切机器验证 Linux 可构建）

```powershell
cd agent
$env:CGO_ENABLED="0"; $env:GOOS="linux"; $env:GOARCH="amd64"
go build -trimpath -ldflags "-s -w" -o vantage-agent-linux-amd64 ./cmd/agent
Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED
```

期望：产出约 **7.3MB** 单文件静态二进制（✅ `docs/agent.md` §10 定位）。
产物是构建验证品，**不要提交**（已在 `.gitignore` 的 `dist/` 之外，放临时目录更稳妥）。

## 7. 真机端到端（必须 Linux；对应待办 A-T09，尚未执行）

Windows 开发机**跑不了**这一节（`Supported=false`）。在 Linux 真机上：

```bash
# ① 编译（开发机交叉编译后 scp，或真机上直接 go build）
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o vantage-agent ./cmd/agent

# ② 配置与凭证校验（不发任何网络请求）
./vantage-agent --config /etc/vantage/config.yaml --check

# ③ 单次采集上报（与常驻模式完全同一条代码路径）
./vantage-agent --once --print-body   # ⛔ --print-body 只打印指标报文，断言其中不含 key/secret

# ④ E2E 测试（连真实中心；需要一套真实凭证）
VANTAGE_E2E_CENTER=http://<center>:8787 \
VANTAGE_E2E_AGENT_ID=<uuid> \
VANTAGE_E2E_KEY=vk_... \
VANTAGE_E2E_SECRET=vs_... \
  go test -count=1 -run TestE2E -v ./internal/reporter/
```

验收与留痕要求见 [`docs/agent-todo.md`](agent-todo.md) A-T09：跑完把日期/中心版本/字节数/`server_ts`
记入 [`docs/agent-status.md`](agent-status.md)，并清理联调用的 Agent 凭证与数据。

## 8. 跨语言契约测试（中心侧，Windows 可跑）

Agent 与中心的接口一致性由 `contracts/` 的共享向量保证，中心侧全量回归：

```powershell
cd D:\phpstudy_pro\WWW\Vantage\server
npm install --cache .npm-cache     # 仅首次；沙箱内必须把 cache 放工作区
npm test                           # 期望：0 failed（允许 live 用例 skip）
```

关键用例：
- `test/agentwire.test.js` —— 把 Agent 产出的**线上黄金字节**（`contracts/wire/*.json`）送进真实链路
  （gzip → 验签 → schema → 摊平 → 落库），全部通过 = 两侧报文契约是通的；
- `test/sign.test.js` —— 逐字节消费 `contracts/agent-signature.json` 验证 canonical 拼法。

**改了上报结构 / 签名 / 指标命名之后，两侧测试都必须跑**（`contracts/README.md` 的流程）。

## 9. 真机联调数据（中心侧 live 用例，可选）

需要本机可连的 PG 16 + Redis 7（`deploy/docker-compose.yml`），会写测试数据并自动清理：

```powershell
cd server
$env:VANTAGE_LIVE_TEST='1'; npm test    # PowerShell
```

配套发一套联调凭证：`node scripts/create-agent.js --name web-01 --tag prod`（明文只显示一次）。

## 10. 测试红线（写新测试前必读）

1. ⛔ 测试文件里只能出现文档用的保留地址（`203.0.113.x`、`example.com`、`127.0.0.1`）
   与明显是假的凭证 —— **测试随仓库公开**（README §2）；
2. ⛔ 新增失败用例不许靠改断言变绿：定性（环境属性 → 明确 skip 并注释；真缺陷 → 修实现）、
   修不了的登记进 [`docs/agent-todo.md`](agent-todo.md)；
3. ⛔ 速率类指标的测试必须注入时钟（`clock` 字段），不能真 sleep、不能拿配置周期当分母（A-T06 验收）；
4. ⛔ 日志类测试必须断言输出**不含 key/secret**（含截断形式）（A-T08 验收）；
5. 跑完覆盖率/临时产物（`cover.out`、交叉编译二进制）即删，⛔ 不进 git。

## 11. 相关文档

| 想了解 | 读这里 |
|---|---|
| Agent 行为契约 | [`docs/agent.md`](agent.md) |
| 现在做到哪了 | [`docs/agent-status.md`](agent-status.md) |
| 还差什么 | [`docs/agent-todo.md`](agent-todo.md) |
| 本次改了什么 | [`docs/agent-changes-2026-10-01.md`](agent-changes-2026-10-01.md) |
| 两侧共享契约怎么用 | [`contracts/README.md`](../contracts/README.md) |
| 中心服务怎么跑 | [`server/README.md`](../server/README.md) |
