# Vantage 前端文档 — Vantage Console（Vue 3）

> **来源**：由《Vantage-DESIGN-v0.7.md》拆分的**前端专项文档**。
> **适用对象**：Vantage Console 前端开发者、UI/交互评审。
> **文档性质**：页面 / 组件 / 数据流 / 交互规格，**不含实现代码**。
> **上位文档**：`Vantage-DESIGN-v0.7.md`（**文件内容已是 v0.8**，文件名保留以维持引用；§5.4、§16、§18 为主）；接口字段以 `docs/api.md` 为准，指标与单位以 `docs/database.md` §5.7.2 为准。
> **阅读约定**：本文中的「✅ 本轮决策 / 本轮已定」= 2026-09-26 Owner 拍板，**均已写入设计文档 v0.8**；逐条对照见 `docs/design-deltas.md`。

**标注图例**

| 标记 | 含义 |
|---|---|
| ✅ 已定 | 直接来自设计文档，不得擅自更改 |
| ➕ 建议 | 拆分时补齐的工程细节，**需 Owner 确认** |
| ❓ 待拍板 | 设计文档未定或存在冲突 |

---

## 1. 定位与硬约束

### 1.1 定位（✅ §0、§3、§16）
- 名称：**Vantage Console**；技术栈 **Vue 3 + ECharts**（✅ 决策 #5）。
- **中文优先**，代码预留 i18n 结构（文案抽 key），后续可加英文（✅ 决策 #26）。
- **基础响应式**：主机列表/详情在手机浏览器可用；**不做** App / PWA（✅ 决策 #27）。
- 许可：AGPL-3.0（✅ §16）。

### 1.2 前端的四条硬约束
1. ⛔ **前端永不下发**：不存在「给 Agent 发指令/改配置/改探活」的入口；UI 上也不提供任何暗示可远程改 Agent 的按钮（✅ §2.1、§18.3）。
2. **免登录只读**：公开视图只展示「当前值」快照与汇总，**不得**请求私有接口、不得展示 IP/内网/历史（✅ §5.4、决策 #21）。
3. **历史与配置必须登录**：历史曲线、IP 变更、进程 Top、审计、告警规则、Agent 管理全部在登录后（✅ §5.4）。
4. **时间权威在服务端**：前端只做展示与时区转换，不自行纠正时间；`agent_ts` 相关的漂移信息只作为**角标/提示**展示（✅ §6.5、决策 #16）。

---

## 2. 目录与模块（✅ §11.4 基线 + ➕ 补齐）

```
web/
├── index.html
├── package.json
├── vite.config.js
├── src/
│   ├── main.js                    # 应用装配（router / store / i18n / 图表按需注册）
│   ├── App.vue
│   ├── router/index.js            # 路由 + 守卫（登录/角色/公开域隔离）
│   ├── views/                     # ✅ 设计已列 5 个 + 登录两页
│   │   ├── PublicStatus.vue       # 免登录总览（✅）
│   │   ├── HostList.vue           # 主机列表（✅）
│   │   ├── HostDetail.vue         # 主机详情（✅）
│   │   ├── Alerts.vue             # 告警（✅）
│   │   ├── Account.vue            # ➕ 我的账号（自助类：2FA / 我的会话 / SSO 绑定状态）
│   │   ├── Settings.vue           # 设置（✅ 管理类，仅 admin）
│   │   ├── Login.vue              # ➕ 登录 + 2FA 两步
│   │   └── NotFound.vue           # ➕ 404
│   ├── components/
│   │   ├── MetricChart.vue        # ✅ 指标曲线
│   │   ├── StatusCard.vue         # ✅ 状态卡（在线/离线/告警汇总）
│   │   ├── ProbeTable.vue         # ✅ 探活表
│   │   ├── AppLayout.vue          # ➕ 导航壳（顶栏 + 侧栏 + 连接状态灯）
│   │   ├── StatusBadge.vue        # ➕ 在线/离线/漂移/Flapping 徽标
│   │   ├── HostTable.vue          # ➕ 主机表（列表页与公开页复用，字段按权限裁剪）
│   │   ├── TimeRangePicker.vue    # ➕ 时间范围选择（与 step 档位联动）
│   │   ├── IpTimeline.vue         # ➕ IP 变更时间线（需登录）
│   │   ├── ProcessTopTable.vue    # ➕ 进程 Top（需登录）
│   │   ├── AlertRuleForm.vue      # ➕ 受控阈值 DSL 表单（零自由文本表达式）
│   │   ├── ChannelForm.vue        # ➕ 通道配置 + 测试发送
│   │   ├── SilenceManager.vue     # ➕ 静默窗口/维护期
│   │   ├── SessionList.vue        # ➕ 我的会话 + 全部下线
│   │   └── AsyncState.vue         # ➕ 加载/空/错误三态统一封装
│   ├── api/
│   │   ├── public.js              # ✅ 免登录接口客户端
│   │   ├── private.js             # ✅ 需登录接口客户端（自动带 Cookie、注入 CSRF、401 处理）
│   │   └── ws.js                  # ✅ WS 连接与消息编解码
│   ├── store/
│   │   ├── auth.js                # ✅ 会话/角色/CSRF
│   │   ├── realtime.js            # ✅ 快照 + 增量合并（WS 数据）
│   │   └── ui.js                  # ➕ 主题/语言/布局偏好（本地存储）
│   ├── locales/{zh-CN.js,en-US.js}   # ➕ i18n 资源（中文优先）
│   ├── styles/element-overrides.scss # ➕ Element Plus 主题变量定制（✅ 本轮决策）
│   └── utils/{format.js,units.js,time.js,metrics.js}   # ➕ 数值/单位/时间/指标名格式化
└── tests/                         # ➕ 组件与 store 单测
```

