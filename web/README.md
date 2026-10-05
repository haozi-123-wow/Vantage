# Vantage Console 前端（`web/`）

Vue 3 + TypeScript + Element Plus 的工程骨架。**工程规格以 [`docs/frontend.md`](../docs/frontend.md) 为准**，
本文件只描述「已经落地了什么 / 怎么跑 / 还差什么」。

> ⚠️ **本次初始化的范围约束（Owner 要求）**：**不参考 `design/` 设计层**。
> 因此这里没有任何设计令牌、色值阶梯或组件视觉规范；`src/styles/element-overrides.scss` 里的色值
> 是骨架期的临时中性色，正式视觉层接入时**整表替换该文件即可**，组件不需要改动。

## 快速开始

```bash
cd web
npm install --cache ../.npm-cache   # 受限沙箱里 npm cache 必须落在工作区内（见根 README §3.1）
cp .env.example .env.development    # 可选：改 vite 代理目标
npm run dev                         # http://localhost:5173
```

| 脚本 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（含 `/api`、`/ws`、`/healthz`、`/readyz` 代理到本机中心服务） |
| `npm run type-check` | `vue-tsc --noEmit`（提交前必跑） |
| `npm test` | `vitest run`（单测） |
| `npm run build` | 先类型检查，再产出 `dist/` |
| `npm run preview` | 预览构建产物 |

联调时后台默认是 `127.0.0.1:8787`（`server/`）；改目标用 `VITE_DEV_API_TARGET`。
⚠️ `/ws` 握手会带浏览器 `Origin`（`http://localhost:5173`），**中心侧的 Origin 白名单必须包含它**，
否则 WS 会被拒（`docs/api.md` §5.1）。

### 本机环境限制（⛔ 先看这一节）

- **受限沙箱里跑不了前端工具链**：Vite / Vitest 用 esbuild 转码，而 esbuild 的 JS API 会 spawn 一个
  esbuild 进程并通过 **stdio 管道**通信 —— 受限模式直接 `spawn EPERM`（与根 README §3.1 记录的是同一类限制）。
  所以 `npm run dev` / `build` / `test` 需要放宽一次权限（或把本会话切成完全权限）。
- **`npm install` 的 cache 必须落在工作区内**：`npm install echarts --cache .npm-cache`
  （系统 npm cache 在受限令牌下不可写；`web/.npm-cache/` 已被根 `.gitignore` 的 `.npm-cache/` 覆盖）。
- **`vite build` 的临时目录也要落在工作区内**（2026-10-05 实测）：esbuild 会在系统 TEMP 下建临时文件，
  而那里**能建不能删** → 构建在 `[vite:esbuild-transpile] remove …: Access is denied` 处失败。
  绕过：`$env:TEMP=$env:TMP='<工作区内的目录>'; npx vite build`。
