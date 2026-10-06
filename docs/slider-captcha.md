# Vantage 滑动验证码选型与接入方案

> 性质：选型调研与接入设计，不含实现代码。
> 结论：人机验证最终选定极验 GeeTest v4 作为默认 provider（配好密钥即默认使用）；自建极简滑块作为可选的零依赖 provider 完整保留（`CAPTCHA_PROVIDER=selfbuilt`），它同时是内网 / 离线部署的唯一可用选项。自建路线的实施规范见 `docs/slider-captcha-selfbuilt.md`，极验变更方案见 `docs/geetest-captcha.md`。
> 依据：`docs/api.md` §1.2（通用请求约定）/§1.4（限流）/§4.1（登录与会话）/§4.10（settings 白名单）、`docs/frontend.md` §4.2（登录页）、`docs/database.md` §7（Redis 键空间契约）、`Vantage-DESIGN-v0.8` §5.2（默认拒绝）、§13（安全清单）。
> 范围说明：验证码不在 `Vantage-DESIGN-v0.8` 与本仓库既有文档的范围内——设计文档与既有文档中从未出现「验证码 / captcha / 人机校验」（已全文检索确认），因此本文的决策项是新增的。
> 定位：§4、§5、§7 是路线对比期的接入草案，用于说明"为什么这样设计"，现行实现以 `docs/geetest-captcha.md` 与 `docs/slider-captcha-selfbuilt.md` 为准。库调研中的版本号、发布时间与下载量取自 npm registry API 与各仓库 README，链接见 §9。

---

## 0. 结论速览

| 路线 | 代表 | 是否可作为安全边界 | 内网可用 | 选型结论 |
|---|---|---|---|---|
| A. 自研极简滑块（服务端出题 + Redis 存答案 + 服务端校验） | 本仓库实现 | 是 | 完全可用 | 推荐：与自研 TOTP 同一取向，零新增运行时依赖；现为可选 provider，内网 / 离线部署的唯一可用选项 |
| B. 采用 AJ-Captcha 协议、后端自研 | anji-plus/captcha（Apache-2.0，Java 核心） | 是 | 是 | 次选：复用成熟交互与底图库，协议需自行按官方文档实现 Node 版 |
| C. 引入现成 Vue3 包 | `@zixinit/vue-captcha` / `vue3-puzzle-vcode` | 视包而定 | 是 | 需锁版本 + 审计；生态薄、单人维护 |
| D. 云服务 | 极验 / 腾讯云 / Cloudflare Turnstile | 是 | 否，需外网 + 密钥 | 仅当面板必然公网可达且接受第三方 JS 时考虑 |
| E. 纯前端滑块 | `vue3-slide-verify` 等 | 否 | 是 | 禁止作为安全边界：答案在客户端，改个返回值即绕过 |

实际选型结果是路线 D 中的极验 GeeTest v4（默认 provider，配好密钥即默认使用）；路线 A 降级为可选 provider（`CAPTCHA_PROVIDER=selfbuilt`）并完整保留，它仍是内网 / 离线部署的唯一可用选项。上表的"推荐"是选型期的对比结论，现行实现一律以 `docs/geetest-captcha.md` 为准。

一句话：滑动验证码是抬高单次尝试成本的补充层，不能替代现有的「Argon2id + 登录限流 + TOTP + 审计」，且它本身可被自动化破解（§2.5 有现成工具佐证）——定位清楚再动手。

---

## 1. 为什么需要它（威胁模型与现有防线）

Vantage 现有登录防线（见 `docs/api.md` §4.1）：

| 防线 | 现状 | 对自动化攻击的作用 |
|---|---|---|
| 慢哈希 | Argon2id 19MiB / t=2 / p=1 | 单次校验约 50ms，抬高了离线爆破成本，但不限制在线次数 |
| 登录限流 | `ratelimit:login:<ip>`，10 次 / 300s，成功失败都计数 | 限制单 IP 速率；对分布式 / 代理池无效 |
| 统一错误码 | 401 `invalid_credentials`（同码同文同耗时） | 防用户名枚举 |
| 二次验证 | TOTP（可选，`security.require_2fa` 可强制） | 密码泄露后的第二道门 |
| 审计 | `auth.login_failed` 等 | 事后发现，不阻断 |

