# Vantage API 落地状态与实现规范（api-status）

> **定位**：本文件承接 `docs/api.md` 的**落地状态、实现期规范、决策记录、待拍板索引**——2026-10-04 从 `docs/api.md` 的「实现进度速览」「§4.1.1 实现规范与落地状态」「§6 用例状态注」「§7 待 Owner 拍板清单」迁出。
> **分工**：`docs/api.md` = 接口契约（路径 / 认证 / 请求参数 / 返回字段 / 错误码 / 语义），**只写已定的东西**；本文件 = 这些契约**落地到什么程度、为什么这么实现、还有哪些没拍**。
> **交叉文档**：`docs/database.md` §7（Redis 键空间）、`docs/geetest-captcha.md`（极验变更方案与落地记录）、`docs/slider-captcha-selfbuilt.md`（自建滑块实施规范）、`docs/frontend.md`（面板侧）。

**状态标记**（本文件专用；`api.md` 只用 `✅ 已定 / ⏳ 未实现 / ⛔ 禁止`）

| 标记 | 含义 |
|---|---|
| ✅ 已落地 | 代码已落地**且有测试**（或验收中已注明例外） |
| 🔶 已落地待验证 | 代码已落地，但还差 `npm test` / `vue-tsc` / 真机联调 |
| ⏳ 未实现 | 契约已定（或待定），代码尚未落地 |

---

## 1. 落地进度速览（2026-10-04）

| 模块 | 状态 | 契约落点 |
|---|---|---|
| 健康检查（`/healthz` `/readyz` `/version`） | ✅ 已落地 | `api.md` §1.6 |
| Agent 上报 / 心跳（HMAC 签名） | ✅ 已落地（M1） | `api.md` §2 |
| 面板账号：登录 / me / 登出 / 改密（会话 + CSRF + 审计） | ✅ 已落地（B4/B5） | `api.md` §4.1；规范见本文件 §3 |
| 面板 2FA（绑定 / 解绑 / 第二步 / 恢复码） | ✅ 已落地（B6/B7） | `api.md` §4.1；规范见本文件 §3 |
| 登录人机验证（滑块，**自建**） | ✅ 已落地后端（S1–S2）；🔶 前端 S3 待 `vue-tsc` 与联调 | `api.md` §4.1 |
| 登录人机验证（**极验 v4**，官方按钮） | ✅ 已落地后端（S5–S7）；🔶 前端 S8 待 `vue-tsc` 与联调 | `api.md` §4.1；变更方案 `docs/geetest-captcha.md` |
| 首管员 / 离线救援 CLI | ✅ 已落地 | 本文件 §3.5 |
| 离线判定（`offline_sweep` 定时任务） | ✅ 已落地（2026-10-04） | 本文件 §4.4；`database.md` §8.2 |
| 公开只读快照（`/api/public/*` 四个端点） | ✅ 已落地（2026-10-04） | `api.md` §3.2；方案 `docs/server-status-api.md`；决策见本文件 §4.6 |
| 主机列表 / 汇总 / 详情 / 探活历史 / IP 时间线 / 进程 Top | ✅ 已落地（2026-10-04） | `api.md` §4.2；决策见本文件 §4.6 |
| 主机时序查询（`/hosts/{id}/metrics`：历史曲线） | ✅ 已落地（2026-10-05；参数全部定稿） | `api.md` §4.3；决策见本文件 §4.8 |
| 添加 Agent（`POST /api/v1/agents`：签发凭证，明文仅一次） | ✅ 已落地（2026-10-04） | `api.md` §4.4；决策见本文件 §4.7 |
| Agent 管理的其余端点（列表 / 详情 / PATCH / rotate / disable｜enable / revoke / rotate-reminder-test） | ⏳ 未实现（M3；两处待定稿见 §4.7） | `api.md` §4.4 |
| 告警 / 通道 / 静默 / 设置 / 用户 / 审计查询 | ⏳ 未实现（M3） | `api.md` §4.5–§4.10 |
| WebSocket（`/ws/*`） | ⏳ 未实现（M3） | `api.md` §5 |

**当前可用端点数 = 29**：3 个探针 + 2 个 Agent 上报端点 + 13 个认证会话端点 + 4 个公开状态端点 + 6 个私有状态端点 + 1 个 Agent 管理端点（`api.md` §4.1/§3.2/§4.2/§4.4）。
**未实现端点当前调用会命中 404 `not_found`**（路由未注册 → §1.3 统一错误信封）。

---

## 2. 验收待办（**由 Owner 执行**，agent 不在本机跑目标环境）

| # | 动作 | 期望 |
|---|---|---|
| 1 | `cd server && npm test` | B 系列 + S 系列全绿（含 `test/auth.captcha.test.js`、`test/auth.captcha.geetest.test.js`、`test/geetest.test.js`） |
| 2 | `cd web && npx vue-tsc --noEmit`（或项目脚本） | S3 / S8 前端通过类型检查 |
| 3 | 重启 vantage-core | §4.1 的 13 个端点全部可用 |
| 4 | 真机绑定 2FA：`设置 → 绑定 2FA` → 扫码 → 输 6 位码 → `enable` | 认证器显示 `Vantage:<用户名>`；返回 10 个恢复码 |
| 5 | 登出再登录 → 第二步验证 | 实时码通过；**30s 内重复用同一码被拒**（防重放） |
| 6 | 用一个恢复码登录 | 提示「剩余 9 个」；打到 ≤2 时前端强提示 |
| 7 | `security.require_2fa=true` 下用未绑定账号登录 | 被引导到强制绑定页并完成绑定 |
| 8 | 极验真机：首次登录不出现按钮 → 故意输错密码 → 出现官方按钮 → 通过后自动重提 | `docs/geetest-captcha.md` §10.2 的人测部分 |
| 9 | （可选）`node server/scripts/create-user.js --reset-2fa <username>` | 被锁用户可重新登录 |
| 10 | `cd server && npm test` | 新增三组全绿：`test/status.service.test.js`（28）、`test/public.api.test.js`（12）、`test/hosts.api.test.js`（11） |
| 11 | `curl -s localhost:8787/api/public/hosts \| jq` | 200，`{items, next_cursor:null, updated_at}`；每项有 `slug`、⛔ **无 `id`**、⛔ 无 IP 字段；无数据时 `snapshot.*` 为 `null`（不是 0） |
| 12 | `curl -s localhost:8787/api/public/summary \| jq` | `total = online + offline + disabled`；`alerts` 三个 0 |
| 13 | `PATCH /api/v1/settings {"public_view.enabled": false}` 后重放 #11（≤30s 生效） | **404** `not_found`（⛔ 不是 403、不是空 body）；改回 true → 立刻 200 |
| 14 | 反复请求 `/api/public/hosts` 61 次（`RATELIMIT_PUBLIC_PER_MINUTE=60`） | 第 61 次 429 `rate_limited` + `Retry-After`；响应头有 `X-RateLimit-*` |
| 15 | 登录后 `curl -b cookie 'localhost:8787/api/v1/hosts?status=online&tag=prod&limit=5'` | 200；含 `last_ip` / `reported_ip` / `clock_drift_ms` / `ip_flapping` / `active_alerts`；`next_cursor` 为 null |
| 16 | 停掉某台 Agent，等待 **90s（阈值）+ 最多 60s（扫描周期）= 最坏 150s** | 该机在 `/api/public/hosts` 变 `offline`；其 `snapshot` 在 **5 分钟后**变全 `null`（⛔ 不是 0） |
| 17 | 断言公开响应文本中不含真实 IP | 用该机 `last_ip` 的值做字符串包含检查 → 必须为空 |
| 18 | `curl -s localhost:8787/api/v1/summary -b cookie` | 200；与 #12 的数字**完全一致**（同一个计数实现） |
| 19 | `curl -s localhost:8787/api/v1/hosts/<id> -b cookie \| jq '.current_metrics \| keys'` | 出现 `disk.used_pct{mount=/data}` 这类**全名**（私有域给原名） |
| 20 | `curl -s localhost:8787/api/public/hosts/<slug>/now \| jq` | 200；`disks[].label` 形如「磁盘 1」；**文本里不含**任何设备名 / 挂载点 / 指标名 |
| 21 | 把某台机 `disable` 后再请求 `/api/public/hosts/<slug>/now` | **404**（与"不存在的 slug"同形，⛔ 不可区分） |
| 22 | `curl -s localhost:8787/api/public/probes \| jq` | 目标为私网 IP 的显示 `内网地址`、域名只显示主机名；⛔ 响应里不含端口 / 路径 |
| 23 | 停掉 Agent 的探活一小时后 `curl .../hosts/<id>/probes -b cookie` | `availability.total` 是该窗口的**全部**探活次数；跨度过大（>30 天）→ 400 `range_too_large` |
| 24 | `curl 'localhost:8787/api/v1/hosts/<id>/processes?at=<两天前>' -b cookie` | 返回**该时刻之前最近一条**；从未采集 → `at/total/top` 全为 `null` |
| 25 | `cd server && npm test`（或只跑 `node test/agents.api.test.js`） | 9 例全绿：201 形状、明文只出现一次、库内只有哈希/密文、**用返回凭证真的能上报成功**、重名 409、校验 400、三态/RBAC/CSRF 403、`install_hint` 三种形式 |
| 26 | 登录后面板添加一台 Agent（或用 curl `POST /api/v1/agents -b cookie -H 'x-csrf-token: …' -d '{"name":"web-01"}'`） | 201；响应含 `agent_key`(`vk_…`)/`agent_secret`(`vs_…`) 各一次；`install_hint.warnings` 里能看到"未配置安装脚本地址" |
| 27 | 用 #26 的 `id`/`agent_key`/`agent_secret` 在那台机上手工写 `config.yaml` + 两个 0600 文件，然后启动 Agent | 中心日志出现首次上报；`/api/v1/hosts` 里该机变 `online`；`agents.status` 落 `online` |
| 28 | 配好 `AGENT_INSTALL_SCRIPT_URL=https://…/vantage.sh` 后重复 #26 | `install_hint.one_liner`/`interactive`/`key_file` 三段都可复制；⛔ 三段里都不得出现 `--key <明文>` 形式 |

