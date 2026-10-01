# Vantage Agent 待办清单（`vantage-agent` / Go）

> **文档性质**：**可执行的待办清单**。每条都给出「依据 → 涉及文件 → 验收标准」，做完把状态改成 ✅
> 并补完成日期。⛔ **不要删条目**（回溯「为什么改这个」比清单好看更重要）。
>
> **配套文档**：[`docs/agent-status.md`](agent-status.md)（当前进度快照与实测记录）。
> **行为契约**：[`docs/agent.md`](agent.md)。口径冲突时**以 `docs/agent.md` 为准**。
>
> **基线**：2026-09-28，`HEAD = 9a091da`。当时 `go build ./...` 通过，`go vet ./...` 与
> `go test ./...` 因 A-T01 失败。
> **进展**：2026-10-01 P0/P1 完成（`1c6dd9a` + `ab83d7f`）—— `go vet` / `go test ./...` **首次全绿**，
> A-T01/A-T02/A-T03/A-T04/A-T05/A-T23/A-T24 已 ✅，新增 A-T25；详见文末变更记录与
> [`docs/agent-changes-2026-10-01.md`](agent-changes-2026-10-01.md)。
>
> **维护约定**：新增待办从 `A-T25` 起编号，不要复用已完成的编号。优先级含义见下表。

## 优先级与状态图例

| 级别 | 含义 |
|---|---|
| **P0** | 阻塞项：不修就会挡住 CI / 产生错误信号，当天处理 |
| **P1** | 一致性与可追溯性：文档口径、代码提交 |
| **P2** | 验证缺口：测试与真机联调留痕 |
| **P3** | M2 交付物：安装脚本与 systemd（Agent 上线必需） |
| **P4** | 里程碑功能遗留：M4 收尾 / M5 / M6 |
| **P5** | 仓库卫生与长期项 |

| 状态 | 含义 |
|---|---|
| ⬜ 未开始 | 尚未动手 |
| 🟡 进行中 | 已开工未验收 |
| ✅ 完成 | 验收标准全部满足（附日期） |
| ⛔ 阻塞 | 有外部依赖（需 Owner 拍板或契约先改） |

---

## 1. P0 —— 阻塞项（建议本轮就清掉）

### A-T01　修 `ping_test.go:57` 的引号笔误 ✅（2026-10-01，`1c6dd9a`）

| 项 | 内容 |
|---|---|
| 问题 | `agent/internal/prober/ping_test.go:57` 的 `why:` 字符串内用了 **ASCII `"`**（U+0022）而非中文引号，Go 解析为字符串提前结束：`missing ',' in composite literal` |
| 依据 | `docs/agent.md` §4（探活要求）；`contracts/README.md`（两侧测试是接口守门人）；`go vet` / `go test` 实测输出 |
| 涉及文件 | `agent/internal/prober/ping_test.go` |
| 修法 | 把该行内层引号改为 `「」` 或转义 `\"`（**推荐 `「」`**，与文件内其他注释风格一致） |
| 验收 | ① `go vet ./...` 通过；② `go test ./... -count=1` 全绿（prober 的 `ping_test` / `http_test` / `tcp_test` 真正跑起来）；③ 若出现**新增**失败用例，单独登记为待办，不要为了让套件变绿而改断言 |
| 风险 | 极低，但它是**唯一**阻塞项 —— 修完 `go test ./...` 立刻从红转绿 |

**完成记录（2026-10-01，`1c6dd9a`）**：引号改「」。编译修复后 prober 测试**首次真正运行**，
暴露 9 个失败用例，逐一定性处理（2 个代码缺陷：`splitHostPort` 歧义判定、Windows errno 分类；
1 个测试向量错误：校验和属性用例 4 字节向量违反 `len ≥ 8` 前置条件；2 个环境依赖用例：
UDP+IPAddr 仅 Linux 可测、DNS 劫持环境自检 skip），**未放宽任何 Linux 断言**。
验收 ①② 达成（vet / test 全绿）；细节见 [`docs/agent-changes-2026-10-01.md`](agent-changes-2026-10-01.md) §2。

