# Vantage Agent 安装脚本（`vantage.sh`）设计文档

> 状态：**设计定稿，未写实现代码**（2026-10-05）。落地对应待办 `docs/agent-todo.md` **A-T10 / A-T11 / A-T12 / A-T13**。
> 上位文档：`Vantage-DESIGN-v0.7.md`（内容 = v0.8）§12.2 / §12.4、`docs/agent.md` §6.1 / §9 / §12、`docs/api.md` §4.4（`install_hint` **已实现**，参数名已冻结）。
> 范围：只定义**部署侧（分发 + 安装 + 运维）契约**。⛔ 不动上报协议、⛔ 不动中心接口、⛔ 不引入任何「中心下发」路径。
> 标记：✅ **已定**（Owner 拍板或有上位依据） ｜ ➕ **默认**（本稿取值，Owner 一句话即可推翻） ｜ ⏭ **移交**（属别的待办，不阻塞本脚本） ｜ ➖ **撤销**（曾列入，已界定为范围外）

---

## 0. 决策台账

| # | 议题 | 结论 | 落点 |
|---|---|---|---|
| Q1 | 二进制分发渠道 | ✅ **三源并存**：GitHub Releases（审计/兜底）+ 国内镜像 + 自建静态站。脚本内置源链「自建站 → 镜像 → GitHub」自动回退；`--source` 可锁定单一源；发布脚本一次发三处并回读自检 | §4.1–4.2、§4.5 |
| Q2 | 校验强度 / 信任根 | ✅ **脚本内嵌公钥 + `openssl` 分离签名，严格默认**：验签失败或缺 `openssl`/`.sig` 即失败（退出码 6），唯一逃生门 `--no-verify`（留痕 `verified=false`）。信任根 = 离线私钥，⛔ 无运行期换公钥路径；DNS TXT 仅作人工核对通道 | §4.3、§4.6 |
| Q3 | unit 内存硬顶 | ⏭ **移交 A-T11**（倾向先不加）：Agent 自设 `GOMEMLIMIT=48MB` 已封一层，硬顶设错会变成"假离线 + 数据缺口"，等 A-T18 真机内存曲线后再定 | §8.1 |
| Q4 | `install` 是否默认做一次真实上报 | ✅ **默认做，失败即算安装失败**：在**创建 unit 之前**以运行用户跑 `--once`；失败则删本次落盘的二进制（unit 从未创建），退出码 8。逃生开关 `--no-smoke-test` | §5.2、§6.6、§6.9 |
| Q5 | 日志目的地 | ⏭ **移交 A-T11**（倾向默认 journald，⛔ 不写 `log.file`）；文件日志作为可选项 | §8.1、§8.2 |
| Q6 | `--key-file` 语义 | ➕ **路径即落点**：文件已存在 → 读取内容 + 校正属主/权限（⛔ 不覆盖内容）；不存在 → 交互输入后写入该路径。中心那条形式③命令两种用法都自洽，中心代码零改动 | §6.2 |
| Q7 | 脚本落点与 URL | ✅ 交付物统一放 `agent/deploy/`；`AGENT_INSTALL_SCRIPT_URL` 配**自建站最新地址**（换脚本只重传一份，⛔ 不改中心 `.env`），GitHub raw 兜底 | §3、§4.4 |
| Q8 | ICMP 权限（`cap_net_raw`）入口 | ➖ **撤销**：属 Agent 运行侧 + A-T13 运维文档，**不属于安装脚本**；脚本不提供任何开关，只保证 unit 不放宽权限 | §2.2、§5.1、§8.1 |
| Q9 | `upgrade` 后是否也做真实上报 | ✅ **要，失败即回滚**；实现为**替换前预演**（`.new` 上跑 `--check` + `--once`，失败则线上零改动） | §7.1 |
| Q10 | 已有 `config.yaml` 与新参数冲突时 | ➕ **报错退出（3）**，交人工决定；`--force` = 备份成 `config.yaml.bak.<时间戳>` 后整体重写。⛔ 不做 YAML 字段级修补、⛔ 不静默覆盖 | §6.5 |
| Q11 | 是否内嵌「备用公钥」 | ➕ **先单把**：换公钥 = 发一次新版本脚本（旧脚本仍只认旧公钥，这是有意为之） | §4.5 |
| Q12 | 已有二进制/unit 但无 `install-state` 的旧机 | ➕ **按"接管"处理**：保留现有配置与凭证 → 装/更新 unit → 补写 `install-state` → 冒烟上报 | §6.8 |

---

## 1. 现状核对（2026-10-05，逐项查过文件）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **Agent 二进制已实现且可用**：`--config` / `--version` / `--check`（只校验不发网）/ `--once`（采一轮就退）/ `--print-body` | `agent/cmd/agent/main.go` L47–67、L109–118 |
| 2 | **仓库内没有任何 `.sh`，也没有 `.service`** —— `vantage.sh`、systemd unit 全缺 | 全仓 `*.sh` / `*.service` 检索为空；`docs/agent-status.md` §7 |
| 3 | **中心侧 `install_hint` 已实现，参数名已冻结**为 `--center` / `--agent-id` / `--key-file` / `--secret-file`（默认路径 `/etc/vantage/agent.key`、`/etc/vantage/agent.secret`） | `server/src/services/agentAdmin.service.js` L54–55、L169–183 |
| 4 | 一键命令的**外层形态已定死**：`VANTAGE_KEY=… VANTAGE_SECRET=… sh -c 'curl -fsSL <script_url> \| sudo -E sh -s -- install …'` | 同上 L174–176；`docs/agent.md` §12.1 |
| 5 | `AGENT_INSTALL_SCRIPT_URL` **必须是 https**，否则中心启动即报错；未配置时三个命令字段全 `null` + 警告 | `server/src/config/index.js` L233–246；`server/src/routes/agents.js` L115–120 |
| 6 | 凭证文件的校验是**硬校验**：必须是普通文件（⛔ 拒 `/dev/stdin`、管道、目录），且 `perm & 0o077 == 0`（**只能 0600/0400/0700 这类，0640 会被拒**） | `agent/internal/auth/credentials.go` L106–166 |
| 7 | Agent 运行期**磁盘占用 ≈ 0**（丢弃式，无落盘缓存）；日志默认走 stdout（`log.file` 缺省为空） | `docs/agent.md` §5.2/§10；`config.go` `Defaults()` L291 |
| 8 | 上报结果有可解析日志：成功 `上报成功`（含 `batch_id`/`bytes`/`server_ts`）、失败 `上报失败（…HTTP 4xx…）` | `agent/internal/scheduler/scheduler.go` L387–394 |
| 9 | 采集周期默认 **30s**（cpu/mem/net/gpu）、60s（disk/process），上报 30s、心跳 60s；中心离线阈值 ≈ 90s | `config.go` L259–293；`docs/agent-status.md` |
| 10 | 真机 E2E（A-T09）当年是**手工**完成的：`/usr/local/bin/vantage-agent` + `/etc/vantage/config.yaml` | `docs/agent-todo.md` §3、`docs/agent-testing.md` §7 |
| 11 | **无 CI、无 Release、无构建脚本**；`git remote = https://github.com/haozi-123-wow/Vantage.git`；`LICENSE` 仍缺（A-T22） | `git remote -v`；A-T22 |
| 12 | 中心侧 `GET /version` 已实现（本设计不依赖它） | `docs/api-status.md` |