---

## 3. 认证与会话实现规范（原 `api.md` §4.1.1）

### 3.1 会话模型 ✅ 已落地

Redis 键空间见 `docs/database.md` §7（⛔ 不新增用途前缀）。

| 键 | 结构 | TTL | 字段 |
|---|---|---|---|
| `session:<sid>` | hash | 滑动 30min + 绝对 24h | `user_id`、`roles`（JSON 数组串，恒 `["admin"]`/`["user"]`）、`totp_ok`、`setup_required`、`created_at`、`last_seen`、`ip`、`ua`（截断 ≤200 字符）、`csrf` |
| `user_sessions:<uid>` | set | 同会话 | 该用户全部 sid |

- Cookie：名取 `config.security.session.cookieName`（默认 `vantage_sid`），`HttpOnly + SameSite=Lax + Path=/ + Max-Age=绝对 TTL`，`Secure` 由 `COOKIE_SECURE` 决定。
- `last_seen` 仅在距上次写入 > 60s 时更新（否则每个请求一次 Redis 写）。
- **集合自愈**：每次登录整理 `user_sessions:<uid>`——① 清掉「hash 已过期但成员还在」的僵尸 sid（Redis 过期只删键，没人负责 `SREM`，不清理会让集合随「登录→闲置过期→再登录」无界增长）；② 存活会话超过上限（`SESSION_MAX_PER_USER`=3）则**踢最旧**，⛔ 新建的 sid 永不参与淘汰。
- **轮换**（✅ 决策 #32）：过 2FA、改密、恢复码验证成功 → 新建 sid + 删旧 sid + 原子替换成员，响应重新下发 Cookie；⛔ `csrf` **不随轮换改变**。
- **CSRF**：会话 hash 内 `csrf` 与请求头 `X-CSRF-Token` 双提交比对。⚠️ 实现口径是**「无会话即放行」**（`server/src/middleware/authPanel.js` 的 `requireCsrf`，与 `api.md` §1.2 ② 的「会话建立前的三个端点天然豁免」等价），安全方法（`GET`/`HEAD`/`OPTIONS`）不校验。

### 3.2 三态矩阵与端点可达性（✅ 与代码一致；2026-10-04 校正）

| 状态 | 判定 | 可达 | 其余接口 |
|---|---|---|---|
| `full` | `totp_ok=1` | 全部 | — |
| `totp_pending` | 已绑 TOTP 但未过第二步 | `me`、`2fa/verify`、`2fa/recovery/verify`、`2fa/setup`（⚠️ 已绑定 → 409）、`logout*` | 403 `totp_required` |
| `setup_required` | `security.require_2fa=true` 且该账号 `totp_enabled=false` | `2fa/setup`、`2fa/enable`、`logout*`、`2fa/verify` 与 `2fa/recovery/verify`（⚠️ 直达服务层 → **409 `conflict`**） | 403 `totp_setup_required` |

⚠️ **2026-10-04 校正了两处与代码不符的旧口径**：

1. **`me` 在 `setup_required` 态返回 403 `totp_setup_required`**（不是 200/放行）——面板 `web/src/store/auth.ts` 的 `refreshMe()` 正是靠捕获它进入强制绑定流程；返回 200 会让前端以为自己已登录，然后每个请求都 403。`totp_pending` 态下 `me` 正常 200。
2. **`2fa/verify` 与 `2fa/recovery/verify` 在 `setup_required` 态没有状态守卫**，请求会直达服务层并返回 **409 `conflict`**（账号没绑 TOTP），而不是 403。旧文写的「其余接口一律 403」对这两个端点不成立。

> `security.require_2fa` 的读取：`server/src/services/settings.service.js`（`SETTING_DEFAULTS` 六个白名单 key 的默认值 + `getSettingBool`/`getSettingInt`，`settings:cache` TTL 30s，缺行取默认）；M3 的 `PATCH /api/v1/settings` 直接复用，不返工。
> ⛔ `me` 的 403 与「放行 `me`」两种表述**只能留一种**：以本表为准。

### 3.3 Redis 键 ✅ 已落地

| 键 | 用途 | TTL |
|---|---|---|
| `totp:used:<user_id>` | SET 结构存已用步号：同一 TOTP 步号只接受一次（`enable` 与 `2fa/verify` 共用） | 90s |
| `captcha:<captcha_id>` | 自建滑块的题目与答案（**`provider=geetest` 下不使用**） | 120s |
| `captcha:ok:<captcha_token>` | 一次性凭证，**值绑定解出验证的 IP** | 120s |
| `login:fail:ip:<ip>` | 登录失败计数（IP 维） | = 登录窗口 |
| `login:fail:acct:<sha256(用户名)[:16]>` | 登录失败计数（账号维） | = 登录窗口 |
| `ratelimit:captcha:<ip>` | 取题 / 验题独立限流桶 | 60s 固定窗口 |
| `captcha:vendor:down:<provider>` | 极验不可达后的**短时熔断**标记（读不到按未熔断处理；它是性能优化而非安全控制） | 30s |

全部键已在 `docs/database.md` §7 登记。

### 3.4 TOTP 与恢复码 ✅ 已落地（B1 原语 + B6/B7 端点）

- 零依赖自研（`node:crypto`）；二维码渲染用 `qrcode@^1.5.4`（本模块唯一新增运行时依赖）。
- 密钥：20 字节随机 → RFC 4648 Base32；`otpauth_uri` = `otpauth://totp/Vantage:<username>?secret=…&issuer=Vantage&algorithm=SHA1&digits=6&period=30`（label 需 URL 编码）。
- 校验：容 ±1 步（时钟漂移）+ 常量时间比较；实现自测用 **RFC 6238 Appendix B 官方向量**（明文 `12345678901234567890` → Base32 `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`；`T=59 → 287082`、`T=1111111109 → 081804`）——向量不符时**修实现**，不放宽断言。
- `totp_secret_enc`：AES-256-GCM，AAD = `totp-secret:<user_id>`（防密文跨用户搬运）。
- 恢复码：固定 10 个、每个 10 字符 Base32（去易混 `0/O/1/I`）、展示形如 `XXXXX-XXXXX`；库里**只存** `HMAC-SHA256(SECRET_KEY, "vantage:recovery:" + 归一化码)`；重新生成 = 整批替换（旧码立即作废）；使用 = 置 `used_at`（单条 `UPDATE … WHERE used_at IS NULL`，行锁保证同一码只可能成功一次）。
- **归一化在哈希口径之内**：大小写、连字符、空白、`I/L→1`、`O→0` 都能命中同一条记录。

### 3.5 首管员与离线救援 CLI ✅ 已落地

