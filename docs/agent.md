# Vantage Agent 文档（vantage-agent，Go）

> **来源**：由《Vantage-DESIGN-v0.7.md》拆分的**被监控端专项文档**。
> **适用对象**：Agent 开发者、负责在被监控机安装/运维的工程师。
> **文档性质**：行为契约（采集 / 探活 / 上报 / 鉴权 / 配置 / 资源 / 运维），**不含实现代码**。
> **上位文档**：`Vantage-DESIGN-v0.7.md`（**文件内容已是 v0.8**，文件名保留以维持引用；§2.1、§4、§6、§12 为主）；上报字段以 `docs/api.md` §2 为准，指标与单位以 `docs/database.md` §5.7.2 为准。
> **阅读约定**：本文中的「✅ 本轮决策 / 本轮已定」= 2026-09-26 Owner 拍板，**均已写入设计文档 v0.8**；逐条对照见 `docs/design-deltas.md`。
> **进度与待办**：现在做到哪了见 [`docs/agent-status.md`](agent-status.md)，还差什么见 [`docs/agent-todo.md`](agent-todo.md)；口径冲突时以本文为准。

**标注图例**

| 标记 | 含义 |
|---|---|
| ✅ 已定 | 直接来自设计文档，不得擅自更改 |
| ➕ 建议 | 拆分时补齐的工程细节，**需 Owner 确认** |
| ❓ 待拍板 | 设计文档未定或存在冲突 |
| ⛔ | 禁止项（违反单向宗旨即视为重大缺陷） |

---

## 1. 定位与不可违背的约束

### 1.1 定位（✅ §0、§3）
- 二进制名 **`vantage-agent`**，Go 1.22+，**单文件静态二进制**，跑在每台被监控机的**宿主机**上（非容器，✅ 决策 #13）。
- 职责：采集 → 本地探活 → 组包签名 → **出站**上报。**没有第二个职责，也没有控制面接口。**

### 1.2 ⛔ 单向通信宗旨（最高优先级，✅ §2.1、决策 #12/#8）
1. **配置只在本地**：中心地址、采集项、频率、探活目标、过滤规则、日志级别等**全部**由本机 `config.yaml` 决定；中心**无法覆盖、无法远程修改**。
2. **中心对 Agent 零写权限**：不存在「下发配置 / 远程执行 / 重启 / 改频率 / 改探活目标」的任何路径；响应体也不携带可执行字段。
3. **响应体极简**：只判断 `{ ok, server_ts }`；⚠️ **不得**从响应中解析并执行任何内容（即便将来中心误加字段，Agent 也必须忽略）。
4. **改配置只能上机**：唯一路径 = 登录目标机改 `config.yaml`（+ `reload`/`restart`），见 §7 与 §9。
5. **Agent 只发起出站连接**，不监听任何端口、不接受任何入站连接（✅ §4.4）。

> 任何「让 Agent 读中心配置」「响应里带权重/开关」的实现都属于**重大设计违规**，即使用户/运维要求也需先改设计文档。

---

## 2. 模块划分（✅ §4.1 + ➕ 补齐）

| 模块 | 职责 | 关键点 |
|---|---|---|
| `cmd/agent/main.go` | 启动、信号处理、优雅退出 | 监听 `SIGHUP`（§9）；`--check` 只校验配置与凭证、`--once` 单次采集上报（联调用） |
| `internal/config/` | 读取、校验 `config.yaml` | 校验失败**保留旧配置**（✅ 决策 #34）；校验规则见 §8 |
| `internal/collector/` | 采集器统一接口 | `cpu` `mem` `disk` `net` `gpu` `process`（`docker` 预留，✅ §4.2）；⚠️ 实现为 **Linux 直读 `/proc`**（零第三方采集依赖，非 gopsutil —— §3 表中的 gopsutil 数据源为早期口径，收窄见待办 A-T25） |
| `internal/prober/` | 本地探活 `ping` / `http` / `tcp` | 目标来自本机配置，结果上报（✅ §4.6） |
| `internal/scheduler/` | 采集与探活调度 | 不同任务不同频率，事件驱动 sleep（✅ §4.5） |
| `internal/reporter/` | 组包 / gzip / 签名 / 上报 / **内存重试** | 只序列化一次（✅ 决策 #35）；重试**内联于本包**（仅当前批次，⛔ 不落盘，✅ 决策 #14） |
| `internal/auth/` | 加载本机 key/secret，生成 HMAC 签名 | key **不经命令行**（✅ 决策 #37） |
| ~~`internal/retry/`~~ | ~~内存级重试（仅当前批次）~~ | ⛔ **实际无此包**：重试逻辑内联在 `internal/reporter/`（约 `send` 一段），只重试当前批次、⛔ 不做跨断网的持久化补传（✅ 决策 #14）——早期设计列了独立包，落地时并入 reporter |
| ~~`internal/buffer/`~~ | ✅ **已定（本轮）：删除该模块** | 设计 §11.2 列的「离线环形缓存（有上限）」与决策 #14/§4.7「不缓存不补传、磁盘占用 ≈ 0」冲突 → 删除；重试只在 `internal/reporter/` 内存中完成 |
| `internal/metric/` | 指标全名拼接与维度转义 | 消费 `contracts/metric-names.json`，与中心同源测试向量（§3 命名硬契约） |
| `internal/model/` | 上报体 / 心跳结构与本地校验 | 消费 `contracts/wire/*.json` 黄金报文 |
| `internal/ulid/` | `batch_id`（幂等键）生成 | 单调、同毫秒不重复（§5.2） |
| `internal/logging/` | slog 日志（text/json、文件轮转） | ⛔ 日志不得出现 key/secret（§12.3） |
| `internal/version/` | 版本号，进 `User-Agent` 与日志 | 便于排障 |

