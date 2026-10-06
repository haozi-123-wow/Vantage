# Vantage 服务器状态接口方案（公开 + 私有）

> **定位**：本文是「获取服务器状态」两个接口的**实施方案与待确认决策清单**，对应 `docs/api.md` §3.2（`/api/public/hosts`）与 §4.2（`GET /api/v1/hosts`）。
> **状态**：✅ **已落地（2026-10-04，两批）**——第一批 3 个端点（`/api/public/hosts`、`/api/public/summary`、`/api/v1/hosts`），第二批 7 个（`/api/v1/summary` ➕、`/hosts/{id}`、`/probes`、`/ip-history`、`/processes`、`/api/public/hosts/{slug}/now`、`/api/public/probes`）；共 **73 个新测试**。逐条决议与实现偏差登记见 `docs/api-status.md` §4.6 / §4.6.1，校验步骤见该文件 §2（第 10–24 条）。**后续的 `/api/v1/hosts/{id}/metrics`（2026-10-05 定稿并落地，见该文件 §4.8）与两个 WebSocket 频道（`/ws/public` · `/ws/live`，2026-10-05 落地，见该文件 §4.9）也均已完成。**
> ⚠️ **例外（已完成）**：文档初稿后先落地了它的**前置件**——离线判定 `offline_sweep`（2026-10-04，
> 见 `docs/api-status.md` §4.4）。原因：上报是请求驱动的，机器掉线时没有任何请求进来，`agents.status`
> 会永远停在 `online`（**一个报平安的监控系统**），而且 `services/ingest.service.js` 已有的「离线→在线恢复广播」
> 因该状态从未被写入而**永不执行**。§2.1 的结论随之更新为「cron 写回 + 接口读取时推导」两者都做。
> **上位文档（冲突时以上位为准）**：`Vantage-DESIGN-v0.7.md`（内容已是 v0.8）→ `docs/api.md`（接口契约）→ `docs/database.md`（数据契约）→ `docs/frontend.md`（面板侧）。
> **现有实现基线（初稿时，2026-10-04 动工前）**：中心 18 个端点已落地（`/healthz` `/readyz` `/version` + 2 个 Agent 端点 + 13 个认证会话端点），当时 `/api/public/*` 与 `/api/v1/hosts` 均为 ⏳ 未实现（`docs/api-status.md` §1）。**本方案是 M2 的第一块交付**；上面「状态」行所列端点现已全部落地。

---

## 0. 一句话结论

两个接口读的是**同一套数据、同一份推导逻辑**，只是可见性与字段集不同：

| 接口 | 分区 | 鉴权 | 本方案的角色 |
|---|---|---|---|
| `GET /api/public/hosts` | `/api/public/*` | **免登录**、按 IP 限流 | 公开只读状态（无 IP、无内部 UUID、无历史） |
| `GET /api/v1/hosts` | `/api/v1/*` | **面板会话**（`requireFullSession`） | 私有状态（含 IP、漂移、Flapping、活动告警数） |

为了不产生两套推导代码，落地时新增：

```
server/src/services/status.service.js       —— 唯一的「当前状态推导」实现（含 snapshot 计算、在线/离线判定）
server/src/repositories/agent.repo.js       —— 追加 listAgentsForStatus() / findAgentStatusBySlug() / findAgentStatusById()
server/src/repositories/metric.repo.js      —— 追加 selectLatestSeriesForAgents()（LATEST 取数）
server/src/routes/public.js                 —— /api/public/*（本方案先落 2 个端点，见 §10 范围裁剪）
server/src/routes/hosts.js                  —— /api/v1/hosts
```

---

## 1. 现状核实（读代码得出，非推测）

写方案前逐条核对过代码与迁移，下面是**会影响实现**的事实：

| # | 事实 | 落点 | 对实现的影响 |
|---|---|---|---|
| 1 | `agents.status` 的**离线扫描（`offline_sweep`）定时任务已落地**（2026-10-04，与本方案同批） | `server/src/services/offline.service.js` + `cron.service.js`（每 `HEARTBEAT_SWEEP_INTERVAL_S`=**60s**；阈值为 **30s × 3 = 90s**，见 §2.1） | ✅ **状态接口仍按读取时推导**（§2.1）——让接口的正确性不依赖 cron 的存活；但 `agents.status` 现在**已经是准确的**（可被告警引擎与 WS 消费） |
| 2 | `snapshot:agent:<id>` 键已定义但**全仓库无写入方** | `server/src/utils/redisKeys.js` L45；同前缀的 `snapshot:public:` 定义在 L52（本方案新增，是当前唯一有写入方的 `snapshot:` 子键） | 目前**没有现成缓存可读**。本方案改为「`/api/public/*` 响应级缓存（短 TTL）」，⛔ 不复用该键名（见 §2.4） |
| 3 | 上报体里**没有 `uptime` 字段** | `docs/api.md` §2.1 的 `host` 对象只有 `{ hostname, os, kernel, arch?, boot_time, capabilities }` | `uptime` 必须由 `host_info.boot_time` 与 `now()` 推导（§3.3） |
| 4 | 上报体里**没有 `mem_pct` / `disk_pct` / `net_*` 字段** | 同上；百分比是**中心就地算的派生序列**（`docs/api.md` §2.1 注 3） | snapshot 的五个数值全部要走「按基名取最新值 → 归一化」的推导，⛔ 不能指望某个"快照行" |
| 5 | `alert_events` 表已建，但**告警引擎尚未实现** | `server/migrations/0006_alerting.sql`；`src/` 下无告警引擎代码 | `active_alerts` / `summary.alerts` 本期**只能查表得出 0**；文档字段保留、语义明确（§10） |
| 6 | **公开限流器**已落地（2026-10-04，本方案实施时新增） | `middleware/rateLimit.js` 的 `createPublicRateLimiter()`（L193，复用同一段固定窗口 Lua）；同文件另有 `createWsRateLimiter()`（L236） | ✅ 已按本方案 §7.1 实现，独立桶 `ratelimit:public:<ip>` |
| 7 | `public_view.enabled` 的白名单与默认值**已就绪** | `services/settings.service.js` L21（`SETTING_DEFAULTS['public_view.enabled'] = true`）+ `getSettingBool()` + `settings:cache` TTL 30s | 公开开关**零新增代码**即可读；⛔ 不要另建缓存或开关 |
| 8 | 列表响应形状**已定**为 `{ items: [...], next_cursor }` | `docs/api.md` §1.2 ③（L144，2026-10-04 定） | 两个接口都必须套 `items` 壳；⚠️ 初稿时 `web/src/api/public.ts` / `private.ts` 按**裸数组**声明，✅ **§9.1 已全部修正** |
| 9 | 公开页设计稿展示了**精确到秒的绝对时间** | `design/preview/public-status.html` L211「最后上报 12 秒前（2026-10-04 20:14:18 UTC+8）」 | `docs/api.md` §3.1 明确要求公开侧**只给相对化/分钟级**以避免行为指纹 → **设计稿此处需改**，本方案按契约实现（§9.2） |
| 10 | 设计稿顶栏展示「在线 3 · 离线 1 · **禁用 1** · 活动告警 3」 | `design/preview/MOCK-DATA.md` L36 | §3.2 的 `summary` 字段表**没有 `disabled`** → 需补（§9.3） |

---

## 2. 设计决策（8 项，**2026-10-04 已逐条拍板**）

> ✅ **口径现状**：本节各处的「（待确认事项 X）」在 2026-10-04 已按 §11 的建议逐条拍板并落地（D1-a 除外，它已决议推迟到 M3）；逐条决议见 `docs/api-status.md` §4.6 / §4.6.1。

### 2.1 D1：在线/离线**在读取时推导**，⛔ 不直接读 `agents.status`

> ✅ **前置件已落地**：`offline_sweep` 定时任务已实施（`services/offline.service.js`，每 60s），
> 因此 `agents.status` **现在**会被正确写成 `offline`。本节讨论的是**状态接口该读哪个**。

**为什么接口仍要自己算、而不直接读那个已经写对的字段**：

1. **让接口的正确性不依赖 cron 的存活**。cron 一旦静默失效（分布式锁异常、Redis 挂掉后 fail-open 到别的实例、任务连续报错），
   直接读字段的接口会**开始"报平安"**——机器死了却显示在线，而且**没有任何东西会告警**。
   读取时推导则退化为「轻微滞后」，永远不会说谎。一个报平安的监控系统比一个报错的监控系统危险得多。