- ⚠️ **工作区子目录的完整性标记（2026-10-05 实测，已修）**：DSH 的受限命令跑在 Windows **低完整性令牌**下，
  而工作区只有**根目录**带低完整性标记 → 受限命令只能写根目录，进 `web/`、`server/` 等子目录一律
  `EPERM / Access is denied`（`write` / `edit` 工具不受影响，只影响 `pwsh` 里跑的命令）。
  修法（顺序不能反）：先 `icacls <目录> /grant *<当前用户 SID>:(OI)(CI)F /T /C /Q`，
  再 `icacls <目录> /setintegritylevel (OI)(CI)Low /T /C /Q`。本仓库只对 `web/` 全树做过；
  `server/`、`docs/` 等**尚未**处理，在那些目录里跑受限命令仍会失败。回滚记录见
  `D:\phpstudy_pro\WWW\Vantage-acl-report\`。
- **测试与构建由 Owner 本人执行**（2026-10-02 约定）：编码 Agent 只负责写代码、写测试。
  ⚠️ 2026-10-05 的这轮实现里，Agent 在本会话（已切到完全权限）代跑了 `vue-tsc` / `vitest` / `vite build`
  做验收，结果见下表 —— 真机与浏览器联调仍由 Owner 执行。

### 验证状态

| 项 | 结果 |
|---|---|
| `npm run type-check` | ✅ 通过（2026-10-05，0 错误；⚠️ 依赖构建生成的 `src/components.d.ts`，它缺失时表格插槽的类型检查会被跳过） |
| `npm test` | ✅ **121/121 通过**（10 个文件：metrics 56 / chart 14 / realtime 12 / time 8 / units 8 / snapshot 7 / private-client 7 / time-range 5 / i18n-keys 2 / geetest 2） |
| `npm run build` | ✅ 通过（vite 7.3.6，✓ built in 41.59s） |

**首屏体积实测（对照 `docs/frontend.md` §10 性能预算；2026-10-05 重新实测）**

| 路由 | 首屏 JS（gzip） | 预算 | 余量 |
|---|---|---|---|
| 公开总览 `/` | ≈ **175 KB**（entry 134.11 + i18n 34.96 + PublicStatus 3.66 + el-skeleton 0.91 + el-alert 0.90 + SummaryBar 0.87） | ≤ 150 KB | **−25 KB（超预算）** |
| 控制台 `/hosts` | ≈ **178 KB**（entry 134.11 + i18n 34.96 + HostList 2.76 + el-input 5.51 + SummaryBar 0.87） | ≤ 250 KB | ~72 KB |
| 主机详情 `/hosts/:id` | ≈ **375 KB**（上面那一档 + HostDetail 197.20，**懒加载**） | —（图表页，非首屏） | — |

- ✅ 路由懒加载与 ECharts 按需注册都已生效：`HostDetail` 是独立 chunk（ECharts 只在那里，⛔ 不在公开页路径上）。
- ⚠️ **公开页已超预算约 25 KB**，成因已定位，两条候选（都还没做，需要 Owner 拍板）：
  ① `vue-i18n` 改用 runtime-only 构建（`vue-i18n/dist/vue-i18n.runtime.esm-bundler.js`，本项目的文案都是普通对象、不依赖消息编译器）；
  ② 拆分 entry：把 Element Plus 的基础运行时代码单独成 vendor chunk（不影响总量，只让公开页并行下载）。


## 已落地的目录结构

```
web/
├── index.html                  # 唯一的 HTML 入口；含首屏主题内联脚本（防暗色白闪）
├── package.json / tsconfig.json / vite.config.ts
├── src/
│   ├── main.ts                 # 装配：pinia → i18n → router → api 接线
│   ├── App.vue                 # 主题边界 + 外壳选择 + 路由出口
│   ├── router/index.ts         # 路由与守卫（登录/角色/公开域隔离）
│   ├── views/                  # PublicStatus（✅ 公开总览）/ HostList（✅）/ HostDetail（✅ 含曲线）/ Alerts / Settings / Login / Account / Forbidden / NotFound
│   ├── components/             # 通用：AppLayout / PublicLayout / StatusBadge / AsyncState / SummaryBar
│   │                           # 公开页：HostCard（就地展开）；列表：HostTable
│   │                           # 详情：MetricChart（ECharts）/ TimeRangePicker / ProbeHistoryPanel / IpTimeline / ProcessTopTable
│   │                           # 公开探活概览：ProbeOverview；登录/2FA：GeetestCaptcha / SliderCaptcha / two-factor/*
│   ├── api/                    # http.ts（底座）/ public.ts / private.ts / ws.ts
│   ├── store/                  # auth.ts / realtime.ts / ui.ts（Pinia setup store）
│   ├── composables/useTheme.ts # 主题切换的唯一入口
│   ├── locales/{zh-CN,en-US}.ts + i18n/index.ts
│   ├── styles/                 # element-overrides.scss（el-* 变量唯一落点）+ base.scss
│   ├── types/                  # domain.ts（接口字段口径）/ http.ts
│   └── utils/                  # metrics / units / time / format / ring / chart / echarts / snapshot
└── tests/                      # vitest 单测（含 contracts/metric-names.json 共享向量）
```

**依赖边界（`docs/frontend.md` §2）**：Element Plus 走 `unplugin-vue-components` + `unplugin-auto-import`
**按需引入**（⛔ 不允许全量 `import ElementPlus`）；ECharts ✅ 已接入并按需注册
（`utils/echarts.ts` 只 `echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer])`），
且只被 `views/HostDetail.vue` 的懒加载 chunk 引用 —— ⛔ 不要在任何首屏路径上 import 它。


## 需要知道的几条硬约束（都已在代码里体现）

- **前端永不下发**：不存在任何向 Agent 发指令的入口；WS 客户端→服务端的应用层消息只有 `subscribe` 一条。
- **公开域硬隔离**：公开路由（`/`、`/status`、`/login`）下调用 `api/private.ts` 会**直接抛错**
  （网络层断言，`tests/private-client.spec.ts` 覆盖），公开域代码只允许走 `api/public.ts` 与 `/ws/public`。
- **凭证不进前端存储**：会话只在 HttpOnly Cookie 里；`csrf` 只存内存，刷新后由 `GET /api/v1/auth/me` 重取。
- **时间必须标偏移**：一律 `utils/time.ts` 渲染为 `2025-09-25 20:00 (UTC+8)`（✅ F4）。
- **缺失不补 0**：`utils/units.ts` 的缺口统一渲染为 `—`；曲线缺失桶用 `null` 断线。
- **指标名同源**：`utils/metrics.ts` 是 `docs/database.md` §5.7.2 的前端实现，
  测试直接消费仓库共享向量 [`contracts/metric-names.json`](../contracts/metric-names.json)。
- **环形缓冲的键是序列全名**（含维度），用基名做键会把多个挂载点混成一条线（F10）。

## 还差什么（按 `docs/frontend.md` §12 里程碑）

✅ **2026-10-05 本轮已落地**：公开总览（`/`）、主机列表（`/hosts`）、主机详情（`/hosts/:id`）
——含 ECharts 历史曲线、探活历史、IP 时间线、进程 Top；工具层新增 `utils/chart.ts`（option 与缺失值口径）、
`utils/echarts.ts`（按需注册）、`utils/snapshot.ts`（`current_metrics` 分组），单测 119 个。

| 待办 | 说明 |
|---|---|
| M3 告警页 | `Alerts.vue` 仍是占位页；规则/通道/静默 CRUD 端点在 `docs/api.md` §4.5–§4.7，服务端尚未实现 |
| M4 设置页 | `Settings.vue` 仍是占位页（Agent 管理 / 用户 / 系统设置 / 公开视图开关） |
| 告警接口落位 | `api/private.ts` 的 `alertsApi` / `auditApi` / `settingsApi` 目前是**占位签名**（⛔ 不猜路径），随服务端 §4.5–§4.10 一起补 |
| 实时通道 | `realtime` store 已按 `id ?? slug` 归一化两个频道；公开页断线退化轮询已实现，等真机联调 `ping/pong` 保活表现 |
| 首屏预算 | 公开页实测超预算约 25 KB，候选方案见上表（需 Owner 拍板）
| 真机联调 | `/api/public/*`、`/api/v1/*`、`/ws/*` 与浏览器交互（分页、图标缩放、移动端断点）由 Owner 在真机执行 |


## 与 `docs/frontend.md` 的两处**有意偏离**（需要的话我可以反向对齐文档）

1. **TypeScript 而非 `.js`**：§2 的目录树写的是 `main.js` / `router/index.js`，本工程按 Owner 本轮选择用 TS。
2. **多出的文件**：`api/http.ts`（请求底座，避免 public/private 两份重复实现）、
   `utils/ring.ts`（环形缓冲）、`views/Forbidden.vue`（§3 要求「越权显示 403 提示页」）、
   `types/`（TS 需要统一的接口字段口径）。
   另外 `store/` 沿用文档的**单数**目录名（Pinia 社区惯例是 `stores/`）。