缺口：当前唯一能"拦住脚本"的机制是按 IP 的固定窗口限流。攻击者用代理池（每 IP 打几次）即可把 10 次 / 5 分钟的窗口摊平，而每次尝试只受 Argon2 的约 50ms 约束——单机每秒可跑十几到几十次，代理池放大后足以对弱口令做在线喷洒。

滑动验证码补的正是这一环：让"每一次尝试"都需要一次人机判定，从而把攻击成本从"带宽 + CPU"抬到"过验证码的成本"。

三条约束：

1. 不得因为加验证码而放宽任何既有防线（限流阈值、Argon2 参数、TOTP 策略均不动）。
2. 验证码不是身份凭证：通过滑块不等于已认证，登录仍必须验密码。
3. 答案（缺口横坐标）只能存在于服务端；响应里出现答案即等于没有验证码。

内网约束（尚未确认，见 §8）：Vantage 是自托管监控系统，面板可能部署在无外网出口的内网。任何依赖 `geetest.com` / `challenges.cloudflare.com` 的方案在该场景下会直接失效（登录页卡住或永远失败）——这是排除云服务路线的首要理由，而非成本。

---

## 2. 现有库调研

### 2.1 云端 SaaS（需外网 + 账号密钥）

| 方案 | 形态 | 关键事实 |
|---|---|---|
| 极验 GeeTest v4 | 滑块 / 点选 / 无感 | 已采纳为默认 provider（配好密钥后即默认使用，见 `docs/geetest-captcha.md`）。官方 npm 包 `geetest@4.1.2` 最后发布于 2017-05，依赖已废弃的 `request@^2.54.0`；现行 SDK 在 GitHub（`GeeTeam/gt-node-sdk` 系列）而非 npm。需要可达极验服务器 + 密钥 |
| 腾讯云 / 阿里云验证码 | 滑块 / 点选 | 云 SDK + 密钥 + 计费；同样要求外网可达 |
| Cloudflare Turnstile | 无感 / managed（非滑块） | 对用户最友好，但需可达 `challenges.cloudflare.com`，且形态不是滑块 |
| reCAPTCHA v3 / hCaptcha | 无感 / 勾选 | 同上，国内可达性通常更差 |

结论：云服务是"最终判定权在人机模型手里"的方案，安全上限最高；但外网依赖与"第三方 JS 进入监控面板"这两点，与 Vantage「面板与反代同源部署、不引外部资源」的既有取向冲突。

### 2.2 自托管开源——滑块

| 项目 | 后端 | 前端 | 许可 | 关键事实 |
|---|---|---|---|---|
| anji-plus/captcha（AJ-Captcha） | Java（`captcha` jar / spring-boot-starter）；仓库另含 Go、PHP 示例 | 示例覆盖 vue / html / angular / react / uni-app / flutter / android / ios / 微信小程序（示例代码，非 npm 包） | Apache-2.0 | 国内事实标准。两种形态：滑动拼图 `blockPuzzle`、文字点选 `clickWord`。流程为"取验证码 → 用户完成 → 随表单提交 → 后端 `captchaService.verification` 二次校验"。社区底图库另仓。README 注明「在线体验暂时下线」。无官方 Node 后端 |
| dromara/tianai-captcha | Java | Java 生态 | Apache-2.0 | 滑块 / 点选 / 旋转，Java 界口碑好；与本仓库 Node 后端栈不匹配，未深入评估 |
| weiwolves/aj-captcha-go | Go | — | — | AJ-Captcha 的第三方 Go 移植。Vantage 的 Go 部分只跑 Agent，而 Agent 不能承载任何"中心下发 / 中心服务"职责（`Vantage-DESIGN-v0.8` §2.1 单向宗旨），因此不能用它当面板的验证码服务 |

### 2.3 npm 上的现成包（Vue3 / 框架无关）