```
node scripts/create-user.js --username admin --role admin --password-stdin   # 建首个管理员
node scripts/create-user.js --list                                          # ⛔ 不返回 password_hash / totp_secret_enc
node scripts/create-user.js --reset-password <username> --password-stdin
node scripts/create-user.js --reset-2fa <username>                          # 离线版「恢复渠道二」
```

⛔ 密码只经 stdin 传入（不进 shell 历史与 `ps`），且任何路径都不打印口令/密钥。

### 3.6 落地顺序（分块交付，每块独立可验收）

> 进度（2026-10-04）：**B1–B8 ✅**、**S1–S2 ✅**、**S5–S7 ✅**、**S3/S8 🔶**（前端待编译与联调）；⏳ 全部待 Owner 跑 §2 的验收清单。

| 块 | 内容 | 验收口径 | 状态 |
|---|---|---|---|
| B1 | `utils/totp.js` + `crypto.js` 增 `totpSecretAad` / `hashRecoveryCode` / `verifyRecoveryCode` | 纯离线单测：RFC 6238 向量、Base32 往返、恢复码归一化 | ✅（`test/totp.test.js`） |
| B2 | `repositories/user.repo.js` + `scripts/create-user.js` | PGlite 真 SQL 用例（跑 0001–0008 迁移）；能建出首个 `admin` | ✅（`test/user.repo.test.js`） |
| B3 | `services/session.service.js` + `middleware/authPanel.js` + 错误码 + `totp:used` 键 | 会话生命周期：滑动/绝对超时、并发上限踢最旧、轮换、CSRF | ✅（`test/session.test.js`；⚠️ 所有 preHandler 必须 `async`，否则 Fastify 按回调式处理会让请求永久挂起） |
| B4 | `routes/auth.js`：`login` / `me` / `logout` / `logout-all` + 登录限流 + Cookie + 审计 | 桩 PG/Redis + `app.inject()`；此时前端 `/login` 首次可联通 | ✅（`test/auth.test.js`） |
| B5 | `POST /auth/password` | 改密后旧 sid 立即失效、其它会话被踢、写审计 | ✅ |
| B6 | `2fa/setup` / `2fa/enable` / `2fa/disable` | 真机扫码绑定一次（§2 第 4 条） | ✅（`test/auth.2fa.test.js`） |
| B7 | `2fa/recovery/regenerate` / `recovery/verify` + `2fa/verify` + `require_2fa` 受限态 + 防重放 | §6.2 用例 12–14 | ✅ |
| B8 | 文档回填 | 文档与代码口径一致 | ✅ |
| S1 | `utils/slider.js`（出题 / 容差 / 轨迹判定纯函数） | 容差边界、轨迹各规则正反例、200 次出题随机性、响应字符串不含答案 | ✅（`test/slider.test.js`） |
| S2 | `services/captcha.service.js` + 2 个端点 + 独立限流桶 + 两个失败计数器 + 错误码 + 键登记 | `docs/slider-captcha-selfbuilt.md` §10.3 的 AC-1…AC-13 | ✅（`test/auth.captcha.test.js`） |
| S3 | `SliderCaptcha.vue` + `Login.vue` 集成 + `store/auth.ts`/`api/private.ts` + i18n | 三条人工验证 + `vue-tsc` 通过 | 🔶 前端待验证 |
| S4 | 文档回填 | 文档与代码口径一致 | ✅ |
| S5–S7 | 极验 v4 后端（纯函数 + provider 抽象 + 端点/配置/熔断） | `docs/geetest-captcha.md` §10.1/§10.2（AC-G1…AC-G12） | ✅（`test/geetest.test.js`、`test/auth.captcha.geetest.test.js`） |
| S8 | 极验 v4 前端（`GeetestCaptcha.vue` + `utils/geetest.ts` + `Login.vue` 按 provider 选组件 + i18n） | 三条人工验证 + `vue-tsc` 通过 | 🔶 前端待验证（`docs/geetest-captcha.md` §16.7） |
| S9 | 出站并发上限（C19 第 5 条，2026-10-04 拍板要做） | 超限不等 3s 超时，按 `GEETEST_FAIL_MODE` 处理 + 单测 | ⏳ 未实现 |

### 3.7 已实现行为细则（与代码逐条对应）

**登录 / 会话 / 改密（B4/B5）**

- **登录限流**：成功与失败**都计数**（只数失败会让攻击者用正确密码"洗白"计数）；Redis 不可用时拒绝服务（503），⛔ 不做无限流登录。
- **等时校验**：账号不存在（或 SSO-only 无本地密码）时也对固定假哈希跑一次完整 Argon2——响应体与耗时都不可区分。
- **失败审计**：`auth.login_failed` 的 `detail.reason` 恒为 `invalid_credentials`；`target` 记尝试的用户名。
- **改密顺序**：验旧密码 → 写新哈希 → 轮换 sid → 踢其它会话（保留当前）→ 审计。
- **审计 action**：`auth.login` / `auth.login_failed` / `auth.logout` / `auth.logout_all` / `auth.password_change` / `auth.password_change_failed`。
- **人机验证与验密的顺序**：先卡人机验证、后验密码。反过来等于给攻击者一个 19MiB Argon2 的免费 DoS 放大器。
- **登录成功后两个失败计数清零**（2026-10-04 决策 A）：闸门在验密之前，不清零会让窗口内"错过一次"的账号每次登录都被要求验证。

**2FA（B6/B7）**

- **setup 的绑定守卫（D7 收敛）**：`totp_enabled=true` 时 setup 一律 409 `conflict` 且**不动库**。
- **防重放**：`verifyTotp()` 命中的**步号**先经 `SADD totp:used:<uid>`（TTL 90s）原子认领，返回 0 即重放 → 400 `invalid_totp` + 审计 `reason='replayed_step'`；90s 恰好覆盖 ±1 步窗口。
- **限流中间件挂在会话校验之前**（无会话狂刷 `verify` 同样计数），与 `/auth/login` 共用 `ratelimit:login:<ip>`。
- **enable 成功 = 已过第二步**：验证码即持有证明，会话补丁为 `full` 并轮换 sid；恢复码在此时生成并整批写入（D1）。
- **disable 顺序**：验密码（统一 401）→ 未绑定 409 → `require_2fa` 策略 409（D3）→ 事务内解绑 + 清恢复码（D5）。不轮换 sid、不动当前会话。
- **第二步不写 `touchLogin`**：`users.last_login_method` 的 CHECK 只允许 `password/totp/oidc`（迁移 0002），且第一步已记录本次登录。
- **审计 action**：`user.2fa_setup` / `user.2fa_enable` / `user.2fa_disable` / `user.recovery_regenerate` / `user.recovery_used` / `auth.2fa_verify`；失败对应 `*_failed`（`detail.reason`：`invalid_totp` / `replayed_step` / `invalid_code` / `invalid_credentials` / `require_2fa_policy`）。⛔ detail 里没有验证码、恢复码明文、secret（有测试钉住）。

**人机验证（S 系列）**

- **提供方解析**（2026-10-04 追认）：`CAPTCHA_PROVIDER` 未设置 → **自动推断**（配了极验密钥用极验，否则用自建滑块）；**显式声明 `geetest` 却缺密钥 → 启动即失败**；`none` = 整条链路关闭。
- **`none` 的性质**：env 级**部署期总闸**，绕过 `settings` 表、面板不可见、无审计。关闭人机验证的**正常路径**是 `security.login_captcha.enabled=false`（面板可改、有审计）。
- **凭据缺失即关整条链路**：出题 404、登录永不因人机验证被拒——⛔ 不是"配了就照用、用不了当通过"。
- **fail-open 的连带义务**（C13）：审计 `auth.captcha_unavailable` + `logger.error` + 3s 超时且不重试 + 30s 熔断。
- **一次性与"成功才消费"**：`captcha_token` 在登录**成功时**才 `DEL`，因此 120s 内可复用（含提交错密码）——这是刻意的：否则用户验证通过后打错密码就要重新验证。
- **`captcha/verify` 是全站唯一"匿名可触发外呼"的端点**：`ratelimit:captcha:<ip>` 挡不住多 IP 分布调用，故除熔断外再加**进程级出站并发信号量**（S9）。

---

## 4. 决策记录

### 4.1 D 系列（实现期偏差，2026-10-04 **全部追认**）

