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
  所以 `npm run dev` / `build` / `test` 每次都需要放宽一次权限；`npm install` 则需要
  `--cache ../.npm-cache --ignore-scripts`（安装期的 lifecycle 脚本同样会踩管道限制）。
- **测试与构建由 Owner 本人执行**（2026-10-02 约定）：编码 Agent 只负责写代码、写测试，
  ⛔ 不代跑 `npm test` / `npm run build`。需要人工验证的命令见下一节。

### 验证状态（本次初始化）

| 项 | 结果 |
|---|---|
| `npm run type-check` | ✅ 通过（无错误） |
| `npm test` | ✅ 85/85 通过（5 个文件） |
| `npm run build` | ✅ 通过（2026-10-02 由 Owner 执行：vite 7.3.6，1704 modules，58s） |

**首屏体积实测（对照 `docs/frontend.md` §10 性能预算）**

| 路由 | 首屏 JS（gzip） | 预算 | 余量 |
|---|---|---|---|
| 公开总览 `/` | ≈ **128 KB**（entry 123.95 + PublicStatus 3.04 + el-alert 0.90） | ≤ 150 KB | ~22 KB（**已用 85%**） |
| 控制台（如 `/hosts`） | ≈ **124 KB**（entry 123.95 + HostList 0.35） | ≤ 250 KB | ~126 KB |

- ✅ 路由懒加载已生效：8 个视图各自成 chunk（0.48–7.96 KB），⛔ 不要改成静态 import。
- 体积几乎全在 entry chunk（339.98 KB raw / **123.95 KB gz**）：Vue + vue-router + Pinia + vue-i18n
  + 按需引入的 Element Plus（含 53.87 KB raw / 8.64 KB gz 的 CSS）。
- ⚠️ **公开页预算只剩约 22 KB**：M1 起新增依赖要先评估（能懒加载就懒加载，或论证 entry 是否需要拆分）；
  ECharts 必须只在含图表的页面动态 import（`docs/frontend.md` §10）。

## 已落地的目录结构

```
web/
├── index.html                  # 唯一的 HTML 入口；含首屏主题内联脚本（防暗色白闪）
├── package.json / tsconfig.json / vite.config.ts
├── src/
│   ├── main.ts                 # 装配：pinia → i18n → router → api 接线
│   ├── App.vue                 # 主题边界 + 外壳选择 + 路由出口
│   ├── router/index.ts         # 路由与守卫（登录/角色/公开域隔离）
│   ├── views/                  # PublicStatus / HostList / HostDetail / Alerts / Settings / Login / Forbidden / NotFound
│   ├── components/             # AppLayout（导航壳）/ StatusBadge / AsyncState
│   ├── api/                    # http.ts（底座）/ public.ts / private.ts / ws.ts
│   ├── store/                  # auth.ts / realtime.ts / ui.ts（Pinia setup store）
│   ├── composables/useTheme.ts # 主题切换的唯一入口
│   ├── locales/{zh-CN,en-US}.ts + i18n/index.ts
│   ├── styles/                 # element-overrides.scss（el-* 变量唯一落点）+ base.scss
│   ├── types/                  # domain.ts（接口字段口径）/ http.ts
│   └── utils/                  # metrics / units / time / format / ring
└── tests/                      # vitest 单测
```

**依赖边界（`docs/frontend.md` §2）**：Element Plus 走 `unplugin-vue-components` + `unplugin-auto-import`
**按需引入**（⛔ 不允许全量 `import ElementPlus`）；ECharts 尚未引入（见「还差什么」），
接入时必须 `echarts/core` 按需注册，⛔ 不整包 import。

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

| 待办 | 说明 |
|---|---|
| M1 公开总览 | `PublicStatus.vue` 接 `/api/public/*` 与 `/ws/public`（当前是占位页 + 三态容器） |
| M2 登录 | `Login.vue` 两步流程（密码 → TOTP / 恢复码），含 429 倒计时；store 与 api 已就绪 |
| 图表层 | 引入 `echarts/core` 按需注册 + 实现 `MetricChart.vue`（缺失断线、`dispose()`、`ResizeObserver`） |
| 剩余组件 | `HostTable`（public/private 双模式）、`TimeRangePicker`、`IpTimeline`、`ProcessTopTable`、`AlertRuleForm`、`ChannelForm`、`SilenceManager`、`SessionList` |
| 告警接口 | `docs/api.md` §4.5–§4.7 的规则/通道/静默 CRUD 端点尚未在 `api/private.ts` 落位（⛔ 不猜路径） |
| 服务端联调 | `/api/public/*`、`/api/v1/*`、`/ws/*` 目前只有健康检查与 Agent 上报已实现（`server/src/app.js`） |

## 与 `docs/frontend.md` 的两处**有意偏离**（需要的话我可以反向对齐文档）

1. **TypeScript 而非 `.js`**：§2 的目录树写的是 `main.js` / `router/index.js`，本工程按 Owner 本轮选择用 TS。
2. **多出的文件**：`api/http.ts`（请求底座，避免 public/private 两份重复实现）、
   `utils/ring.ts`（环形缓冲）、`views/Forbidden.vue`（§3 要求「越权显示 403 提示页」）、
   `types/`（TS 需要统一的接口字段口径）。
   另外 `store/` 沿用文档的**单数**目录名（Pinia 社区惯例是 `stores/`）。