| 包 | 版本 / 许可 | 最后发布 | 下载量（月） | 评价 |
|---|---|---|---|---|
| `@zixinit/vue-captcha` | 0.1.2 / MIT | 2026-09 | 377 | 最对口的 Vue3 候选：Vue 3.5+ peer、ESM、`exports` 含 `./slider`、`./client-slider`、`./core`（自称 server adapters）；engines ≥ Node 22.12。但仍是 v0.1.x、单人维护、依赖 `vue3-puzzle-vcode@1.1.7` |
| `vue3-puzzle-vcode` | 1.1.7 / 未标注 license | 2024-01 | 6.4k | Vue3 拼图组件，纯前端（无服务端校验接口），license 字段缺失 |
| `vue3-slide-verify` | 1.1.8 / MIT | 2025-07 | — | Vue3 滑块，纯前端判定（仅依赖 `vue`）；同作者线为 `vue-monoplasty-slide-verify`（Vue2） |
| `captcha-pro` | 1.0.0 / MIT | 2026-03 | 512 | 框架无关的"行为验证码"（滑块拼图 + 点选），TypeScript；包很新，服务端校验能力需进一步核实 |
| `create-puzzle` | 3.0.4 / MIT | 2026-01 | 3.9k | 在浏览器端生成拼图与背景图。服务端无法独立得知缺口位置，单独使用不构成安全边界（适合作纯前端演示） |
| `rc-slider-captcha` | 1.9.0 / MIT | 2025-12 | 7.7k | React 组件（Vue 需自写），文档给出推荐的后端出题 / 校验协议；作者另一包即上条 `create-puzzle` |
| `@slider-captcha/core`（+ 数十个 fork） | 1.0.1 / MIT | 2020-08 | 20–1300 | Node/Express 服务端核心（依赖老版 `sharp@^0.25`）+ React 前端。已 5 年未更新，且 npm 上存在大量同源 fork（`@ad2302/*`、`@fpdevel/*`、`@memrearal/*`、`@caesar003/*`、`@rosid/*`、`@supersymmetrysoftware/*`、`slider-captcha-react-pimath`…）——生态信号很差，不建议引入 |

### 2.4 非滑块但解决同一问题的路线（可选替代）

| 路线 | 代表 | 说明 |
|---|---|---|
| 工作量证明（PoW） | ALTCHA、Cap.js（SHA-256 PoW） | 无需图片、无外网、无障碍友好；代价是消耗访客 CPU，且对"专用硬件 / 脚本农场"效果有限。工程上是"零素材、零第三方"的干净方案 |
| 无感行为评分 | 云服务（Turnstile / reCAPTCHA v3） | 体验最好，但外网依赖 |

若最终目标只是"抬高脚本成本"而非"必须有滑块交互"，PoW 的自托管成本与可维护性优于自研滑块；但本文按既有需求以滑块为主方案。

### 2.5 调研中得到的关键安全事实

1. 纯前端滑块等于零防护：`vue3-slide-verify`、`vue3-puzzle-vcode` 这类组件在浏览器里判定"是否对齐"，攻击者直接调用其回调 / 改返回值即可通过；服务端完全不知情。
2. 服务端校验的滑块也能被自动破解：
   - `captcha-recognizer-js`（npm，MIT，2026-09）：纯浏览器内用 ONNX Runtime Web 跑 YOLO 做滑块缺口识别，"No server required"——即"识别缺口"已是开箱即用的前端能力；
   - `puppeteer-slider-solve`、`@2captcha/captcha-solver`（月下载 10 万+）：把滑块（含极验）作为可批量打码的对象。
3. 因此滑块的真实价值是"把每次尝试的成本从约 50ms 抬到需要一次图像识别 + 轨迹伪造"，挡住低级脚本与扫描器，提高规模化喷洒的经济成本。它不是、也不能被描述为"人机识别的硬边界"。
4. 抗辨识性来自"服务端不可预测 + 一次性 + 行为校验"，而不是来自图片复杂度。设计时把力气花在这三处（§5.4），不要花在"把拼图做得更花"。

---

## 3. 候选对比矩阵（按 Vantage 契合度）

| 维度 | A 自研极简 | B AJ-Captcha 协议自研后端 | C `@zixinit/vue-captcha` | D 云服务 | E 纯前端包 |
|---|---|---|---|---|---|
| 新增运行时依赖 | 0（除 `qrcode` 外可零新增） | 0（仅按协议实现） | 1 包 + 其 1 依赖 | JS SDK（外链或 npm） | 1 包 |
| 内网 / 断外网可用 | 是 | 是 | 是 | 否 | 是 |
| 服务端独立校验 | 是 | 是 | 是（需按其 server adapter 实现） | 是 | 否 |
| 包维护风险 | 无（自有代码） | 无（自有代码） | v0.1.x / 单人 / 低下载 | 供应商锁定 | 各异 |
| 与既有栈契合（Fastify + Redis + Vue3 + Element Plus） | 完全契合 | 契合（协议与 UI 形态现成） | 契合（Vue3 原生） | 一般 | 契合 |
| 素材（底图） | 需自备若干张（放仓库）或程序化生成 SVG | 可对接社区底图库 | 随包 | 供应商 | 随包 |
| 代码量估算 | 服务端约 300 行 + 前端约 250 行 | 服务端约 350 行 + 前端约 150 行（复用示例形态） | 服务端约 150 行 + 前端约 100 行 | 少量接线 | 极少 |
| 可审计性 | 全部自有 | 可审计 | 需审依赖 | 不可审 | 不可审 |
| 总评 | 推荐 | 次选 | 备选（接受风险时） | 条件性 | 禁用 |