---

## 3. 采集器规格（✅ §1.2、§4.2）

| 采集器 | 数据源 | 产出指标（命名/单位见 `docs/database.md` §5.7.2） | 默认周期 |
|---|---|---|---|
| `cpu` | `gopsutil/cpu.Percent` + `Load` | `cpu.usage`、`cpu.core.usage{core=<n>}`、`cpu.load1/5/15`、`cpu.ctx_switch` | 15s |
| `mem` | `mem.VirtualMemory()`、`SwapMemory()` | `mem.total/used/available/cached/buffers`、`mem.used_pct`、`swap.*` | 15s |
| `disk` | `disk.Partitions()` + `disk.Usage()`；IO 读 `/proc/diskstats` | `disk.total/used/used_pct`、`disk.inode_used_pct`、`disk.read_bps/write_bps`、`disk.read_iops/write_iops`、`disk.latency_ms`（维度 `{device,mount}`，如 `disk.used_pct{mount=/}`） | 30–60s |
| `net` | `net.IOCounters(pernic=true)`；连接数按平台实现 | `net.rx_bps/tx_bps`（速率=差值/时间）、`net.rx_total/tx_total`、`net.conn_count`、`net.err/drop`（维度 `{device}`，如 `net.rx_bps{device=eth0}`） | 15s |
| `gpu` | NVIDIA：`nvidia-smi --query-gpu ... --format=csv`；AMD：`rocm-smi`（预留） | `gpu.util`、`gpu.mem_used/mem_total`、`gpu.temp`、`gpu.power`（维度 `{index}`，如 `gpu.util{index=0}`） | 10–15s |
| `process` | `process.Processes()` | `process.count` + Top-N（`{pid,name,cpu,mem}`，建议 N=10）+ 关键进程白名单存活 | 30–60s |
| `docker`（预留） | 读 `docker.sock`（需用户加入 docker 组，非 root 可用） | 本期恒定 `null`（✅ §4.2、决策 #13） | — |

> ⚠️ **序列命名是 Agent 与中心的硬契约（✅ 本轮决策：维度写进指标名）**：Agent 侧必须按 `docs/database.md` §5.7.2 的规则（维度键字母序、`%`/`{}`/`=`/`,`/空白的百分号转义、无维度不带花括号、全名 ≤ 200 字符）拼出 `metric` 全名，与中心用**同一套测试向量**对齐；拼错的直接后果是中心 schema 校验拒绝（400）或写成一条无人读的孤立序列。同时上报的 `labels` 仅作便利副本。

**采集共性要求（✅ §4.2、§4.3）**
- 单次采集耗时目标 **< 50ms**（GPU 调用除外）；避免每周期新建大对象（复用 buffer/结构体）。
- 缺权限/工具缺失（GPU 工具不存在、`docker.sock` 不可读）→ **优雅降级 + 明确日志**，⛔ 绝不崩溃（✅ §4.4）。
- 不支持的指标在**能力声明**中标记并**置空/省略**而非报错（✅ §4.9），如 Windows 无 inode、macOS 基本无 NVIDIA GPU。✅ 已定（本轮）：能力声明放上报体 **`host.capabilities`**（布尔键值，键集合见 `docs/api.md` §2.1），**首次上报与能力变化时必填**、其余可省；⛔ 白名单外的键会被中心拒绝。
- 设备名/挂载点建议统一小写（维度值区分大小写，`Eth0` 与 `eth0` 会是两条序列）。
- 时钟：采集时间戳可用本机时间，但**上报的权威时间由中心决定**；本机可配是否用 `server_ts` 校正自身展示/探活记录时间（默认开，✅ §6.5）。

---

## 4. 本地探活（prober，✅ §4.6）

**设计前提**：中心不能下发命令 → **探活目标只能在 Agent 本地配置**。