**结论**：脚本要补的是「把第 10 条那套手工动作变成可重复、可校验、可回滚的一条命令」，同时**不能**改第 3/4 条已冻结的接口形态（改了就得动中心 + 前端 + 契约文档）。

---

## 2. 目标与范围

### 2.1 目标

1. **一条命令装上**：`VANTAGE_KEY=… VANTAGE_SECRET=… sh -c 'curl -fsSL <url> | sudo -E sh -s -- install --center … --agent-id …'`；凭证另有交互式与 `--key-file` 两种形式（✅ 决策 #37 修订）。除面板三段命令外**不需要任何前置手工步骤**。
2. **可校验**：下载物**先验签、再校验 sha256**（§4.3）；安装中做 `--check` 离线自检，并以一次**真实上报**收尾（✅ Q4）。
3. **可回滚**：`upgrade` 替换前预演、保留上一版二进制（✅ Q9）。
4. **幂等**：重复 `install` 不破坏既有配置与凭证；`uninstall` 默认保留凭证与配置（✅ G9）。
5. **非 root 运行 + systemd 加固**（✅ `docs/agent.md` §9）；脚本自身只在安装窗口用 root。
6. **零新增常驻依赖**：目标机只要求 `sh`、`curl`、`tar`、`openssl`、（`sha256sum` 或 `shasum`）。⛔ 不引入 Python/Go/node。

### 2.2 非目标

- ⛔ Windows / macOS 安装脚本（M6，A-T19）。
- ⛔ Alpine/openrc、非 systemd 发行版（报错，不做权宜实现）。
- ⛔ 自动升级、定时轮询、中心推送版本（违反单向宗旨）。
- ⛔ 自动获取/轮换凭证（轮换必须人工上机）。
- ⛔ Docker/systemd 容器编排、批量下发（本期 5 台，手工逐台执行）。
- ⛔ **ICMP 权限授予**（`cap_net_raw`）：属 Agent 运行侧与 A-T13；脚本不提供任何开关（✅ Q8）。

---

## 3. 交付物

| 文件 | 内容 | 待办 |
|---|---|---|
| `agent/deploy/vantage.sh` | 唯一入口，POSIX `sh`，子命令 `install/upgrade/uninstall/start/stop/restart/reload/status/version/help` | A-T10 |
| `agent/deploy/vantage-agent.service` | systemd unit（脚本内嵌同一份文本，文件用于审计/对照） | A-T11 |
| `agent/deploy/config.minimal.yaml` | 安装时生成的 `config.yaml` 模板（最小必填 + 注释示例） | A-T10 |
| `agent/deploy/build-release.sh` | 开发者工具：交叉编译 + 打包 + `SHA256SUMS` | 分发前提 |
| `agent/deploy/publish-release.sh` | 维护者工具：签名 + 推三源 + 写 `latest.txt` + 回读自检（§4.5） | ✅ Q1/Q2 |
| `agent/deploy/tests/static-assert.sh` | 静态断言（红线检查，§12.1） | A-T12 |
| `docs/agent-install-ops.md` | `setcap` opt-in、出站白名单、凭证替换、排障 | A-T13 |
| `docs/agent-install-script.md` | 本文 | — |

✅ **Q7**：交付物统一放 `agent/deploy/`（agent 的东西归 agent）；`AGENT_INSTALL_SCRIPT_URL` 指向**自建站最新地址**，换脚本只重传一份，⛔ 不用改中心 `.env`。

---

## 4. 分发与校验

### 4.1 三种源与产物清单（✅ Q1）

同一套产物发布到三个源。**自建站与镜像走我们定的归一化布局，GitHub 用其原生 Releases 布局**：

| 源类型 | 判定 | 产物 URL | latest 解析 |
|---|---|---|---|
| `github` | host 是 `github.com`（或 URL 含 `/releases/download`） | `${SRC}/releases/download/${TAG}/<asset>` | `${SRC}/releases/latest` 的 302 末段 |
| `static` | 其他一切 https 站点 | `${SRC}/${TAG}/<asset>` | `${SRC}/latest.txt`（单行 `v0.1.0`） |

```
vantage-agent_${TAG}_linux_amd64.tar.gz
vantage-agent_${TAG}_linux_arm64.tar.gz
SHA256SUMS          ← "<sha256>  vantage-agent_${TAG}_linux_amd64.tar.gz"（两行）
SHA256SUMS.sig      ← 发布私钥对 SHA256SUMS 的分离签名（ECDSA P-256）
vantage.sh          ← 脚本自身的同版本拷贝
```

- `TAG` 形如 `v0.1.0`；`agent/internal/version.Version` 由构建脚本注入**同一个字符串**，脚本据此判断「已装版本 == 目标版本」。
- `tar.gz` 内**只含** `vantage-agent`（静态单文件）+ `LICENSE`（A-T22 落地后）。
- ⛔ 三个源必须**同名同内容**，否则校验与回退都会失效。
- ⚠️ 三源的 `latest` 可能因同步延迟而不一致 → 面板一键命令用于「装最新」，**批量/生产安装建议显式 `--version` 固定**。

### 4.2 源链、回退与版本解析（✅ Q1）

**默认源链（按序尝试）**：① 自建站 → ② 国内镜像 → ③ GitHub Releases。

- 每源失败（DNS/超时/TLS/404/校验失败）→ WARN + 记录原因 → 试下一源；**全部失败**才以退出码 5 中止，并**逐源打印**失败原因。
- ⛔ **同源自洽**：`tar.gz`、`SHA256SUMS`、`.sig` 必须来自**同一个源**，⛔ 不跨源混用（用 A 源的清单校验 B 源的包 = 校验变摆设）。
- ⛔ **latest 也按源链**：在某源解析出 `TAG` 后，后续下载只在该源内进行；换源时**重新解析**。
- ✅ `--source` / `VANTAGE_SOURCE`：**只用指定源、不回退**（可审计、可复现；镜像排障时"悄悄回退了"更坏）。
- 源链地址写死在脚本头部常量区（一处可改），`--help` 与 `status` 都打印当前源链。

| 场景 | 做法 |
|---|---|
| `--version` 给定 | 直接拼 `TAG`，不做网络发现（生产批量安装推荐） |
| 未给定（latest） | 按源链顺序解析，取第一个成功的源 |
| 解析失败 | 报错并提示「显式传 `--version vX.Y.Z`」；⛔ 不猜版本、⛔ 不用本地文件名反推 |

### 4.3 两道校验与密钥选型（✅ Q2）

**顺序不可颠倒**：

1. **签名校验（信任边界）**：用**脚本内嵌公钥**执行
   `openssl dgst -sha256 -verify <内嵌公钥> -signature SHA256SUMS.sig SHA256SUMS`
   失败 = 删除临时文件并中止（**退出码 6**），⛔ 不降级、不继续、不启动。