---

## 4. 推荐与理由

本节是选型期的推荐与理由：路线 A 的结论（自研仍是内网 / 离线部署的唯一可用选项）仍然成立，但已不再是默认项——默认 provider 为极验，见 `docs/geetest-captcha.md`。现行实现以该变更方案与 `docs/slider-captcha-selfbuilt.md` 为准。

推荐路线 A（自研极简滑块），理由按优先级：

1. 与仓库既有取向一致：TOTP 就是"零依赖自研 + RFC 官方向量自测"的产物（`server/src/utils/totp.js`）；滑块的核心同样只有三件事——随机出题、服务端存答案、服务端校验，没有需要跟随上游演化的空间。
2. 内网可用且不引外部 JS：面板与反代同源部署，登录页不该因为外网不可达而失效。
3. 避免 npm 生态风险：滑块相关 npm 包要么是纯前端（无防护价值），要么五年未更新（`@slider-captcha/core`），要么是 v0.1.x 单人维护；这类包一旦停更，安全修复责任就落回维护者，而届时"读懂它的实现"比"自己写 300 行"更贵。
4. 协议自持：未来要换成点选 / 旋转、要加 PoW、要调整容差，都不受上游约束。

若更看重"少写代码 + 现成交互与底图"，则选 B（AJ-Captcha 协议 + 自研 Node 后端）：拿它的协议字段与前端交互范式，后端在 Fastify 里实现两个端点，底图可用其社区底图库（注意 Apache-2.0 的署名与素材许可需逐个确认）。

无论如何不选 D（除非明确要求"面板必然公网可达且接受第三方 JS"），也绝不选 E。

---

## 5. 接入设计（路线 A 的契约级方案）

本节是路线对比期的草案：权威契约在 `docs/slider-captcha-selfbuilt.md`（§4 存储键、§5 端点契约、§6 算法、§7 前端）。本节保留用于说明设计取舍，实现以自建方案为准。

### 5.1 交互流程

```
① 前端进入登录页（或登录失败达到阈值后）
      ↓ POST /api/v1/auth/captcha/challenge   （免登录，按 IP 限流）
② 服务端随机出题：生成缺口位置 (x, y)，把答案写 Redis，返回 SVG 背景图 + 拼图块
      ↓ 用户拖动拼图块（前端只采集轨迹，不做判定）
③ POST /api/v1/auth/captcha/verify  { captcha_id, x, y, track }
      ↓ 服务端比对容差 + 校验轨迹 → 通过则发放一次性 captcha_token
④ POST /api/v1/auth/login  { username, password, captcha_token? }
      ↓ 服务端按策略决定是否强制要求 token；校验通过后立即消费该 token
⑤ 走既有登录流程（Argon2 → 2FA → 会话）
```

关键取舍：把"验滑块"与"验密码"拆成两个请求，而不是把 `x` 直接塞进 `/auth/login`。理由：一是用户拖完立刻知道对错，不必等到提交密码才报错；二是登录请求体保持简洁；三是 `captcha_token` 一次性消费，天然防重放。

### 5.2 接口契约（新增 2 个端点）

#### `POST /api/v1/auth/captcha/challenge` — 取题

| 项 | 值 |
|---|---|
| 认证 | 无（免登录） |
| CSRF | 豁免（与会话无关，理由同 `/auth/login`） |
| 限流 | `ratelimit:captcha:<ip>`（新增桶，建议 30 次 / 分钟——比登录桶宽松，因为"换一张"是正常操作） |
| 审计 | 不记（否则审计被"取题"噪声淹没） |

请求体：无。

成功 200：