### A-T02　删除临时草稿 `agent/tmp_cksum_check/` ✅（2026-10-01，`1c6dd9a`）

| 项 | 内容 |
|---|---|
| 问题 | `agent/tmp_cksum_check/main.go` 是写 ping 测试时验证 ICMP 校验和的**临时程序**，已被 `git add` 进暂存区，还会出现在 `go test ./...` 的包列表里 |
| 依据 | 仓库不应携带临时草稿；`docs/agent.md` §2 的模块表里没有它 |
| 涉及文件 | `agent/tmp_cksum_check/`（整个目录） |
| 验收 | 目录删除且 `git status --short` 不再出现该路径；`go build ./...` 仍通过 |

**完成记录（2026-10-01，`1c6dd9a`）**：目录已删。⚠️ 该草稿此前已被误提交进 `8737820`，
删除需以新提交生效（已完成）；配套在 `.gitignore` 兜底 `agent/tmp_*/`（A-T23）。

---

## 2. P1 —— 口径一致性与可追溯性

### A-T03　提交当前暂存的 Agent 实现 ✅（2026-09-30，`8737820`；顺序偏差由 `1c6dd9a` 补救）

| 项 | 内容 |
|---|---|
| 问题 | 95 文件 / +19002 行（Agent 全部实现 + `contracts/` + server 测试）只在暂存区，`HEAD` 仍是中心的 `9a091da`；一次误操作即丢失 |
| 依据 | 可追溯性；`docs/agent-status.md` §5.3 |
| 验收 | ① A-T01、A-T02 先完成（别把红的测试和草稿提交进去）；② 提交信息说明范围（Agent 采集/探活/上报链路 + 共享契约 + 中心侧契约测试）；③ `git status` 干净；④ 建议**一个提交聚焦一件事**：Agent 实现、`contracts/`、server 测试适配可拆成 2–3 个提交 |
| 备注 | ⛔ 提交前确认测试文件里只有文档用的保留地址（`203.0.113.x`、`example.com`、`127.0.0.1`）与明显的假凭证（README §2 的红线） |

**完成记录（2026-09-30，`8737820`，98 文件 / +17858 行）**：⚠️ 未遵守本条验收 ① 的顺序要求
（先 A-T01/A-T02），红测试与草稿被一并带入历史；已由 `1c6dd9a` 补救（修复 + 删除）。
提交信息覆盖了 Agent 链路 + contracts + server 测试适配的范围说明；`git status` 其余部分干净。

### A-T04　纠正 README 的 Agent 状态口径 ✅（2026-10-01，`ab83d7f`）

| 项 | 内容 |
|---|---|
| 问题 | README 三处与事实不符：§1 组件表把 `vantage-agent` 写成**「未开工」**（同页顶部又写「🚧 进行中」）；§3.2 写「Go Agent 尚未开工，M1 阶段用脚本 + 手工报文联调」；§7 里程碑 M2–M6 整列 ⏳、M1 只承认中心侧 |
| 依据 | `docs/agent-status.md` §4 实测结论 |
| 涉及文件 | `README.md`（§1 组件表、§3.2、§7 里程碑表、§2 仓库结构里的 `agent/` 注释） |
| 验收 | ① 组件表状态改为与 `docs/agent-status.md` §4 一致的表述（M1–M4 代码完成 / 测试红 / M2 部署侧未开工）；② §3.2 补「Agent 已有 `--once` 单次联调与 `--check` 配置校验」；③ §7 里程碑行的状态与本文 §1 表不冲突；④ 顺带把 `docs/agent-status.md`、`docs/agent-todo.md` 加进 §5 文档索引 |

**完成记录（2026-10-01，`ab83d7f`）**：验收 ①②③④ 全部达成；其中 ① 的表述按当日事实更新为
「M1–M4 代码完成、**测试全绿**（不再是测试红）/ M2 部署侧未开工」。§2 仓库结构注释、§8 依赖许可
（去掉不存在的 gopsutil）一并纠正。

### A-T05　修正 `docs/agent.md` §2 的模块表口径 ✅（2026-10-01，`ab83d7f`）