**依赖边界（➕ 建议）**
- 图表：`echarts/core` + 按需引入（`LineChart`、`GridComponent`、`TooltipComponent`、`DataZoomComponent`、`CanvasRenderer`），**禁止整包 import**。
- UI 组件库：✅ **已定（本轮）：Element Plus**——表格/表单/弹窗/日期选择开箱即用、中文文档最全，适合运维面板。落地要求：**按需引入**（`unplugin-vue-components` + `unplugin-auto-import`，⛔ 禁止全量 `import ElementPlus`），主题定制走 CSS 变量（`src/styles/element-overrides.scss`），暗色用其 dark 主题（`html.dark`）+ 与 `ui.js` 偏好联动。
- 状态管理：Pinia（Vue3 标准），仅两个 store 起步（✅ 设计给了 `auth`/`realtime`）。

---

## 3. 路由与访问域（➕ 建议，权限矩阵 ✅ §5.4）

| 路由 | 视图 | 访问 | 说明 |
|---|---|---|---|
| `/`（或 `/status`） | `PublicStatus.vue` | 免登录 | 公开总览：主机列表 + 当前快照 + 探活概览 + 汇总；**只读、无跳转详情**——✅ 已定（本轮）：点击主机**就地展开当前快照**，⛔ 不设公开详情路由（历史/IP 一律不可见） |
| `/login` | `Login.vue` | 免登录 | 用户名密码 → TOTP 第二步（同一路由内两步） |
| `/hosts` | `HostList.vue` | 需登录 | 主机列表（含 IP、漂移、Flapping、告警数） |
| `/hosts/:id` | `HostDetail.vue` | 需登录 | 曲线 / 探活历史 / IP 时间线 / 进程 Top |
| `/alerts` | `Alerts.vue` | 需登录 | 事件列表 + 规则管理 + 通道 + 静默窗口 |
| `/account` | `Account.vue` | 需登录 | ✅ 2026-10-03 新增：**自助类**——二次验证（绑定/解绑/恢复码）、我的会话、SSO 绑定状态。⛔ 不能只让管理员进：服务端对 `2fa/*` 没有任何 admin 门槛，放开到本页才符合契约 |
| `/settings` | `Settings.vue` | 需登录（`admin`） | **管理类**：Agent 管理（创建/**手动轮换**/禁用/吊销）、用户与权限（分配 `admin`/`user`，✅ 本轮决策）、系统设置项、公开视图开关、审计入口 |
| `/:pathMatch(.*)*` | `NotFound.vue` | — | 404 |

**路由守卫规则（➕ 建议）**
- 公开域（`/`、`/login`）**只允许调用 `/api/public/*` 与 `/ws/public`**：在 `api/public.js` 与 `ws.js` 层做硬隔离（私有客户端在公开域被调用时直接抛错），避免公开页触发 401 噪音与隐私泄露。
- 受保护路由：`meta.requiresAuth`；进入前若 `auth.js` 未确认登录态，先调 `GET /api/v1/auth/me`；失败 → 跳 `/login?redirect=<当前路径>`。
- `meta.role` 控制需管理员的路由（✅ 本轮决策：权限**暂时两级** `admin` / `user`，普通用户纯只读）；越权显示 403 提示页而非静默重定向。
- 已登录用户访问 `/login` → 直接回 `redirect` 或 `/hosts`。
- 公开视图整体关闭（`public_view.enabled=false`）时 `/api/public/*` 返回 404 → `/` 显示「公开视图已关闭，请登录」并提供登录入口（✅ §5.4 可整体开关）。

---

## 4. 页面级规格

### 4.1 `PublicStatus.vue` — 免登录总览（✅ §5.4、决策 #10/#21）

> ✅ **后端已就绪（2026-10-04）**：本页要的三个接口全部落地 —— `GET /api/public/summary`（顶栏）、`/api/public/hosts`（卡片网格）、`/api/public/hosts/{slug}/now`（就地展开）、`/api/public/probes`（探活概览）。仍缺的是 `/ws/public`（实时更新），**可先按 15–30s 轮询**（轮询用的 REST 已可用）。前端类型已声明：`web/src/api/public.ts` + `types/domain.ts`。

| 区块 | 内容 |
|---|---|
| 顶部汇总 | 在线数 / 离线数 / 告警数（`GET /api/public/summary`），全部为**当前值** |
| 主机卡片网格 | 每机：显示名（✅ 已定：公开页**只用 `display_name`**，缺失回退泛化名如「主机 3」）、在线状态徽标、CPU/内存/磁盘/网络速率概览、探活 up/down 计数；点击**就地展开当前快照**（⛔ 不跳详情页、⛔ 无历史） |
| 探活概览 | `GET /api/public/probes` → 目标 + up/down + 延迟 + 检查时间 |
| 实时更新 | 订阅 `/ws/public`，先快照后增量；断线时显示「实时连接已断开（重连中）」并退化为轮询（➕ 建议 15–30s） |

⛔ 禁止出现：IP、内网网段、设备名（建议泛化为「磁盘 1/2」「网卡 1/2」）、历史曲线、进程 Top、任何管理入口（✅ §5.4、决策 #21）。

### 4.2 `Login.vue` — 登录 + 2FA（✅ §18.1）

- 第一步：用户名 + 密码 → `POST /api/v1/auth/login`。
  - 若返回 `totp_required: true` → 切到第二步（TOTP 6 位输入），此时**所有其它接口都会 403 `totp_required`**，故 UI 必须停留在登录流程内。
  - ⛔ 不在任何本地存储写入凭证（凭 Cookie `sid`，`HttpOnly`）。