| 字段 | 类型 | 说明 |
|---|---|---|
| `captcha_id` | string | 随机的题目标识（≥16 字节 base64url）；Redis 键 `captcha:<id>` |
| `bg_svg` | string | 背景图（含缺口）的 SVG 文本，前端内联渲染 |
| `piece_svg` | string | 拼图块的 SVG 文本（用户拖动它） |
| `width` / `height` | number | 画布逻辑尺寸（前端按此比例缩放，服务端按逻辑坐标校验） |
| `expires_in` | number | 秒（建议 120） |

响应中不得出现：缺口坐标、容差、轨迹阈值、任何可用于反推答案的数值属性（例如 `<rect x="…">` 直接暴露缺口位置）。

#### `POST /api/v1/auth/captcha/verify` — 验题

请求体：

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `captcha_id` | string | 是 | 来自 challenge |
| `x` | number | 是 | 用户放下时拼图块的逻辑横坐标 |
| `y` | number | 可选 | 若只做横向滑动可省略 |
| `track` | array | 是 | `[[t_ms, x], …]` 轨迹采样（点数上限 200，防超大 body） |

成功 200：`{ captcha_token, expires_in: 120 }`

错误：

| 状态 | code | 触发 |
|---|---|---|
| 400 | `captcha_invalid` | 偏差超容差 / 轨迹可疑 / 题目过期或已用过（`details.reason`：`mismatch` / `track_suspicious` / `expired` / `not_found`） |
| 400 | `schema_invalid` | 字段缺失或超长 |
| 429 | `rate_limited` | `ratelimit:captcha:<ip>` 超限 |

#### 既有端点改动：`POST /api/v1/auth/login`

- 请求体新增可选字段 `captcha_token`（string）。
- 策略判定（服务端），这是本节草案的设计取值：`security.login_captcha = off` 时忽略该字段（仍接受但校验通过也不计）；`after_failures`（默认）时，当同一 IP 在当前限流窗口内的登录尝试次数 > `security.login_captcha_after`（默认 3）则强制要求有效 `captcha_token`（即窗口内第 4 次起要求）；`always` 时每次登录都要求。
- 缺 token 且策略要求 → 400 `captcha_required`（前端据此弹出滑块；不复用 401，否则前端无法区分"要滑块"和"密码错"）。

上述策略与当前实现有两处差异，以实现为准：

| 项 | 本节草案的设计取值 | 当前实现 |
|---|---|---|
| 设置项 | `security.login_captcha` 三值 enum（`off` / `after_failures` / `always`）+ `security.login_captcha_after`（默认 3） | `security.login_captcha.enabled`（bool，默认 `true`）与 `security.login_captcha.after_failures`（int，默认 1）两个设置项；不存在三值 enum 与 `security.login_captcha_after` |
| 触发条件 | 复用登录限流器的计数（含成功尝试） | 独立的两个失败计数器 `login:fail:ip:<ip>` 与 `login:fail:acct:<hash>` |

权威口径见 `docs/slider-captcha-selfbuilt.md` §2.1/§2.2/§8.2 与 `server/src/services/settings.service.js` 的 `SETTING_DEFAULTS`。

另外一处差异：token 不在登录"校验通过"时消费，而是登录成功后才 `DEL captcha:ok:<token>`；失败不消费，因此有效期内（120s）可复用于"密码仍错"的重试（见 `docs/slider-captcha-selfbuilt.md` §6.4 与 `server/src/services/captcha.service.js`）。重放已消费的 token → 400 `captcha_invalid`（`details.reason = expired`）。

关于"复用登录限流计数"的取舍：好处是零新增计数器（让 `createLoginRateLimiter` 把 `count` 挂到 `request` 上即可，无需新键）；代价是该计数包含成功尝试（`docs/api.md` §1.4 的既定口径：成功与失败都计数），因此"窗口内正常登录 3 次以上"也会触发滑块——对面板这种低频操作可接受。自建方案改用独立的失败计数器，见 `docs/slider-captcha-selfbuilt.md` §2.1；这段讨论保留为选型期记录。

为什么默认"失败若干次后才要求"：滑块对正常用户是纯摩擦，首屏就要求等于给每一次正常登录加税；而攻击者恰恰是"高频尝试"的那一方，用同一 IP 窗口内尝试次数做触发器，正好把摩擦加在攻击者身上。