| 项 | 内容 |
|---|---|
| 问题 | §2 模块表列了 `internal/retry/`，实际**不存在该包**（重试内联在 `internal/reporter/reporter.go:370-418`）；代码另有文档未列的 `internal/{logging,metric,model,ulid}` |
| 依据 | `docs/agent-status.md` §6 D-03 |
| 涉及文件 | `docs/agent.md` §2（模块表） |
| 验收 | ① `internal/retry/` 一行改为「重试内联于 `internal/reporter/`（只重试当前批次，⛔ 不落盘）」或直接删行并说明；② 补上 `logging` / `metric` / `model` / `ulid` 四个包及职责；③ ⛔ **只改口径不改结论**：`internal/buffer/` 删除、只内存重试、不补传这三条保持不变 |
| 注意 | 这是**文档改动**，不是代码改动 —— 不要为了对齐文档去新建一个空壳 `internal/retry` 包 |

**完成记录（2026-10-01，`ab83d7f`）**：retry 行改为「实际无此包，重试内联于 reporter」；补齐
`logging` / `metric` / `model` / `ulid` 四行；buffer 行的指引同步改指 reporter；`cmd/agent` 行补
`--check` / `--once`。⛔ 三条结论（buffer 删除、只内存重试、不补传）未动。
**附带发现**：collector 行原文「gopsutil 为主」与实现（直读 /proc，依赖仅 yaml.v3）不符，已在
§2 行内纠正；§3 规格表数据源列的收窄登记为 **A-T25**。

---

## 3. P2 —— 验证缺口

### A-T06　补 `internal/collector` 单元测试 ⬜

| 项 | 内容 |
|---|---|
| 问题 | 12 个采集文件、**零测试**；`collector/testdata/proc/**` 已备好 **21 个夹具**（`stat` / `meminfo` / `diskstats` / `net/dev` / `net/tcp` / `mountinfo` / `uptime` / `loadavg` / 各 PID 的 `stat`+`statm`+`comm`）却完全没被使用 |
| 依据 | `platform_other.go:9-11` 的设计意图就是「任意开发机都能把 `ProcRoot` 指向夹具跑真实解析」；`docs/agent.md` §3 |
| 涉及文件 | 新增 `agent/internal/collector/*_test.go` |
| 验收 | ① 六类采集器的 `/proc` 解析都有用例，且**跑在夹具目录上**（`t.Parallel()` 可选）；② 速率类指标（`disk.read_bps`、`net.rx_bps`）用两次采样 + 注入时钟验证「差值 ÷ 真实经过时间」，并覆盖**周期被 reload 改掉**的场景（`rate.go:8` 明确要求不得拿配置周期当分母）；③ 优雅降级路径有用例：缺 `nvidia-smi`、`/proc` 文件缺失、无 inode；④ 过滤规则 `filters.disk.exclude_fs` / `include_mounts` / `net.exclude_devices`（含 `docker*` 匹配裸 `docker`）有用例；⑤ `go test ./internal/collector/ -count=1` 全绿 |

### A-T07　补 `internal/scheduler` 单元测试 ⬜

| 项 | 内容 |
|---|---|
| 问题 | 调度器（15KB，唯一的常驻主循环）零测试：周期调度、心跳节流、SIGHUP 整代重启、自监控三项全靠人读代码 |
| 依据 | `docs/agent.md` §7（reload 失败保留旧配置）、§5.2（心跳）、§10（自监控） |
| 涉及文件 | 新增 `agent/internal/scheduler/scheduler_test.go` |
| 验收 | ① 各采集器按各自 `interval` 触发（注入假时钟，避免真 sleep）；② 连续无变更时按 `report.heartbeat_interval` 发心跳、**不得更密**（`scheduler.go:344`）；③ `Reload(newCfg)` 生效且**保留进程/TCP 连接语义**；④ `ReloadFailed(err)` 后**旧配置继续生效**（这是 §7 的核心失败安全）；⑤ `agent.reload_ok` / `agent.report_failures` / `agent.mem_rss` 三项按预期出现；⑥ 优雅退出不泄漏 goroutine（`goleak` 或退出后计数断言） |