- 第二步：`POST /api/v1/auth/2fa/verify`；成功后 sid 已轮换 → 必须重新调用 `GET /api/v1/auth/me` 刷新 `csrf` 与角色，再跳转 `redirect`。
- 第二步提供 **「使用恢复码登录」** 链接（✅ 本轮决策：恢复渠道一）：切到恢复码输入 → `POST /api/v1/auth/2fa/recovery/verify` → 成功后同样重取 `me`；若响应 `remaining_recovery_codes ≤ 2`，前端强提示「恢复码快用完了，请到设置页重新生成」。
- 失败提示：统一「用户名或密码错误」，**不区分**账号是否存在（与后端一致，`docs/api.md` §4.1）。
- 登录限速触发（429）→ 展示「尝试过于频繁，请稍后再试」，带倒计时（读 `Retry-After`）。
- 📝 **人机验证（极验 v4 官方按钮）** —— ✅ **后端（S5–S7）与前端（S8）均已落地（2026-10-03）**，⏳ 真机联调待 Owner；规范详见 `docs/geetest-captcha.md` §7，接口契约见 `docs/api.md` §4.1：
  - **策略（不变）**：**首次登录不出现验证**；**密码错一次后**（401 带 `details.captcha_required`，或兜底的 400 `captcha_required`）→ 登录表单里**就地出现极验官方按钮**（不用重输密码、不用刷新）。
  - **实现**：`onMounted` 即 `initGeetest4`（配置从 `POST /auth/captcha/challenge` 取：`provider`/`captcha_id`/`product`/`language`）并 `appendTo` 一个**默认隐藏**的 slot（满足官方「页面在加载时就初始化」的要求，行为数据从页面打开即可采集）；密码错后只需把容器显示出来 → 官方按钮出现 → 点击 → 官方验证弹窗 → `onSuccess` → `captchaVerify({lot_number, captcha_output, pass_token, gen_time})` → **自动重提登录**。
  - ⛔ **三条禁令**：① 不在前端判定对错（前端判定 = 零防护）；② `captchaObj.getValidate()` 返回 `false` 时**不得提交**（会撞服务端 400 `schema_invalid`，用户却看到"验证失败"而永远过不去）；③ **不要**在 `onSuccess` 里 `reset()`（我们的 `captcha_token` 120s 内可复用、密码错不消费，用户**不必**重新验证）。
  - ⚠️ **`challenge` 可能返回 404**：它同时表示「验证码被关闭」「提供方未配置」「极验处于熔断窗口」。三种情况都应当**直接提交登录、不显示任何验证入口**（此时服务端也不会要求 `captcha_token`）—— 这正是 fail-open 在前端应有的样子（`docs/geetest-captcha.md` §16.2 偏差 3）。
  - ⚠️ 极验验证窗**内部文案不受本站 i18n 控制**（由 `language` 参数切换，且图片内文字不随语言变）；我们只控制按钮周围的提示。错误码新增 `error.captcha_unavailable`（503），⚠️ 其 message 被服务端折叠为通用文案，**必须按 `error.code` 匹配**。
  - ⚠️ 两个端点（`/auth/captcha/challenge`、`/auth/captcha/verify`）虽在**会话建立前**调用，但仍属 `/api/v1/*`，须走 `api/private.js`（`skipCsrf`）；⛔ 不要因为 `/login` 被标了公开域就改用 `api/public.js`（`router/index.ts:89` 已按 `to.name !== 'login'` 处理该例外）。
  - ⚠️ **现状（S8 已落地）**：两个组件都在仓库里，**由运行时的 `provider` 决定用哪个**（⛔ 不按构建期 env 硬编码，否则换部署要重新构建前端）：
    - `provider='geetest'` → `web/src/components/GeetestCaptcha.vue`（+ `web/src/utils/geetest.ts` 动态注入 `gt4.js`）——⚠️ **常驻挂载**、容器默认隐藏（官方要求"页面加载时就初始化"）；
    - `provider='selfbuilt'` → `web/src/components/SliderCaptcha.vue`（S1–S4，**完整保留**，仍是内网/离线部署与回滚目标）——只在服务端确实要求时才挂载。
    - `Login.vue` 在 `onMounted` 调一次 `POST /auth/captcha/challenge` 拿 `provider` 与配置；⚠️ 该请求 **404 不阻塞登录**（直接提交、不显示验证入口）。
- ⛔ 本期**不提供** SSO / OIDC 登录入口（`users` 表已预留 OIDC 字段，对接放在后续里程碑，见 `docs/api.md` §4.1）；若将来接入，按钮形态与本地登录并列，仍复用同一套 `sid` 会话。

### 4.3 `HostList.vue` — 主机列表（✅ §5.4 需登录）

> ✅ **后端已就绪（2026-10-04）**：`GET /api/v1/hosts`（列表，含过滤/排序/limit）+ `GET /api/v1/summary`（顶栏计数，⛔ **不要**用列表条数自己数）+ `GET /api/v1/hosts/{id}`（进详情）。⚠️ `next_cursor` 本期恒为 `null`（无真游标），前端按"有值才翻页"处理即可。仍缺 `/ws/live`（可先轮询）。

| 模块 | 说明 |
|---|---|
| 过滤/搜索 | 状态（在线/离线/禁用）、标签、名称关键字 |
| 表格列 | 显示名、状态徽标、CPU%、内存%、磁盘最高占用%、上下行速率、探活 up/down、最后上报（相对时间 + `title` 绝对时间）、**当前 IP**、漂移角标、Flapping 角标、活动告警数 |
| 行内操作 | 进入详情；⛔ 无「重启/改配置/下发」类操作（不存在） |
| 实时 | `/ws/live` 增量更新「当前值」列；历史列不随 WS 变化 |
| 排序/分页 | 默认按「有问题优先」（离线/告警 > 在线）；支持按名称/CPU 排序；cursor 分页（`docs/api.md` §1.2） |

### 4.4 `HostDetail.vue` — 主机详情（✅ §1.1、§5.4、§8、§18）