### 5.3 Redis 键与 TTL（已登记进 `docs/database.md` §7）

按 `docs/database.md` §7「键空间集中定义、不新增用途前缀」的约定，以下键必须先写进 §7 表格再实现：

| 键 | 结构 | TTL | 含义 |
|---|---|---|---|
| `captcha:<captcha_id>` | hash | 120s | `x`、`y`、`created_at`、`attempts`（失败计数，≥3 即作废） |
| `captcha:ok:<captcha_token>` | string（值 = 解出该题的 IP，不是占位 `1`） | 120s | 已通过的凭证，登录时一次性消费（实际在登录成功后才消费，失败不消费） |
| `ratelimit:captcha:<ip>` | string | 60s 窗口 | 取题 / 验题按 IP 限流 |

与 `totp:used:<uid>` 同一模式：答案与凭证都只在 Redis，不入 PG、不进日志。

实际登记的键比上表多两个失败计数器：`login:fail:ip:<ip>` 与 `login:fail:acct:<sha256(lower(username))[:16]>`（TTL = `loginWindowS`，默认 300s），共 5 个键；极验分支另加 `captcha:vendor:down:<provider>`（30s）。完整清单见 `docs/slider-captcha-selfbuilt.md` §4.1 与 `server/src/utils/redisKeys.js`。

### 5.4 服务端校验规则（抗辨识的关键，而非图片复杂度）

| 规则 | 建议值 | 作用 |
|---|---|---|
| 横坐标容差 | `max(4, width * 0.008)` px（300px 宽约 4–6px） | 容忍手感误差 |
| 轨迹点数 | ≥ 8 | 挡"一次事件直接给终点" |
| 总时长 | 300ms – 15000ms | 挡瞬移与"挂机不动" |
| 单调性 | x 允许极小回退（≤2 次、每次 ≤3px） | 真实拖动有抖动，脚本常是完美单调 |
| 速度方差 | > 0（要求存在加减速） | 挡线性匀速的"机器滑动" |
| 末点一致 | `track` 末点 x ≈ 提交 x | 挡轨迹与提交值不一致的伪造 |
| 一次性 | 验过即 `DEL captcha:<id>`；失败 `attempts+1`，≥3 作废 | 挡重放与暴力试位（容差 5px / 300px 宽约等于 1/60 命中率，不设失败上限等于给了 60 次机会） |
| 时间校验 | 以 Redis TTL 为准，不信任前端时间 | 挡本地时钟伪造 |

不得回传：答案、容差、阈值、失败次数上限（前端只需要"对 / 错"与"过期 / 请重试"）。

### 5.5 前端（`web/`）

- 新增 `web/src/components/SliderCaptcha.vue`：Vue 3 `<script setup>` + TypeScript（遵循仓库的 Vue 约定：Composition API + `<script setup>`），Element Plus 主题变量配色；不使用 canvas 私有交互（可访问性与测试都更差），用 SVG + `pointerdown/pointermove/pointerup`（同时兼容触屏与鼠标）。
- `Login.vue` 接入：登录返回 400 `captcha_required` → 内联展示滑块 → 验证通过 → 自动重试登录（带 `captcha_token`），用户无需重输密码。
- i18n：`zh-CN` / `en-US` 都要加文案（`web/src/locales/*.ts`），不硬编码中文。
- 可访问性：滑块容器给 `aria-label` 与键盘操作说明，并且必须有替代路径（见 §5.7）。

### 5.6 审计与错误码登记

| 项 | 值 |
|---|---|
| 审计 action | 失败记 `auth.captcha_failed`，其 `detail.reason` 取值 `mismatch` / `track_suspicious` / `not_found` / `too_many_attempts`，另有 `provider` 与可选的 `delta_px`（没有 `expired` / `replayed`，见自建方案 §9）；成功不单独记，改为在 `auth.login` 的 `detail` 里加 `captcha_used: true` |
| 审计脱敏 | `detail` 里不得出现答案 x、用户提交的 x（可记 `delta_px` 用于调参）、token、captcha_id 全值 |
| 新错误码 | `captcha_required`（400）、`captcha_invalid`（400）已登记于 `server/src/utils/errors.js` 与 `docs/api.md` §1.3 错误码总表 |

### 5.7 降级与无障碍