### A-T08　补 `logging` / `ulid` / `cmd/agent` 的必要测试 ⬜

| 项 | 内容 |
|---|---|
| 问题 | 三个包零测试。`logging` 涉及 ⛔「日志不得出现 key/secret」的红线，`ulid` 是幂等键生成器（重复 = 中心幂等误判） |
| 依据 | `docs/agent.md` §12.3 排障纪律（日志禁泄凭证）；§5.2 幂等键 |
| 验收 | ① `logging`：`text` / `json` 两种格式可切换，且**断言输出里不含 key/secret 字样**（含截断形式）；② `ulid`：单调递增、同毫秒不重复、长度/字符集正确；③ `cmd/agent`：`--version` / `--check` 的正常与失败路径（可用 `config.Load` + 临时配置文件） |

### A-T09　真机 E2E 跑通并留痕 ✅（2026-10-01，详见 `docs/agent-status.md` §5.0.1）

| 项 | 内容 |
|---|---|
| 问题 | `agent/internal/reporter/e2e_test.go` 需要 `VANTAGE_E2E_CENTER` / `VANTAGE_E2E_AGENT_ID` / `VANTAGE_E2E_KEY` / `VANTAGE_E2E_SECRET`，**从未运行过**；「签名 + TLS + schema + 落库真的通」目前只有假中心与中心侧黄金字节测试间接支撑。且 Windows 开发机上 `collector.Supported=false`，`--once` 会被拦住 → **必须在 Linux 上做** |
| 依据 | `docs/agent.md` §5.1；`contracts/README.md`（黄金字节须被真实链路接受） |
| 验收 | ① 在 Linux 机器上跑 `go test -count=1 -run TestE2E -v ./internal/reporter/` 全绿；② 另跑一次 `vantage-agent --check` 与 `--once --print-body`，确认 `--print-body` 输出中**不含凭证**；③ 把「日期 / 中心版本 / 报告字节数 / `server_ts` / 是否首次上报带 `host.capabilities`」记入 `docs/agent-status.md` §5.1；④ 用后清理联调 Agent 与数据 |

**完成记录（2026-10-01）**：Debian 12 真机（经堡垒机，占位 `us-e2e-01`），Go 1.27.1 机上构建，
中心 0.8.0 + PG **18.4**（基线 16；迁移/分区/落库实测兼容）+ Redis。验收 ①②③ 达成：
E2E 3/3 PASS（WrongSecret / RealCenter / IdempotentReplay）；`--once` 上报 `server_ts=1790844501013`
（2815B→1179B）、报文 grep 无凭证、首报带 `host.capabilities`（gpu.nvidia=false 优雅降级）；
`metrics_raw` 149 行落库；`setsid` 后中心跨堡垒机会话存活。
**真机首跑抓出 A-T26 缺陷并当场修复**（`--once` 缺预热轮）——本条存在的意义被完美验证。
④ 处置：Owner 先决定**保留并常驻运行**（2026-10-01）——agent 以常驻调度模式接管（30s 周期，
日志 `/var/log/vantage-agent.log`），联调凭证转正为该机长期凭证（`e2e-linux-01`，中心状态
`online`，`last_seen` 实时，`metrics_raw` 持续增长 149→336 行/两周期）；随后 Owner 要求**停止
运行但保留环境**（同日，SIGTERM 优雅退出）——进程已停，凭证（`/etc/vantage/`）、二进制
（`/usr/local/bin/vantage-agent`）、源码克隆（`/opt/vantage/src`）、数据库（`vantage_e2e`）全部
在位。重启命令：
`cd /opt/vantage/src/server && setsid nohup npm start </dev/null > /var/log/vantage-core.log 2>&1 &`
`cd /opt/vantage && setsid nohup /usr/local/bin/vantage-agent --config /etc/vantage/config.yaml </dev/null >> /var/log/vantage-agent.log 2>&1 &`
（⚠️ `/opt/vantage/creds.txt` 含明文凭证，环境弃用时应删除。）

---