| 类型 | 实现要点 |
|---|---|
| `ping` | 优先**非特权 ICMP**（IPv4 udp4 "ping" socket / `golang.org/x/net/icmp`）；无权限或环境不支持时降级：① 退化为 `tcp` 连通探测（并记日志提示）；② 可选 `setcap cap_net_raw+ep`（**opt-in**，非必需，✅ §4.4） | ✅ 已定降级策略（本轮）：非特权 ICMP 不可用时**自动降级为 TCP 探测并打 WARN**（⛔ 不静默降级、⛔ 不因此崩溃）；`setcap` 仅作为文档给出的 opt-in 手段 |
| `http` / `https` | 方法、期望状态码集合、可选 `body_contains`；记录延迟与状态码；支持超时 |
| `tcp` | 连接建立耗时；不发送业务数据 |
| `dns`（可扩展） | 预留类型 |

**上报字段**（见 `docs/api.md` §2.1 `probes[]`）：`name`、`type`、`target`、`up`、`latency_ms`、`status_code`、`error`。
**闭环（✅ §4.6）**：中心只存结果 + 判定 + 告警；用户新增探活 = 登录目标机改 `config.yaml` 的 `probes:` → `reload`/`restart` → 新结果随下次上报出现。

---

## 5. 上报管线（reporter，✅ §6.2、§6.6、§10.1、决策 #18/#19/#35）

### 5.1 单次上报顺序（严格不可调换）

```
1) 组包（batch_id = 新 ULID；ts = 本机 unix ms；seq++；host + metrics + probes）
2) JSON 序列化 —— 只做一次，得到 raw_bytes
3) sha256_hex(raw_bytes)
4) canonical = "POST\n/api/v1/agent/report\n" + ts + "\n" + nonce + "\n" + sha256_hex(raw_bytes)
   signature  = hex(HMAC_SHA256(secret, canonical))
5) gzip(raw_bytes)                     ← 压缩仅作传输层，不参与签名
6) POST，头：X-Agent-Id / **X-Agent-Key** / X-Timestamp / X-Nonce / X-Signature / Content-Encoding: gzip
7) 判断 2xx 与 {ok:true}；失败进入内存重试（§5.2）
```

⛔ **绝不能**先 `JSON.parse` 再重新序列化来算签名（字段顺序/空格会变，导致验签失败）——✅ 决策 #35「签名用的字节与发送的字节同源」。

### 5.2 幂等、重试与丢弃（✅ 决策 #18、§4.7）

| 项 | 规格 |
|---|---|
| 幂等键 | `batch_id`（ULID，每批唯一）；中心 Redis `SETNX batch:<id>`，TTL 10min，重复批次直接忽略 |
| 重试 | **仅内存**、仅当前批次：如最多 3 次、指数退避（2s→4s→8s）、总耗时上限 ~30s（➕ 建议值） |
| 仍失败 | **丢弃该批**，继续下一周期；⛔ 不写磁盘、不留缓存 |
| 进程重启 | 不保留断网期间数据（✅ §4.7） |
| 数据缺口 | 由中心的**离线告警**覆盖（超 3×周期无数据判离线）；恢复联网后**不补旧数据**，从当前时刻重新上报 |
| 心跳 | 无变更时可只报心跳（✅ §4.3）：`POST /api/v1/agent/heartbeat`（`docs/api.md` §2.2） |
| 过期上报 | 中心会丢弃中心接收时间迟于 6h 的批次（建议值）；Agent 侧无需处理 |

### 5.3 网络与体积（✅ §4.3；✅ 本轮已定具体阈值）

- 批量 + gzip，**单次上报目标 < 20KB**；无变更时仅心跳。
- ✅ **单批压缩前上限 256KB**（`report.max_batch_bytes`）：超限时按顺序裁剪——① `process.top` 截半 → ② 丢弃 GPU 次要指标（`power`/`temp`）→ ③ 丢弃 `net.err/drop`、`disk.latency_ms` 等次要指标；仍超限则**丢弃该批并记日志**（不重试，避免放大网络故障）。
- ✅ 重试：**最多 3 次**、退避 **2s 起指数**（2/4/8s）、**总时长 ≤ 30s**；仍失败即丢弃（见 §5.2）。
- 中心侧上限（压缩前 1MB / 解压后 4MB）高于 Agent 侧阈值，因此正常情况下 Agent **不应**因体积被拒（出现 413 说明 Agent 侧熔断逻辑失效）。
- 全链路 HTTPS（✅ §6.3）；证书校验默认开启；mTLS 可选（提供 `cert/key` 配置）。
- 出站目标**只有中心**（建议配合主机防火墙出站白名单，✅ §13）。
- 超时与连接复用：建议 `timeout: 10s` + Keep-Alive 复用连接，避免每周期重建 TLS。

---

## 6. 鉴权与凭证（auth，✅ §6.1、§6.2、决策 #37）

### 6.1 凭证来源（⛔ 仍禁 `--key` 参数；✅ 本轮修订 #37：面板默认给 env 形式的一键命令）

**加载优先级（✅ 决策 #37 + ✅ 本轮修订）**