> ✅ **后端已就绪（2026-10-04），只差历史曲线**：头部 + 当前快照 → `GET /api/v1/hosts/{id}`（`current_metrics` 给**全部序列的当前值**，键是指标全名，含 `mount=/data`）；探活历史 → `/hosts/{id}/probes`（按 probe 分组，`availability.ratio` 是**整窗口**可用率）；IP 时间线 → `/hosts/{id}/ip-history`；进程 Top → `/hosts/{id}/processes`。
> ⏳ **仍缺**：`GET /api/v1/hosts/{id}/metrics`（历史曲线，参数待定稿）与 `GET /api/v1/alert-events?agent_id=`（该机关联告警，属 M3 告警域）。前端类型已声明：`web/src/api/private.ts` 的 `HostDetail` / `HostProbeHistory` / `HostIpHistory` / `HostProcessSnapshot`。

| 区块 | 数据来源 | 要点 |
|---|---|---|
| 头部信息 | `GET /api/v1/hosts/{id}` | 名称、状态、`host_info`（os/kernel/arch/boot_time）、`capabilities`、「时钟漂移」角标（✅ §6.5）、「Flapping」角标（✅ 决策 #39） |
| 当前快照 | `GET /api/v1/hosts/{id}` 或 `/ws/live` | CPU（整体+每核）、内存/swap、各分区容量与 inode、各网卡速率/流量/连接数、GPU、进程总数 |
| 历史曲线 | `GET /api/v1/hosts/{id}/metrics` | 见 §6 图表规格；`TimeRangePicker` 选择范围 → step 自动降档 |
| 探活历史 | `GET /api/v1/hosts/{id}/probes` | 每 probe：状态时间条 + 可用率 + 最近延迟；失败点显示 `error`/`status_code` |
| IP 变更时间线 | `GET /api/v1/hosts/{id}/ip-history` | 当前 IP + 区间列表 + 事件（旧→新、是否同网段、来源 remote/agent_reported、`flapping` 事件） |
| 进程 Top | `GET /api/v1/hosts/{id}/processes` | 进程总数 + Top-N 表（CPU/内存）；**需登录** |
| 该机关联告警 | `GET /api/v1/alert-events?agent_id=` | 最近事件列表（可跳 `/alerts`） |

➕ 建议：详情页 URL 带查询参数保存当前选择（`?range=6h&metrics=cpu.usage`），便于分享与刷新恢复。

### 4.5 `Alerts.vue` — 告警（✅ §7.1–7.3）

| 页签 | 内容 |
|---|---|
| 事件 | 事件列表（状态 firing/resolved、severity、规则、主机、**触发序列全名**（`metric`，如 `disk.used_pct{mount=/data}`，用 `labels` 渲染成「/data」）、触发值、开始/恢复时间、通知结果）；点开看 `notification_log`；可按 `metric` 过滤 |
| 规则 | 列表 + `AlertRuleForm` 新建/编辑；字段受控：类型（阈值/离线/IP变化/探活/时钟漂移）、比较符、阈值、持续时长、severity、通道多选、静默期、启用开关；**指标选择 = 基名下拉 + 「全部维度 / 指定维度」开关**（✅ 本轮决策：开关直接映射为传基名/传全名；选「指定维度」时展开该基名已上报的维度值多选，如勾选 `/data`、`eth0`、`GPU 0`），⛔ 不提供自由文本指标输入 |
| 通道 | `ChannelForm`：SMTP / 企业微信 / 钉钉 / 飞书 / Webhook；「测试发送」按钮（✅ §7.2）；敏感字段只显示遮罩，未修改则不提交（部分更新） |
| 静默 | `SilenceManager`：维护期/静默窗口（✅ §7.1） |

⛔ 规则表单**不得**提供自由表达式输入框（`expr` 必须保持为空）——受控阈值 DSL 是零 RCE 的前端体现（✅ §7.1、决策 #22）。若将来开放 `expr`，需单独评审。
➕ 表单按 `kind` **动态渲染 `params` 字段**（✅ 本轮决策：统一放 `params`，字段白名单与后端一致，见 `docs/database.md` §5.11）：探活类 = 选探活目标（该机已上报的 `probe_name`）+ 条件（down / 延迟 > / 状态码不在）；IP 变化类 = any / subnet / frequent；离线类 = cycles；时钟漂移类 = 阈值 ms。前端⛔ 不得发送白名单外的键（后端会 400）。

### 4.6 `Settings.vue` — 设置（✅ §5.4、§6.1、§18.1）

> ✅ **Agent 管理里的「创建」已就绪（2026-10-04）**：`POST /api/v1/agents` + 前端 `agentsApi.create()`（类型见 `web/src/api/private.ts` 的 `CreatedAgent`/`AgentInstallHint`）。
> ⚠️ 三点实现口径与本节描述要对齐：① `agent_key`/`agent_secret` **仅此一次**返回，离开页面不可再取（UI 必须强提示 + 提供复制）；② `install_hint` 是**对象**（`one_liner`/`interactive`/`key_file` 三段 + `security_note` + `warnings`）——未配置 `AGENT_INSTALL_SCRIPT_URL` 时三段均为 `null`，此时⛔ 不要渲染复制按钮，改为展示 `warnings[].message`；③ 列表 / 手动轮换 / 禁用 / 吊销仍 ⏳（要等 `GET /api/v1/agents` 的字段与"吊销语义"定稿，见 `docs/api-status.md` §4.7）。

> ✅ **2026-10-03 拆分（Owner 拍板「方案 A」）**：本页只放**管理类**区块；**自助类**（二次验证、我的会话、SSO 绑定状态）移到「我的账号」页 `/account`（`Account.vue`，见 §3 路由表）。理由：本页仅 `admin` 可达，而服务端对自助类**不设 admin 门槛**（`server/src/routes/auth.js` 的 `2fa/*` 只有 `requireSession` / `requireFullSession` + `requireCsrf`，无 `requireRole`）——把自助类放在本页，会让普通用户（`role=user`）在完整态下**永远无法自助开启 2FA**；受限态被守卫特批进绑定页只是「被策略强制绑定」这一条路径，不构成自助入口。