## 4. P3 —— M2 交付物（Agent 上线的必要条件）

### A-T10　实现 `vantage.sh` ⬜

| 项 | 内容 |
|---|---|
| 依据 | `docs/agent.md` §12.1（子命令表）、§12.2（安装参数三种形式） |
| 验收 | ① 子命令齐：`install` / `upgrade` / `uninstall`（默认保留配置+key+日志并打印保留路径，`--purge` 才彻底删且需交互确认）/ `start` / `stop` / `restart` / `status` / `reload`（= `systemctl reload vantage-agent`）；② `install` 下载二进制后**校验 sha256**（能签名更好）→ 创建低权用户 → 写入受限配置目录 → 安装 unit → 启动；③ `upgrade` 替换二进制但**保留配置**；④ `status` 输出「运行中/版本/最后上报时间/最近错误码/生效配置摘要」 |
| 红线 | ⛔ 任何子命令都不得接受 `--key <明文>`；⛔ 脚本落地 key 文件后立即 `unset VANTAGE_KEY` 并清理临时缓冲；⛔ 日志与 `--help` 不得出现 key/secret |

### A-T11　实现 systemd unit + 非 root 加固 ⬜

| 项 | 内容 |
|---|---|
| 依据 | `docs/agent.md` §9（systemd 加固表）、§7（`ReloadSignal=SIGHUP`） |
| 验收 | ① unit 含 `User=vantage`、`NoNewPrivileges=true`、`ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`、`ReadWritePaths=<数据目录>`、`ReloadSignal=SIGHUP`；② 不监听任何端口、不写系统目录（与 §9 一致）；③ 实测 `systemctl reload vantage-agent` 触发 SIGHUP 并热重载成功，且**校验失败的配置无法把进程带进半配置状态**（改坏 `config.yaml` 后 reload，旧配置仍生效 + 日志有 `config_reload_failed`） |

### A-T12　对齐三种 key 传递形式 ⬜

| 项 | 内容 |
|---|---|
| 依据 | `docs/agent.md` §6.1（加载优先级：交互式/stdin > env > `--key-file`）、§12.2；`docs/design-deltas.md` D-09（决策 #37 修订） |
| 验收 | ① 交互式/stdin 与 `--key-file` 两种形式在 `vantage.sh` 中可用；② env 内联形式可用且在脚本内即时清理，并打印「会进 shell history、建议 `history -d`」提示；③ ⛔ `--key` / `--secret` 明文参数**在脚本与二进制中都不存在**（可写一条 grep 断言测试进 CI）；④ 面板将来复制的一键命令与脚本参数名一致 |

### A-T13　补非 root / ICMP / 出站白名单运维文档 ⬜

| 项 | 内容 |
|---|---|
| 依据 | `docs/agent.md` §4（`setcap` 为 opt-in）、§9（出站白名单为 ➕ 建议） |
| 验收 | ① 文档给出 `setcap cap_net_raw+ep` 的 opt-in 步骤与**风险说明**，并明确「不设也可用，会自动降级为 TCP 探测 + WARN」；② 给出「只放行中心地址」的防火墙示例（iptables/nftables 或云安全组）；③ 文档里的命令**不得出现任何真实地址/账号** |

---

## 5. P4 —— 里程碑功能遗留

### A-T14　`collect.process.watch` 关键进程存活上报 ⛔（需先改契约）

| 项 | 内容 |
|---|---|
| 问题 | 配置项存在且校验通过，但**上报格式没有承载字段**；`collector/process.go:99-105` 自注「本期只记录、不产出指标」，启动打一次 WARN |
| 依据 | `docs/agent.md` §3（process 行含「关键进程白名单存活」）、§8 |
| 前置 | ⛔ 这是**契约变更**：按 `contracts/README.md` 的顺序 —— 先改 `docs/api.md` §2.1 + `docs/agent.md` → 再改 `contracts/wire/*.json` → 最后改两端实现与中心 schema/落库 |
| 验收 | ① 文档先定字段形状（`process.watch[]` 或独立 `watch_results[]`）与中心落库位置；② 两端黄金字节与 schema 同步更新且双侧测试绿；③ Agent 侧在 `top_n: 0` 时仍能单独上报 watch 结果 |