2. **sha256 校验（完整性）**：从**已验签**的 `SHA256SUMS` 取目标行 → `sha256sum -c`（回退 `shasum -a 256`、`busybox sha256sum`）。

| 项 | 结论 |
|---|---|
| 算法 | **ECDSA P-256**（`openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256`）：`dgst -sha256 -sign/-verify` 自 OpenSSL 1.0.2 起全支持，支持列表内发行版都满足；PEM 公钥约 180 字节，适合内嵌 |
| ⛔ 不用 Ed25519 | 它不能走 `dgst -verify` 路径（需 `pkeyutl -verify -rawin` + OpenSSL ≥ 1.1.1），会平白砍掉兼容性 |
| 公钥指纹 | `openssl pkey -pubin -in release.pub.pem -outform DER \| sha256sum` 取前 16 位十六进制，**脚本内打印、`--help` 中文档化、官网/DNS TXT 公布**，供人工核对 |
| 私钥 | ⛔ 离线保管，不进仓库、不进发布脚本、不进日志；`publish-release.sh` 只从执行者提供的环境变量/路径读取 |
| `openssl` 缺失 | **严格失败**（退出码 6）+ 打印该发行版安装命令；唯一逃生门 `--no-verify`（醒目 WARN + `install-state` 记 `verified=false`，`status` 长期显示该事实） |

⚠️ 同源 sha256 本来**只防传输损坏/截断**；把信任根搬进脚本（内嵌公钥）**才是防"某个源被换包"的那一道**。文档与 `--help` 必须区分这两件事，⛔ 不得含糊宣称。

### 4.4 脚本自身的来源

- `AGENT_INSTALL_SCRIPT_URL` 指向**一个固定 https 地址**；三个源都托管脚本副本，运维择快者配置：
  - 自建站（推荐，国内最稳）：`https://<自建站>/vantage.sh`
  - 镜像：`https://<镜像>/vantage.sh`
  - 仓库 raw（兜底/审计）：`https://raw.githubusercontent.com/haozi-123-wow/Vantage/main/agent/deploy/vantage.sh`
- ➕ 若要求可复现，可指向 tag 定死版本：`https://<自建站>/v0.1.0/vantage.sh`（与产物同目录，天然同版本）。
- ⛔ 脚本运行期**不自我更新、不二次 `curl | sh`**（管道中途换脚本是最典型的"看起来能用"的事故源）。
- 脚本自带 `SCRIPT_VERSION`（如 `2026.10.05`），与二进制版本分别演进；`status` 同时打印「脚本版本 / 二进制版本 / 来源源」，可据此发现"自建站上是旧拷贝"。

### 4.5 发布链路（`publish-release.sh`）

| 步 | 动作 |
|---|---|
| 1 | `build-release.sh` → 两架构 `tar.gz` + `SHA256SUMS` + 脚本拷贝 |
| 2 | **签名**：`openssl dgst -sha256 -sign <离线私钥> -out SHA256SUMS.sig SHA256SUMS`；私钥路径由执行者用环境变量提供 |
| 3 | GitHub：`gh release create <tag> <assets>`（凭据只从本机 gh 登录态/环境读取） |
| 4 | 自建站：`rsync`/`scp` 到 `${SRC}/${TAG}/`，再写 `${SRC}/latest.txt` |
| 5 | 国内镜像：同上（对象存储或另一台机） |
| 6 | **回读自检（⛔ 不可省）**：对三源各跑一遍「下载 `SHA256SUMS` + `.sig` → 用**脚本内嵌公钥**验签 → 比对两架构包 sha256」，并核对 `latest.txt` 是否为刚发布的 `TAG` |
| 7 | ➕ 可选：把 `TAG` 与公钥指纹写入 DNS TXT（`_vantage.<域名>`），作独立人工核对通道（⛔ 不参与安装判定） |

- `latest.txt` 的写入放在**产物上传完成之后**，避免「latest 指向还没传完的版本」。
- ⛔ 公钥轮换不走"运行期从网络换公钥"（那等于把信任根交出去）；换公钥 = 发一次新版本脚本（✅ Q11）。
- `publish-release.sh` 属维护者工具，不在被监控机的执行路径上；其失败不影响已安装的 Agent。

### 4.6 信任根说明：公钥公开为什么不是问题（✅ Q2）

- **公钥本来就是公开信息**：它只能用来**验证**"这个包是私钥持有者签的"，⛔ 不能签出新包、⛔ 不能改包（改一个字节签名即失配）。安全性全部来自**私钥保密**，与公钥是否公开无关。
- **真正要防的是"公钥被掉包"**：假脚本内嵌攻击者公钥 → 用攻击者公钥验攻击者的包必然通过。对策：脚本只从自己的固定 https 域名取（§4.4）、`AGENT_INSTALL_SCRIPT_URL` 只配自己的站、公钥指纹在官网/DNS TXT 公布供人工核对。
- **曾被考虑并否决的方案**（记录结论，避免重复讨论）：
  | 方案 | 信任根 | 评价 |
  |---|---|---|
  | 自建 HTTPS 权威清单（不签名） | 域名 + CA | 比 GitHub 自主，但仍是**网络单点**；域名/主机被控即失效 |
  | DNS TXT 当信任根 | 你的权威 DNS | 裸 DNS 无认证（可投毒/在途篡改）；目标机常无 `dig/nslookup`；TTL 缓存导致发布延迟生效。要成信任根须同时满足「直查权威 NS + DNSSEC 校验 + 失败 fail-closed」，三条都要额外运维，收益仍不如内嵌公钥 |
  | 只用同源 sha256 | 无 | 只防截断，镜像被换包无法发现 |
  → 结论：**信任根必须是脚本里内嵌、不通过网络获得的东西**；DNS 只适合当**人工核对通道**。

---

## 5. CLI 契约

### 5.1 子命令

| 子命令 | 语义 | 要点 |
|---|---|---|
| `install` | 首次安装（已装且配置一致 → 走 `upgrade` 分支保留配置） | §6 |
| `upgrade` | 换二进制，配置与凭证原样保留 | §7.1 |
| `uninstall` | 停服务 + 删 unit + 删二进制；**默认保留** `/etc/vantage/*`、状态文件、日志 | §7.2 |
| `start` / `stop` / `restart` | `systemctl` 透传 | §7.3 |
| `reload` | `systemctl reload vantage-agent`（= SIGHUP 热重载，✅ 决策 #34） | §7.3 |
| `status` | 服务 + 版本 + 最后上报时间 + 最近失败 + 生效配置摘要 + 凭证权限体检 | §7.4 |
| `version` / `help` | 打印脚本版本 / 用法 | ⛔ 输出不得含任何凭证 |

➖ **不设** ICMP 相关子命令（✅ Q8：属 Agent/运维侧，见 A-T13）。