| 顺序 | 方式 | 说明 |
|---|---|---|
| 1 | **交互式输入 / stdin** | **最安全**（不进 shell history、不进 `/proc/$PID/cmdline`、不进 `environ`）；面板命令里也提供该形式 |
| 2 | `VANTAGE_KEY` / `VANTAGE_SECRET` 环境变量 | ✅ **本轮修订：面板默认给出一键命令即用此形式**（方便复制即用）；⚠️ 代价：会进 shell history，且 root 可经 `/proc/$PID/environ` 读取 → 脚本落地 key 文件后**立即 `unset VANTAGE_KEY`**，用户执行完建议 `history -d` 清理 |
| 3 | `--key-file` / 配置 `key_file`（`chmod 600`、归运行用户） | 长期运行的推荐落地方式；面板同时提供该形式的命令 |

⛔ **永久红线（修订后依然保留）**：**不允许 `--key <明文>`、`--secret <明文>` 等把密钥放进进程命令行的形式**（`ps` / `/proc/$PID/cmdline` 对同机低权用户可见）。本轮修订只放开「**环境变量内联**」这一种便捷形式，且必须在脚本内即时清理。

> ⚠️ 修订记录：设计 §12.2 / §15 决策 #37 原文为「**禁用**命令行（含 env）以外的一切便捷传递，优先交互式/stdin」。本轮按 Owner 决定放宽为：**面板可给带 `VANTAGE_KEY` 的一键命令**，同时**仍禁止 `--key` 参数**，并保留交互式/stdin 与 `--key-file` 两种更安全形式。设计文档 §12.2、§13 安全清单需同步这一措辞。

**凭证轮换：中心不做并存，必须人工替换（✅ 本轮决策）**

| 项 | 规格 |
|---|---|
| 触发 | 仅管理员在面板显式执行（⛔ 无自动轮换；中心只做「到期提醒」，见 `docs/database.md` §5.2） |
| 失效 | 轮换后**旧凭证立即失效**（⛔ 无新旧并存过渡期），Agent 随即收到 401 |
| 运维动作 | 把新 key/secret 写入受限文件（`chmod 600`）→ `vantage.sh reload`（优先，避免误判离线）或 `restart`；⛔ 不得经命令行传 key（决策 #37） |
| 代价 | 替换窗口内数据按丢弃式策略**永久缺失**（✅ 决策 #14），且中心会判离线并告警 → 建议在维护窗口执行 |
| ⛔ 红线 | Agent 侧**不存在**「自动获取新凭证」「从中心拉 key」「响应里带新凭证」的逻辑（单向宗旨 ✅ §2.1） |

### 6.2 签名（✅ §6.2；✅ 本轮已定分隔符）

```
canonical = "POST" + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256_hex(raw_body)
signature = hex(HMAC_SHA256(secret, canonical))
```

- ✅ 已定：**固定 `\n`（LF，0x0A）分隔 4 处、末尾不加换行**，与 `docs/api.md` §2.1 逐字节一致；`path` 仅路径（⛔ 不含 host/query）；`timestamp` 为十进制 ASCII unix **毫秒**；`nonce` 建议 ≥ 16 字节随机（32 hex）原样放入 canonical。
- ⛔ **必须配共享测试向量**（固定 secret/body/ts/nonce → 期望签名值），两端各跑一遍，避免「实现都对但拼法不同」这类难查的 401。
- 🔐 **两份凭证分工（✅ 本轮修订）**：`X-Agent-Key`（`vk_` 前缀）用于**身份**校验，`agent_secret`（`vs_` 前缀）只用于算 HMAC、**不上行**；两者都从受限文件加载（⛔ 不进命令行，决策 #37）。中心侧 secret 以密文存储（`agent_secret_enc`），因为验签需要重算。
- ⚠️ **时钟必须准**：中心签名窗口默认 **300s**（可收紧 60s，**硬上限 5min**）。漂移 > 5min 一律拒收（`timestamp_skew`），2 分钟级漂移在默认策略下会被接受并触发 `clock_drift` 告警（✅ 决策 #17）。
- 与本机时间相关的运维动作：启用 NTP/chrony；漂移告警出现时执行 `timedatectl` 校准（✅ §6.5）。

### 6.3 权限边界（✅ §6.4）

- Agent **只能写自己的数据**；`agent_id` 与签名凭证强绑定，⛔ 不得上报他机数据。
- ⛔ 不得实现「读取响应中的配置并应用」的逻辑；响应仅 `{ok, server_ts}`。

---

## 7. 配置热重载（SIGHUP，✅ §4.10 / 决策 #34）