### A-T15　`host.boot_time` 口径收窄为一 ⛔（需与中心同步）

| 项 | 内容 |
|---|---|
| 问题 | 中心侧 `server/README.md` 的 M-05 记录：当前「整数与字符串都收、原样落 JSONB」，等 Agent 定型后收窄为一并在 schema 锁死 |
| 验收 | ① 与 `docs/api.md` §2.1 一起定死一种表示（建议 RFC3339 或 unix 秒）；② Agent 侧 `model/report.go` 相应字段类型固定；③ 中心 schema 改为强校验；④ `contracts/wire/report-full.json` 同步 |

### A-T16　`disk[].device` 是否必填定型 ⛔（需与中心同步）

| 项 | 内容 |
|---|---|
| 问题 | 中心 M-06：`docs/database.md` §5.7.2 的维度含 `device`，但 `docs/api.md` §2.1 字段表没列它；当前可选，缺失时序列只带 `mount` 维度 |
| 验收 | ① 确认 Agent 能稳定提供 `device`（Linux 上来自 `/proc/self/mountinfo`/`diskstats`）；② 若可以，改为必填并写进 `docs/api.md` §2.1；③ 同一 Agent 的维度口径必须**始终一致**（否则同一挂载点会分裂成两条序列） |

### A-T17　M5：Docker 采集转正 ⬜

| 项 | 内容 |
|---|---|
| 依据 | `docs/agent.md` §3（`docker` 预留行）、决策 #13 |
| 前置 | 先按契约流程改文档（`metrics.docker` 从恒 `null` 变为有内容）+ 中心 schema |
| 验收 | ① 读 `docker.sock`（用户加入 docker 组即可，**非 root**）；② 无 socket/无权限 → 优雅降级 + `capabilities.docker=false`，⛔ 不崩溃；③ 移除 `config.go:543` 的「排在 M5」拒绝逻辑；④ 中心侧落库与面板（如涉及）同步 |

### A-T18　M5：systemd 加固打磨 ⬜

| 项 | 内容 |
|---|---|
| 依据 | `docs/agent.md` §9、§14 M5 |
| 验收 | ① 加固后逐项验证采集仍正常（`ProtectSystem=strict` 下的 `ReadWritePaths` 正确）；② 日志走 journald 时格式与轮转策略确认；③ 出一份「加固前后资源占用对照」（内存 <20–30MB、空闲 CPU <0.5%） |

### A-T19　M6：Windows / macOS 采集器与安装脚本 ⬜

| 项 | 内容 |
|---|---|
| 依据 | `docs/agent.md` §13.2/§13.3、§14 M6 |
| 验收 | ① 按 `collector/{cpu,mem,disk,net,gpu,process}_<os>.go` 构建标签分发，**主干与中心侧零改动**；② 每平台能力声明正确（Windows 无 inode、macOS 基本无 NVIDIA）；③ 各自安装脚本与 reload 机制（Windows 服务 / launchd）；④ 翻转 `collector.Supported` 并解除 `main.go:78-82` 的拒绝启动 |
| 备注 | 工程量参考：以 Linux 为 100%，Windows ≈ +40~60%，macOS ≈ +30~50% |

### A-T20　探活 `dns` 类型（预留转正）⬜

| 项 | 内容 |
|---|---|
| 实现位置 | `config.go:629` 当前显式拒绝；`server` 侧 `probe_results` 类型白名单已含 `dns` |
| 验收 | ① 定义探测语义（解析耗时？期望 IP 集合？）先写进 `docs/agent.md` §4；② 解除配置拒绝并实现；③ 中心侧类型白名单无需改动即可接受 |

### A-T21　GPU AMD / `rocm-smi`（预留转正）⬜

| 项 | 内容 |
|---|---|
| 实现位置 | `collector/gpu.go` 仅 NVIDIA；配置 `collect.gpu.provider` 字段已留 |
| 验收 | ① `provider: amd` 时走 `rocm-smi`，产出同一套 `gpu.*` 指标与 `{index}` 维度；② `capabilities.gpu.amd` 正确声明；③ 与 NVIDIA 路径共用降级/超时/`[N/A]` 容错框架 |