| # | 议题 | 结论 | 状态 |
|---|---|---|---|
| D1 | `2fa/enable` 是否顺带生成并返回 10 个恢复码 | 是：返回 `{ recovery_codes, remaining_recovery_codes }` | ✅ 追认 |
| D2 | 受限态下 `GET /auth/me` 的返回码 | 403 `totp_setup_required`（`totp_pending` 仍 200） | ✅ 追认 |
| D3 | `require_2fa=true` 时是否禁止自助解绑 2FA | 禁止，409 `conflict`（`reason=require_2fa_policy`） | ✅ 追认 |
| D4 | 改密策略 | 8–128 + 不得与旧密码相同（400 `invalid_request`）+ 必须在 `full` 态 | ✅ 追认 |
| D5 | `2fa/disable` 是否同时作废全部恢复码 | 是（事务内解绑 + 清码） | ✅ 追认 |
| D6 | 审计 `action` 命名 | 见 §3.7；失败路径另加 `*_failed` | ✅ 追认 |
| D7 | 矩阵把 `2fa/setup` 列入 `totp_pending` 放行 —— 字面实现允许"只持密码者换绑验证器再自验"，构成 **2FA 绕过** | 收敛为：已绑定账号（含 `totp_pending` 态）调 setup → 409 `conflict` 且不动库；丢设备自救走恢复码（渠道一）或管理员重置（渠道二） | ✅ 追认（原设计文字被推翻，理由：安全性优先） |

### 4.2 C 系列（人机验证，2026-10-03 / 10-04）

| # | 议题 | 结论 |
|---|---|---|
| C1 | 自建 vs 第三方 | 自建（后由 C12 扩展为双提供方） |
| C6–C11 | 自建滑块细节 | 按文档建议实现：按账号计数、阈值 1、token 绑定 IP |
| C8 | 登录成功后是否清零失败计数 | **已被 2026-10-04 决策 A 取代**：清零（不再是"成功不重置"） |
| C12 | 新增 `CAPTCHA_PROVIDER`，默认 `geetest` | **受控细化（2026-10-04 追认）**：未设置 → 自动推断（有密钥→`geetest`，无密钥→`selfbuilt`）；显式 `geetest` 缺密钥 → 拒绝启动；`none` 保留为部署期总闸。⛔ 自建滑块代码保留不删 |
| C13 | 极验不可达时 | fail-open 放行 + 审计 + error 日志 + 3s 超时且不重试 |
| C14 | `captcha_unavailable` 错误码登记 | ✅ 已采纳（503，`api.md` §1.3 已登记） |
| C15 | `gt4.js` 引入方式 | ✅ 已采纳：动态注入（关闭/自建部署时登录页零极验外链） |
| C16 | 用极验官方按钮 | ✅ 已采纳：`product='popup'`，密码错后才显示 |
| C17 | 是否传 `userInfo` | ⛔ 不传（不把账号交给第三方） |
| C18 | 端点形状 | ✅ 保持两步契约（`/auth/login` 形状零改动） |
| C19 | 熔断 / 出站并发上限 | 熔断 ✅ 已实现；**出站并发上限 → 2026-10-04 拍板要做**（S9 ⏳） |

### 4.3 2026-10-04 拍板（本轮）

| # | 议题 | 结论 | 落点 |
|---|---|---|---|
| 1 | 文档结构 | 契约留 `api.md`；状态/规范/待拍板迁到本文件 | 本文件 |
| 2 | `CAPTCHA_PROVIDER` 默认语义与 `none` | 追认自动推断；保留 `none` 并写进契约（env 级、面板不可见） | `api.md` §4.1.0 |
| 3 | 列表分页形状 | 列表端点统一 `{ items, next_cursor }`（`api.md`「不套壳」原则的明确例外） | `api.md` §1.2 ③ |
| 4 | `GET /hosts/{id}/probes` 形状 | `{ probes: [...], current: {...} }` | `api.md` §4.2 |
| 5 | C19 第 5 条出站并发上限 | 做（进程级信号量） | `api.md` §4.1、本文件 S9 |
| 6 | `rotate-reminder/test` 端点 | 要，写进契约 | `api.md` §4.4 |
| 7 | D1–D7 + C12 细化 | 全部追认；三态矩阵按代码改写 | §3.2、§4.1、§4.2 |
| 8 | 41 处 `➕ 建议` | 已落地的固化为正式约定；未落地的进 §5 索引 | `api.md`、本文件 §5 |

### 4.4 离线判定落地（2026-10-04，本轮）

**背景**：上报是**请求驱动**的——`POST /api/v1/agent/report` 到达时才把 `agents.status` 写成 `online`。
被监控机断电/断网时不产生任何请求，于是**没有任何东西会去改那一行**：`agents.status` 永远停在 `online`，
「已经死了三天的机器在面板上依然是绿的」。这不是功能缺失，而是**一个报平安的监控系统**。

连带影响（实施前就已存在、且方向静默）：`services/ingest.service.js` 的 `publishDeltas()` 里
「`statusBefore !== 'online'` 才广播」那条逻辑，其唯一意义是给浏览器补发**离线→在线**的恢复增量；
而 `offline` 从未被写入过 → 该分支**永不执行** → M3 的 `/ws/live` 接上后，前端永远收不到"恢复"推送。

**落地内容**

| 项 | 落点 | 说明 |
|---|---|---|
| 判定服务 | `server/src/services/offline.service.js` | `offlineThresholdS(config)` = **30s × `OFFLINE_CYCLES_MULTIPLIER`（默认 3）= 90s**；`markStaleAgentsOffline()` |
| 定时任务 | `cron.service.js` 的 `CRON_TASKS.offlineSweep` | 每 `HEARTBEAT_SWEEP_INTERVAL_S`（默认 **60s**）跑一次；复用既有 cron 分布式锁 |
| 实时扇出 | `cron.service.js::publishOfflineDeltas()` | 与上报路径**同频道**（`live:metrics`）**同形状**（§5.2 的 `delta{channel:"status"}`），M3 的 WS 层原样转发、不翻译 |
| 测试 | `test/offline.service.test.js`（17 例） | 阈值/边界、`disabled` 永不参与、`last_seen_at IS NULL`、未来时间戳、幂等防抖、恢复后再判、扇出形状、扇出失败不影响判定 |

**两条关键实现选择**（结果与设计 §5.3 / `database.md` §8.2 一致，但落点不同）

| # | 议题 | 结论 | 理由 |
|---|---|---|---|
| 1 | 并发安全：判定与"正在上报"的机器撞车 | 写成**单条 `UPDATE ... WHERE`**，⛔ 不写"先 SELECT id 列表再逐条 UPDATE" | PG 在 READ COMMITTED 下会对被并发更新的行**重新求值 WHERE**：上报表先拿行锁 → 扫描的 UPDATE 阻塞 → 上报提交 → 扫描重判时 `now() - last_seen_at` 已远小于阈值 → 该行自动跳过。朴素写法会让"刚上报完"的机器被打上 offline（下一周期自愈，表现为随机闪一下） |
| 2 | 状态接口读 `agents.status` 还是自己算 | **读取时推导**（见 `docs/server-status-api.md` §2.1） | 让接口的正确性**不依赖 cron 的存活**。若直接读字段，cron 一旦静默挂掉（分布式锁、时钟、异常），接口就开始"报平安"，且**没有任何东西会告警**。两侧共用同一个阈值来源，不会漂移 |

**时钟口径**：`last_seen_at` 由 **Node 进程时钟**写入（`routes/agent.report.js` 的 `request.receivedAt` ← `Date.now()`），
判定一律用**数据库 `now()`** 与之比较 → 两侧同为「DB 时间 − 进程时间戳」，偏差方向一致。
⛔ 不要在一处用 `now()`、另一处用 `Date.now()` 做同一个判定，那才会真出「接口说在线、库说离线」。

**⚠️ 阈值基准的坑（2026-10-04 实际踩到并修复）**

阈值公式是「上报周期 × 倍数」，而**上报周期的真实值来自 Agent 侧**：`agent/internal/config/config.go`
的 `defaultConfig()` 在修订 G3 中把 `report.interval` 默认值由 15s 改成了 **30s**。
中心文档（设计 §4、`docs/agent.md` 的 G3 表、`docs/api.md` §3.2）当时**没同步**，实现照着旧文档取 15s，
于是阈值 = 45s **小于** 30s 的上报周期 → **正常上报的机器也会在两次上报的间隙里被判离线**，
下一次上报又救活它 → 面板上表现为「机器随机闪一下离线」，且因为很快自愈而极难排查。