| 项 | 规格 |
|---|---|
| 触发 | 收到 **`SIGHUP`**（systemd `ReloadSignal=SIGHUP`） |
| 动作 | 重新读取 `config.yaml` → **完整校验** → **原子替换**内存配置（指针切换，读侧无锁）→ **保留进程、TCP 连接与鉴权/签名状态** |
| 失败安全 | 校验不通过 → **保留旧配置** + 记日志 + 上报 `config_reload_failed` 告警；⛔ 绝不进入半配置状态 |
| 管理入口 | `vantage.sh reload`（= `systemctl reload vantage-agent`），与 install/upgrade 等统一 |
| 解决的问题 | 避免 `restart` 造成短周期下反复上下线 → **误触离线告警**（离线阈值 ≈ 3×周期）+ **曲线断层** |
| 范围 | ✅ 热重载适用于 Linux（systemd）；Windows/macOS（M6）用各自机制 |
| ⛔ | 重载**只读本地文件**；不存在「从中心拉配置」的路径（单向宗旨） |

➕ 建议：`reload` 成功/失败都写一条明确的 INFO/WARN 日志（含生效的关键配置摘要，但**不得**打印 key/secret）。

---

## 8. `config.yaml` 字段参考（❓ 具体字段名为 ➕ 建议，设计仅给出 `probes` 示例）

```yaml
center:
  url: "https://vantage.example.com"   # 必填；仅出站
  timeout: 10s
  tls:
    ca_file: ""                        # 自签/内网 CA 时使用
    insecure_skip_verify: false        # ⛔ 默认 false，生产禁止 true
    cert_file: ""                      # mTLS 可选
    key_file: ""

agent:
  id: "<uuid>"                         # 由中心创建时生成
  key_file: "/etc/vantage/agent.key"   # chmod 600
  secret_file: "/etc/vantage/agent.secret"

host:
  alias: "web-01"                      # 可选本地别名
  tags: ["prod", "bj"]

collect:
  cpu:     { enabled: true,  interval: 15s, per_core: true }
  mem:     { enabled: true,  interval: 15s }
  disk:    { enabled: true,  interval: 60s }
  net:     { enabled: true,  interval: 15s }
  gpu:     { enabled: true,  interval: 15s, provider: nvidia }
  process: { enabled: true,  interval: 60s, top_n: 10, watch: ["sshd", "nginx"] }
  docker:  { enabled: false }          # 预留，本期不实现

report:
  interval: 15s                        # 上报周期（中心离线阈值 ≈ 3×）
  heartbeat_interval: 60s              # 无变更时只报心跳
  gzip: true
  gzip_level: 6
  max_batch_bytes: 262144              # ✅ 已定：256KB（压缩前）；超限裁剪顺序见 §5.3
  retry: { max_attempts: 3, backoff: 2s, max_elapsed: 30s }   # ✅ 已定（本轮）

probes:                                # ✅ 设计 §4.6 给出示例结构
  - name: "site-health"
    type: http
    url: "https://example.com/healthz"
    method: GET
    expect_status: [200]
    body_contains: "ok"                # 可选
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

filters:                               # ✅ §4.8：Agent 端默认过滤，本地可覆盖
  disk:
    exclude_fs: ["tmpfs","devtmpfs","proc","sysfs","overlay","squashfs","cgroup","cgroup2","devpts","autofs","ramfs"]
    include_mounts: []                 # 白名单优先（如 ["/","/data"]）
    exclude_mounts: []
  net:
    exclude_devices: ["lo","docker*","veth*","br-*","virbr*"]

clock:
  use_server_ts: true                  # ✅ §6.5：用中心时间校正自身展示/探活记录时间

resource:
  gomemlimit_mb: 48                    # ✅ §4.3：内存封顶

log:
  level: info                          # debug/info/warn/error
  file: "/var/log/vantage/agent.log"
  max_size_mb: 16
  max_backups: 3
  format: text                         # ✅ 已定：默认 text，可切 json（便于外部采集）
```

**校验规则（✅ §4.10「重新读取 + 校验」）**
- ✅ 已定（本轮）：`center.url` 必须为 `https://`；仅**测试环境**可通过显式开关 `center.allow_insecure_http: true`（默认 `false`）使用 http，且启动时打印醒目 WARN；生产 ⛔ 不允许；
- `agent.id` 必须为合法 UUID；key/secret 文件必须存在且**权限为 600**（否则 WARN + 拒绝启动/重载）；
- 各 `interval` 下限（建议 ≥ 5s，避免自伤）；`probes[].name` 唯一；`type` 在允许集合内；
- ✅ 已定（本轮）：**未知字段一律拒绝**（启动即失败、`reload` 则保留旧配置），错误信息须指出未知键的完整路径——避免拼写错误静默生效；
- 校验失败：进程启动时退出并打印原因；`reload` 时保留旧配置（§7）。

---

## 9. 非 root 运行与系统加固（✅ §4.4、§12.2）

| 项 | 要求 |
|---|---|
| 运行用户 | 默认**不要求 root**，以专用低权用户（如 `vantage`）运行 |
| 权限 | 不监听 < 1024 特权端口；不写系统目录；数据/缓存写在用户可写目录 |
| ICMP | 优先非特权 ICMP；不可用时降级为 TCP 探测或 opt-in `setcap cap_net_raw+ep`（✅ §4.4） |
| systemd 加固 | `User=vantage`、`NoNewPrivileges=true`、`ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`、`ReadWritePaths=<数据目录>`、`ReloadSignal=SIGHUP` |
| 日志 | 输出到 `journald` 或受限日志文件；⛔ 不打印 key/secret |
| 文件权限 | key/secret 文件 `chmod 600`，属运行用户 |
| 出站白名单 | ➕ 建议文档给出防火墙示例（仅放行中心地址） |