### 5.2 `install` 参数（⛔ 前四个名字不可改，中心已生成）

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `--center <url>` | ✅ | — | 中心地址；**默认强制 https**（与 Agent 校验一致），`--insecure-http` 才放行 http 且打 WARN |
| `--agent-id <uuid>` | ✅ | — | 中心生成的 UUID；脚本按与 `config.go` 同口径的 `uuidRE` 校验 |
| `--key-file <path>` | | `/etc/vantage/agent.key` | 路径即**凭证落点**（✅ Q6 语义，细节见 §6.2） |
| `--secret-file <path>` | | `/etc/vantage/agent.secret` | 同上；⛔ 两者不得同路径（Agent 侧也会拒） |
| `--version <tag>` | | latest | 见 §4.2 |
| `--source <url>` | | 内置源链 | 指定**单一源**（不回退，§4.2）；⛔ 必须 https（除 `--insecure-http`） |
| `--user <name>` | | `vantage` | 运行用户（不存在则创建 system user） |
| `--data-dir <path>` | | `/var/lib/vantage` | 预留写入目录（⚠️ 当前 Agent 运行期不落盘，仅供 unit `ReadWritePaths` 与未来使用） |
| `--host-alias <name>` | | 本机 hostname | 写进 `host.alias` |
| `--smoke-test` / `--no-smoke-test` | | **默认开** | 在装 unit **之前**跑一次 `--once` 真实上报，失败即安装失败（✅ Q4，细节见 §6.6） |
| `--no-start` | | 关 | 装完不启动（批量预置场景）；此时默认跳过冒烟上报，除非显式 `--smoke-test` |
| `--force` | | 关 | 允许覆盖/重写已有 `config.yaml`（默认拒绝，见 §6.5） |
| `--dry-run` | | 关 | 只打印将执行的动作与最终文件内容；⛔ 不写盘、⛔ 不发上报（下载仍可发生，便于验证 URL） |

### 5.3 环境变量

| 变量 | 用途 | 清理要求 |
|---|---|---|
| `VANTAGE_KEY` | `vk_` 前缀明文 key | 写入受限文件后**立即 `unset`**（✅ 决策 #37） |
| `VANTAGE_SECRET` | `vs_` 前缀明文 secret | 同上 |

➕ 另认 `VANTAGE_SOURCE`（等价 `--source`）、`VANTAGE_VERSION`（等价 `--version`）便于内部批量执行；⛔ **不认** `VANTAGE_KEY_FILE` 之类多余入口。

### 5.4 通用开关、退出码与输出

- 通用：`-y/--yes`（跳过交互确认）、`-q/--quiet`、`-v/--verbose`、`--json`（仅 `status`）、`--insecure-http`（仅测试环境）、`--no-verify`（✅ Q2 唯一逃生门）。
- 退出码：`0` 成功 ｜ `2` 用法错误 ｜ `3` 前置检查/配置冲突 ｜ `4` 凭证问题 ｜ `5` 下载失败 ｜ `6` 校验失败 ｜ `7` 系统/服务操作失败 ｜ `8` 安装或升级验证失败。
- 输出规范：**进度与结果走 stderr；机器可读结果（`--json`、`--dry-run` 的文件内容）走 stdout**；每条失败信息 = 「现象 + 原因 + 下一步命令」。

---

## 6. `install` 流程（按执行顺序）

### 6.1 前置检查（全部通过才动盘）

| 检查 | 不通过时 |
|---|---|
| `id -u == 0` | 报错并给出完整 `sudo` 命令 |
| systemd 在管（`/run/systemd/system` 存在且 `systemctl` 可用） | 报错：「本脚本只支持 systemd（Alpine/openrc 与无 init 容器不在本期范围）」 |
| `/etc/os-release` 可读（仅用于日志与提示，⛔ 不做发行版分支逻辑） | WARN 继续 |
| 架构映射：`x86_64→amd64`、`aarch64/arm64→arm64` | 其他架构直接拒绝 |
| 命令齐备：`curl`、`tar`、`openssl`、`sha256sum`/`shasum` | 报错并给出该发行版安装命令（apt/dnf/yum 三选一，仅打印不执行） |
| 磁盘：`/usr/local/bin` 与 `/etc` 至少 50MB 可用 | 报错 |
| 参数校验：`--center` https（除 `--insecure-http`）、`--agent-id` 是 UUID | 退出码 2 |
| `mktemp -d` + `trap` 清理（含异常退出） | 失败即中止 |

### 6.2 凭证获取（安全核心）

**判定顺序**（与 `docs/agent.md` §6.1 一致）：

1. `--key-file` / `--secret-file` 指向的文件**已存在且非空** → 读取（✅ Q6：这两条路径即最终落点；脚本只读取内容做校验与权限校正，**不重写内容**）→ 校正属主/权限为 `vantage:0600`。
2. 否则 `VANTAGE_KEY` / `VANTAGE_SECRET` **均已设置** → 取之；落盘后**立即 `unset`**。
3. 否则存在可控终端 → 从 **`/dev/tty`** 交互读取（`stty -echo` 关闭回显，读完恢复；空输入重问，最多 3 次）→ 写入 `--key-file` / `--secret-file` 指定路径（未指定则默认路径）。
4. 否则（无 `/dev/tty`，如 cron/CI）→ **fail closed**：报错并指向形式①/③，⛔ 不读 stdin、⛔ 不等待。

**硬规则**：

- ⛔ **不存在 `--key <明文>` / `--secret <明文>` 参数**；除 `getopt` 外再做一次显式拒绝（`case "$1" in --key|--secret|--key=*|--secret=*) exit 2`）。
- ⛔ 任何路径都不把凭证写进 stdout/stderr/日志/`--help`（含截断形式）；`--dry-run` 用 `<redacted>` 占位。
- 交互必须读 `/dev/tty`：脚本体本身占着 stdin（`sh -s --`），⛔ 读 stdin 会直接 EOF。
- 临时缓冲：`mktemp` 0600，写完立即 `rm -f`；⛔ 不用 `/tmp/key.txt` 这类固定名。
- 格式校验：`vk_` / `vs_` 前缀 + 长度下限 + 去首尾空白 + 拒绝含换行的值。若两个文件内容互换（key 文件里放着 `vs_`），给出"请把两个路径对调"的明确诊断（与 Agent 侧报错一致）。
- 形式①落地后打印：**「env 形式已进 shell history；本机 root 可读 `/proc/$PID/environ`；如需清理请执行 `history -d`，下次建议用交互式或 `--key-file`」**（与中心 `security_note` 同义）。
- 若 `sudo` 因 `env_reset` 丢了变量（形式①误用 `sudo` 而未加 `-E`），给出明确诊断而不是"凭证为空"。

### 6.3 下载与校验

- 按 §4.2 **源链逐个尝试**：每源内先定 `TAG`（或用 `--version`）→ 下载 `tar.gz` + `SHA256SUMS` + `.sig` → 校验；失败只换源，⛔ 不换清单。
- `curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 300 -A "vantage-install/${SCRIPT_VERSION}"`（仅 `--insecure-http` 时放宽 `--proto`）。
- **校验顺序（⛔ 不可颠倒）**：① 内嵌公钥验签 `.sig` → ② 从已验签清单取目标行做 sha256 比对 → ③ 解包到 `$tmp/unpack`。验签失败或缺 `openssl`/`.sig` → 退出码 6；`--no-verify` 才跳过 ①。
- 解包安全（以 root 运行，须防路径穿越）：解包后用 `find` 确认**恰好一个普通文件**、名为 `vantage-agent`、⛔ 非符号链接/非硬链接；`tar` 使用 `--no-same-owner`（GNU tar 可用时）。
- 落盘用 `install -m 0755 -o root -g root`，⛔ 不直接 `cp`（避免保留可疑权限位）。
- 「实际使用的源 + `verified` + 公钥指纹」写进 `install-state`。