修复：`AGENT_REPORT_PERIOD_S = 30`（阈值 90s），并加两条回归防线（`test/offline.service.test.js`）：
① 扫描周期必须**小于**阈值；② 按 30s 节奏上报的机器在**任何相位**都不得被判离线。
➡️ 教训：**跨端共享的常量就是契约**，一端改了默认值，另一端必须同步；否则错误是静默的。
➕ 待观察：Agent 的 `report.heartbeat_interval` 默认 60s，真实最坏上报间隔是 60s 而非 30s，
90s 阈值只留 1.5 倍余量 —— 真机若出现偶发假离线，优先把 `OFFLINE_CYCLES_MULTIPLIER` 提到 4。

**⛔ 本期不含**：离线**告警与通知**（写 `alert_events` + 经 `channels` 发企微/邮件）属 M3 的告警引擎。
届时它应消费 `markStaleAgentsOffline()` 的返回值（只含**本次真正发生迁移**的主机，防抖已由 SQL 保证），
⛔ 不要自己再扫一遍表——否则两边阈值一旦漂移就会出现「面板说离线、告警没发」。

### 4.5 A 系列（设计文档拆分期的接口决策，全部已定）

| # | 结论 | 契约落点 |
|---|---|---|
| A1 | canonical 固定 `\n` 分隔（4 处），path 仅路径、不含 query；配共享测试向量 | `api.md` §2.1、`contracts/agent-signature.json` |
| A2 | 公开接口用独立 `public_slug`，⛔ 不含内部 UUID | `api.md` §3.1、`docs/database.md` §5.1 |
| A3 | 幂等命中**不加** `duplicate: true`，响应形态恒定 | `api.md` §2.1 |
| A4 | 压缩前 **1MB** / 解压后 **4MB**（Agent 侧单批熔断阈值 256KB） | `api.md` §2.1、`docs/agent.md` §5.3 |
| A5 | **保留**心跳端点，限流**共用** Agent 桶 | `api.md` §2.2 |
| A6 | 指标维度写进指标名（方案 A），`metrics` 参数接受**基名或全名** | `api.md` §4.3 |
| A7 | WS 应用层**只允许 `subscribe`**；保活改用**协议层 ping/pong 帧**；其它消息 → 关闭 `1008` | `api.md` §5.2、§5.3 |
| A8 | `install_hint` **带 key（`VANTAGE_KEY` env 内联）+ 另给交互式 / `--key-file` 两种形式**；明文同时单独展示一次；⛔ 仍禁 `--key` 参数 | `api.md` §4.4「决策 #37 修订」；设计文档 v0.8 §12.2/§13/#37 已同步 |
| A9 | **面板自助绑定 TOTP**（setup / enable / disable + `security.require_2fa` 强制策略） | `api.md` §4.1 |
| A10 | 分页用 **cursor（keyset）**，`limit` 默认 20 / 上限 200；列表响应形状 2026-10-04 定为 `{ items, next_cursor }` | `api.md` §1.2 ③ |
| A11 | 权限两级 `admin` / `user`，且 **`user` 纯只读**（所有写操作仅 `admin`） | `api.md` §4.9 |
| A12 | **不做**事件 `ack`，用 `silences` + 规则 `cooldown` 覆盖 | `api.md` §4.6 |
| A13 | **两条恢复渠道**：① 一次性恢复码；② 管理员 `POST /api/v1/users/{id}/2fa/reset` | `api.md` §4.1、§4.9 |
| A14 | 面板开关存 **PG `settings` 表**（白名单 key + JSONB），`PATCH /api/v1/settings` 立即生效并写审计 | `api.md` §4.10、`docs/database.md` §5.4 |

> 唯一保留的开放项是 **A13 的 SSO 对接细节**（`docs/database.md` §12.2 N3），不阻塞任何里程碑，见 §5.1。

### 4.6 服务器状态接口落地（2026-10-04，本轮）

**交付**：`GET /api/public/hosts`、`GET /api/public/summary`、`GET /api/v1/hosts`。

| 文件 | 角色 |
|---|---|
| `src/services/status.service.js` | **唯一**的状态推导实现（在线判定阈值来源、snapshot 计算、探活计数、两种白名单投影、响应缓存） |
| `src/routes/public.js` / `src/routes/hosts.js` | HTTP 语义（限流 + 总开关 / 会话三态 / 参数校验 / 响应 schema） |
| `src/middleware/publicView.js` | `publicViewGuard`：`public_view.enabled=false` → 404（**每请求**判定） |
| `src/middleware/rateLimit.js` | ➕ `createPublicRateLimiter()`（复用同一段固定窗口 Lua，独立桶 `ratelimit:public:<ip>`） |
| `src/repositories/{agent,metric,probe}.repo.js` | 各追加只读取数（1 条 SQL 取整页，⛔ 无 N+1） |

**本轮拍板（原 `docs/server-status-api.md` §11 的待确认项）**：

| # | 决议 | 要点 |
|---|---|---|
| D1-b | ✅ 已实施（上一轮） | 离线判定**两处都做**：cron 写回 `agents.status`（告警/WS 消费）+ 接口读取时推导（不依赖 cron 存活）；阈值唯一来源 `offlineThresholdS(config)` |
| D1-a | ⏸️ 推迟到 M3 | 离线参数（阈值倍数 / 扫描周期 / 按机阈值）进 `settings` 的输入清单见 `docs/server-status-api.md` §11.1 |
| D2-a | ✅ 采纳 | 「最新值」观测窗口 = **5 分钟**（20 × 上报周期）；窗口外一律 `null`（⛔ 不返回旧值） |
| D3-a | ✅ 采纳 | 公开侧 `last_seen_ago`（中文分级文案）+ `last_seen_at`（**分钟级取整**）；⛔ 两者都不到秒。➕ 补充：**私有侧** `last_seen_at` 是**精确值**（`api.md` §4.2 原文要求）；**从未上报**（`last_seen_at IS NULL`）时两者均为 `null`（⛔ 不编造「超过 30 天」） |
| D4-a | ✅ 采纳「上缓存」 | **响应级**缓存：`snapshot:public:hosts` / `snapshot:public:summary`，TTL = `PUBLIC_CACHE_TTL_S`（默认 10s，0 = 关）；⛔ 不复用 `snapshot:agent:<id>`；缓存读写失败**不影响响应** |
| D5 | ✅ 已实施 | 关闭 → 404 + 统一错误信封；**每请求**判定（有测试证明"同一实例先 404、改回立刻 200"） |
| D6 | ✅ 已实施 | 公开响应由白名单函数构造 + 路由 response schema（`additionalProperties: false`）双保险；测试用"字段全填满的 agent"做字符串包含断言 |
| D7 | ✅ 已实施 | `active_alerts` / `summary.alerts` **照契约查询**（`LEFT JOIN + COALESCE`，⛔ 非 `INNER JOIN`）而非硬编码 0；本期恒 0 |
| D8-a | ✅ 采纳 | 默认排序「有问题优先」（非在线 → 有活动告警 → 在线 → `last_seen_at DESC`）；`limit` 默认 20 / 上限 200（超限**夹取**）；`next_cursor` **恒 null**；`cursor` 被**忽略**（⛔ 不 400） |
| D-名 | ✅ 采纳 | 公开显示名缺失时回退 `name`（⛔ 不生成泛化名「主机 N」） |
| D-禁 | ✅ 采纳 | 公开列表**不出现** `disabled`；`summary.disabled` 仍计数（保证 `total` 自洽） |
| D-键 | ✅ 采纳 | 在既有 `snapshot:` 前缀下新增两个子键（已写入 `docs/database.md` §7 契约表） |
| D-限流 | ✅ 采纳 | 私有 `/api/v1/hosts` 本期**不加**专用限流桶（已登录 + 登录桶足够） |
| D-tag | ✅ 采纳 | `tag` 过滤与派生排序共存时接受"排序前失去 GIN 索引能力"（几十台规模） |
| D-范围 | ✅ 采纳 | 本块只做 3 个端点；`/hosts/{slug}/now`、`/probes` 与主机详情系列留到下一块 |

**实现期的两条偏差登记**（都已在代码注释里写明理由）：