2. 两个位置的阈值**必须逐字同源**，否则会出现「接口说在线、库说离线」。做法：`offline.service.js` 的
   `offlineThresholdS(config)` 是**唯一**阈值来源，扫描任务与状态接口都调它，⛔ 绝不写第二份表达式。

**判定式**（与 `offline_sweep` 完全一致，⛔ 不允许出现第二份实现）：

```
有效状态 = 'disabled'                                  当 agents.status = 'disabled'
         | 'online'                                    当 last_seen_at IS NOT NULL
                                                          且 now() - last_seen_at <= 阈值
         | 'offline'                                   其余（含 last_seen_at IS NULL）
阈值 = offlineThresholdS(config) = 30s（上报周期）× config.heartbeat.offlineMultiplier（默认 3）= 90s
```

⚠️ **上报周期为什么是 30s**：`agent/internal/config/config.go` 的 `defaultConfig()` 在**修订 G3** 中
把 `report.interval` 默认值由 15s 改成了 **30s**（采集周期随之对齐：cpu/mem/net/gpu 30s、disk/process 60s）。
中心侧若沿用旧文档的 15s，阈值会算成 45s —— **小于 30s 的上报周期**，于是**正常上报的机器也会在两次
上报之间被判离线**（面板随机闪离线，随后自愈，极难排查）。⚠️ 相关陈旧描述已一并校正：
设计 §4 L169、`docs/agent.md` G3 表、`docs/api.md` §3.2。

⚠️ **另一处余量风险（待观察）**：Agent 的 `report.heartbeat_interval` 默认 **60s** —— 指标无变化时
最长 60s 才发一次心跳，所以真实的最坏上报间隔是 **60s** 而不是 30s。当前 90s 阈值只留了 1.5 倍余量，
偏紧；若真机上出现偶发假离线，优先把 `OFFLINE_CYCLES_MULTIPLIER` 提到 4（=120s）。

- `disabled` 是**人工状态**，优先级最高、不参与超时判定（`agents_disabled_ck` 约束保证它有 `disabled_at`）。
- ⚠️ 上报周期 30s 目前**不是**中心的 `config` 项（`heartbeat` 只有 `offlineMultiplier` / `sweepIntervalS`），故写成具名常量 `AGENT_REPORT_PERIOD_S = 30`（`offline.service.js`，**已实现**）。**（待确认事项 D1-a：是否提成中心 env / 数据库设置项）**

> ✅ **偏差登记已完成**：设计 §5.3 的离线是「定时任务把状态写回 `agents.status`」，本方案把判定**同时**放在查询路径。
> 两者结果一致（共用同一阈值函数）；读路径的存在是为了让接口不依赖 cron 存活。已登记在 `docs/api-status.md` §4.4。

---

### 2.2 D2：`snapshot` 是**推导值**，五个数值 + 一个可选；无数据一律 `null`（⛔ 不补 0）

`snapshot` 的结构与 `docs/api.md` §3.2 逐字一致，并显式补齐 `frontend.md` 未写全的口径：

| 字段 | 类型 | 推导方式 | 缺失时 |
|---|---|---|---|
| `cpu_pct` | number \| null | 最新 `cpu.usage` 的值 | `null` |
| `mem_pct` | number \| null | 优先最新 `mem.used_pct`；缺失时用 `mem.used / mem.total × 100` 兜底 | `null` |
| `disk_pct` | number \| null | 最新 `disk.used_pct{...}` 各序列取 **MAX**（= 「磁盘最高占用%」，与 `frontend.md` §4.3 列名、设计稿「磁盘最高」一致） | `null` |
| `net_rx_bps` | number \| null | 最新 `net.rx_bps{device=...}` 各网卡 **SUM** | `null` |
| `net_tx_bps` | number \| null | 最新 `net.tx_bps{device=...}` 各网卡 **SUM** | `null` |
| `gpu_pct?` | number \| null | 最新 `gpu.util{index=...}` 取 MAX；**无 GPU 序列时字段缺省**（对应设计稿「capabilities.gpu=false ⇒ GPU 图整块隐藏」，⛔ 不显示空图） | 字段缺省 |

**为什么必须允许 `null`**：设计稿 L280–L298、L401 明确要求「离线/禁用的主机指标一律 `—`，且不画仪表条：**没有数据不等于数值为零**」。若这里补 0，面板会显示「CPU 0%」，把「失联」伪装成「空闲」。

**"最新"的取数口径**（`LATEST` 语义）：

```
对每个 (agent_id, metric) 取 ts 最大的一行，且 ts >= now() - 观测窗口
观测窗口 = 5 分钟（= 20 × 上报周期，容忍 Agent 短暂重试与漂移）
```

- 窗口存在的意义：`metrics_raw` 保留 15 天且按天分区，无窗口的「取最新」会退化成**对所有分区的全表扫描**；5 分钟窗口让查询只碰最近 1–2 个分区。
- 窗口外的旧序列**不返回**（`snapshot` 全 `null`），而不是返回 5 天前的旧数值——这正是「没有数据不等于 0，也不等于旧值」。
- ⚠️ 这个窗口是本方案引入的**工程常量**，`docs/` 中无记载 → **（待确认事项 D2-a）**

---

### 2.3 D3：`last_seen_ago` 用**字符串**（与 `docs/api.md` §3.2 一致），并**额外**返回 `last_seen_at`（RFC3339）

`docs/api.md` §3.2 写的是「**相对化描述**（如 `"2 分钟前"`）或分钟级取整」，而 `docs/frontend.md` §4.3 的私有列表要求「相对时间 + `title` 绝对时间」。为让同一套表格组件（`frontend.md` §4.3 注：公开页与私有页复用同一张 `HostTable`）能同时满足两边，**公开接口同时给两个字段**：

| 字段 | 类型 | 口径 |
|---|---|---|
| `last_seen_ago` | string \| null | 中文相对化文案，**分级取整**（`disabled` 时 `null`） |
| `last_seen_at` | string(RFC3339) \| null | ⚠️ **分钟级取整后的绝对时间**（`floor(epoch_s / 60) * 60`），⛔ 不暴露毫秒/秒级指纹 |

分级规则：`<60s` → `"刚刚"`；`<60min` → `"N 分钟前"`；`<24h` → `"N 小时前"`；`<30d` → `"N 天前"`；否则 `"超过 30 天"`。

> **取舍说明**：`docs/api.md` §3.1 对 §3.2 的这条仍标着 ❓（"相对化描述或分钟级取整"）。本方案**两个都给**：文本满足「人读」，分钟级 RFC3339 满足表格 `title`。⛔ 两者都**不得**精确到秒，否则公开页可被用来做主机上下线的行为指纹分析。
>
> **我建议**：采纳本方案并把 `docs/api.md` §3.1 的两个 ❓ 标为 ✅ 已定（口径=本表）。**（待确认事项 D3-a）**

---

### 2.4 D4：公开接口的缓存 —— 用**响应级短 TTL 缓存**，⛔ 不复用 `snapshot:agent:<id>`

`docs/api.md` §3.2 要求「服务端缓存 `snapshot:agent:<id>`（TTL 5–15s）」+ `Cache-Control: no-store`。

**问题**：`snapshot:agent:<id>` 是**每机**键，而 `/api/public/hosts` 是**全量列表**——按机缓存对列表端点无效（要么逐机读 N 次，要么拼装）。且该键目前无写入方（事实 #2）。

**方案**：

| 项 | 做法 |
|---|---|
| 缓存对象 | **整个响应体**（键 `snapshot:public:hosts` / `snapshot:public:summary`，复用 §7 已登记的 `snapshot:` 前缀），而非每机快照 |
| TTL | `config.rateLimit.*` 之外的独立项 `PUBLIC_CACHE_TTL_S`，默认 **10s**（落在契约的 5–15s 区间内，与 30s 上报周期同量级） |
| 未命中 | 走 PG 查询 → 写缓存；⚠️ 缓存写失败**不影响响应**（warn 日志即可，`settings.service.js` 已有同款写法） |
| 缓存读失败 | 按未命中处理，直接查库（同上） |
| ⛔ 不做 | 不用 `snapshot:agent:<id>`（语义不符、无写入方）；不做「缓存穿透保护」（列表端点无主键查询语义） |
| 内容 | 缓存的是**已脱敏**的响应体。⛔ 绝不缓存含 IP / 内部 UUID 的私有接口响应 |

> ⚠️ 若你不希望本期引入新 env 项，可退化为「不加缓存，公开接口直接查库」——代价是每次公开页刷新都打 PG（按 5 台规模完全可接受，且 `ratelimit:public:<ip>` 已限流）。**（待确认事项 D4-a：要不要现在就上缓存）**