### 6.4 用户与目录

| 对象 | 属主:组 | 权限 | 说明 |
|---|---|---|---|
| 运行用户 `vantage` | — | — | `useradd --system --no-create-home --home-dir /var/lib/vantage --shell /usr/sbin/nologin`；**已存在则复用**（不改其 shell） |
| `/etc/vantage` | `root:vantage` | `0750` | 配置目录 |
| `/etc/vantage/config.yaml` | `root:vantage` | `0640` | 运行用户可读、普通用户不可读 |
| `/etc/vantage/agent.key` / `.secret` | `vantage:vantage` | **`0600`** | ⚠️ **不能 0640**：Agent 检查 `perm & 0o077 == 0`，组/其他位非 0 直接拒启动（§1 事实 6） |
| `/etc/vantage/install-state` | `root:root` | `0644` | 安装元数据（版本/源/`verified`/公钥指纹/时间/脚本版本），⛔ 绝不含凭证 |
| `/var/lib/vantage` | `vantage:vantage` | `0750` | 预留；当前 Agent 运行期不写 |
| `/usr/local/bin/vantage-agent` | `root:root` | `0755` | 二进制 |

### 6.5 写配置（含冲突规则，✅ Q10）

- 生成 `config.yaml`：模板见 §8.2，注入 `--center` / `--agent-id` / `--host-alias` / 凭证路径；⛔ 不写 `log.file`（走 journald）；⛔ 不写任何未知键（Agent 对未知字段**一律拒绝**，写错一个字就启动失败）。
- **已有 `config.yaml` 时**：
  - 其中 `agent.id` 与 `center.url` 与本次参数**一致** → 原样保留（幂等重跑的正常路径），打印「配置未改动」；
  - **不一致** → **报错退出（退出码 3）**，打印「现有配置指向 agent `<旧>` / center `<旧>`，本次要装的是 `<新>`」，并给两条出路：① `--force`（**先备份为 `config.yaml.bak.<时间戳>` 再整体重写**）；② 手工备份后删除再重跑。
  - ⛔ **不做 YAML 字段级修补**：纯 POSIX `sh` 没有可靠的 YAML 编辑手段（`sed`/`awk` 改结构化文件必然在某些排版下出错）。
  - ⛔ **不静默覆盖**：会冲掉用户手调的采集/探活/过滤规则，且往往几周后才被发现。
- 以运行用户身份跑 `vantage-agent --config /etc/vantage/config.yaml --check`（`runuser -u vantage --`，回退 `su -s /bin/sh -c`）：
  - 成功 → 打印「生效摘要」；失败 → 打印 Agent 原文错误 + 下一步命令，**中止安装**（此时二进制尚未落盘、unit 未创建）。

### 6.6 冒烟上报（✅ Q4；在装 unit 之前）

> 顺序设计：把真实上报放在**创建服务之前**，"失败即安装失败"就变成"**还没装到那一步就停了**"，比"装完再回滚"少一半失败面，也⛔ 不会留下一个曾短暂运行过的服务。

1. 二进制先落到最终路径 `/usr/local/bin/vantage-agent`（`install -m 0755 -o root -g root`）；此时 unit 尚未创建。
2. `runuser -u vantage -- /usr/local/bin/vantage-agent --config /etc/vantage/config.yaml --once`，超时上限按 Agent 自身口径 `2×center.timeout + report.retry.max_elapsed`（默认约 50s）。
   - **成功** → 打印 `上报成功：server_ts=… bytes=…`，继续 §6.7。
   - **失败** → 打印 Agent 原文错误 + 按错误码分类处置（DNS/连接 → 防火墙与 `--center`；TLS → 证书/`ca_file`；401 `signature_invalid` → key/secret 不匹配或反代改写 body；401 `timestamp_skew` → 校时；429 → 中心限流），随后按 §6.9 清理（删本次落盘的二进制；⛔ unit 从未创建），退出码 8。
   - ⚠️ 取舍如实写明：这把「安装成功」与「网络/凭证真的通」绑在一起——好处是**不会留下一个装上了却永远不上报的 Agent**（本项目最难排查的一类"成功安装"），代价是中心暂时不可达时安装会失败（用 `--no-smoke-test` / `--no-start` 明确绕开，并提示「需自行确认上报」）。

### 6.7 装 unit、启动与收尾

1. 写 `/etc/systemd/system/vantage-agent.service`（§8.1）→ `daemon-reload` → `enable` → `start`。
2. `systemctl is-active vantage-agent` == `active`（等最多 10s）；失败 → §6.9（移除本次新建的 unit 与二进制；⛔ 保留 `/etc/vantage`），退出码 8。
3. 从 journald 抓最近 20 行，确认出现 `vantage-agent 启动`，且不含 `failed`/`panic`。
4. 写 `install-state`。
5. 打印收尾：面板预期（已冒烟上报一次，应立刻/在一个周期内出现）、`verified` 与公钥指纹、下一步（编辑 `config.yaml` 加探活 → `vantage.sh reload`）、`vantage.sh status` 提示。

### 6.8 幂等与接管

- 检测到 `/usr/local/bin/vantage-agent` 已存在 → 走 **`upgrade` 分支**（保留配置与凭证），而不是重装；`--force` 才允许重写 `config.yaml`。
- ✅ **Q12 接管**：存在二进制/unit 但**无 `install-state`**（早期手工装的机器，如 A-T09 那台）→ 保留现有 `config.yaml` 与凭证 → 装/更新 unit → 补写 `install-state` → 冒烟上报。⛔ 不要求先卸载干净。
- 检测到 `VANTAGE_KEY` 已设置、但机器已安装且未给 `--key-file` → **不静默改用新凭证**，提示用户明确意图（防误踩轮换窗口：中心轮换后旧凭证**立即失效**，见 `docs/agent.md` §6.1）。

### 6.9 失败清理与回滚

- 全程只写临时目录，最后一次 `mv`（同文件系统 `rename`）落盘；`trap` 保证异常退出时删除临时目录与临时凭证文件。
- 落盘顺序：凭证/配置 → 二进制 → **冒烟上报** → unit → 启动。任一步失败：
  - **冒烟上报失败** → 删本次落盘的二进制；unit 未创建、服务未启动（无需回滚）；退出码 8。
  - **替换后启动失败（upgrade 路径）** → 恢复 `vantage-agent.prev` → 重新 `restart` → 退出码 8。
  - **首次安装启动失败** → 停服务、移除**本次新建**的 unit 与二进制；⛔ **不删** `/etc/vantage`（用户可能已在其中放了凭证，宁可留下并打印路径）。配置与凭证保留意味着**修好网络或换对凭证后，重跑同一条命令即可**（走 upgrade 分支，不覆盖 `config.yaml`）。