---

## 10. 资源预算（硬指标，✅ §4.3）

| 维度 | 目标 | 手段 |
|---|---|---|
| 内存 | 空闲 **< 20–30MB**；`GOMEMLIMIT`（如 48MB）封顶 | 避免每周期新建大对象；复用缓冲 |
| CPU | 空闲 **< 0.5%**；单次采集 **< 50ms**（GPU 除外） | 事件驱动 sleep，**无忙轮询**；批次间让出 |
| 磁盘 | **≈ 0**（不做补传缓存） | ✅ 断网丢弃式（决策 #14） |
| 网络 | 单次上报 **< 20KB**，批量 + gzip；无变更只报心跳 | |
| 二进制 | 静态编译单文件，无运行时装依赖 | |
| 并发 | 固定少量 goroutine（每采集器 1 条 + 上报 1 条），**不随主机规模膨胀** | |

✅ 已定（本轮）：**内置最小自监控集**——`agent.mem_rss`（内存占用）、`agent.report_failures`（上报失败计数）、`agent.reload_ok`（最近一次 SIGHUP 结果）随上报发出，便于尽早发现「监控系统自身把机器压垮」或配置反复重载失败；⚠️ 需把这几个指标名加入中心的 schema 白名单与 `docs/database.md` §5.7.2 指标表。

---

## 11. 待 Owner 拍板清单（Agent 视角）

### 11.1 ✅ 本轮已拍板

| # | 议题 | 结论 | 落点 |
|---|---|---|---|
| G1 | `internal/buffer/` 与「不补传」冲突 | **删除该模块**，Agent 无任何磁盘缓存；重试仅由 `internal/retry/` 在内存完成 | §2、§5.2、§10 |
| G2 | 上报体积上限、重试次数/退避/总时长 | 中心 1MB/4MB（压缩前/解压后）；Agent 单批 **256KB** 熔断（裁剪顺序见 §5.3）、重试 **3 次 / 2s 起指数 / ≤30s** | §5.3、§8 |
| G5 | `capabilities` 能力声明位置 | ✅ **放进上报体 `host.capabilities`**（首次与能力变化时必填）；中心落 `agents.capabilities`，面板据此隐藏不支持的图表/列；键集合见 `docs/api.md` §2.1 | §3、`docs/api.md` §2.1 |
| G9 | `uninstall` 是否删除配置与日志 | ✅ **默认保留**（配置/key/日志），只停服务并删二进制与 unit；**`--purge` 才彻底删**（交互确认） | §12.1 |
| G3 | `report.interval` 默认值 | ✅ **30s**（⚠️ 2026-10-04 校正：原写 15s，但 `agent/internal/config/config.go` 的 `defaultConfig()` 在 G3 修订中已改为 **30s**，采集周期随之对齐 —— cpu/mem/net/gpu 30s、disk/process 60s；中心离线阈值随之从 ≈3×15s 变为 **≈3×30s = 90s**）。⚠️ `heartbeat_interval` 默认 **60s**：纯心跳的最坏上报间隔是 60s 而非 30s | §8 |
| G4 | 无 GPU 机的采集行为 | ✅ **恒定为跳过**：不报错、日志记 debug、⛔ 不进上报体；`capabilities.gpu.*` 置 false | §3、§8 |
| G6 | 是否允许 http（非 TLS）中心地址 | ✅ **仅测试环境**，需显式 `center.allow_insecure_http: true`（默认 false）且启动打 WARN；生产强制 https | §8 |
| G7 | 未知配置字段 | ✅ **拒绝**（启动失败 / `reload` 保留旧配置），错误信息指出未知键路径 | §8 |
| G8 | 探活 `ping` 降级策略 | ✅ 非特权 ICMP 不可用时**自动降级为 TCP 并 WARN**（不静默）；`setcap` 仅 opt-in | §4 |
| G10 | Agent 自监控 | ✅ 内置最小集：`agent.mem_rss`、`agent.report_failures`、`agent.reload_ok`（需加入中心 schema 白名单与指标表） | §10 |
| G11 | 日志格式 | ✅ 默认 `text`，可切 `json` | §8 |

### 11.2 仍待拍板

✅ **本清单已清空**：Agent 侧全部议题（G1–G11）均已拍板，见 §11.1。后续若发现新议题，在 §11.1 继续累计。

---

## 12. 安装、管理与排障（✅ §12.2–12.4、决策 #24/#25/#37）

### 12.1 `vantage.sh` 统一脚本（✅ 决策 #24）