---

## 6. P5 —— 仓库卫生与长期项

### A-T22　补齐 `LICENSE`（AGPL-3.0） ⬜

| 项 | 内容 |
|---|---|
| 依据 | README §8 已自注「仓库尚未放入 `LICENSE` 文件，正式开源前需补」；决策 #28 |
| 验收 | 仓库根目录存在 `LICENSE`，内容为 AGPL-3.0 全文，且 README §8 的 ⚠️ 提示可删 |

### A-T23　`.gitignore` 兜住临时产物 ✅（2026-10-01，`1c6dd9a`）

| 项 | 内容 |
|---|---|
| 问题 | `agent/tmp_cksum_check/` 这类草稿目录能被 `git add` 进来；本机还存在 `.gocache` / `.gomodcache` / `.gopath` / `.npm-cache` 等工作区缓存 |
| 验收 | ① 确认上述缓存目录均在 `.gitignore` 内（当前 `.gocache` 等已在）；② 约定草稿目录命名（如 `agent/tmp_*/`）并忽略；③ ⛔ 不要用宽泛的 `tmp*` 误伤正式代码 |

**完成记录（2026-10-01，`1c6dd9a`）**：新增 `agent/tmp_*/` 规则（未用宽泛 `tmp*`）；`.gocache` /
`.gopath` / `.gomodcache` / `.npm-cache` 此前已在。

### A-T24　打通文档索引 ✅（2026-10-01，`ab83d7f`）

| 项 | 内容 |
|---|---|
| 问题 | `docs/agent-status.md` 与 `docs/agent-todo.md` 尚未被 README §5「文档索引」与 `docs/agent.md` 头部引用 |
| 验收 | ① README §5 索引加两行；② `docs/agent.md` 头部「阅读约定」附近加一句「进度与待办见 `docs/agent-status.md` / `docs/agent-todo.md`」；③ 两份文档互相引用保持有效 |

**完成记录（2026-10-01，`ab83d7f`）**：验收 ①②③ 达成；README §5 另加测试手册
`docs/agent-testing.md`（随本批新增）。

### A-T25　收窄 `docs/agent.md` §3 采集器数据源列的 gopsutil 早期口径 ⬜

| 项 | 内容 |
|---|---|
| 问题 | §2 模块表已在 A-T05 纠正为「直读 /proc」，但 §3 采集器规格表的「数据源」列仍逐行写 gopsutil API（如 `gopsutil/cpu.Percent`）；实现实际全部直读 `/proc`（`stat`/`meminfo`/`diskstats`/`net/dev`/`net/tcp*`/`mountinfo`/`docker.sock` 预留），`go.mod` 仅依赖 `gopkg.in/yaml.v3` |
| 依据 | 2026-10-01 核对（`go.mod` + 全仓 grep 无 gopsutil）；`docs/agent-status.md` §2 早已按 /proc 口径清点 |
| 涉及文件 | `docs/agent.md` §3（数据源列）；顺带核对 README/设计文档残留的 gopsutil 提法 |
| 验收 | ① §3 数据源列改为真实数据源（含「容量查询走注入的 statfs」这一例外）；② 采集共性要求里「单次采集 <50ms」等结论不变；③ ⛔ 只改口径不改行为要求 |
| 级别 | P1（文档准确性；建议与 A-T06 写测试时一并做，写测试即为逐行核对数据源） |

### A-T26　修复 `--once` 单轮模式缺预热轮（metrics.cpu 必缺失）✅（2026-10-01，`90e81e8`）