- ⚠️ 回滚**不做**的事：⛔ 不改中心侧任何数据（那次冒烟上报若已成功落库就留着，是否清理由管理员在面板决定）。

---

## 7. 其他子命令

### 7.1 `upgrade`（✅ Q9：替换前预演）

1. 解析目标版本（§4.2）；与 `install-state` 中版本相同且未 `--force` → 提示「已是最新」并退出 0。
2. 下载 + 验签 + sha256 + 解包（同 §6.3）。
3. 候选二进制落到 **`/usr/local/bin/vantage-agent.new`**（`install -m 0755 -o root -g root`）。⚠️ 与目标**同目录** ⇒ 后续替换是 `rename` 原子操作；⛔ 不放在 `mktemp -d` 的 0700 目录里——`vantage` 用户穿不过去会执行失败。
4. **预演 A（离线）**：`runuser -u vantage -- …/vantage-agent.new --check` → 失败：删 `.new`，⛔ 线上零改动，退出码 8。
5. **预演 B（真实上报）**：`runuser -u vantage -- …/vantage-agent.new --once` → 失败：删 `.new`，⛔ 线上零改动（服务仍跑旧版本，无需回滚），打印分类处置，退出码 8。
   - ⚠️ 放替换前：这样"升级失败"= "根本没替换"，服务全程不中断，也不存在"新版本短暂跑过一段"的中间态。
   - ℹ️ 这会多产生一条真实上报（与线上服务的上报并存，`batch_id`/nonce 各自随机，互不冲突）——它正是"新二进制 + 现有配置 + 现有凭证"能否真正通路的唯一证据。
6. 备份 → `mv` 候选二进制到 `/usr/local/bin/vantage-agent`（旧版留作 `vantage-agent.prev`）。
7. `systemctl restart`；10s 内不为 `active` → **自动回滚** `.prev` + 再次 `restart` + 退出码 8（并打印排查命令）。
8. 更新 `install-state`；打印「旧版本 → 新版本」。
9. ⛔ 不自动升级、不检查更新、不接受中心指示（单向宗旨）。

### 7.2 `uninstall`

- 默认：`stop` → `disable` → 删 unit + `daemon-reload` → 删二进制；**保留** `/etc/vantage/`（配置 + 凭证）、`install-state`、日志；打印保留路径与「彻底清理」命令（✅ G9）。
- `--purge`：先打印**将被删除的清单**，需交互输入 `yes`（⛔ `-y` 不可跳过，⛔ 无 TTY 直接拒绝）；删除配置目录、状态文件、运行用户（仅在「无该用户的其他文件属主」或明确 `--remove-user` 时）。
- ⛔ 任何情况下都不动中心侧数据、不删数据库。

### 7.3 `start` / `stop` / `restart` / `reload`

- 透传 `systemctl`，并做「服务是否已安装」前置判断（给出「先 install」的提示而不是 systemd 原文报错）。
- `reload` 后额外读最近日志：出现 `config_reload_failed` → 明确提示「新配置校验失败，已回退旧配置」+ 退出码 7（这是 `reload` 最容易被误认为成功的地方）。

### 7.4 `status`（`--json` 可选）

| 行 | 来源 |
|---|---|
| 服务状态 / 进程启动时间 | `systemctl show -p ActiveState,SubState,ExecMainStartTimestamp` |
| 已装版本 / 二进制路径 / 来源源 / `verified` | `vantage-agent --version` + `install-state` |
| **最后上报时间** | `journalctl -u vantage-agent -o short-iso -n 5000` 中最后一条 `上报成功` 的时间戳（回退：最后一条 `心跳已上报`） |
| 最近失败 | 最后一条 `上报失败（…）`（含 HTTP 码），与最后成功时间对比给「可能原因」 |
| 生效配置摘要 | `vantage-agent --check`（以运行用户身份）输出的摘要行 |
| 凭证权限体检 | `stat -c '%a %U:%G'` 两个凭证文件 + 目录权限；不合格给出 `chmod/chown` 命令（不打印内容） |
| 中心连通性（可选） | `curl -fsS -m 5 ${center}/healthz`；⛔ 不发送任何凭证 |

⚠️ 「最后上报时间/最近失败」靠解析 Agent 的日志文案 → **日志文案若改动，这里要同步改**。

---

## 8. 落地资产

### 8.1 systemd unit 草案

> 边界：`install` 必须把 unit 落盘并启用（`docs/agent.md` §12.1 第一条；`start/stop/restart/reload/status` 本质是 `systemctl` 封装），所以 unit 是脚本的**依赖物**；但 unit 的**内部取舍**（加固项、内存上限、日志去处）属 **A-T11**（Q3/Q5），⛔ 不阻塞脚本实现——脚本把它当参数化模板。

```ini
[Unit]
Description=Vantage Agent - 主机指标采集与上报
Documentation=https://github.com/haozi-123-wow/Vantage
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vantage
Group=vantage
ExecStart=/usr/local/bin/vantage-agent --config /etc/vantage/config.yaml
ReloadSignal=SIGHUP
Restart=always
RestartSec=5s
TimeoutStopSec=10s

# —— 加固（docs/agent.md §9）——
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=/var/lib/vantage

# —— 资源 ——
TasksMax=64
# MemoryHigh / MemoryMax：⏭ 移交 A-T11（Q3）——Agent 自设 GOMEMLIMIT=48MB 已封一层，
#   硬顶设错会变成"假离线 + 数据缺口"，等真机实测内存曲线后再定。
# OOMPolicy=continue

[Install]
WantedBy=multi-user.target
```

⚠️ **两条「看起来更安全但会直接打断采集」的加固项（⛔ 不要加）**：

- `PrivateDevices=true` → 读不到块设备统计，`disk.*` 缺失；
- `ProcSubset=pid`（或类似收缩 `/proc` 的项）→ 读不到 `/proc/stat`、`/proc/meminfo`、`/proc/net/*`，`cpu/mem/net` 全废。

➕ 若 A-T11 最终选择文件日志（Q5）：另加 `ReadWritePaths=/var/log/vantage`，并在 `config.yaml` 里写 `log.file`。
➖ ICMP 权限（`cap_net_raw`）**不属于本脚本范围**（✅ Q8）：脚本只保证 unit **不放宽权限**（如上：`CapabilityBoundingSet=` / `AmbientCapabilities=` 皆为空）。Agent 拿不到该能力时会自动降级为 TCP 探测 + WARN（✅ G8）；真要 ICMP 由 A-T13 文档给手工步骤与风险说明。

### 8.2 `config.yaml` 最小模板