1. **`limit` 不用 Fastify querystring schema**：`app.js` 刻意设 `coerceTypes: false`（§5.2「不做类型强制转换」），而 query string 的值**永远是字符串** —— 用 `type: 'integer'` 声明会让 `?limit=20` 直接 400。故校验手写在路由层（错误码仍是 400 `schema_invalid`）。
2. **在线判定表达式在 `agent.repo.js`、阈值在 `offline.service.js`**：SQL 里的 `CASE` 与扫描任务的 `UPDATE ... WHERE` **互为反向**（`offline.service.js` 是 `... > 阈值 → offline`，状态查询是 `... <= 阈值 → online`），两侧共用同一个 `offlineThresholdS(config)` 参数。⛔ 这是刻意的"一处判定、一处阈值"，不是两套实现。

**测试**：`server/test/status.service.test.js`（31 例）、`server/test/public.api.test.js`（17 例）、`server/test/hosts.api.test.js`（11 例）、`server/test/hosts.detail.test.js`（14 例）—— 共 **73 例**，覆盖状态推导、脱敏、限流、总开关、缓存、三态、参数校验与"截断后可用率不得虚高"这类反直觉口径。

#### 4.6.1 第二块（同日）：面板汇总 + 单机纵深 + 公开收尾

**新增交付**：`GET /api/v1/summary`、`GET /api/v1/hosts/{id}`、`/hosts/{id}/probes`、`/hosts/{id}/ip-history`、`/hosts/{id}/processes`、`GET /api/public/hosts/{slug}/now`、`GET /api/public/probes`。
**新增代码**：`utils/time.js`（`from`/`to` 解析与范围校验，**四个历史类端点共用**）、`utils/ip.js` 的 `isPrivateAddress()`（公开脱敏用）、三个 repo 各追加 2–3 个只读函数。

| # | 决议 | 理由（一句话） |
|---|---|---|
| **E1** | ➕ 新增 `GET /api/v1/summary`（**契约新增**，与公开汇总同形、共用 `computeSummary()`、⛔ 不做响应缓存） | 列表页顶栏用列表自己数**是错的**：`limit` 一截断就只是"这一页有几台" |
| **E2** | 详情 = 列表条目 + `host_info` + `capabilities` + `current_metrics`（键 = **指标全名**） | 私有域给原名（排障要用 `mount=/data`）；⛔ 公开侧走泛化标签，两条路径不共用 |
| **E3** | 探活历史的 `availability` 用 **SQL 窗口函数**按**整个窗口**算，⛔ 不用返回的那几个点算 | 每 probe 只返回最近 500 点；用返回点算可用率会**系统性虚高**（"100% 可用"却明明断过），且没人会怀疑到分页上 |
| **E4** | `from`/`to`：接受 RFC3339（**必须带时区**）或 unix 毫秒/秒；默认 24h、上限 30 天；⛔ 裸时间串拒绝 | 猜错时区 = 8 小时数据错位，而且"看起来有数据" |
| **E5** | `/processes` 的 `at` = 「该时刻**之前**最近一条」；无数据时 `at`/`total`/`top` **三者同 null** | 采样是周期性的，"严格等于"等于永远查不到；`null` 与 `0/[]` 必须能区分"没采集"与"确实没有" |
| **E6** | 公开单机的设备名泛化：磁盘按 `mount`（无则 `device`）**字典序** → `磁盘 1..n`、网卡按 `device` → `网卡 1..n`、GPU 用 `index` → `GPU 1..n`；响应里**一个指标名都没有** | 原 §3.1/§9.2 的 ❓ 就此闭环；白名单式构造让"将来新增维度"也不可能漏出去 |
| **E7** | 公开 `target_host` 脱敏：域名留、路径/端口剥离、**私网 IP → `内网地址`、公网 IP 保留**、解析不出来 → `null` | 一刀切隐藏所有 IP 只会让公开页变成一排「—」；而私网 IP 是真泄露网段 |
| **E8** | 公开单机对 `disabled` 主机返回**与"不存在"相同的 404** | 否则 slug 成了"这台机是否被人工禁用"的枚举口子（列表已不显示它） |
| **E9** | 公开侧新增两个响应级缓存子键（`snapshot:public:now:<slug>`、`snapshot:public:probes`，TTL 同 `PUBLIC_CACHE_TTL_S`） | 展开与探活概览同样是"多人同时刷"的端点；键数量 ≈ 主机数，不会被枚举撑爆 |
| **E10** | `id`/`slug` 的形状校验放在**路由 schema**（非法值 400 `schema_invalid`） | ⛔ 否则会先撞 PG 的 `22P02` 变成 400 `invalid_request` —— 同一个错误两种 code，前端没法统一处理 |

**⚠️ 本轮踩到并已加注释防守的坑（值得记住）**：
**fast-json-stringify 对"任意键对象"默认序列化成 `{}`** —— `host_info`、`capabilities`、`current_metrics`、`top[]` 四处都中招（HTTP 200、字段名在、内容全空）。修法是在这些子 schema 上显式写 `additionalProperties: true`；`routes/hosts.js` 里已就地写明"往后再加透传 JSONB 必须带上这一行"。

---

### 4.7 添加 Agent 落地（`POST /api/v1/agents`，2026-10-04）

**交付**：`src/routes/agents.js`、`src/services/agentAdmin.service.js`、`agent.repo.js` 的 `insertAgent()`；新增 env `AGENT_INSTALL_SCRIPT_URL`；响应里 `install_hint` **由 `string` 改为对象**。

| # | 决议 | 理由（一句话） |
|---|---|---|
| **F1** | 守卫 = `requireFullSession` + `requireRole('admin')` + CSRF | 发凭证比"看数据"重得多：⛔ 不允许在只过了密码的会话里签发（与 §4.4「全部仅 admin」一致） |
| **F2** | `install_hint` 改成**对象**（`center_url`/`script_url`/`one_liner`/`interactive`/`key_file`/`security_note`/`warnings`） | 契约初稿写的 `string` 装不下"三段命令 + 一条风险提示"，而前端规格要求分开显示（一键命令显眼、另两种折叠） |
| **F3** | 一键命令**同时传 `VANTAGE_KEY` 与 `VANTAGE_SECRET`**（原 `agent.md` §12.1 只写了 KEY） | secret 是 HMAC 签名的必需输入，缺它 Agent 通不过校验 —— 原示例是漏写，已同步 `agent.md` §12.1 与形式③的 `--secret-file` |
| **F4** | 未配置安装脚本地址 → 三个命令字段**全 null** + `install_script_not_configured` 警告 | ⛔ 不给带 `<mirror>` 占位符的假命令：一条 `curl` 到错地址还被 `sudo sh` 执行的命令更危险 |
| **F5** | `AGENT_INSTALL_SCRIPT_URL` 只接受 `https://`（不满足即**启动失败**） | 该地址会被拼进 `curl … \| sudo sh`，http 等于把"以 root 执行远端脚本"暴露在链路上（与 `center.url` 强制 https 同源） |
| **F6** | `center_url` 优先取已有的 env **`PUBLIC_ORIGIN`**，未配置时按当前请求推导并在 `warnings` 里提醒 | 复用既有配置项（它本就是"面板对外地址"），⛔ 不新造第二个同类 env |
| **F7** | 名字重复 → 409 `already_exists`（`details.field='name'`）；`public_slug` 撞车 → 换 slug 静默重试（≤5 次） | `pg` 对两者都只给 `23505`，必须靠 `err.constraint` 区分：一个是**管理员要处理的业务冲突**，另一个是随机巧合 |
| **F8** | 审计 `agent.create`，detail 只写 `agent_id`/`public_slug`/`tags`/`has_display_name` | ⛔ 凭证进审计 = 把审计表变成第二份凭证库 |
| **F9** | 响应在契约之外**多给** `name`/`display_name`/`tags`/`status`/`created_at` | 面板可直接渲染结果行，⛔ 不必为"创建完看一眼"再等列表端点（列表还在待定稿） |

**测试**：`server/test/agents.api.test.js`（9 例）——其中两条是**端到端**的：① 库里只落哈希与密文、⛔ 明文不出现在任何列与审计里；② **用接口返回的明文凭证签一份真实上报并拿到 200**（再换错 key → 401），证明这对凭证"真的能用"而不是"看起来对"。

**⏳ 仍未定稿的两处（做列表/吊销前必须定）**：
1. **列表字段与"吊销"语义**：契约写 `status: active|disabled|revoked`，而 `agents.status` 是**连接状态**（`online/offline/disabled`，✅ R18），库里**没有 `revoked`、也没有 `revoked_at`** ⇒ 要么加一次迁移拆成"连接状态 + 凭证状态"，要么改契约把"吊销"并入 `disabled`（建议前者，理由见 §4.6 的 A 条讨论）。
2. **列表字段缺 `id`**（还有 `name`/`display_name`/`tags`/`public_slug`/`created_at`/`disabled_at`）：前端拿不到 `id` 就没法调 PATCH / rotate / disable / revoke。