| 项 | 内容 |
|---|---|
| 问题 | A-T09 真机首跑发现：`cpu.usage` 是差分指标需要两个采样点，`runOnce` 只跑一轮 → `metrics.cpu` 永远缺失 → 本地校验（中心 schema 底线）必拒。Windows 开发机不可达（`Supported=false` 提前拒绝），`cmd/agent` 无测试 |
| 修复 | `runOnce` 增加预热采集轮（产出丢弃，只为喂进上一份样本），间隔 `onceWarmupGap=2s` 后跑正式轮；net/disk 速率类同样受益 |
| 验收 | ① 真机 `--once` 退出码 0 且成功上报（`server_ts=1790844501013`，2815B→1179B）；② 本地 `go vet`/`go test`/Linux 交叉编译全绿 —— 均已达成 |
| 备注 | ⚠️ `90e81e8` 因开发机会话无 GitHub 凭证**尚未推送**，待 Owner 在常用终端 `git push`；资产机以补丁文件方式先应用了该改动 |

### A-T27　提交 `server/package-lock.json` ⬜

| 项 | 内容 |
|---|---|
| 问题 | `server/package-lock.json` 在本地一直是**未跟踪**状态、从未入库；A-T09 克隆部署时 `npm ci` 直接失败（无锁文件可用），只能退回 `npm install`（依赖版本不受锁约束） |
| 依据 | A-T09 部署实测；README §3 的 `npm install` 流程无法保证可复现 |
| 验收 | ① `git add server/package-lock.json` 并提交推送；② 部署文档/脚本统一用 `npm ci`（有锁走 ci）；③ `npm ci --omit=dev` 在干净克隆上通过 |
| 级别 | P1（可复现构建） |

---

## 7. 建议执行顺序

```
第 1 轮（当天，恢复绿色 + 止血）✅ 2026-10-01 完成（1c6dd9a）
  A-T01 修引号 → A-T02 删草稿 → 复跑 go vet / go test 全绿
  A-T03 提交（先别带 A-T04 的文档改动，保持提交聚焦）
  ※ 实际执行顺序有偏差：A-T03 先行（8737820），A-T01/A-T02 由 1c6dd9a 补救，见各条完成记录

第 2 轮（口径与可追溯）✅ 2026-10-01 完成（ab83d7f）
  A-T04 README 状态口径 → A-T05 docs/agent.md §2 → A-T24 索引（可并入 A-T04 的提交）
  ※ A-T25 为本轮新登记，建议与 A-T06 一并做

第 3 轮（把「未验证」变成「已验证」）⬜ 下一步
  A-T06 collector 测试（夹具现成，性价比最高）→ A-T07 scheduler 测试 → A-T09 Linux 真机 E2E 留痕

第 4 轮（M2 上线能力）⬜
  A-T11 systemd unit → A-T10 vantage.sh → A-T12 三种 key 形式 → A-T13 运维文档

之后：A-T14/A-T15/A-T16（契约收窄，需两侧一起动）→ A-T17/A-T18（M5）→ A-T19～A-T21（M6 与预留项）
```

**判定「Agent 可以上线」的最小集合**：A-T01 ✅ + A-T03 ✅ + A-T09 ✅ + A-T10/T11/T12/T13 ✅。
**判定「M1–M4 全部收口」还需**：A-T06 / A-T07 ✅ + A-T14～A-T16 定型。

---

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-28 | 首次建立待办清单：A-T01…A-T24，来源为 `docs/agent-status.md` §6/§7/§8 的偏差、未实现项与风险 |
| 2026-10-01 | P0/P1 完成：A-T01/A-T02/A-T03/A-T04/A-T05/A-T23/A-T24 置 ✅（提交 `1c6dd9a` + `ab83d7f`）；`go vet` / `go test ./...` 首次全绿；新增 A-T25（§3 数据源列 gopsutil 口径收窄）；第 1/2 轮执行顺序标注完成情况。改动细节见 [`docs/agent-changes-2026-10-01.md`](agent-changes-2026-10-01.md) |
| 2026-10-01(晚) | **A-T09 真机 E2E ✅**（Debian 12 经堡垒机：3/3 PASS + `--once` 真实上报落库，PG 18.4 兼容实测，红线检查通过）；登记并完成 A-T26（`--once` 预热轮修复，`90e81e8`，⚠️ 待推送）；登记 A-T27（package-lock.json 未入库）。上线最小集合仅剩部署侧 A-T10～T13 |