```yaml
# 由 vantage.sh install 生成；字段全表见 docs/agent.md §8。
# ⚠️ Agent 对未知字段一律拒绝：加字段前先查文档。
center:
  url: "https://vantage.example.com"      # = --center
  timeout: 10s
agent:
  id: "00000000-0000-0000-0000-000000000000"   # = --agent-id
  key_file: "/etc/vantage/agent.key"
  secret_file: "/etc/vantage/agent.secret"
host:
  alias: "web-01"                         # = --host-alias（默认本机 hostname）
# —— 以下均为缺省值，按需打开（reload 后热加载）——
# log:
#   level: info                           # debug/info/warn/error；format: text|json
#   # file 留空 = 走 stdout（systemd 收进 journald）；日志去处见 A-T11（Q5）
# collect:
#   disk:    { enabled: true, interval: 60s }
#   process: { enabled: true, interval: 60s, top_n: 10 }
# probes:
#   - { name: "site-health", type: http, url: "https://example.com/healthz", expect_status: [200], interval: 30s }
# filters:
#   disk: { exclude_fs: ["tmpfs","devtmpfs","overlay"] }
# resource:
#   gomemlimit_mb: 48
```

- 采集/上报周期**沿用代码默认**（30s / 60s / 上报 30s / 心跳 60s），模板不重复写死——避免与 `Defaults()` 双份漂移（这正是 2026-10-04 那次 15s↔30s 事故的成因）。
- ⛔ 模板中不得出现任何真实域名、IP、账号、凭证（`docs/agent-testing.md` §10 红线）。

---

## 9. 与中心侧的联动

| 项 | 结论 |
|---|---|
| 参数名 | 由中心 `agentAdmin.service.js` 生成，脚本**只接受不改**（§5.2 前四个参数） |
| 脚本地址 | 运维在中心 `.env` 配 `AGENT_INSTALL_SCRIPT_URL`（必须 https）→ 面板给出三段命令（✅ 已实现）；✅ Q7 后配**自建站**地址，GitHub raw 兜底 |
| 凭证路径 | 中心默认给 `/etc/vantage/agent.key` / `.secret`，与脚本默认一致（⛔ 若改脚本默认值，必须同步中心常量与 `docs/api.md`） |
| 本期中心代码改动 | **0 行**（✅ Q6 语义与中心现有三条命令自洽；⛔ 不需要动 `docs/api.md` §4.4 或前端文案） |

---

## 10. 安全红线核对表（实施后逐条可验证）

| # | 红线 | 脚本落实 | 验证方式 |
|---|---|---|---|
| 1 | ⛔ 无 `--key`/`--secret` 明文参数（#37） | 显式 `case` 拒绝 + 长选项表不含这两项 | grep 断言 + `--help` 全文检查 |
| 2 | env 形式落地后即时清理（#37） | 写完文件立即 `unset` + 打印 history 提示 | 断言 `unset` 在写盘之后、且全程无 `echo "$VANTAGE_KEY"` |
| 3 | 凭证不进日志/`--help`/`ps` | 不 `export` 给子进程、不用 `set -x` 覆盖凭证段、`--dry-run` 用 `<redacted>` | 安装日志 grep `vk_`/`vs_` 必须 0 命中 |
| 4 | 凭证 0600 且属运行用户 | `install -m 0600 -o vantage`；`install-state` 不含凭证 | `stat` 断言 + `--check` 通过 |
| 5 | ⛔ 通信严格单向、中心零下发 | 脚本不读取中心任何指令；`upgrade` 仅人工触发 | 代码审查：全脚本只有 `/healthz` 一个 GET 且不带凭证 |
| 6 | 全链路 HTTPS | `--proto '=https'`；`--center` 非 https 默认拒绝 | 负例：`--center http://…` 必须失败 |
| 7 | 破坏性操作需确认（G9） | `uninstall --purge` 必须输入 `yes`；⛔ `-y` 不跳过 | 负例：`-y --purge` 仍停在确认 |
| 8 | 命令注入面 | ⛔ 无 `eval`；变量引用一律加引号；`--source`/路径走白名单字符校验并拒绝换行 | ShellCheck + 断言 `--source 'https://x; rm -rf /'` 被拒 |
| 9 | 信任根在内嵌公钥（✅ Q2） | 验签先于 sha256；缺 `openssl`/`.sig` 即失败；⛔ 无"运行期换公钥"路径；`--no-verify` 必须留痕 | 负例：换包/换清单/用别的私钥重签/删 `.sig`/卸 `openssl` 都必须失败；`--no-verify` 后 `status` 显示 `verified=false` |
| 10 | 私钥不进仓库/日志（✅ Q2） | `publish-release.sh` 只从环境变量取私钥路径 | 发布日志 grep `PRIVATE KEY` 必须 0 命中 |
| 11 | 安装期不落明文临时文件 | `mktemp` 0600 + `trap` 清理；凭证经文件/`/dev/tty` 而非参数 | 异常中断后 `find /tmp -name '*vantage*'` 为空 |

---

## 11. 兼容性与边界

| 维度 | 支持 | 不支持（明确报错，不做权宜实现） |
|---|---|---|
| init | systemd（Debian 11/12、Ubuntu 22.04/24.04、RHEL/Rocky/Alma 9） | openrc（Alpine）、无 init 容器、WSL1 |
| shell | `dash`、`busybox ash`（POSIX；⛔ 不用 `pipefail`、`[[ ]]`、数组、`local -n`） | bash 专有语法 |
| 架构 | `amd64`（x86_64）、`arm64`（aarch64） | `armv7`、`i386` |
| 输入方式 | 交互式 TTY、env、`--key-file` | 无 TTY 且无凭证（fail closed） |
| 网络 | 直连 GitHub / https 镜像 | http 源（除 `--insecure-http` 测试） |

⚠️ `curl | sh` 的固有代价（不粉饰）：脚本内容用户看不到就执行了。对策：脚本在仓库里可审计、URL 固定、脚本内不再 `curl` 第二次、面板同时给交互式与 `--key-file` 两种形式。

---

## 12. 测试与验收

### 12.1 本机可做（Windows 开发机）

1. `sh -n agent/deploy/vantage.sh` 语法检查（Git for Windows 自带 `usr/bin/sh.exe`；不可用则在 Linux 容器内做）。
2. **静态断言**（`agent/deploy/tests/static-assert.sh`）：⛔ 无 `--key`/`--secret` 参数、⛔ 无 `eval`、必须出现 `unset VANTAGE_KEY`、`--purge` 必含确认、`--help` 不含 `vk_`/`vs_` 样例。
3. `build-release.sh` 只验**交叉编译产物**（`CGO_ENABLED=0 GOOS=linux`，与 `docs/agent-testing.md` §6 同口径）。

### 12.2 需真机/容器（**按协作约定由 Owner 执行**，命令可直接复制）