**⚠️ 外部依赖**：`install_hint` 指向的 `vantage.sh` **尚未落地**（仓库无任何 `.sh`，见 `docs/agent-status.md`）——接口已就绪，但那条一键命令要等脚本 + `AGENT_INSTALL_SCRIPT_URL` 配好才真正可用；在此之前管理员按响应里的 key/secret 手工写 `config.yaml` + 两个 0600 文件即可。

---

### 4.8 历史曲线落地（`GET /api/v1/hosts/{id}/metrics`，2026-10-05）

**交付**：`src/repositories/metric.repo.js`（`METRIC_STEPS` + 两个只读查询）、`src/services/metricQuery.service.js`（选档/对齐/两道闸门/成形）、`src/routes/hosts.js` 的 `GET /hosts/:id/metrics`；`errors.js` 新增错误码 `too_many_series`。
**测试**：`server/test/hosts.metrics.test.js`（**19 例**）。

| # | 决议 | 理由（一句话） |
|---|---|---|
| **G1** | 档位定为 `30s` / `1m` / `5m`，**删掉 `15s`** | Agent 默认上报周期在修订 G3 里已是 **30s**（`agent/internal/config/config.go`）；15s 的网格会让每两个桶空一个，前端看起来像"一直在丢采集"——这是"假离线"那批过期数字的同一批残留 |
| **G2** | **最长只看 30 天**，⛔ 不在降采样表上再聚合（不做 30m / 1h / 6h 档） | 现有三张表（raw 15 天 / 1m 90 天 / 5m 365 天）直接够用，**零新增数据路径** |
| **G3** | 最细档 = **上报周期**（30s），不是一个手抄的数字 | 档位宁可偏粗：30s 网格查 15s 上报的机器只是每桶 2 个样本（`agg` 处理掉），不会出现空桶；反过来（15s 网格查 30s 上报）必然一半空桶 |
| **G4** | 闸门 A：展开后序列数 ≤ **20**；闸门 B：序列数 × 桶数 ≤ **50,000** | 30 天档一条线本身就是 8640 点，**单条线的点数没有收紧余地**，闸门只能长在"总量"上；换算下来只有 30 天档会撞 B（**5 条**），其余四档都是 A（20 条） |
| **G5** | 超限 → 400 `too_many_series`，⛔ **绝不截断**，且 `details` 带 `max_series_at_this_range` | 悄悄少画几条线在图表上完全看不出来；前端拿这个数去限制勾选框，正常用户撞不到这条错误 |
| **G6** | `step=auto` = **选最细的档使点数 ≤ 2000，都不满足就用 `5m`** | 这一条规则恰好复现产品的 5 个预设按钮（1h/6h/24h/7d/30d → `30s`/`30s`/`1m`/`5m`/`5m`），所以接口**不需要**再加 `window=1h` 之类的预设参数 |
| **G7** | `agg` = `avg`(默认) / `max` / `min` / `last`；`?include_n=true` 回传桶内样本数 | 降采样层把 `v_avg`/`v_min`/`v_max`/`v_last`/`n` **都预先存好了** ⇒ 这些全是"读哪一列"，零额外成本（原契约"仅降采样层支持 min/max"的悬念据此消解） |
| **G8** | 基名展开用**区间比较** `[base\|\|'{', base\|\|'}')`，⛔ 不用 `LIKE` | `_` 是 LIKE 的单字符通配符，而本项目基名大量使用下划线（`used_pct` / `rx_bps`）——与 `selectLatestSeriesForAgents` 同一口径 |
| **G9** | `from`/`to` **向外对齐到桶边界**并**原样回显** | 不对齐就会悄悄丢掉第一个（或最后一个）不完整的桶；回显的是"这张图实际覆盖的时间"，前端画横轴要直接用它 |
| **G10** | 缺失桶**既不补 0 也不补 null**，只是不出现；指标名合法但该机没有 → **200 + `series: []`** | 补 0 会把"采集断了"画成"CPU 掉到 0"（事后没人查得出来）；"这台机没有 GPU"不是客户端的错 |

**⚠️ 实现期踩到并已加防线的一个坑（值得记住）**：
**`metrics` 参数不能用 `split(',')` 切分** —— 序列全名的**维度分隔符本身就是逗号**
（`disk.used_pct{device=sda1,mount=/data}`），直接切会把它劈成两条非法名字（实测 400）。
修法是只按**花括号之外**的逗号切（`metricQuery.service.js` 的 `splitMetricList()`），
并留了一条专门的回归用例（"一条请求里写两个带维度的全名都要认"）。契约文字已同步（`api.md` §4.3）。

**另一处已同步的口径**：请求什么都不给时**先报 `metrics`**（= 契约参数表的顺序），不是先报 `from` ——
前端按 `details.field` 高亮输入框，这个顺序也是契约的一部分。

**⏳ 顺带记账（本轮未动）**：`metrics_1m` / `metrics_5m` 目前**只有人写、没人读**（唯一读者是保留期清理任务），
本接口是它们的**第一个读者**；且按 G1–G2 的口径，`1m` 层实际只服务"24 小时"这一档。
是否缩短 `RETENTION_METRICS_1M_DAYS`（现 90 天）/ `RETENTION_METRICS_5M_DAYS`（现 365 天）需要一次单独确认（涉及删数据）。

---

## 5. 待拍板索引

> 规则（2026-10-04）：`api.md` 正文**只写已定契约**；下列条目尚未拍板，实现到对应模块前必须逐条定稿。⚠️ 为了不让 M2/M3 的端点失去可读的草案，提案表格仍留在 `api.md` 端点旁边，但**状态以本表为准**（未拍板 = 随时可改）。

### 5.1 全局 / 部署

| 项 | 内容 | 位置 |
|---|---|---|
| 同源部署与 CORS | 面板与反代同源部署（Caddy 反代 `/api`、`/ws`），不开启跨域；必须跨域时只允许白名单 Origin + `credentials: true` | `api.md` §1.1 |
| Agent 上报头 `X-Nonce` 长度 | 建议 ≥16 字节随机（32 hex 字符）——中心的签名校验**不强制长度**，是否在 schema 里钉死待定 | `api.md` §2.1 |
| `User-Agent` 约定 | `vantage-agent/<version>`（排障用） | `api.md` §2.1 |
| 心跳独立限流桶 | 已定共用 Agent 桶；是否再给心跳一个更宽的桶 | `api.md` §2.2 |
| OIDC 对接细节 | 是否允许 SSO 自助注册、IdP 的 group/role claim 如何映射到 `admin`/`user`（`docs/database.md` §12.2 N3）——本期不实现 OIDC，不阻塞里程碑 | `api.md` §4.1 末 |

### 5.2 M2 / M3 未实现端点的参数提案