| 子命令 | 说明 |
|---|---|
| `install` | 下载二进制 → **校验 sha256**（能签名更好）→ 写入受限配置目录 → 创建低权用户 → 安装 systemd unit → 启动 |
| `upgrade` | 下载新版本（GitHub Releases/镜像）→ 校验 → 替换二进制 → `restart`（**配置保留**，✅ §12.4） |
| `uninstall` | 停服务 + 移除 systemd unit 与二进制；✅ 已定（本轮）：**默认保留配置、key/secret 与日志**并打印保留路径，彻底清理需 `uninstall --purge`（需交互确认，删除前提示将丢失凭证与采集配置） |
| `start` / `stop` / `restart` / `status` | 常规控制 |
| `reload` | = `systemctl reload vantage-agent`（触发 SIGHUP，✅ 决策 #34） |

**安装参数（✅ §12.2、决策 #37 + ✅ 本轮修订）**

```bash
# 形式①：面板默认给出的一键命令（env 内联，复制即用）——⚠️ 会进 shell history
# ⚠️ 2026-10-04 校正：**两个凭证都要传**（secret 用于 HMAC 验签，缺了它 Agent 通不过签名校验）。
VANTAGE_KEY=<key> VANTAGE_SECRET=<secret> sh -c 'curl -fsSL https://<github-or-mirror>/vantage.sh | sudo -E sh -s -- install \
  --center https://vantage.example.com --agent-id <uuid> [--version v0.1.0] [--source <mirror>]'

# 形式②：交互式 / stdin（最安全，面板也给出该形式）
curl -fsSL https://<github-or-mirror>/vantage.sh | sudo sh -s -- install \
  --center https://vantage.example.com --agent-id <uuid>      # 执行后交互提示输入 key 与 secret

# 形式③：key 文件（长期方案，0600）
  ... --key-file /etc/vantage/agent.key --secret-file /etc/vantage/agent.secret

# ⛔ 任何形式都不得使用 --key <明文> / --secret <明文>（ps / /proc/$PID/cmdline 可见）
```

- ⚠️ 使用形式①后：脚本把 key/secret 写入受限文件即 `unset VANTAGE_KEY`（与 `VANTAGE_SECRET`）并清理临时缓冲；建议用户执行 `history -d` 或按提示改用形式②/③。
- ⚠️ `--center` 的取值来自面板配置的 `PUBLIC_ORIGIN`（未配置时按当前请求推导，并会在 `install_hint.warnings` 里提醒）——见 `docs/api.md` §4.4。
- ✅ 安装完成后，采集项/频率/探活/过滤等**由用户手动编辑 `config.yaml`** 再 `reload`/`restart`（✅ §12.2）。
- ✅ 上线流程（§12.3）：中心建 Agent → 生成 key（明文仅一次，面板同时给一键命令与 key/secret 两份副本）→ 宿主机执行脚本 → 首次上报成功（面板出现该机 + 首次 IP）→ 按需编辑 `config.yaml` → 配置告警通道。
- ⛔ 中心**不参与分发、不推送**（§12.4）。

### 12.2 常见故障排查表（➕ 建议）

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 401 `signature_invalid` | secret 不匹配；**中间件改写了 body**（如反代二次压缩/改编码）；签名串分隔符与中心不一致 | 核对 secret、确认反代不改 body、统一 canonical 规范 |
| 原本正常但**突然持续** 401 `signature_invalid` | 管理员在面板做了**凭证轮换** → 旧凭证立即失效（✅ 本轮决策，`docs/database.md` §5.2） | 上机替换 key/secret 文件（`chmod 600`）→ `vantage.sh reload` |
| 401 `timestamp_skew` | 本机时钟漂移 > 5min | 启动 NTP/chrony，`timedatectl` 校准 |
| 409 `nonce_reused` | nonce 生成重复（随机源异常）或重放 | 检查随机源；确认非多进程共用同一批次 |
| 400 `schema_invalid` | 采集字段超范围/数组超长（如 up 了 300 个挂载点）；版本比中心新 | 对齐 `docs/api.md` §2.1 白名单；升级中心 |
| 413 `payload_too_large` | 挂载点/进程 Top 过大 | 收紧过滤规则或降低 `top_n` |
| 中心显示「离线」但机器正常 | Agent 出站被拦（防火墙/代理）；TLS 握手失败；上报周期被改大 | 查 Agent 日志与 `curl` 连通性；核对 `report.interval` 与离线阈值 |
| 曲线出现断层 | 配置 `reload` 失败（保留旧配置）或短时断网（丢弃式，不补传） | 查 `config_reload_failed` 日志；断网缺口属**预期行为**（✅ §4.7） |
| 出现 `clock_drift` 告警 | 本机时钟偏 > 60s | 校准时间；属「接受+修正+告警」策略的预期结果（✅ 决策 #17） |
| 探活全部 down | 非特权 ICMP 不可用（`ping` 类型）；目标确实不可达 | 看日志建议改用 `tcp`，或 opt-in `setcap`（✅ §4.4） |
| GPU 指标缺失 | 未安装 `nvidia-smi` / 无卡 | **属正常降级**（✅ §4.4），非故障 |
| reload 后仍按旧频率 | `config.yaml` 校验失败被拒；systemd unit 未设 `ReloadSignal` | 查看 reload 日志；核对 unit 配置 |