1. 策略开关：`security.login_captcha.enabled = false` 时全链路不生效（出题端点返回 404 或 403，由实现定，建议 404 以免暴露"存在但被关"）。
2. 无 JS / 键盘用户：提供"改用恢复码登录"或"联系管理员"的说明；Vantage 已有 TOTP 与管理员 2FA 重置渠道，可复用为替代路径。
3. 服务端出题失败（Redis 不可用）：不得静默放行（fail-open）——按既有取向（`docs/api.md` §1.4 限流同款）返回 503 `upstream_unavailable`，即"宁可暂时登不上，也不放开"。
4. 阈值策略下的豁免：已开启 TOTP 的账号是否可跳过滑块？建议不豁免（保持实现简单、语义单一）。

### 5.8 验收用例

权威清单见 `docs/slider-captcha-selfbuilt.md` §10.3 的验收用例表（含"首次登录不出现滑块""密码错后引入""代理池兜底""换 IP 用 token"等）。此处不再重复维护，避免两处漂移。

---

## 6. 与既有系统的一致性检查

| 关注点 | 结论 |
|---|---|
| `docs/api.md` §4.1 登录端点 | 新增了可选 `captcha_token` 字段（向后兼容：不传即旧行为；`LOGIN_BODY_SCHEMA` 在 `server/src/routes/auth.js`） |
| `docs/api.md` §1.3 错误码总表 | 登记了 `captcha_required` / `captcha_invalid`（400）两条；极验分支另加 `captcha_unavailable`（503），见 `server/src/utils/errors.js` |
| `docs/api.md` §1.4 限流表 | 登记了 `ratelimit:captcha:<ip>`（30 次 / 分钟），并注明"与登录桶独立"——不与 `ratelimit:login` 合并，否则用户"换一张图"会消耗登录额度 |
| `docs/api.md` §4.10 settings 白名单 | 登记了两个 key：`security.login_captcha.enabled`（bool，默认 `true`）与 `security.login_captcha.after_failures`（int，默认 1 = 第 1 次失败之后即第 2 次起要求滑块）。本节早先写的 `security.login_captcha`（enum）与 `security.login_captcha_after` 与实际不符，见 `docs/slider-captcha-selfbuilt.md` §8.2 与 `server/src/services/settings.service.js`；不在白名单内的 key 会让 `PATCH /settings` 返回 400 `unknown_setting` |
| `docs/database.md` §7 Redis 键空间 | 登记了 5 个键（`captcha:<id>`、`captcha:ok:<token>`、`login:fail:ip:<ip>`、`login:fail:acct:<hash16>`、`ratelimit:captcha:<ip>`）+ 极验的 `captcha:vendor:down:<provider>`；不登记即违反"键名唯一来源"约定 |
| `docs/frontend.md` §4.2 登录页 | 补充了"验证入口何时出现、失败如何提示、i18n key"小节（按 provider 分支分别说明） |
| Agent / 上报链路 | 零影响（验证码只作用于面板登录，不进 Agent 路径） |
| 审计体量 | 只记失败，正常用户不产生审计噪声 |

---

## 7. 工作量与分块

权威分块表见 `docs/slider-captcha-selfbuilt.md` §11：纯函数原语（`utils/slider.js` + 纯函数单测）；服务 / 2 个端点 / 独立限流桶 / 两个失败计数器 / 错误码 / 键登记 / 设置项；前端组件与登录页集成 + i18n；文档回填。合计约 3 天。此处不再重复维护。

底图素材建议放 `server/assets/captcha/`（3–6 张，仓库内，不支持管理员上传以免引入文件上传面）；拼图块用 SVG `clipPath` 裁剪同一张底图，零图像处理依赖——不引入 `sharp` / `canvas`，与"依赖越少越好"冲突，且要编译原生模块。

---

## 8. 开放决策项（一次只问一条）

| 议题 | 结论 / 现状 | 说明 |
|---|---|---|
| 路线选择：A 自研极简 / B AJ-Captcha 协议 + 自研后端 / C 现成 Vue3 包 / D 云服务 | 先选自研（理由见 §4），随后改用极验 GeeTest v4 作为默认 provider，自建路线降级为可选 provider 并完整保留 | 自建路线实施规范见 `docs/slider-captcha-selfbuilt.md`，极验变更方案见 `docs/geetest-captcha.md` |
| 触发策略与阈值 | 首次登录不要求；一次密码错后后续登录要求（阈值 1），并同时按 IP 与账号记失败 | 已按此实现，细节见自建方案 §2 |
| 是否允许引入原生依赖（`sharp` / `canvas`）处理真实照片底图 | 否（用仓库内置底图 + SVG 裁剪） | 尚未决定 |
| 面板是否可能运行在无外网环境（决定云服务是否彻底出局） | 按"是"（内网自托管）预留 | 尚未确认 |
| 是否同时提供 PoW 替代（ALTCHA / Cap.js）作为"无图"通道 | 暂不（先把滑块做完，保持范围可控） | 尚未决定 |