| 端点 / 位置 | 待定内容 |
|---|---|
| `GET /api/v1/hosts`（§4.2） | ✅ 2026-10-04 已定：过滤参数 `status` / `tag` / `q` 全部落地（`cursor` 被忽略、`next_cursor` 恒 null）——见 §4.6 |
| `GET /api/v1/hosts/{id}`（§4.2） | ✅ 2026-10-04 已定：= 列表条目 + `host_info` + `capabilities` + `current_metrics`（键 = 指标全名） |
| `GET /api/v1/hosts/{id}/probes`（§4.2） | ✅ 2026-10-04 已定：`from`/`to`（默认 24h、上限 30 天）+ `name`/`type`；按 probe 分组返回 `availability`（**整窗口**）/`latest`/`results`（每 probe 最多 500 点） |
| `GET /api/v1/hosts/{id}/ip-history`（§4.2） | ✅ 2026-10-04 已定：`limit`（默认 100/上限 500，两个列表各自适用）；返回 `intervals` + `events` + `current_ip` |
| `GET /api/v1/hosts/{id}/processes`（§4.2） | ✅ 2026-10-04 已定：`at` 省略取最近一条、给定时取"该时刻之前最近一条"；无数据时 `at/total/top` 三者同 null |
| `GET /api/v1/hosts/{id}/metrics`（§4.3） | ✅ 2026-10-05 **已全部定稿并落地**：档位 `auto`/`30s`/`1m`/`5m`（**删掉 `15s`**）、`agg` = `avg`/`max`/`min`/`last` + `?include_n=true`、基名展开用区间比较、最长 30 天且不做再聚合、`step=auto` = "最细且点数 ≤2000"、两道闸门（≤20 条序列 / ≤5 万点）超限 400 不截断、响应含 `host_id`/实际 `step`/`agg`/对齐后的 `from`·`to`、缺失桶不出现在数组里 —— 见 §4.8 |
| `GET /api/v1/agents`（§4.4） | ⏳ 待定：列表字段（现表缺 `id`/`name`/`display_name`/`tags`/`public_slug`/`created_at`/`disabled_at`）、是否支持 `?status=` 过滤、以及 `status: active\|disabled\|revoked` 与库表（`online/offline/disabled`）的冲突怎么收（见 §4.7 的两处未定稿） |
| `POST /api/v1/agents/{id}/revoke`（§4.4） | ⏳ 待定："吊销"如何落库（库内无 `revoked_at`/`revoked`）——加迁移拆成"连接状态 + 凭证状态"，还是并入 `disabled`（见 §4.7 建议） |
| `POST /api/v1/alert-rules/{id}/dry-run`（§4.5） | 试算窗口与返回字段（「若启用会触发几次」，不发送） |
| 告警规则校验范围（§4.5） | `threshold` 数值范围（如 ±1e12）、`duration`/`cooldown` 下限、`params` 按 `kind` 的白名单（`docs/database.md` §5.11） |
| `GET /api/v1/notification-log`（§4.6） | 查询参数（`event_id`/`channel`/`ok`/`from`/`to`） |
| `POST /api/v1/channels/{id}/test`（§4.6） | 是否允许自定义测试文案 |
| `GET /api/v1/silences` / `POST`（§4.7） | `?active=true` 过滤语义；`target` 与规则同构的字段级契约 |
| `GET /api/v1/audit-logs`（§4.8） | 查询参数集合与 `detail` 脱敏口径 |
| 用户管理端点（§4.9） | 除 `2fa/reset` 外全部为建议：请求/返回字段集在 M3 定稿 |
| `PATCH /api/v1/settings`（§4.10） | 变更后是否向在线 WS 广播 `delta{channel:"settings"}` |
| `/ws/*` 消息编码（§5.2） | 具体编码为建议（语义已定）：`snapshot`/`subscribe`/`delta` 的字段集合与 `channels[]` 取值集合 |
| 公开域细节（§3.2） | ✅ 2026-10-04 已定：`last_seen_ago` 分级文案 + `last_seen_at` 分钟级取整、响应级缓存 `PUBLIC_CACHE_TTL_S`（默认 10s）、**设备名泛化口径**（`磁盘 N`/`网卡 N`/`GPU N`）、`target_host` 脱敏口径（域名留、私网 IP → `内网地址`、公网 IP 留）—— 见 §4.6.1 E6/E7 |

---

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-05 | **历史曲线接口落地**（`GET /api/v1/hosts/{id}/metrics`，M2 收尾）：新增 `services/metricQuery.service.js`、`metric.repo.js` 的 `METRIC_STEPS` + 两个只读查询、`routes/hosts.js` 的 `GET /hosts/:id/metrics`；新增错误码 `too_many_series`；`api.md` §4.3 的 ❓ 全部定稿。**关键口径**：档位 `30s`/`1m`/`5m`（**删掉 `15s`** —— 上报周期是 30s）、最长 **30 天**且不做跨表再聚合、`step=auto` = "选最细的档使点数 ≤2000"（恰好复现 5 个预设按钮）、两道闸门（展开后 ≤20 条序列、总数 ≤5 万点）超限 400 **不截断**、缺失桶不补 0、`from`/`to` 向外对齐到桶边界后回显。决议 G1–G10 见 §4.8。⚠️ 记一条实现坑：**`metrics` 不能用 `split(',')` 切分**（全名的维度分隔符就是逗号），只能按花括号外的逗号切，已留回归用例 |
| 2026-10-04 | **添加 Agent 接口落地**（`POST /api/v1/agents`）：新增 `routes/agents.js`、`services/agentAdmin.service.js`、`agent.repo.js::insertAgent()`；新增 env `AGENT_INSTALL_SCRIPT_URL`（未配置则不给安装命令，⛔ 不给占位符假命令）；`install_hint` 由契约初稿的 `string` **改为对象**（三段命令 + 风险提示 + warnings）；一键命令补上 `VANTAGE_SECRET`（原 `agent.md` §12.1 漏写，已同步）；新增审计动作 `agent.create`；决议 F1–F9 与两处待定稿见 §4.7；前端 `agentsApi.create()` 与类型已就位（`vue-tsc` 通过）。⚠️ 记一条测试坑：PGlite 适配器必须给 `pool.connect()`（上报落库走 `withTransaction`），且清理顺序要按外键（`agent_ip_history` 等 RESTRICT） |
| 2026-10-04 | **状态类接口收尾（第二批）**：新增 `GET /api/v1/summary`（契约新增）、`/api/v1/hosts/{id}`、`/{id}/probes`、`/{id}/ip-history`、`/{id}/processes`、`GET /api/public/hosts/{slug}/now`、`GET /api/public/probes`；新增 `utils/time.js`、`utils/ip.js::isPrivateAddress()`、两个公开缓存子键（`database.md` §7 已登记）；决议 E1–E10 见 §4.6.1；`api.md` §3.2/§4.2 全部改为 ✅ 并写死契约（清理了三处旧草案形状）；前端类型声明同步（`vue-tsc` 通过）。⚠️ 记一条教训：**fast-json-stringify 对任意键对象默认序列化成 `{}`**，透传 JSONB 必须写 `additionalProperties: true` |
| 2026-10-04 | **服务器状态接口落地（第一批）**：`/api/public/hosts`、`/api/public/summary`、`/api/v1/hosts`：新增 `status.service.js`（唯一推导）、`routes/public.js`、`routes/hosts.js`、`middleware/publicView.js`、`createPublicRateLimiter()`；新增 env `PUBLIC_CACHE_TTL_S`（默认 10s）与两个 Redis 键（`snapshot:public:hosts|summary`，已登记 `database.md` §7）；D2-a/D3-a/D4-a/D8-a 与 D-名/D-禁/D-键/D-限流/D-tag/D-范围 全部按方案建议落地 → 新增 §4.6，`api.md` §3.2/§4.2 状态改为 ✅，前端类型声明（`web/src/api/public.ts`、`private.ts`、`types/domain.ts`）同步修正为 `{items, next_cursor}` |
| 2026-10-04 | 决议：离线参数的「数据库可配」（阈值倍数 / 扫描周期 / 按机阈值）**推迟到 M3 告警引擎一起做**，本期保持 env + 硬编码不变；M3 输入清单见 `docs/server-status-api.md` §11.1 |
| 2026-10-04 | ⚠️ **校正离线判定的基准（重要）**：Agent 的 `report.interval` 默认值实为 **30s**（`agent/internal/config/config.go` 修订 G3：15s→30s），而实现与多处文档仍按旧文档的 15s ⇒ 阈值 45s **小于**上报周期 ⇒ **正常上报的机器也会在两次上报之间被判离线**（假离线）。已改为 30s 基准、阈值 **90s**、扫描周期默认 **60s**；新增回归防线（扫描周期必须 < 阈值、按 30s 节奏上报的任何相位都不得判离线）；同步校正 `docs/agent.md` G3 / `docs/database.md` §8.2 / `docs/api.md` §3.2 |
| 2026-10-04 | **离线判定落地**（`services/offline.service.js` + `CRON_TASKS.offlineSweep`，单语句 UPDATE 防抖、扇出 `status:offline` delta）→ 新增 §4.4，`database.md` §8.2 同步；服务器状态接口方案见 `docs/server-status-api.md` |
| 2026-10-04 | 本文件建立：从 `api.md` 迁出落地状态、§4.1.1 实现规范、§6 用例状态注、§7 待拍板清单；三态矩阵按代码校正（`me`=403、`verify`/`recovery` 在 `setup_required` 下=409）；D1–D7 与 C12 细化全部追认；本轮 8 项决策见 §4.3 |
| 2026-10-03 | 极验 v4 双提供方（S5–S8）落地；自建滑块（S1–S4）落地 |
| 2026-10-02 | B1–B8 落地（会话 / 改密 / 2FA / 恢复码 / CLI） |