```bash
# 起一个带 systemd 的容器
docker run -d --name vantage-verify --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw jrei/systemd-debian:12
docker exec -it vantage-verify bash

# ① 正例（交互式形式）
curl -fsSL https://<自建站>/vantage.sh | sudo sh -s -- install --center https://<中心> --agent-id <uuid>
sudo vantage.sh status

# ② 负例清单（每条都必须按预期失败且不留下半成品）
#    a) 错 sha256（改 SHA256SUMS 后重跑）→ 退出码 6、无新二进制
#    b) --center http://…              → 退出码 2
#    c) 无 TTY 且无凭证（cron）        → 退出码 4、不挂起
#    d) 非 root                        → 退出码 3
#    e) 无 systemctl（容器默认）        → 退出码 3
# ③ 幂等：连续 install 两次 → 第二次走 upgrade 分支、config.yaml 未被覆盖
# ④ 接管：手工放好 config/凭证但删掉 install-state → install 应补齐状态并成功（Q12）
# ⑤ uninstall 默认保留 → /etc/vantage 仍在；uninstall --purge（-y）→ 仍需确认
# ⑥ 源链（Q1）：自建站改成不存在的域名 → 自动落到镜像/GitHub 并打 WARN；
#    三源全断（或 --source 指向死地址，此时**不回退**）→ 退出码 5 且逐源打印原因
# ⑦ 跨源不混用：A 源定版本后人为让 A 源 tar.gz 404 → 必须换源**重新解析**，⛔ 不得去 B 源取包
# ⑧ 签名（Q2，严格默认）：换一个自制的包（清单与包同改）→ 验签必须失败、退出码 6；
#    用另一把私钥重签 → 必须失败；删 .sig → 退出码 6；卸 openssl → 退出码 6；
#    只有 --no-verify 能放行，且随后 status 必须显示 verified=false
# ⑨ 冒烟上报（Q4，默认开）：--center 指向不可达地址 → install 退出码 8，
#    不留下本次落盘的二进制、**根本没有创建 unit**（/etc/vantage 保留，重跑可继续）；
#    --no-smoke-test 时装完即退出 0，并打印「需自行确认上报」
# ⑩ 升级预演（Q9）：新版本包必然上报失败 → upgrade 退出码 8、线上二进制与服务完全没变
#    （.prev 也不该被覆盖）
# ⑪ 升级后回滚：新版本能过两道预演但启动即崩 → upgrade 自动回滚 .prev、服务恢复 active、退出码 8
```

### 12.3 验收（对齐 A-T10/A-T11/A-T12/A-T13 原文）

- **A-T10**：子命令齐 + 验签与 sha256 双重校验 + 低权用户 + unit + 启动；`--purge` 交互确认；`status` 五项齐全（含 `verified`）。
- **A-T11**：unit 含 §8.1 全部加固项；`systemctl reload` 触发 SIGHUP；改坏 `config.yaml` 后 `reload` **保留旧配置**且日志有 `config_reload_failed`（⛔ 不进半配置状态）。
- **A-T12**：三种形式全部可用；env 形式落地即 `unset` 并提示；⛔ `--key` 在脚本与二进制中都不存在（grep 断言）；脚本参数名与面板一键命令一致。
- **A-T13**：`setcap` opt-in + 风险说明 + 出站白名单示例；文档命令不含真实地址/账号。

---

## 13. 实施顺序

| 步 | 内容 | 前置 |
|---|---|---|
| 0 | 生成发布密钥对（ECDSA P-256，私钥离线）+ 公钥固化进脚本；`build-release.sh` + `publish-release.sh`（含签名与三源回读自检）；首个 Release `v0.1.0`（含 `SHA256SUMS` / `.sig`） | ✅ Q1/Q2、A-T22（LICENSE） |
| 1 | `vantage-agent.service` + `config.minimal.yaml`（unit 取舍见 A-T11，先用 §8.1 草案） | — |
| 2 | 脚本骨架：参数解析、前置检查、`--dry-run`、退出码、`version/help` | — |
| 3 | 凭证三形式 + `/dev/tty` + `unset` + 静态断言测试 | 步 2 |
| 4 | `install`：下载/校验/用户目录/配置/`--check`/冒烟上报/unit/启动 | 步 1–3 |
| 5 | `upgrade`（替换前预演 + 原子替换 + 自动回滚）与 `status` | 步 4 |
| 6 | `uninstall`（含 `--purge` 确认）、`reload` 失败识别 | 步 4 |
| 7 | A-T13 运维文档（`setcap`、出站白名单、凭证替换流程） | 步 6 |
| 8 | 中心配 `AGENT_INSTALL_SCRIPT_URL` → 面板一键命令端到端复核 + 回填 `docs/agent-status.md` / `docs/agent-todo.md` | 步 4、7 |

⚠️ **步 0 必须由 Owner 在自己终端执行**（生成私钥、打 tag、发 Release、上传自建站与镜像）：DSH 沙箱内推不了远端，也不该接触私钥。步 1–8 可在沙箱内完成编码，真机/容器验证按 §12.2 由 Owner 执行。

---

## 14. 溯源与变更记录

**溯源**

| 本文 | 来源 |
|---|---|
| §1、§9 参数名与命令形态 | `docs/api.md` §4.4、`server/src/services/agentAdmin.service.js` L169–183 |
| §2.1、§5.2、§6.2、§10#1/#2 | 设计 §12.2、§13 安全清单；`docs/agent.md` §6.1；决策 #37 修订 |
| §4.1/§4.2/§4.5 | 设计 §12.2「GitHub Releases / 镜像 + sha256」+ Owner Q1 拍板（三源并存） |
| §4.3/§4.6 | Owner Q2 拍板（内嵌公钥 + openssl 分离签名，信任根 = 离线私钥） |
| §7.1 | 设计 §12.4 升级（用户主动、配置保留、中心不参与分发） |
| §6.4、§8.1 | `docs/agent.md` §9（非 root 与 systemd 加固）；`credentials.go`（0600 硬校验） |
| §6.5、§8.2 | `docs/agent.md` §8（字段与校验规则）；`config.go`（未知字段拒绝、`Defaults()`） |
| §7.2/§7.3/§7.4 | `docs/agent.md` §12.1 + G9 / §7（SIGHUP）/ §12.3（`status` 建议项） |
| §11 | `docs/agent.md` §13（跨平台路线）；设计 §17 |
| §12.3 | `docs/agent-todo.md` A-T10/A-T11/A-T12/A-T13 验收条目 |

**变更记录**（2026-10-05，同日多轮；细节演化见 git 历史）

| 主题 | 内容 |
|---|---|
| 首版 | 现状核对、交付物、CLI 契约、install 流程、unit 与 config 草案、安全红线、验证方案 |
| 分发与校验（Q1/Q2） | Q1 定三源并存 → §4.1/§4.2/§4.5；Q2 经「能否自建权威 / 用权威 DNS」讨论后定**内嵌公钥 + openssl 分离签名（严格默认）** → §4.3/§4.6 |
| 安装与升级流程（Q4/Q9） | Q4 定「装完必须真发一次上报」并前移到**装 unit 之前**（§6.6）；Q9 定「升级也做真实上报」并实现为**替换前预演**（§7.1） |
| 范围界定（Q7/Q8） | Q7 定落点 `agent/deploy/` + 自建站 URL；Q8（ICMP 权限）Owner 界定为 Agent 运行侧事务 → **撤销**，不在脚本内提供开关 |
| 收口与整理（Q6/Q10/Q11/Q12） | Q6/Q10/Q11/Q12 按默认取值（台账 ➕）；本文重排为「台账在前 + 单一出处 + 统一标记」，修正原 §6.5 自相矛盾（"只补缺失字段"在纯 sh 下不可实现） |