---

### 2.5 D5：`public_view.enabled=false` 时**返回 404**，且是**每请求判定**

`docs/api.md` §3.2 已定：关闭时**所有** `/api/public/*` 返回 404（不泄露「存在但被关闭」）。

实现要点（两条都容易踩坑）：

1. **每请求判定**，⛔ 不在启动时判定一次——它是面板可改的运行时开关（`settings:cache` TTL 30s 内生效，见 `settings.service.js`）。
2. **404 的 body 也必须走统一错误信封**（`{ error: { code: 'not_found', ... } }`），⛔ 不能是空 body 或 HTML——`app.setNotFoundHandler` 已经是这个形状，路由内直接 `throw new AppError('not_found')` 即可保持一致。
3. ⚠️ `web/src/api/public.ts` 的 `isPublicViewDisabled()` 就是按 **404** 判的（L16-18），与本决策一致，前端无需改判定。

**新增公开视图端点时的强制要求**（本次一并落地，避免将来漏一条）：任何新 `/api/public/*` 路由都必须挂 `publicViewGuard`，review 时按「有没有挂 guard」逐条核。

---

### 2.6 D6：公开接口必须**零内部标识** —— 用一条"闸门"而不是靠每处自觉

`docs/api.md` §3.1 的 ⛔ 清单：真实 IP、内网拓扑、`agent_key`/`secret`、其他 Agent 内部标识、配置、阈值、审计信息；主机标识一律用 `public_slug`。

**方案**：公开路由的响应对象由一个**只挑白名单字段**的函数构造（`toPublicHost()`），⛔ **不得**把 `agents` 行对象整体 `...spread` 进响应。理由：将来有人给 `agents` 加一列（比如 `last_ip` 的变体、`host_info` 里新增设备名），spread 写法会**静默泄漏**，而白名单写法必须显式加字段。

**落地校验**（纳入本方案的验收，见 §8）：

- 单元测试：构造一个「所有字段都填满」的 agent（含 `last_ip` / `reported_ip` / `agent_key_hash` / `host_info.device`），断言公开响应 JSON 里**不出现**这些值（按字符串包含断言，含 `agent_id` UUID）；
- 断言公开响应里**不含 `id` 字段**（内部 UUID 关键名）。

---

### 2.7 D7：`active_alerts` / `summary.alerts` —— 本期**照实现**，但会恒为 0

`alert_events` 表已建（事实 #5），告警引擎在 M3。本方案**按契约实现查询**（`SELECT count(*) ... WHERE status='firing'`），而不是硬编码 `0`：

- 好处：M3 一落地，两个接口的这两个字段**自动变正确**，无需回头改接口；
- ⚠️ 必须做：`alert_rules` / `alert_events` 为空时 SQL 返回 0，**不是报错**（用 `LEFT JOIN` + `COALESCE`，⛔ 不用 `INNER JOIN`，否则无告警的主机会从列表里消失）；
- ⚠️ 写进验收/文档：本期集成测试只断言「字段存在且为 0」，⛔ 不写成「告警数正确」的假验收。

---

### 2.8 D8：私有接口的排序与分页 —— 排序可定，**游标建议本期不做**

`docs/api.md` §4.2 的 `GET /api/v1/hosts` 声明了 `limit` / `cursor`（§1.2 ③ keyset 分页），但：

- 本接口返回的是**当前态**（不是按时间排列的事件流），keyset 游标没有天然的自然键；
- `docs/frontend.md` §4.3 要求「默认按『有问题优先』（离线/告警 > 在线）排序」，这是一个**派生值排序**，不满足 keyset 分页「排序键必须在索引上且唯一稳定」的前提；
- 当前规模 5 台、设计余量「几十台」（`docs/frontend.md` §10），`limit=200` 上限在任何情况下都够取全量。

**方案**：

| 项 | 取值 |
|---|---|
| 默认排序 | **有问题优先**：`disabled`/`offline` 在前 → 有活动告警的行在前 → 在线 → 最后按 `last_seen_at DESC` 稳定兜底 |
| `limit` | 默认 20、上限 200（与 §1.2 ③ 一致）；超上限夹取并 warn（同 `getSettingInt` 的夹取口径） |
| 响应形状 | `{ items: [...], next_cursor: null }` —— ✅ **形状完全合规**，只是恒没有下一页 |
| `next_cursor` | 本期恒 `null`；⚠️ ⛔ 不返回 `next_cursor: "..."` 的假游标（会让前端以为要翻页） |
| 参数校验 | `status` 只接受 `online`/`offline`/`disabled`；`limit` 非法 → 400 `schema_invalid` |

> **我建议**：本期按上表实现（形状合规、语义诚实），把「真 keyset 分页」推迟到主机数真的超过 200 时再做，并在 `docs/api-status.md` §5.2 记一条。
> ⚠️ 这条与 `docs/api.md` §4.2 标注的 ✅ 有轻微出入（它把 `limit`/`cursor` 标为 ✅），**请确认**。**（待确认事项 D8-a）**

---

## 3. 接口契约细则

### 3.0 两个接口的公共部分

| 项 | 约定 |
|---|---|
| 时间格式 | 响应中所有时间**RFC3339 UTC**（如 `2026-10-04T12:14:18.000Z`），与 `docs/api.md` §1.2 一致 |
| 时间权威 | 一律用**数据库 `now()`**（=`server_ts` 同源），⛔ 不用 Node 进程时间做窗口判断（多实例/时钟漂移下会漂） |
| 响应头 | `Cache-Control: no-store`（`app.js` L112-115 已对 `/api/*` 统一注入，⛔ 不要另写） |
| 请求 ID | `X-Request-Id` 已由 `app.js` 的 `onSend` 注入 + 错误体 `request_id` |
| 压缩 | 走 `@fastify/compress`（全局已开，响应侧），阈值 1KB |
| 错误信封 | 一律 `{ error: { code, message, details?, request_id } }`（`utils/errors.js`） |

### 3.1 `GET /api/public/hosts` — 公开主机列表

**鉴权**：无。**限流**：`ratelimit:public:<ip>`，60 次/分钟。
**前置闸门（顺序固定）**：`publicRateLimit` → `publicViewGuard`（读 `public_view.enabled`）→ 缓存/查询。

**200**：