自建路线新增的决策项（失败阈值、成功后是否重置计数、token 是否绑定 IP、底图来源、出题限流阈值、是否按账号记失败）见 `docs/slider-captcha-selfbuilt.md` §12。

---

## 9. 参考链接（调研来源）

云端
- 极验 Node SDK（npm，2017 年）：https://registry.npmjs.org/geetest/latest
- 极验自定义 API 集成说明：http://docs.geetest.com/downloads/sensebot_%E8%87%AA%E5%AE%9A%E4%B9%89API%E8%AF%B4%E6%98%8E%E6%96%87%E6%A1%A3.pdf

自托管开源
- AJ-Captcha（Apache-2.0，Java 核心 + 多端示例）：https://github.com/anji-plus/captcha ｜中文说明：https://raw.githubusercontent.com/anji-plus/captcha/master/README_CN.md ｜文档站：https://ajcaptcha.beliefteam.cn/captcha-doc/
- AJ-Captcha 社区底图库：https://gitee.com/anji-plus/AJ-Captcha-Images
- AJ-Captcha 的 Go 移植（与 Vantage 单向宗旨不符，仅记录）：https://socket.dev/go/package/github.com/weiwolves/aj-captcha-go
- tianai-captcha（Java）：https://github.com/dromara/tianai-captcha

npm 候选
- `@zixinit/vue-captcha`（Vue3 + 服务端适配）：https://registry.npmjs.org/@zixinit/vue-captcha/latest ｜仓库：https://github.com/huwenlong92/vue-captcha
- `vue3-puzzle-vcode`：https://registry.npmjs.org/vue3-puzzle-vcode/latest
- `vue3-slide-verify`（纯前端）：https://www.npmjs.com/package/vue3-slide-verify
- `captcha-pro`（框架无关）：https://github.com/saqqdy/captcha-pro
- `create-puzzle` + `rc-slider-captcha`（React / 浏览器端生成）：https://github.com/caijf/create-puzzle ｜https://github.com/caijf/rc-slider-captcha
- `@slider-captcha/core`（2020，sharp 依赖）：https://registry.npmjs.org/@slider-captcha/core/latest ｜仓库：https://github.com/adrsch/slider-captcha

破解与绕过
- `captcha-recognizer-js`（浏览器内 ONNX 缺口识别）：https://registry.npmjs.org/-/v1/search?text=slider%20captcha ｜仓库：https://github.com/this-is-h/captcha-recognizer-js
- `puppeteer-slider-solve`：https://www.npmjs.com/package/puppeteer-slider-solve
- `@2captcha/captcha-solver`（含 GeeTest / Turnstile 等）：https://github.com/2captcha/2captcha-javascript

PoW 替代
- ALTCHA（开源 PoW，含免费与付费档）：https://altcha.org/docs/how-it-works/ ｜https://altcha.org/docs/open-source-vs-paid/
- Cap.js（SHA-256 PoW）：https://github.com/MorizeroDev/capjs

---

## 10. 溯源

| 本文内容 | 来源 |
|---|---|
| §1 现有防线 | `docs/api.md` §1.4、§4.1；`server/src/middleware/rateLimit.js` |
| §1 内网约束 | `docs/api.md` §1.1（面板与反代同源部署、不引外部资源）；`server/src/utils/totp.js` 记录的自研理由 |
| §5.3 Redis 键登记要求 | `docs/database.md` §7「键空间集中定义」 |
| §5.4 一次性与防重放口径 | `docs/api.md` §4.1（`totp:used:<uid>` 同款模式） |
| §5.7 fail-closed 取向 | `docs/api.md` §1.4（Redis 不可用时拒绝服务，不做无限流登录） |
| §6 settings 白名单 | `docs/api.md` §4.10 + `server/src/services/settings.service.js` |