### 12.3 排障纪律
- ⛔ 日志、`--help`、错误信息中**不得**出现 key/secret（含截断形式）。
- ✅ 建议：`status` 子命令输出「运行中/版本/最后上报时间/最近错误码/生效配置摘要」，便于一眼定位。

---

## 13. 平台适配与跨平台路线（✅ §4.9、§17，决策 #29/#30）

### 13.1 适配层要求（✅ §4.9，从 M1 就按此写，避免返工）
- `collector/` 采用**接口 + 每 OS 一份实现**（Go 构建标签分发）：`cpu_linux.go / cpu_windows.go / cpu_darwin.go`。
- 每个采集器带**能力声明**：本平台支持哪些指标；不支持的**置空/省略**而非报错。
- 主机信息（`host.os` / `host.arch`）随上报，中心侧统计与展示可按平台区分（中心零改动，✅ §17.2）。

### 13.2 难度总览（✅ §17.1）

| 指标 | Linux | Windows | macOS |
|---|---|---|---|
| CPU / 内存 / 进程 | 🟢 | 🟢 | 🟢 |
| 磁盘容量 | 🟢 | 🟢 | 🟢 |
| 磁盘 inode | 🟢 | 🔴 无此概念（置空） | 🟡 平台 API |
| 磁盘 IO/延迟 | 🟢 | 🟡 性能计数器 | 🟡 IOKit/iostat |
| 网络速率/流量 | 🟢 | 🟢 | 🟢 |
| 网络连接数 | 🟢 | 🟡 不同 API | 🟡 不同 API |
| GPU(NVIDIA) | 🟢 nvidia-smi | 🟢 nvidia-smi | 🔴 基本没有 |
| GPU(Apple Silicon) | — | — | 🔴 难，先跳过 |
| Ping 探活 | 🟢 非特权 ICMP | 🟡 一般需管理员 | 🟡 可调系统 ping |
| 服务/守护 | 🟢 systemd | 🟡 Windows 服务 | 🟡 launchd |
| 安装脚本 | 🟢 sh | 🟡 PowerShell/NSIS | 🟡 launchd（可能需签名） |

### 13.3 路线（✅ §17.2）
- **Linux 优先**：M1–M5 只做 Linux；主干与安全模型在 Linux 全量验证。
- **Win/Mac 排到 M6**：只新增「采集器实现 + 安装脚本 + 服务/权限适配」，中心与上报格式不变。
- **工程量**：以 Linux 为 100%，Windows ≈ +40~60%，macOS ≈ +30~50%。

---

## 14. 里程碑（Agent 侧，✅ §14）

| 阶段 | Agent 产出 |
|---|---|
| M1 | `cpu/mem/disk/net/gpu/process` 采集 + 组包上报（未鉴权或简易鉴权）+ 出站通路 |
| M2 | key+HMAC 签名、TLS、限流/幂等配合、单向性复核（响应体只含 `{ok, server_ts}`） |
| M3 | 探活（ping/http/tcp）完整 + 告警相关字段（漂移、离线心跳） |
| M4 | GPU/进程完善、非 root 打磨、SIGHUP 热重载、`setcap` 文档 |
| M5 | Docker 采集（预留转正）、systemd 加固打磨 |
| M6 | Windows / macOS 采集器 + 各自安装脚本与 reload 机制 |

---

## 15. 与设计文档的对照（溯源）

| 本文位置 | 设计文档来源 |
|---|---|
| §1.2、§6.3 | §2.1 单向宗旨、§6.4 权限、决策 #12 |
| §2 | §4.1 模块划分、§11.2 目录（含 G1 冲突） |
| §3 | §1.2 监控项、§4.2 采集实现要点、§4.5 调度周期 |
| §4 | §4.6 探活闭环、§4.4 非特权 ICMP |
| §5 | §6.2 签名、§6.6 落地顺序、§10.1/§10.3 上报与幂等、§4.7 断网策略、§4.3 网络开销 |
| §6 | §6.1 凭证模型、§12.2 key 传递、决策 #37 |
| §7 | §4.10 热重载、决策 #34 |
| §8 | §4.6 `probes` 示例、§4.8 过滤、§6.5 `use_server_ts`、§4.3 `GOMEMLIMIT` |
| §9 | §4.4 非 root、§12.2 systemd/权限 |
| §10 | §4.3 极低占用（硬指标）、决策 #14 |
| §12 | §12.2 安装脚本、§12.3 上线流程、§12.4 升级、决策 #24/#25 |
| §13 | §4.9 平台适配层、§17 跨平台路线、决策 #29/#30 |
| §14 | §14 里程碑 |