```json
{
  "items": [
    {
      "slug": "k7Qm2XvT9p",
      "name": "主机 1",
      "status": "online",
      "os": "Ubuntu 24.04.1 LTS",
      "uptime": 3723840,
      "snapshot": {
        "cpu_pct": 23.8, "mem_pct": 38.1, "disk_pct": 61.4,
        "net_rx_bps": 1468006.4, "net_tx_bps": 4089446.4
      },
      "probes": { "up": 2, "down": 1 },
      "last_seen_ago": "刚刚",
      "last_seen_at": "2026-10-04T12:14:00.000Z"
    }
  ],
  "next_cursor": null,
  "updated_at": "2026-10-04T12:14:30.000Z"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `slug` | string | `agents.public_slug`（⛔ **不是**内部 UUID；`agents_public_slug_format_ck` 从库层面保证 UUID 不可能出现在这里） |
| `name` | string | **显示名**：`COALESCE(NULLIF(display_name,''), name)`；⚠️ 设计稿要求「缺失回退泛化名（如『主机 3』）」（`frontend.md` §3 / F3），**本方案回退 `name`**（见待确认 D-名） |
| `status` | string | `online` / `offline`（⛔ 公开列表**不出现** `disabled`——人工禁用是内部运营信息；见待确认 D-禁） |
| `os` | string? | `host_info.os`；缺失时**字段缺省**（非 null） |
| `uptime` | number? | `now() - host_info.boot_time`（秒）；`boot_time` 缺失/非法时字段缺省 |
| `snapshot` | object | §2.2；六键，`gpu_pct` 视情况缺省 |
| `probes` | object | `{ up, down }`：每机**最近一轮**探活结果的 up/down 计数；从未探活 → `{ "up": 0, "down": 0 }` |
| `last_seen_ago` | string \| null | §2.3 |
| `last_seen_at` | string \| null | §2.3，分钟级取整 |
| `updated_at`（响应级） | string | 快照生成时间 = 本次查询的 `now()`（缓存命中时 = 缓存生成时刻） |
| `next_cursor` | null | §2.8 |

**⛔ 绝不出现**：`id`（内部 UUID）、`last_ip`、`reported_ip`、`agent_key_hash`、`agent_secret_enc`、`host_info.device` / `mount` / `hostname`、`clock_drift_ms`、`ip_flapping`、`tags`、`active_alerts`、阈值与配置。

**404**：`public_view.enabled=false`（统一信封）。

**排序**：与私有列表**同一套**「有问题优先」排序，保证同一批主机在两边顺序一致（⛔ 不各排各的）。

### 3.2 `GET /api/public/summary` — 公开汇总计数（**同一交付块**）

> 为什么和 `/hosts` 一起做：公开页顶栏「在线 3 · 离线 1 · 禁用 1 · 告警 3」需要它，而它读的是**完全相同的推导**（同一个 service 函数）。分开做等于把同一段逻辑实现两遍。

**200**：

```json
{
  "total": 5, "online": 3, "offline": 1, "disabled": 1,
  "alerts": { "critical": 1, "warn": 2, "info": 0 },
  "updated_at": "2026-10-04T12:14:30.000Z"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `total` / `online` / `offline` | number | 主机总数 / 在线 / 离线（⛔ `disabled` **不计入** `online` 与 `offline`） |
| `disabled` | number | ➕ **本方案新增**：`docs/api.md` §3.2 的字段表漏了它，但设计稿顶栏「禁用 1」与 `MOCK-DATA.md` L36 都需要（事实 #10） |
| `alerts` | object | `{ critical, warn, info }` 当前 `firing` 事件数（§2.7：本期恒 0） |
| `updated_at` | string | 同 §3.1 |

### 3.3 `GET /api/v1/hosts` — 私有主机列表

**鉴权**：`loadPanelSession` → `requireFullSession` → `requireCsrf`（GET 不校验，挂上以保持与 `auth.js` 同构的 preHandler 顺序）。
**三态**：`setup_required` → 403 `totp_setup_required`；`totp_pending` → 403 `totp_required`（复用既有中间件，⛔ 不另写判定）。
**限流**：本期**不加**——已登录 + 会话限流（登录桶）已覆盖，私有读接口无被匿名刷的风险；⚠️ 若你要对齐公开接口，可加 `ratelimit:panel:<user_id>`（待确认 D-限流）。

**查询参数**

| 参数 | 必需 | 取值 | 说明 |
|---|---|---|---|
| `status` | 否 | `online` / `offline` / `disabled` | 过滤**推导后**的状态（⛔ 不是过滤 `agents.status` 列——否则 `online` 会连失联主机一起返回） |
| `tag` | 否 | string | `agents.tags @> to_jsonb($x::text)`（走 `agents_tags_gin_idx`）；⚠️ D8 的「有问题优先」排序下它将**失去索引能力**（见待确认 D-tag） |
| `q` | 否 | string ≤ 64 | 名称模糊搜索（对 `name` 与 `display_name` 做 ILIKE；拼进 SQL 前先转义 `%`、`_`、`\`） |
| `limit` | 否 | 默认 20、上限 200 | §2.8 |
| `cursor` | 否 | — | ⛔ 本期不实现（§2.8）；传了**忽略**、⛔ 不 400（✅ D8-a 已定；见 §11） |

**200**：`{ items: [...], next_cursor: null, updated_at }`，每项在公开字段之外**追加**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string(uuid) | 内部 ID（⛔ 仅私有接口可见） |
| `display_name` | string \| null | 原始列（面板可同时展示 `name` + `display_name`，`frontend.md` §3 F3） |
| `tags` | string[] | 标签 |
| `status` | string | `online` / `offline` / `disabled`（三态齐全） |
| `arch` | string \| null | `host_info.arch` |
| `last_ip` / `reported_ip` | string \| null | `INET` 列 → **文本**（双源比对，设计 §8） |
| `clock_drift_ms` | number \| null | 符号口径：**负值 = Agent 慢**（`heartbeat.service.js` L17-21，⛔ 与前端徽标同号） |
| `ip_flapping` | boolean | 决策 #39；`flapping_since` 一并返回便于面板显示「持续多久」 |
| `active_alerts` | number | §2.7（本期 0） |
| `snapshot` | object | 与公开接口**同一结构**（§2.2）——同一张 `HostTable` 组件两边复用（`frontend.md` §4.3） |

**错误**

| 状态 | code | 触发 |
|---|---|---|
| 401 | `session_expired` | 无 Cookie / sid 失效 |
| 403 | `totp_required` / `totp_setup_required` | 受限态（复用既有中间件） |
| 400 | `schema_invalid` | `status` 取值非法、`limit` 非正整数/超上限 |

---

## 4. 数据来源与查询策略

### 4.1 数据来源总览（全部为**已存在**的表，⛔ 本方案零迁移、零新表、零新列）

| 需要的数据 | 来源 | 备注 |
|---|---|---|
| 主机清单、显示名、slug、标签 | `agents` | `migrations/0003_agents.sql` |
| 在线/离线判定 | `agents.status` + `agents.last_seen_at` | §2.1 推导 |
| IP / 漂移 / Flapping | `agents.last_ip` / `reported_ip` / `clock_drift_ms` / `ip_flapping` / `flapping_since` | 仅私有 |
| `os` / `arch` / `boot_time` | `agents.host_info` JSONB | `host_info->>'os'` 等 |
| CPU/内存/磁盘/网络/GPU 当前值 | `metrics_raw`（最近窗口内每个 `(agent_id, metric)` 的最新一行） | §4.2 |
| 探活 up/down 计数 | `probe_results`（每机**最近一轮**） | §4.3 |
| 活动告警数 | `alert_events` where `status='firing'` | §2.7（本期 0） |

### 4.2 「每序列最新值」的取数写法（性能敏感点）

⚠️ **禁止**按主机循环发查询（`for agent of agents: SELECT ...`）——5 台尚可，设计余量几十台时就是 N+1；且每台要查 6 个基名，会变成 6N 次往返。

**一次性取全量**（`UNION ALL` + 每分支 `DISTINCT ON`，走 PK `(agent_id, metric, ts)` 的**反向扫描**）：

```sql
-- 一个分支示例（cpu.usage）；其余基名同构，用 UNION ALL 拼在一条语句里
SELECT DISTINCT ON (agent_id) agent_id, 'cpu_pct' AS slot, value
  FROM metrics_raw
 WHERE agent_id = ANY($1::uuid[])
   AND metric = 'cpu.usage'
   AND ts >= $2::timestamptz
 ORDER BY agent_id, ts DESC
```

- `agent_id = ANY($1::uuid[])` 把范围锁在**当前页**的主机集合上（不是全表）；
- `ts >= $2` 让分区裁剪只保留最近 1–2 个 `metrics_raw_YYYYMMDD` 分区；
- `DISTINCT ON (agent_id) ... ORDER BY agent_id, ts DESC` 正好命中 `PRIMARY KEY (agent_id, metric, ts)` 的反向扫描（`docs/database.md` §5.7.3 L388 已明确「额外索引大概率冗余，先不建」——本方案遵守，⛔ 不新增索引）；
- 带维度的基名（`disk.used_pct{...}` / `net.rx_bps{...}` / `gpu.util{...}`）需要按**基名前缀**取全部维度序列再在 JS 里 MAX/SUM：
  ```sql
  -- 注意：用区间比较而不是 LIKE，理由见下
  WHERE metric >= 'disk.used_pct' AND metric < 'disk.used_pct' || chr(256)
    AND (metric = 'disk.used_pct' OR left(metric, length('disk.used_pct') + 1) = 'disk.used_pct{')
  ```
  ➕ **为什么不用 `LIKE 'disk.used_pct{%'`**：`_` 在 LIKE 里是单字符通配符，而本项目的基名**大量使用下划线**（`used_pct`、`rx_bps`、`ctx_switch`）——`LIKE 'disk.used_pct{%'` 会把 `diskXused_pct{...}` 也匹配进来。`docs/api-status.md` §5.2 恰恰记了这条待定口径「基名展开口径（**区间比较而非 LIKE**）」，本方案按该结论实现。
  ⚠️ 更准确地说：`_` 通配在**当前命名空间下**不会真的撞车（没有 `diskXused_pct` 这种序列，`vantage_is_valid_metric_name` 也允许 `X` 大写字母），但它是**潜在**的匹配污染源；区间比较零成本，从根上避免。

### 4.3 探活计数（`probes: { up, down }`）

「最近一轮」的判定 = 每机 `probe_results` 中 `checked_at` 最大的**那一批**（同一批的 `checked_at` 完全相同，因为它们在同一事务里写入，见 `probe.repo.js` L50-51）：

```sql
WITH latest AS (
  SELECT agent_id, max(checked_at) AS at
    FROM probe_results
   WHERE agent_id = ANY($1::uuid[]) AND checked_at >= $2::timestamptz
   GROUP BY agent_id
)
SELECT p.agent_id,
       count(*) FILTER (WHERE p.up)     AS up,
       count(*) FILTER (WHERE NOT p.up) AS down
  FROM probe_results p
  JOIN latest l ON l.agent_id = p.agent_id AND l.at = p.checked_at
 WHERE p.agent_id = ANY($1::uuid[])
 GROUP BY p.agent_id
```

未探活 / 窗口外 → `{ up: 0, down: 0 }`。

### 4.4 公开接口的查询成本（给后续压测一个基准）

每条公开请求（未命中缓存）≈ 3 条 SQL：agents+host_info+告警计数（1 条，`LEFT JOIN` 聚合）、metrics 最新值（1 条 `UNION ALL`）、探活计数（1 条 CTE）。按 5 台、每台约 40 条序列的规模，均在毫秒级；`ratelimit:public:<ip>` 60/min + 10s 响应缓存把最坏情况的 DB 压力锁死在「每个 IP 每 10 秒最多 1 次三连查询」。

---

## 5. 落地清单（确认后按此执行）

### 5.1 新增文件

| 文件 | 内容 |
|---|---|
| `server/src/services/status.service.js` | `deriveEffectiveStatus()`、`buildSnapshot()`、`listStatusesForPanel()` / `listStatusesForPublic()` / `getSummary()` / `getStatusBySlug()`。⛔ 唯一推导实现，路由层只做「取参 → 调用 → 投影」 |
| `server/src/middleware/publicView.js` | ⚠️ **实测为新增文件**（初稿误列在 §5.2「修改文件」）：`createPublicViewGuard()` 读 `public_view.enabled`，false → `throw new AppError('not_found')` |
| `server/src/routes/public.js` | `registerPublicRoutes()`：`GET /summary`、`GET /hosts`（§10 范围裁剪） |
| `server/src/routes/hosts.js` | `registerHostRoutes()`：`GET /hosts` |
| `server/test/status.service.test.js` | 推导逻辑单测（真 PGlite 写数据 + 断言，口径见 §8） |
| `server/test/public.api.test.js` | 公开接口集成测（用 `app.inject()`，`app.test.js` 的模式） |
| `server/test/hosts.api.test.js` | 私有接口集成测（含未登录 401、受限态 403、脱敏断言） |

### 5.2 修改文件

| 文件 | 改动 |
|---|---|
| `server/src/middleware/rateLimit.js` | ➕ `createPublicRateLimiter()`（复用 `FIXED_WINDOW_LUA`，窗口 60s，⛔ 不复制 Lua）；可选 `createPanelRateLimiter()`（待确认） |
| `server/src/repositories/agent.repo.js` | ➕ `listAgentsForStatus(pool, filters)` / `countAgentsByEffectiveStatus()` / `countFiringAlertsBySeverity()` / `readDbNow()`。✅ 第二批已按需补上 `findAgentStatusBySlug()`（L364）/ `findAgentStatusById()`（L321）——它们服务 `/hosts/{slug}/now` 与 `/hosts/{id}`，⛔ 不做无人调用的死代码 |
| `server/src/repositories/metric.repo.js` | ➕ `selectLatestSeriesForAgents(pool, input)`（§4.2；落地名，⛔ 不是初稿写的 `selectLatestSeriesByBase`） |
| `server/src/repositories/probe.repo.js` | ➕ `countLatestProbeResults(pool, agentIds, since)`（§4.3） |
| `server/src/app.js` | 挂载两个新路由 + 更新顶部「路由挂载清单」注释（把 `/api/public/*`、`/api/v1/hosts` 从 ⏳ 改为 ✅） |
| `server/src/config/index.js` | ➕ `rateLimit.publicCacheTtlS`（`PUBLIC_CACHE_TTL_S`，默认 10，范围 0–60；0 = 关缓存）——仅当采纳 D4 |
| `server/.env.example` | ➕ 上述 env 项（带注释说明为何是 10s） |
| `docs/api.md` | §3.1 两个 ❓ 标为已定（D3）；§3.2 `summary` 字段表 ➕ `disabled`；§4.2 明确 `limit`/`cursor` 的本期口径（D8） |
| `docs/api-status.md` | ✅ **已同步**（2026-10-04）：§1 进度表补「离线判定 ✅ 已落地」两行；新增 §4.4 记录离线判定落地（含两条实现选择与时钟口径）；§5.2 移除/标记已闭环的条目 |
| `server/README.md` | §1 目录树补两个新路由；路由清单指针不变（指向 `app.js`） |

### 5.3 明确**不做**（避免范围蔓延）

| 不做 | 归属 |
|---|---|
| `GET /api/public/hosts/{slug}/now`（单机展开） | 公开页骨架联动时做（§10） |
| `GET /api/public/probes`（探活概览） | 同上（§10） |
| `GET /api/v1/hosts/{id}` 及 `/metrics` `/probes` `/ip-history` `/processes` | M2 后续块（`docs/api-status.md` §1） |
| ~~`offline_sweep` 定时任务~~ | ✅ **已完成**（2026-10-04，见 `docs/api-status.md` §4.4），不再是本方案的前置件 |
| 告警引擎 / 真实告警计数 | M3（§2.7） |
| WebSocket `/ws/public` `/ws/live` | M3 |
| 任何索引 / 迁移 / 新表 / 新列 | ⛔ 本方案**零迁移**（§4.1） |
| 前端页面接线（`PublicStatus.vue` / `HostList.vue` 从骨架变可用） | 后端契约冻结后的独立任务；本方案只改前端**类型声明**（§9.1） |

> ✅ **上表的「不做」只描述第一批的范围**：其中 `/api/public/hosts/{slug}/now`、`/api/public/probes`、`/api/v1/hosts/{id}` 及四个子资源（含 `/metrics`）与 `/ws/public` · `/ws/live` **均已落地**（第二批 2026-10-04、收尾 2026-10-05，见 §12 与 `docs/api-status.md` §4.6.1 / §4.8 / §4.9）；仍未做的是「告警引擎 / 真实告警计数」。

---

## 6. 关键实现要点（写代码时必须遵守的硬约束）

1. **时间一律来自 DB `now()`**：窗口判断、`last_seen_ago`、`uptime` 全部用 SQL 里的 `now()`（或同一查询返回的 `now` 列），⛔ 不用 `Date.now()` —— 多实例部署下进程时间不同步会让判定抖动。
2. **⛔ 不 spread `agents` 行**（§2.6）：公开侧走 `toPublicHost()` 白名单投影；私有侧显式列字段。
3. **推导状态必须与过滤参数自洽**（§3.3）：`?status=online` 过滤的是**推导后**的值，所以「推导表达式」要么写进 SQL 的 `WHERE`，要么在 JS 里过滤后再截断 `limit`（⚠️ 后者会返回不满 `limit` 的结果，须在文档/契约里说明；**本方案选择写进 SQL**，避免分页语义被破坏）。
4. **`null` 就是 `null`**（§2.2）：⛔ 不把缺失值写成 `0`、`0.0`、`""`、`"—"`（`"—"` 是前端的展示职责）。
5. **公开侧字段缺失用「缺省」而非 `null`**（`os`/`uptime`/`gpu_pct`）：与 `PublicSnapshot.gpu_pct?` 的 TS 可选标记一致；其余固定字段用 `null`。
6. **`INET` 列必须显式转文本**：`last_ip` / `reported_ip` 直接用 `pg` 返回会被序列化为字符串但类型不确定，建议 SQL 里 `host(last_ip) AS last_ip`（IPv6 带掩码时会出 `::1/128`，需 `host()` 剥离）。
7. **限流器 Redis 不可用时拒绝服务**（与 `rateLimit.js` 现有三个限流器同款取舍）：公开接口的 Redis 挂了 → 503 `upstream_unavailable`，⛔ 不静默放行（设计 §5.2「默认拒绝」）。
8. **⛔ 公开接口不写审计**；私有 GET 也不写审计（`audit.repo.js` L7-10：审计只记「异常与人为操作」，正常读不记）。
9. **⛔ 任何响应不得回显阈值/配置**：`rate_limit`、`alert_rules.params` 等即使查到了也不进响应体。
10. **幂等/缓存键带前缀**：新增 Redis 键必须进 `utils/redisKeys.js`。✅ 本方案**不新增用途前缀**——复用 §7 已登记的 `snapshot:`（它当前的 `snapshot:agent:<id>` 子键无写入方，恰好是为「公开快照缓存」预留的语义），只新增两个子键 `snapshot:public:hosts` / `snapshot:public:summary`，并在 `docs/database.md` §7 补两行（待确认 D-键）。

---

## 7. 配置与运维

### 7.1 新增 env

| 变量 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `PUBLIC_CACHE_TTL_S` | 10 | 0–60 | 公开接口响应缓存 TTL；`0` = 关闭缓存（D4） |

其余全部复用既有项：`RATELIMIT_PUBLIC_PER_MINUTE`（=60）、`OFFLINE_CYCLES_MULTIPLIER`（=3）、`SETTINGS_CACHE_TTL_S`（=30）。

### 7.2 新增 Redis 键（复用既有 `snapshot:` 前缀，需你确认写入契约文件）

| 键 | 类型 | TTL | 用途 |
|---|---|---|---|
| `snapshot:public:hosts` | string(JSON) | `PUBLIC_CACHE_TTL_S` | 公开主机列表响应缓存 |
| `snapshot:public:summary` | string(JSON) | 同上 | 公开汇总响应缓存 |

✅ **不新增用途前缀**：`docs/database.md` §7 已登记 `snapshot:agent:<id>`（「公开『当前快照』缓存」，TTL 5–15s），但**全仓库无写入方**（事实 #2）。本方案改用「响应级」粒度后语义仍在 `snapshot:` 名下，故只追加两个子键，⛔ 不引入 `cache:*` 之类的新前缀（`redisKeys.js` 头部注释：键名是跨模块契约，散落拼接是 TTL 不一致与「键名打错导致防护静默失效」的主要来源）。

⚠️ `snapshot:agent:<id>`（每机粒度）在本方案落地后仍**不会被写入**——它当前的语义与列表端点不匹配。建议在 `docs/database.md` §7 保留该行但标注「⏳ 暂无写入方：`/ws/*` 实时扇出落地时可能复用」，避免后来者以为它是活的缓存。

⚠️ 内存吃紧时的清理优先级不变（`redisKeys.js` 头部注释已规定先清 `ratelimit:*` / `snapshot:*` 这类可重建键）——本方案的缓存键同属「可重建」，可一并清理。

### 7.3 可观测性

| 项 | 做法 |
|---|---|
| 日志 | 公开视图被关闭时命中 guard → `warn` 一条（含 `ip`、`url`），便于判断是「被关」还是「前端调错路径」 |
| 慢查询 | 沿用 `PG_STATEMENT_TIMEOUT_MS`（默认 15s）；本方案查询预期 < 20ms，⛔ 不为它单独调参 |
| 验收指标 | 未命中缓存的公开请求 ≤ 3 条 SQL（agents+告警聚合 / metrics 最新值 / 探活计数各一条）；命中缓存 ≤ 0 条 SQL（可通过 `pg` 的 `query` 打桩断言，见 §8）。⚠️ 落地补充：`updated_at` 取自 agents 查询返回的 `now()`，**仅当页内没有任何主机时**才额外发一条 `SELECT now()`（即空表场景 4 条）；这是"时间只有一个来源"的代价，不在正常路径上 |

---

## 8. 验收方式（**由你执行**）

按现有习惯（`docs/api-status.md` §2），我交付**可直接复制的验证步骤**，真机执行由你完成。

| # | 动作 | 期望 |
|---|---|---|
| 1 | `cd server && npm test` | 新增 3 个测试文件全绿；既有用例不回归（当前 `server/test/*.test.js` 共 **35 个文件、554 条用例**，其中 15 条为真机 `skip` 用例） |
| 2 | `curl -s localhost:8787/api/public/hosts \| jq` | 200，`items[].slug` 存在、**无 `id`**、**无 IP 字段**、`snapshot` 无数据时为 `null` |
| 3 | `curl -s localhost:8787/api/public/summary \| jq` | `total` = `online + offline + disabled` |
| 4 | `PATCH /api/v1/settings {"public_view.enabled": false}` 后重放 #2（≤30s 生效）（⚠️ 该端点属 M3、尚未实现，见 `docs/api-status.md` §1；本条的开关切换需绕开它） | **404** `not_found`（⛔ 不是 403、不是空 body） |
| 5 | 反复请求 `/api/public/hosts` 61 次 | 第 61 次 429 `rate_limited` + `Retry-After`；响应头有 `X-RateLimit-*` |
| 6 | 未登录 `curl /api/v1/hosts` | 401 `session_expired` |
| 7 | 登录后 `curl -b cookie /api/v1/hosts` | 200，含 `last_ip` / `clock_drift_ms` / `ip_flapping` / `active_alerts` |
| 8 | 停掉某台 Agent，等待 **90s（阈值）+ 最多 60s（扫描周期）= 最坏 150s** | 该机在 `/api/public/hosts` 变 `offline`；`snapshot` 在 5 分钟后变 `null`（**不是 0**） |
| 9 | 断言公开响应文本中不含 `last_ip` 的值 | 用真实 IP 做字符串包含检查 → 必须为空 |
| 10 | `?status=online` / `?tag=prod` / `?q=web` 各一次 | 过滤生效；非法 `status` → 400 `schema_invalid` |

---

## 9. 需要同步修订的既有文档/代码（已发现的不一致）

> ✅ **处置状态（2026-10-04，随本方案落地一并完成）**：**9.1 / 9.3 / 9.4 已全部修完**（`vue-tsc --noEmit` 通过）；**9.2 仍待办**（涉及 `design/preview/*.html` 设计稿，属设计侧改动）。

### 9.1 前端类型声明与契约不一致（⛔ 会影响联调）—— ✅ 已修

| 位置 | 现状 | 契约（`docs/api.md`） | 处置 |
|---|---|---|---|
| `web/src/api/public.ts` L26 | `getHosts(): Promise<PublicHost[]>` | `{ items: [...], next_cursor }` | ✅ 改为 `HostsResponse<PublicHost>`（`{ items, next_cursor, updated_at }`） |
| `web/src/api/public.ts` L36 | `getProbes(): Promise<PublicProbe[]>` | `{ items: [...] }` | ✅ 改为 `ListResponse<PublicProbe>`（该端点已在第二批落地，见 §12） |
| `web/src/api/private.ts` L378 | `hostsApi.list(...): Promise<HostListItem[]>` | `{ items: [...] }` | ✅ 改为 `HostsResponse<HostListItem>` |
| `web/src/types/domain.ts` L64 | `last_seen_ago?: number` | `last_seen_ago: string`（§2.3） | ✅ 改为 `string \| null`，并 ➕ `last_seen_at: string \| null` |
| `web/src/types/domain.ts` L63 | `probes: { up, down }` | 一致 | 无需改 |
| `web/src/types/domain.ts` L68-74 | `PublicSummary` 无 `disabled` | §3.2 新增该字段 | ✅ ➕ `disabled: number` |
| ➕ 新增 | 无通用列表壳类型 | §1.2 ③ | ✅ ➕ `ListResponse<T>` / `HostsResponse<T>`；`PrivateHost.status` 收窄为三态字面量；`PublicHost.status` 收窄为 `Exclude<HostStatus,'disabled'>` |

> ⚠️ 这些改动**不涉及任何页面逻辑**（`PublicStatus.vue` / `HostList.vue` 仍是骨架，`public.ts` 无调用方）。

### 9.2 设计稿与脱敏要求冲突 —— ⏳ 待办（设计侧）

`design/preview/public-status.html` L211 / L273 / L363 显示「12 秒前（2026-10-04 20:14:18 UTC+8）」——**秒级绝对时间**违反 `docs/api.md` §3.1（避免毫秒级行为指纹）。接口侧已按契约实现（分钟级取整），**设计稿需同步改**：改为「12 秒前」或「12 秒前（精确到分钟）」，并把绝对时间移出公开页（私有页保留）。

⚠️ 同一份设计稿里若还画着**磁盘/网卡的真实设备名**，也要改成接口现在给的泛化标签（`磁盘 1` / `网卡 1`）——口径见 `docs/api-status.md` §4.6.1 的 E6。

### 9.3 `docs/api.md` §3.2 `summary` 字段表漏了 `disabled` —— ✅ 已修

与 `MOCK-DATA.md` L36「在线 3 · 离线 1 · **禁用 1** · 活动告警 3」和设计稿顶栏不一致。✅ 已补该字段（实现即按补齐后的形状）。

### 9.4 `docs/api-status.md` §5.2 的 `GET /api/v1/hosts` 待拍板项 —— ✅ 已闭环

原写「过滤参数 `status` / `tag` / `q`」，现已给出具体语义（§3.3）并落地，该行已标记为已定；同时新增 `docs/api-status.md` §4.6 记录本轮决议。

---

## 10. 范围裁剪说明（为什么只做这两个端点）

「获取服务器状态」在契约里对应 **`/api/public/*` 4 个 + `/api/v1/hosts` 6 个**端点。本方案**只做状态本身**，理由：

| 端点 | 本期 | 原因 |
|---|---|---|
| `GET /api/public/hosts` ✅ | **做** | 状态列表，本方案主体 |
| `GET /api/public/summary` ✅ | **做** | 与上者共享同一推导（§3.2），分开做等于写两遍 |
| `GET /api/public/hosts/{slug}/now` ⏳ | 不做 | 公开页「就地展开」用；它是 `/hosts` 的**字段超集**，等公开页接线时与 `frontend.md` §3 一起定稿更省返工（见待确认 D-范围） |
| `GET /api/public/probes` ⏳ | 不做 | 探活概览表（设计稿 §3 区块）；初稿时依赖「探活可用率」口径（✅ 该口径已定，见 `docs/api-status.md` §5.2） |
| `GET /api/v1/hosts` ✅ | **做** | 私有状态列表，本方案主体 |
| `/api/v1/hosts/{id}` 及 4 个子资源 ⏳ | 不做 | 详情页（M4 交付物），历史/进程 Top 属另一批契约 |

> ✅ **现状**：上表标 ⏳「不做」的三个单机端点与 `/api/v1/hosts/{id}` 的子资源**都已在第二批落地**（2026-10-04；`/metrics` 于 2026-10-05），见 §12 与 `docs/api-status.md` §4.6.1 / §4.8；本节保留的是**第一批的范围决策**。

> 若你希望**一次性把 4 个公开端点都做完**，请明确告知（`/hosts/{slug}/now` 的「分区/网卡/GPU 数组 + 设备名泛化」口径需要先拍板，`docs/api.md` §3.2 标着 ❓）。**（待确认事项 D-范围）**

---

## 11. 待确认事项清单

> ⛔ 按你的偏好，我不会一次性追问。**下面是完整索引**，我只会**逐条**问最关键的那几个（见文末「我建议先定这几条」）。
>
> ✅ **现状（2026-10-04 拍板）**：除 D1-a（已决议推迟到 M3）外，下表各项均已按「我的建议」拍板并落地（D-范围为第一批口径，其后的第二批已把余下端点一并做完，见 §10 的现状注）；逐条决议见 `docs/api-status.md` §4.6 / §4.6.1。

| # | 事项 | 我的建议 |
|---|---|---|
| D1-a | 离线判定的**三个旋钮**（上报周期基准 30s、阈值倍数、扫描周期）分别放哪？见 §11.1 | ⏸️ **已决议推迟到 M3**：本期保持 env/硬编码不变；M3 落地告警时把 ②③ 移入 `settings`、并一并定稿「按机阈值」（§11.1 有输入清单） |
| ~~D1-b~~ | ~~离线判定放读路径还是补 `offline_sweep`~~ | ✅ **已定并已实施**：两者都做（cron 写回 + 接口读取时推导），理由见 §2.1 与 `docs/api-status.md` §4.4 |
| D2-a | 「最新值」的观测窗口 = **5 分钟**是否可接受？ | 接受（20 × 上报周期） |
| D3-a | `last_seen_ago` 用字符串 + 附带分钟级 `last_seen_at`？ | 采纳，并把 `docs/api.md` §3.1 的 ❓ 标为已定 |
| D4-a | 现在引入响应级缓存（+`PUBLIC_CACHE_TTL_S` env + `snapshot:public:*` 键）吗？ | 引入（5 台规模下也可省；但你若要"最小改动"可去掉，接口形状不变） |
| D8-a | `limit`/`cursor`：本期 `next_cursor` 恒 `null`、不实现真游标？ | 采纳；传 `cursor` **忽略**（而非 400） |
| D-名 | 公开显示名缺失时回退 `name` 还是泛化名「主机 N」？ | **回退 `name`**（泛化名需要前端按序号生成，且 `name` 本身是运维自己起的别名，非主机名） |
| D-禁 | 公开列表是否出现 `disabled` 主机？ | **不出现**（人工禁用是运营信息）；但 `summary.disabled` 保留计数，保证 `total = online + offline + disabled` |
| D-限流 | 私有 `/api/v1/hosts` 是否也加按用户的限流桶？ | 不加（已登录 + 登录桶足够） |
| D-tag | `tag` 过滤与「有问题优先」排序共存时，是否接受走 `agents_tags_gin_idx` 前的全表过滤？ | 接受（几十台规模）；若你要求，可退化为「先按 GIN 取候选，再排序」 |
| D-键 | 允许在既有 `snapshot:` 前缀下新增 `snapshot:public:hosts` / `snapshot:public:summary` 两个子键吗？（`docs/database.md` §7 是契约文件） | 允许（⛔ 不新增前缀），并把这两行同步写入该文档 §7 |
| D-范围 | 是否一次做完 4 个公开端点（含 `/hosts/{slug}/now`、`/probes`）？ | 只做 2 个（§10） |

**我建议先定这几条（按影响面排序）**：

1. ~~**D1-b / D1-a** —— 离线判定放哪~~ → ✅ **D1-b 已定并已实施**（cron 写回 + 读取时推导，见 `docs/api-status.md` §4.4）；**D1-a** 仍待确认（是否把 30s 上报周期提成中心 env / 数据库设置项；另见 §11 末尾的「数据库可配」讨论）
2. **D4-a** —— 要不要现在就上缓存（决定是否动 `config` 与 `redisKeys` 两个契约文件）
3. **D8-a / D-范围** —— 分页与端点范围（决定契约文档要不要改）

其余（D2-a / D3-a / D-名 / D-禁 / D-键 / D-tag / D-限流）我按「我的建议」先写进实现，你若不同意再单点回退即可——它们都不改变接口形状。

---

### 11.1 讨论：离线判定参数放数据库控制，可行吗？（2026-10-04，**只讨论不改码**）

> ✅ **决议（2026-10-04）：推迟到做告警引擎（M3）时一并处理。**
> 本期只做了「扫描周期默认 30s → 60s、阈值基准 15s → 30s（阈值 90s）」这两项改动，
> ⛔ 未新增任何 `settings` 键、未新增 env、未改调度器。
> **M3 落地告警时的输入清单**（届时按此逐条对齐，避免返工）：
> 1. ② 阈值倍数 → `settings` 键（如 `offline.threshold_cycles`，int，默认 3，范围 2–20）；
> 2. ③ 扫描周期 → `settings` 键（需要同时改调度器：interval 型任务改为每次 `tick()` 重读间隔，
>    见下文「两个实现注意点」；⚠️ 该段逻辑被另外 6 个任务共享，必须一起回归）；
> 3. **按机阈值**（`3 × 该机上报周期`）—— 与 `alert_rules.params.offline = { cycles?: 3 }`
>    （`docs/database.md` §5.11「默认 3×**该机**上报周期」）是同一件事，届时需一并定稿；
>    走通它需要**上报契约变更**（`host` 增加上报周期字段，见下文 ①）；
> 4. ⛔ `offlineThresholdS(config)` 变 async 的影响面（`cron.service.js` 调用点 + 测试）。
>
> 以下为当时的完整分析，保留备查。

**⚠️ 先把「可配」拆开：它其实是三个不同的旋钮**，混在一起谈会得出错误结论。

| # | 旋钮 | 现状 | 语义 | 改错的后果 |
|---|---|---|---|---|
| ① | **上报周期基准**（`AGENT_REPORT_PERIOD_S` = 30s） | 硬编码在 `offline.service.js` | 阈值公式的**基准** | 取小了 → **假离线**（正常上报的机器被判死）；取大了 → 漏报窗口变长 |
| ② | **阈值倍数**（`offlineMultiplier` = 3） | env `OFFLINE_CYCLES_MULTIPLIER` | 「容忍丢几批」 | 调小 → 网络抖动即误报；调大 → 掉线半小时才被发现 |
| ③ | **扫描周期**（`sweepIntervalS` = 60s） | env `HEARTBEAT_SWEEP_INTERVAL_S` | 「多久去看一眼」 | 调到大于阈值 → 判定精度被扫描周期主导（阈值 90s、扫描 180s ⇒ 最坏 270s 才发现） |

**结论先行**：③ 放数据库**可行且推荐**；② 放数据库**可行**；① **不要**做成中心配置。

#### ③ 扫描周期进数据库：可行，且与既有架构契合

- `services/settings.service.js` 已经是一套完整的「白名单 + 默认值 + `settings:cache`(TTL 30s) + 变更即失效」机制，
  `public_view.enabled` 就是这么用的。复用成本≈0。
- 本项目已经确立了**「运行时可调 vs 重启才生效」的分界**（`settings.service.js` 与 `config/index.js` 的注释都写了）：
  env 放"改了要重启"的工程常量，`settings` 表放"面板可改、立即生效"的开关。
  **扫描周期属于前者还是后者？** 介于两者之间 —— 它是调度参数，改动只需**下一个 tick 生效**（不需要重建任务，只要每次读 config 时重新取值）。
- ⚠️ 两个实现注意点：
  1. **`offlineThresholdS(config)` 的签名要变成 async**（要查设置），而它现在是纯函数、被同步调用。
     影响面：`cron.service.js` 一处 + 测试若干。不难，但不是零成本。
  2. **调度器现在在 `start()` 时把 `intervalMs` 算死了**（`schedule(task, fromMs)` 用 `task.intervalMs`）。
     要让"改完立即生效"，得让 interval 型任务在每次 `tick()` 时**重新读取**间隔，而不是启动时固定。
     这是对 `cron.service.js` 调度逻辑的改动，需要单独评估（其余 6 个任务都共享这段逻辑）。

> **⏸️ 已决议推迟到 M3（告警引擎）**：③ 与 ② 都值得进 `settings`，但**与告警引擎一起做返工最少** ——
> 那时会一并出现「按机器/按规则配离线容忍」的需求（`alert_rules.params.offline.cycles`），三件事共用同一套设置读取路径。
> 本期**保持现状**：② `OFFLINE_CYCLES_MULTIPLIER` 与 ③ `HEARTBEAT_SWEEP_INTERVAL_S` 都是 env（改需重启），
> ① 硬编码 30s。**M3 的输入清单见本节开头。**
> 若日后只想先要最小的"运维不改 env"，**先只把 ② 放进 `settings`**（不碰调度器，改动小得多）。

#### ② 阈值倍数进数据库：可行，注意"设置读取失败"的口径

`settings` 表已支持 int 型（`getSettingInt` 带**夹取**语义：越界值夹到 `[min,max]` 而不是直接采用，
理由见 `settings.service.js` 的注释 —— `after_failures=0` 那种"静默失效"是它要防的）。
新增 `offline.threshold_cycles`（int，默认 3，范围 2–20）与现有机制完全同构。

⚠️ 必须明确**读不到时的行为**：`getSettingInt` 现在的口径是"类型不对 → 回退默认值 + warn"。
对本项来说这是**正确的**（回退到 3 只是判定宽松度回到默认，不会造成假离线）；
⛔ 但绝不能反过来"读不到就当作 0"——那会让阈值归零，**全站瞬间判离线**。

#### ① 上报周期基准：**不建议**做成中心配置 —— 这是本轮踩坑的根因

它看起来最该"可配"，实际上**最不该**，理由三条：

1. **它不是中心的参数，是 Agent 的参数。** 真实值由每台机器的本地 `config.yaml`（`report.interval`）决定，
   中心配一个全局值只是在**猜**。中心把它做成可配置，等于把"猜"制度化：
   运维改了中心的值，机器上没改 → 立刻产生假离线或漏报，**而且两边都没有任何提示**。
2. **Agent 侧这个值没有上界。** `config.go` 只校验下限 `MinInterval = 5s`（防自伤），
   `report.interval` 可以填 5 分钟。那种机器在任何 90s 阈值下都会被**反复判离线→恢复**，
   每次转换都是一条告警（还有 `publishOfflineDeltas` 的广播）。
   ⚠️ 这不是"配得不对"，而是**当前架构的信息缺口**：中心不知道各机的上报周期。
3. **让 Agent 上报它是唯一能真正解决问题的方向。** 上报体 `host` 对象里加一个字段
   （如 `report_interval_s`），落 `agents.host_info`，中心即可**按机算阈值**（`3 × 该机周期`）。
   设计与契约里其实已经埋了这条线：`alert_rules.params.offline = { cycles?: 3 }`
   （`docs/database.md` §5.11）写的就是「默认 3×**该机**上报周期」。
   ➕ 若要走这条路，属于**上报契约变更**（`docs/api.md` §2.1 的 `host` 白名单 + `server/src/models/report.js`），
   需要你确认后单独排期。

> **我的建议**：① 保持硬编码 30s + 在注释里写明"必须与 Agent 默认值同步"（**已实现**），
> 并把「Agent 上报自己的周期」列为**后续契约变更的候选**。⛔ 不要把它做成中心 env/设置项 ——
> 那会让"两边不一致"从**编译期可见的常量**变成**运行期静默的错误**。

#### ➕ 顺带发现的容量估算陈旧（**建议单独处理**）

`docs/database.md` §9 的容量估算以「15s 粒度」为基准（144 万行/天 → 反推 ≈50 序列/台）。
G3 之后实际是**混合粒度**（cpu/mem/net/gpu 30s、disk/process 60s），
所以 144 万行/天 **偏高约 2 倍**（真实值取决于 30s 与 60s 序列的比例，需按实测序列数重算）。
⚠️ 这会影响 `metrics_raw` 的分区大小与保留期容量规划，但**不属于本次改动**，故只登记不动手。

---

## 12. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-05 | ✅ **收尾项也已落地**：`/api/v1/hosts/{id}/metrics`（时序查询；决议 G1–G10 见 `docs/api-status.md` §4.8）与两个 WebSocket 频道 `/ws/public` · `/ws/live`（决议 H1–H9 见该文件 §4.9）。至此 §5.3 / §10 中标 ⏳「不做」的端点全部落地（仅剩告警引擎属 M3） |
| 2026-10-04 | ✅ **第二批也已落地**：`/api/v1/summary`（契约新增）、`/hosts/{id}`、`/hosts/{id}/probes`、`/ip-history`、`/processes`、`/api/public/hosts/{slug}/now`、`/api/public/probes`。逐条决议 E1–E10 与一条重要教训（**fast-json-stringify 对任意键对象默认序列化成 `{}`**）见 `docs/api-status.md` §4.6.1；§9.2 的**设备名泛化 ❓ 已闭环**（`磁盘 N`/`网卡 N`/`GPU N`，响应里一个指标名都不出现） |
| 2026-10-04 | ✅ **本方案第一批已落地**（3 个端点：`/api/public/hosts`、`/api/public/summary`、`/api/v1/hosts`）。落地记录与逐条决议见 `docs/api-status.md` §4.6；`api.md` §3.2/§4.2 状态已改为 ✅。⚠️ 三处与初稿的差异：① §5.1 的 `findAgentStatusBySlug()` / `findAgentStatusById()` 在第一批**未实现**（它们只服务第二批的详情端点，⛔ 不做无人调用的死代码）——第二批已按需补上；② `middleware/publicView.js` 是**新增文件**（初稿误列在"修改文件"）；③ 新增一次 `SELECT now()`（仅当页内没有主机时）用于 `updated_at`，因此未命中缓存的公开请求在**极端空表**场景下是 4 条 SQL 而不是 §4.4 写的 3 条（正常有主机时仍是 3 条） |
| 2026-10-04 | **校正离线判定基准（重要）**：Agent 的 `report.interval` 默认值是 **30s**（`agent/internal/config/config.go` 修订 G3 已由 15s 改为 30s），而实现与多处文档仍按 15s ⇒ 阈值算成 45s < 上报周期，会**假离线**。已改：`AGENT_REPORT_PERIOD_S` 30s、阈值 **90s**、扫描周期默认 **60s**（`HEARTBEAT_SWEEP_INTERVAL_S`，原 30s）；同步校正 `docs/agent.md` G3、`docs/database.md` §8.2、`docs/api.md` §3.2、设计 §4 引用；新增两条回归防线（扫描周期 < 阈值、按 30s 节奏上报的任何相位都不得判离线）。另新增 §11.1「离线参数放数据库」讨论 |
| 2026-10-04 | 初稿：现状核实（10 条事实）、8 项设计决策、2+1 个接口契约、数据来源与查询策略、落地与验收清单、4 处既有文档/代码不一致、12 项待确认 |
| 2026-10-04 | **决议：离线参数「数据库可配」推迟到 M3 告警引擎一起做**（§11.1）——本期不改 `settings`/env/调度器，M3 输入清单已写入该节 |