| 区块 | 内容 |
|---|---|
| Agent 管理 | 列表（状态/最后上报/**凭证年龄 `credential_age_days`**）；**创建** → 结果面板同时给出：① **一键安装命令（含 `VANTAGE_KEY`，复制按钮）** ② 交互式/stdin 与 `--key-file` 两种更安全形式的命令（折叠在次要位置）③ `agent_key`/`agent_secret` 明文（独立字段 + 复制按钮）；全部标注「仅显示一次，离开即不可再取」，并展示安全提示（env 形式会进 shell history、建议 `history -d` 或改用 `--key-file`）——✅ 本轮修订决策 #37，见 `docs/api.md` §4.4；**手动轮换**（✅ 本轮决策：无并存过渡，旧凭证立即失效 → 必须弹窗强提示「需立即上机替换 key 文件并 reload，否则该机将判离线」+ 主机名二次确认，返回结构与创建一致）；**禁用/启用**；**吊销** |
| 轮换提醒 | ✅ 本轮决策：`rotate_recommended` 为真时列表打「建议轮换」徽标（附 `credential_age_days`）；**阈值取后端下发的 `rotate_policy.days`**（默认 90 天，⛔ 前端不硬编码，`notify=false` 时仅保留徽标）；顶部可显示汇总提示条「N 台主机凭证已超过建议轮换周期」 |
| 面板账号 | ✅ 本轮决策：权限**暂时两级** `admin` / `user`；本页提供**最小集**——用户列表 + 分配 `role` + 启用/禁用 + 重置该用户 2FA（见下一行）；⛔ 本期不做改密/删除用户 UI（改密走用户自助或 DB 运维）；「新建用户」建议保留（否则无法增加管理员） |
| 二次验证 (2FA)（→ `/account`） | ✅ 本轮决策：**面板自助绑定**——「绑定」展示 `otpauth_uri` 二维码 + secret 文本（提示一次性）+ 输入验证码确认；「解绑」需密码二次确认；展示当前状态与绑定时间；**恢复码**：绑定成功即展示 10 个一次性码（强制提示保存）、显示剩余数量、支持重新生成（旧码立即作废）；若 `security.require_2fa=true` 且账号未绑定 → 登录后强制跳「我的账号」（`/account`，受限态只能访问该页，`docs/api.md` §4.1）。✅ **解绑已落地（2026-10-04）**：`components/two-factor/TwoFactorUnbindForm.vue`（危险按钮 → 就地表单 → 当前密码二次确认 → 204 后 `refreshMe()` 并回执"已解绑、恢复码一并作废"）；`require_2fa=true` 时服务端回 409，前端**原样展示服务端 message**（不换成通用"状态冲突"）；⚠️ 密码填错是 401 `invalid_credentials`，⛔ 不得当成会话失效把人踢下线（见 §9 会话失效那行） |
| 用户 2FA 重置 | ✅ 本轮决策（恢复渠道二）：面板账号列表提供「重置该用户 2FA」按钮（仅 `admin`）——二次确认（输入用户名）→ 调 `POST /api/v1/users/{id}/2fa/reset`（清绑定 + 作废恢复码 + 踢该用户下线）；UI 须明确提示「该用户下次登录将只用密码」 |
| 我的会话（→ `/account`） | `SessionList`：当前会话信息（创建时间/最后活动/IP/UA）+「登出全部设备」（✅ 决策 #32） |
| SSO（占位，→ `/account`） | ➕ 预留入口：展示当前账号的 SSO 绑定状态（未绑定/已绑定 + `oidc_issuer`）；本期仅展示占位与说明，不做 OIDC 登录（✅ 本轮决策） |
| 系统设置项 | ✅ 本轮决策：统一渲染 `GET /api/v1/settings` 返回的**白名单项**（`public_view.enabled`、`security.require_2fa`、`credential_rotate.reminder_days`、`credential_rotate.notify`），按后端下发的**类型与默认值**渲染控件与文案，⛔ 前端不硬编码 key 列表/默认值；保存走 `PATCH /api/v1/settings`（仅 `admin`），成功后提示「已立即生效」（无需重启） |
| 公开视图 | 总开关 `public_view.enabled`（✅ §5.4，读写走上面的 `/api/v1/settings`）；✅ 已定（本轮）：**默认开启** → 本页需醒目展示当前状态（开/关徽标 + 生效范围说明）+ 「一键关闭」（二次确认，提示将影响免登录访问）；并提示公开接口已按 IP 严格限流、内容已脱敏 |
| 审计 | 可选入口：`GET /api/v1/audit-logs`（需登录，✅ §5.4） |

---

## 5. 数据层规格

### 5.1 API 客户端（✅ §11.4 三个模块；➕ 约定）

| 模块 | 职责 |
|---|---|
| `api/public.js` | 仅 `/api/public/*`；**绝不**附带凭证；可被公开页安全调用 |
| `api/private.js` | 仅 `/api/v1/*`；`credentials: 'include'`；**所有非 GET 请求自动注入 `X-CSRF-Token`**（取自 `auth` store，源于登录/`me` 响应）；统一错误映射（401 → 清理 auth store + 跳登录；403 `totp_required` → 跳登录第二步；429 → 气泡提示 + 倒计时） |
| `api/ws.js` | WS 连接、订阅、心跳、退避重连、消息分发到 `realtime` store |

➕ 建议：统一在响应拦截层把后端 `error.code` 映射为中文文案（i18n key），避免每个组件各写一套提示。

### 5.2 `store/auth.js`（✅ §18.1）

状态：`user / roles / csrf / session / status(unauthenticated|authenticated|totp_pending|unknown)`。
> ✅ 本轮决策补充：`roles` 恒为单元素数组（`["admin"]` 或 `["user"]`），前端统一用 `isAdmin` 计算属性判定写权限，**不要**散落判断字符串。
动作：`bootstrap()`（启动或刷新后调 `GET /api/v1/auth/me`）、`login()`、`verifyTotp()`、`logout()`、`logoutAll()`。
⛔ 不持久化任何凭证到 `localStorage`/`sessionStorage`（会话在 HttpOnly Cookie 中）。
➕ 建议：`csrf` 只存内存（页面刷新后由 `me` 重新获取）。

### 5.3 `store/realtime.js` — 快照 + 增量合并（✅ §18.2）

| 概念 | 规格 |
|---|---|
| 快照 | 连接建立后收到 `snapshot` → **整表替换**当前状态（不合并、不累加），保证与后端一致 |
| 增量 | 收到 `delta` → 按 `agent_id` + **指标全名**（`基名{维度=..}`，见 `docs/database.md` §5.7.2）就地更新「当前值」，并推入**定长环形缓冲**（建议每序列 300 点）供曲线即时追加；缓冲的键即 `series.metric` 全名，⛔ 不要用基名做键（会把多个挂载点混成一条线） |
| 连接状态 | `connecting / open / closed / degraded`，供 `AppLayout` 显示「实时连接」指示灯 |
| 重连 | **指数退避**（如 1s → 2s → 4s → … → 上限 30s + ±20% 抖动，✅ §18.2）；重连成功后**重新拉全量快照**，并清空环形缓冲避免断线期空洞被误连 |
| 不补传 | 掉线期间缺失的增量**不补**（✅ §18.2 无断点续传）；UI 必须在曲线上显示**断点**（缺失即断线，不插值） |
| 心跳 | ✅ 本轮决策：**保活由协议层帧完成**（服务端发 ping 帧、浏览器自动回 pong，前端**不发**任何保活消息）；前端只做**失活检测**——超过阈值（建议 45s）未收到任何帧/消息即判为 `degraded` 并触发重连 |
| 频道订阅 | 公开页只订阅公开频道；详情页按需 `subscribe {agents: [id]}` 降低流量 |
| 页面隐藏 | ✅ 已定（本轮）：`document.hidden` 时**不改变 WS 订阅**（保持状态一致），仅**暂停图表渲染**（`IntersectionObserver` + 暂停动画/重绘） |

> ⛔ 客户端 → 服务端消息**只允许** `subscribe`（✅ 本轮决策：保活走协议层帧，不再有应用层 ping/pong）；新增任何消息类型都需评审（不得成为下发通道）。

---

## 6. 图表规格（✅ 决策 #5；➕ 工程约束）

### 6.1 `MetricChart.vue` 契约

| 项 | 规格 |
|---|---|
| Props | `series`（来自 `/metrics` 或实时缓冲）、`unit`、`step`、`height`、`theme`、`loading`、`error`、`showMinMax` |
| **序列标识（✅ 本轮决策）** | 指标名 = `基名{维度=值}` 全名（`docs/database.md` §5.7.2）。`series.metric` 是权威键（用作 ECharts `series.id`），`series.base` 用于**分组**（同一基名一组、可折叠），`series.labels` 用于**图例文案**（显示 `/data`、`eth0`、`GPU 0`）；解析/拼装走 `utils/metrics.js` 的 `parseMetric`/`buildMetric`，⛔ 不在组件里手写字符串拼接 |
| 数据源分层 | 历史由 `/api/v1/hosts/{id}/metrics` 拉取（按 `step` 档位）；**实时增量**由 `realtime` store 追加到尾部（仅「当前值」，不参与历史重算） |
| 缺失处理 | 缺失桶**不补 0 也不补 null**，数组里直接没有那个点（`docs/api.md` §4.3）：前端按时间轴的空档断线（`connectNulls: false` / 逐点定位），并在 tooltip 里标注「无数据」。⛔ 代码里不要 `?? 0` 兜底 |
| 点数上限 | **不是前端的事**（✅ 2026-10-05 定）：一条线的点数由服务端档位决定（30s/1m/5m，最多为 30 天档的 8640 点/条），⛔ 前端**不做二次抽稀** —— 抽稀会把尖刺整段抹掉。前端要做的只有一件事：**按当前范围限制可勾选的序列数**（服务端在 400 的 `details.max_series_at_this_range` 里给出上限；30 天档是 5 条，其余档 20 条） |
| 单位格式 | 统一走 `utils/units.js`：`%`、bytes（自动 B/KiB/MiB/GiB/TiB）、bytes/s、℃、W、次/s、ms |
| 交互 | 十字准星 + 共享 tooltip、`dataZoom`（拖动选择时间窗）、图例可切换序列、双击重置 |
| 主题 | 明/暗两套（跟随 `ui.js` 偏好 + `prefers-color-scheme`）；ECharts 主题注册一次，切换时 dispose 重建 |
| 性能 | 实时流式更新时 **关闭动画**（`animation: false`）；组件卸载必须 `dispose()`；容器用 `ResizeObserver` 驱动 `resize()` |
| 空/错态 | 无数据显示「暂无数据（该区间无上报）」；接口失败显示重试按钮（`AsyncState`） |

### 6.2 常用图表清单（➕ 建议）

✅ 已定（本轮）：默认时间范围 **6h**；主机详情默认展示 **CPU / 内存 / 磁盘 / 网络 四图**，GPU 与探活按需展开（GPU 图在 `capabilities.gpu.*` 为 false 时整块隐藏）。

| 图表 | 指标 | 备注 |
|---|---|---|
| CPU | `cpu.usage` + `cpu.core.usage{core=<n>}`（默认折线，每核可折叠） + `cpu.load1/5/15`（副轴） | 每核过多时默认隐藏，提供「显示每核」开关 |
| 内存 | `mem.used_pct` + `mem.used/available` + `swap.used_pct` | 面积图 |
| 磁盘 | `disk.used_pct{mount=..}` 多线 + `disk.inode_used_pct` 切换 + IO（`disk.read_bps/write_bps`、`disk.latency_ms`） | 挂载点较多时按需勾选；请求用基名 `disk.used_pct` 让服务端展开全部维度序列 |
| 网络 | `net.rx_bps/tx_bps`（每网卡一 group）；累计流量用 `net.rx_total/tx_total` | 速率轴自动单位；图例用 `labels.device` |
| GPU | `gpu.util`、`gpu.mem_used/mem_total`、`gpu.temp`、`gpu.power`（维度 `{index}`） | 无 GPU 时整块隐藏（`capabilities` 驱动） |
| 探活 | 状态时间条（up/down 色块）+ 延迟折线 | 用 `ProbeTable`，非 ECharts 或轻量 bar |

⛔ 前端**不自行聚合、也不自行抽稀**（如把 30s 数据在浏览器端降采样成大范围曲线）——一律由服务端按 `step` 返回（✅ §9「前端长周期图表只查降采样层」）。
✅ **时间范围选择器与档位的对应关系不用前端硬编码**：`TimeRangePicker` 只传 `from`/`to`，服务端按 `step=auto` 的规则选档并在响应里回传**实际** `step`（1h/6h→`30s`、24h→`1m`、7d/30d→`5m`）；前端把回传的 `step` 显示在图表角落即可（`docs/api.md` §4.3 有完整对照表）。

---

## 7. 权限与可见性矩阵（✅ §5.4，前端实现口径）

| UI 元素 | 公开（免登录） | 需登录 | 备注 |
|---|---|---|---|
| 主机列表 / 状态 | ✅ | ✅ | 公开页显示名为 `display_name`；私有页可显示 `name`；**公开域一律用 `public_slug`**（✅ 本轮决策），⛔ 公开域不得出现/缓存内部 UUID |
| 当前指标快照 | ✅ | ✅ | 公开页隐藏 IP 与设备真实名 |
| 探活 up/down 概览 | ✅ | ✅ | 公开页 target 脱敏（`docs/api.md` §3.2） |
| 汇总计数 | ✅ | ✅ | |
| 历史曲线 | ❌ | ✅ | 公开页不渲染图表组件（避免误调私有接口） |
| IP 变更时间线 | ❌ | ✅ | |
| 进程 Top | ❌ | ✅ | |
| 审计日志 | ❌ | ✅ | |
| 告警规则/通道/静默 CRUD | ❌ | ✅（仅 `admin`） | 普通用户（`user`）隐藏写按钮（✅ 本轮决策：暂时两级权限） |
| Agent 管理/密钥操作 | ❌ | ✅（`admin`） | key 一次性展示 |

➕ 建议：**同一组件按权限裁剪字段**（`HostTable` 传 `mode: 'public' | 'private'`），而不是维护两套表格，减少视觉不一致。

---

## 8. i18n、主题与响应式

### 8.1 i18n（✅ 决策 #26、§16）
- 默认 `zh-CN`；`locales/en-US.js` 结构先建好（可留空字符串回退到 key）。
- 文案 key 命名：`view.hostDetail.title`、`common.loading`、`metric.cpu.usage`、`error.signature_invalid` 等；**至少把错误码映射表抽成 i18n**。
- 数字/时间格式：统一走 `utils/format.js`（`Intl.DateTimeFormat` / `Intl.NumberFormat`），✅ 已定（本轮）：时间一律按**浏览器本地时区**展示，且**必须标注偏移**（如 `2025-09-25 20:00 (UTC+8)`）——因为后端一律 UTC。

### 8.2 主题与视觉（➕ 建议）
- 明/暗主题：基于 **Element Plus 的暗色主题（`html.dark`）+ CSS 变量**定制（✅ 本轮决策），配色语义固定：在线=绿、离线=灰、告警=橙（warn）/红（critical）、漂移=黄、Flapping=紫（避免与告警色混淆）。
- 状态不只靠颜色：徽标同时带文字/图标（可访问性）。

### 8.3 响应式断点（✅ 决策 #27；➕ 具体值）

| 断点 | 布局 |
|---|---|
| ≥ 1200px | 侧栏 + 内容区；详情页图表两列；表格全列 |
| 768–1199px | 侧栏折叠为图标；图表单列；表格隐藏次要列（保留状态/CPU/内存/操作） |
| < 768px | 单列；表格转**卡片列表**；图表高度压缩（200–240px）+ 横向可滚动；顶部汇总改为横向滑动卡片 |

⛔ 不做 PWA/离线缓存（✅ 决策 #27）。

---

## 9. 安全与隐私（前端侧，✅ §13）

| 要求 | 实现口径 |
|---|---|
| 会话安全 | 仅依赖 HttpOnly Cookie；⛔ 不读、不写 `sid`；⛔ 不用 `localStorage` 存 token |
| CSRF | 所有写请求带 `X-CSRF-Token`（来自 `me`/登录响应）；缺失即视为前端缺陷 |
| XSS | 默认文本插值；⛔ 禁用 `v-html`，除非对后端返回值做过白名单清洗（`error`/`top.name` 等字段视为不可信） |
| 越权请求 | 公开页不得请求私有接口（网络层断言，便于测试） |
| 敏感信息 | ⛔ 不在 URL、日志、埋点、控制台打印 key/secret/Cookie；一次性 key 展示页刷新后即消失（不缓存） |
| 会话失效 | 401 → 清理 auth store + 跳登录并保留 `redirect`；⚠️ **但 `invalid_credentials` 除外**（2026-10-04 修正）：它是"用户在自助表单里填错了口令"（`/auth/login`、`/auth/2fa/disable` 的密码二次确认），此时会话仍然有效 —— 按会话失效处理会把用户因为一次手误踢出控制台。分流实现见 `web/src/api/private.ts` 的 `isSessionExpiry()`；403 `totp_required` → 回到登录第二步 |
| 依赖 | 锁版本；定期 `npm audit`（✅ §13） |

---

## 10. 性能预算（✅ 已定，本轮：按本表执行）

| 指标 | 目标 |
|---|---|
| 首屏 JS（gzip） | 公开页 ≤ 150KB；控制台首屏 ≤ 250KB（含按需引入的 Element Plus，✅ 本轮决策下须实测） |
| 路由懒加载 | 登录后页面全部动态 import；ECharts 仅在含图表的页面加载 |
| WS | 全站**单连接**复用（公开页 1 条 `/ws/public`，登录后 1 条 `/ws/live`）；切换页面只改订阅，不重建连接 |
| 长列表 | 主机数 × 列数 无虚拟滚动需求（当前 5 台、设计余量几十台）；事件/审计列表用 cursor 分页 |
| 图表 | 同屏图 surface ≤ 6 个；不可见图表暂停渲染（`IntersectionObserver`） |

---

## 11. 测试与验收（➕ 建议）

| 层 | 覆盖 |
|---|---|
| 单元 | `realtime` store 的快照替换/增量合并/重连清空缓冲；`utils/units.js` 单位换算（bytes/Bps/℃）；错误码 → 文案映射 |
| 组件 | `MetricChart` 缺失数据断线（不补 0）；`HostTable` 公开模式下**不渲染** IP 列；`AlertRuleForm` 无自由表达式字段 |
| 契约 | 用 `docs/api.md` §6.2 的面板用例做联调：未登录 401、`totp_required`、CSRF 失败、sid 轮换后需重取 `me` |
| 回归（防越线） | 静态断言：代码库中不存在指向 `/api/v1/agent/*`（下发类）或任何「发送指令」文案的 UI 路径（✅ §13 单向性复核的前端部分） |
| 手工 | 手机浏览器（< 768px）看列表与详情可用；弱网/断 WS 时 UI 有明确降级提示 |

---

## 12. 里程碑映射（✅ §14）

| 阶段 | 前端产出 |
|---|---|
| M1 | `PublicStatus.vue` + `HostTable`(public) + `/ws/public` 实时更新（免登录公开状态页） |
| M2 | `/login` 登录流程（含 CSRF/401 处理）；公开页保持只读 |
| M3 | `Alerts.vue`（事件列表 + 规则表单 + 通道配置 + 测试发送） |
| M4 | `HostDetail.vue` 完整（曲线/探活历史/IP 时间线/进程 Top）+ TOTP + RBAC 可见性 + `Settings.vue` Agent 管理 |
| M5 | 体验打磨（主题、响应式、性能预算、空/错态） |
| M6 | 无前端改动（跨平台仅 Agent 侧，✅ §17.2「中心侧零改动」） |

---

## 13. 待 Owner 拍板清单（前端视角）

| # | 议题 | 建议 |
|---|---|---|
| F1 | ✅ 已定：**Element Plus** + 按需引入（禁全量 import）+ CSS 变量定制 | 见 §2 依赖边界、§8.2 |
| F2 | ✅ 已定：公开页**就地展开当前快照**（点击主机卡片展开），⛔ **不设**公开详情路由、不含历史与 IP | 见 §3、§4.1 |
| F3 | ✅ 已定：公开页**只用 `display_name`**（缺失回退泛化名如「主机 3」）；私有页显示 `name` + `display_name` | 见 §3、§4.1、§7 |
| F4 | ✅ 已定：时间按**浏览器本地时区**展示并**标注偏移** | 见 §8.1 |
| F5 | ✅ 已定：页面隐藏**不暂停 WS 订阅**，仅暂停图表渲染 | 见 §5.3 |
| F6 | ✅ 已定：2FA **面板自助绑定**（绑定/解绑 + 强制策略引导页） | 见 §4.6 |
| F7 | ✅ 已定：性能预算按 §10 执行（公开页首屏 ≤150KB / 控制台 ≤250KB gz、路由懒加载、单 WS 连接） | 见 §10 |
| F8 | ✅ 已定：**不做**事件 `ack`（认领）UI，用静默窗口覆盖 | 见 §4.5、`docs/api.md` §4.6 |
| F9 | ✅ 已定：默认时间范围 **6h**，默认展示 **CPU / 内存 / 磁盘 / 网络 四图**（GPU、探活按需展开） | 见 §6.2 |
| F10 | ✅ 已定：维度写进指标名；前端按 `base` 分组、`labels` 作图例 | 见 §6.1/§6.2；解析统一走 `utils/metrics.js` |
| F11 | ✅ 已定（本轮）：权限两级、凭证**手动**轮换 UI、轮换提醒徽标 | 见 §4.6、§7 |
| F12 | ✅ 已定：用户管理**最小集**——用户列表 + 分配 `role` + 启用/禁用 + 重置该用户 2FA；⛔ 本期不做改密/删除 UI（改密走用户自助或 DB 运维） | 见 §4.6 |
| F13 | ✅ 已定：阈值**可配**（默认 90 天），由后端 `rotate_policy` 下发，前端不硬编码 | 见 §4.6 |
| F14 | ✅ 已定：`public_view.enabled` **默认开启** | 见 §4.6、`docs/api.md` §3.2 |

> ✅ **前端侧议题已全部拍板**（F1–F14），本文不再有待决策项。

---

## 14. 与设计文档的对照（溯源）

| 本文位置 | 设计文档来源 |
|---|---|
| §1.1、§8.1、§8.3 | §3 技术栈、§16 前端与许可、决策 #26/#27 |
| §1.2、§9 | §2.1 单向宗旨、§13 安全清单、§18.3 |
| §2 | §11.4 前端目录 |
| §3、§4.1、§7 | §5.4 面板访问分级、决策 #10/#21 |
| §4.2、§5.2 | §18.1 有状态会话、决策 #31/#32 |
| §4.3、§4.4 | §1.1 面板能力、§5.3 心跳/离线、§6.5 时钟漂移、§8 IP 追踪 |
| §4.5、§4.6 | §7.1–7.3 告警、§6.1 凭证、决策 #22/#23/#37 |
| §5.3、§6 | §18.2 实时通道、§9 降采样（前端只查降采样层） |
| §10、§12 | §14 里程碑 |
