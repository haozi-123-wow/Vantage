# Vantage 人机验证 · 自建滑块 → 极验 GeeTest v4 变更方案

> **性质**：**变更方案 + 实施规范**（含逐文件改动清单、协议算法、失败模式决策、验收用例）。⛔ 本文**不含已实现的代码**。
>
> **依据**：`docs/slider-captcha.md`（选型调研，C1 原定 = A 自研）、`docs/slider-captcha-selfbuilt.md`（自建方案的权威实施规范，S1–S4 已落地）、`docs/api.md` §1.2/§1.3/§1.4/§4.1/§4.10、`docs/database.md` §5.4/§7、`docs/frontend.md` §4.2。极验官方资料见 §15。
>
> **状态**：✅ **后端已落地（S5–S7，2026-10-03）**；✅ **前端已落地（S8，2026-10-03）**；⏳ 待 Owner 跑 `npm test` 与真机验收。逐条落地记录（含**与本方案的偏差**）见 **§16**。
> - ✅ **C12 已定（2026-10-03）= G1-a**：新增 `CAPTCHA_PROVIDER` 开关，**极验为默认**、自建滑块**降级为可选 provider（⛔ 不删代码）**。
> - ✅ **C13 已定（2026-10-03）= `open`**：极验不可达时**放行**，并按 §9.3 把「审计 + error 日志 + 超时预算」一并做掉（这三项因 C13 选 `open` 从「建议」变成**必做**——否则这一层会在没人察觉的情况下静默消失）。
> - ✅ **C16 已定（2026-10-03）= 用极验的「官方按钮」**：`product` 取 `popup`（备选 `float`），⛔ **不用 `bind`**。观感与「点按钮 → 官方验证弹窗」都由极验提供，我们只负责**什么时候把那个按钮显示出来**（首次不显示、密码错后就地显示）。⚠️ 此项**推翻了本文初稿 §7.3 的 `bind` 建议**，§7 已整节重写。
> - ✅ **C15 已采纳（2026-10-03，实施时按 §7.1 的推荐项）= 动态注入 `gt4.js`**：先问 `/auth/captcha/challenge`，`provider='geetest'` 时才注入脚本。连带效果正是 §7.1 想要的那条：**关闭/自建部署时登录页零极验外链**。
>
> 当前代码：后端与前端都已是极验（S5–S7 见 §16，S8 见 §16.7）；自建滑块 `SliderCaptcha.vue` **保留**（`CAPTCHA_PROVIDER=selfbuilt` 时仍会用到）。✅ 相关文档的字面契约已随 S7/S8 并入（`docs/api.md` §0/§1.3/§4.1/§4.1.0/§6.2、`docs/database.md` §7、`docs/frontend.md` §4.2），回填清单见 §14、落地记录见 §16。
>
> **编号约定**（延续既有体系，⛔ 不新起炉灶）：
> - **C12–C19** = 本次变更引入的开放决策（续 `slider-captcha.md` 的 C1–C5 与 `slider-captcha-selfbuilt.md` 的 C6–C11）；
> - **S5–S9** = 实施分块（续自建方案的 S1–S4）；
> - **AC-G1…AC-G12** = 本次验收用例。⚠️ **刻意**用 `AC-G` 前缀：既有 `slider-captcha-selfbuilt.md` 已占用 AC-1…AC-13，`api.md` §6.2 又用了 15–18，两套编号已经撞号。本文不扩大已有的编号混乱，同时建议 Owner 后续统一（见 §14 第 7 条）。

---

## 0. 一页速览

| 维度 | 现在（自建滑块，S1–S4 已落地） | 变更后（极验 GeeTest v4） |
|---|---|---|
| 出题 | 服务端 `utils/slider.js` 生成 SVG，答案进 Redis | **极验云端出题**，浏览器加载 `gt4.js`；服务端不参与出题 |
| 验题 | 服务端比对容差 + 校验轨迹 | 服务端调 `POST gcaptcha4.geetest.com/validate` 二次校验 |
| 外部依赖 | **零**（纯 Redis + 纯函数） | ⛔ 新增 **2 个外部域名**（服务端 1 个 + 浏览器 1 个）+ 极验账号与密钥 |
| 离线/内网部署 | ✅ 可用 | ⛔ **不可用**（见 §1.2 代价三） |
| 登录页脚本 | 只有自家打包产物 | ⛔ **执行第三方 CDN 的 JS**（见 §1.2 代价二） |
| 出题质量 | 程序化 SVG，可被 YOLO 类模型秒解 | 极验的云端行为+风控策略，对抗强度显著更高，且**持续更新** |
| 失败时的可用性 | Redis 坏 → 503，**登不进去**（fail-closed） | 极验坏 → 官方口径是**放行**（fail-open，见 §9） |
| 合规 | 无 | ⛔ 需隐私政策披露「向第三方共享登录行为与 IP」（见 §1.2 代价四） |

**不变的部分（这是本文最重要的承诺）**：触发策略（首次登录不要求、密码错后才要求）、两层失败计数（IP + 账号）、一次性凭证与 IP 绑定、「登录成功才消费」、闸门在验密之前、三态矩阵正交、`/auth/login` 请求体形状、错误码 `captcha_required`/`captcha_invalid`——**全部保持不变**。理由与做法见 §2、§3.4。

---

## 1. 先说清楚这次变更的代价

⛔ 这一节不是免责声明，是**决策输入**。四条代价里有两条（代价三、代价四）可能直接推翻这次变更。

### 1.1 换来的东西（按 Owner 2026-10-03 给出的优先级）

> **Owner 原话要点**：「使用极验好处是**前端好看**、还**不容易被脚本绕过**、**后端也不用费劲去判断**；主要就是（自建滑块的）**前端太丑了**。」

1. **前端观感 —— 本次变更的**首要**动机**：自建滑块（S3）是手写的程序化 SVG + 指针拖拽，视觉与交互只是"能用"水平，Owner 明确判定为"太丑"。极验给的是**成熟产品级的官方按钮与验证弹窗**（AI 无感判定、动效、多语言、移动端适配），这套 UI 我们不再自己维护。
2. **抗脚本**：自建方案的诚实结论是「真实作用 = 把每 5 分钟最多 10 次尝试变成每 5 分钟至少一次人机判定」（`slider-captcha-selfbuilt.md` §6.4），且程序化底图的缺口能被现成 ONNX/YOLO 模型识别（同文件 §6.1）。极验的价值在于**云端风控策略 + 持续更新的对抗代码**——这是自建永远追不上的部分。
3. **后端不用自己实现判定**：出题算法、容差调参、轨迹可疑度判定、底图素材与反破解对抗都从我们的代码里消失（`utils/slider.js` 那套纯函数随之退休）。
4. **可解释性**：极验返回的 `reason` 与后台统计能给出「为什么这个人被拦」的依据。

⚠️ **对第 3 条要打个诚实的折扣**：后端**确实**不再需要自己写判定，但**净负担大致持平**——新增的是「跨公网调用 + HMAC 签名 + 超时预算 + 容灾与失败模式 + 审计」（§5.1 的核心代码不到 60 行，但 §9 的失败模式决策与 §8.5 的网络前提是真成本）。所以这次变更的真实收益集中在 **第 1 条（观感）与第 2 条（抗脚本）**，而不是"后端变省事了"。

### 1.2 失去的东西

**代价一：可用性与安全的取向被反转。**
自建版是 **fail-closed**（`captcha.service.js` 文件头第 5 条：Redis 异常一律向上抛 → 503）。极验接入后，`/validate` 是**跨公网调用**，而极验官方要求的处理方式是**失败即放行**（§9）。也就是说：**我们主动把「人机验证这一层」的可用性交给了一家外部公司，并且按官方口径它坏掉时等于不存在**。

**代价二：登录页将执行第三方 CDN 的 JavaScript。**
`gt4.js` 由 `https://static.geetest.com/v4/gt4.js` 加载，且它是个 **loader**（官方原文：「它用于加载对应的验证JS库」），会继续从极验的域名拉取真正的验证库。后果：
- 任何能改写这个脚本的人，**能在登录页读到用户输入的明文密码**。对自研产品来说，这等于把管理员口令交给第三方供应链——而 Vantage 登录的正是「能看全公司监控数据」的账号。
- ✅ **SRI（子资源完整性）基本不适用**：loader 动态注入后续脚本，哈希无法覆盖。自托管 loader 只能减少一跳，不能消除依赖。
- ⚠️ 当前 Vantage **未设置 CSP**（依赖里没有 helmet/@fastify/helmet），所以这不是「加一条 CSP 放行」的问题，而是「本来就允许任意外链脚本」的现状。⛔ 若将来加 CSP，必须放行 `script-src https://static.geetest.com`、`connect-src https://*.geetest.com` 等（§8.5）。

**代价三：部署前提变了——内网/离线环境直接不可用。**
极验要求**服务端**与**浏览器**都能打通极验域名（含备用域名，见 §8.5）。Vantage 是**自托管**产品，部署在隔离内网、只放行必要出口的场景非常常见。这类环境里：
- `provider=geetest` → 前端初始化失败、服务端 `validate` 失败；
- 最终表现是**登录页卡住或登录被拒**，且错误文案是「人机验证未通过」——**极易被误判成 Vantage 自己的 bug**（见 §9.1 场景 B，这是最贵的一个坑）。
- ✅ 缓解：保留自建滑块作为可选提供方（C12 建议 G1-a），`provider=selfbuilt` 时零外部依赖。

**代价四：合规。**
- 极验是**第三方服务**：登录 IP、浏览器行为特征、`referer`、`userInfo`（若传）都会流向极验。
- 需要：① 极验后台报备调用域名；② 在隐私政策里披露「使用了极验行为验证，会向其传输…」；③ 若 Vantage 实例部署在 GDPR/个人信息保护要求较严的地区，把登录行为传给第三方需要额外的合法性基础。
- ⛔ 直接影响设计：**不要传 `userInfo`**（见 C17）——传了等于把用户名交给第三方，与既有「登录响应不得携带账号线索」的原则也冲突。

### 1.3 与自建方案的对照

| 维度 | 自建（现状） | 极验 v4 |
|---|---|---|
| 服务端新增网络出口 | 0 | 1（`gcaptcha4.geetest.com:443`，另有 2 个备用域名） |
| 浏览器新增脚本源 | 0 | 1（`static.geetest.com`，实际会再拉多个资源） |
| 新增 npm 依赖 | 0 | **0**（Node ≥22 用内置 `fetch`；前端用官方 CDN 脚本，不引 npm 包） |
| 新增密钥 | 0 | 2（`captcha_id` 公开 / `captcha_key` **机密**） |
| 新增 Redis 键 | 4 | **-1**（`captcha:<id>` 不再使用），其余不变 |
| 需要账号/备案 | 否 | **是**（极验账号 + 域名报备 + 免费版有量级限制） |
| 单次登录额外延迟 | 0 | 未通过时 +1 次跨公网 RTT（见 §9.3 的熔断与超时预算） |

---

## 2. 不变的契约（复述，防止实现时漂移）

这一节逐条复述 `slider-captcha-selfbuilt.md` §2 与 `api.md` §4.1 的既定语义。⛔ **换提供方不得改动其中任何一条**。

1. **首次登录永远不要求人机验证**：新部署、失败计数为 0 时，不带任何验证参数也能登录成功。（这是原需求的核心断言。）
2. **出现密码错误后才引入**：同 IP 或同账号的失败计数 ≥ `security.login_captcha.after_failures`（默认 1）→ 该窗口（`loginWindowS`，默认 300s）内的后续登录**必须**携带有效验证凭证。
3. **两层计数都要**：`login:fail:ip:<ip>` 拦连续尝试；`login:fail:acct:<sha256(用户名)[:16]>` 拦「代理池每 IP 只试一次」的分布式喷洒。⛔ 少了按账号维度，那套攻击下计数器永远是 0。
4. **闸门在验密之前**：顺序固定为 ① 登录限流 → ② 读策略与计数 → ③ 校验人机验证凭证 → ④ 查库 + Argon2 → ⑤ 失败则计数 +1 并回 `details.captcha_required` → ⑥ 成功才消费凭证。
   🔑 ③ 必须在 ④ 之前：否则攻击者不必过验证就能让服务端每次跑满 19MiB 的 Argon2，等于白送一个 DoS 放大器。
5. **触发器不查库**：② 的判定只用 IP / 提交的用户名 + 设置项。否则会引入「账号是否存在」的计时侧信道，破坏三种登录失败同码同文同耗时的既有不变量。
6. **凭证绑定来源 IP**，且**登录成功时才消费**（失败不消费）——用户划过一次后打错密码不必重滑。
7. **策略与三态正交**：它只决定「这次登录能不能进入验密环节」，⛔ 不改变 `full`/`totp_pending`/`setup_required` 的判定。
8. **总开关 `security.login_captcha.enabled=false`** 时整条链路不生效：取题端点 **404 `not_found`**（⛔ 不用 403，免得暴露「有这东西但被关了」），登录响应与未接入验证码时**逐字节相同**。

---

## 3. 架构：把「提供方差异」收敛到一个接缝

### 3.1 现状（S 系列）

```
routes/auth.js
  POST /auth/captcha/challenge ──▶ captcha.service.issueChallenge()  ──▶ utils/slider.js（出题，纯函数）
  POST /auth/captcha/verify    ──▶ captcha.service.verifyChallenge() ──▶ utils/slider.js（判定，纯函数）
  POST /auth/login             ──▶ auth.service.login() ──▶ captcha.service.requireForLogin / assertLoginToken / consumeLoginToken
                                     └─ 策略、计数、一次性 token 全在 captcha.service.js
```

⚠️ 问题：`captcha.service.js` 把**编排职责**（策略/计数/token）与**滑块实现细节**（`utils/slider.js` 的出题与判定）写在同一个对象里（`issueChallenge` 直接 `generateChallenge()` + `buildChallengeSvg()`）。换提供方会同时改到编排与实现，容易把 §2 的语义改坏。

### 3.2 目标（provider 抽象）

```
services/captcha.service.js               ← 只留「编排」：策略、两层计数、闸门、一次性 token、审计
  └─ services/captcha/providers/index.js  ← 按 config 选提供方（工厂）
       ├─ services/captcha/providers/slider.provider.js    ← 从 captcha.service.js 迁出的滑块实现
       └─ services/captcha/providers/geetest.provider.js   ← 新增：极验二次校验
utils/slider.js        （原样保留，只被 slider.provider.js 使用）
utils/geetest.js       ← 新增：纯函数（签名、参数拼装、响应解析），零网络，可单测
```

🔑 **接缝的位置是刻意选的**：`provider` 只回答「这次人机判定过没过」，**它不知道也不关心**策略、失败计数、一次性 token、审计、登录流程。这样 §2 的 8 条契约全部留在 `captcha.service.js` 里，换提供方时它们**一行都不用改**。

### 3.3 提供方接口（JS 签名）

```js
/**
 * 人机验证提供方接口。⛔ 实现里不得出现策略判定 / 失败计数 / 发放 token / 写审计。
 * @typedef {object} CaptchaProvider
 * @property {'slider'|'geetest'} name
 * @property {() => boolean} isConfigured  ← 凭据/开关是否齐备（⛔ 不查 Redis、不查库）
 * @property {(input: {ip: string|null, logger?: object}) => Promise<object>} issueChallenge
 *   出题。返回值就是路由层要回给前端的**响应体**（形状由提供方决定，见 §6）。
 * @property {(input: object) => Promise<
 *     { ok: true } |
 *     { ok: false, reason: string, unavailable?: boolean }
 *   >} verifyChallenge
 *   验题。`unavailable=true` 表示「**提供方自身不可用**，不是用户没通过」——
 *   ⛔ 这两者必须分开表达，否则 §9 的失败模式无从实现（详见 §9.4 教训一）。
 */
```

### 3.4 为什么保持「两步」契约，而不是改成「一次提交」（C18）

极验的常规接法是**一步**：前端拿到 4 个参数后随登录请求一起提交，服务端在登录接口里调 `/validate`。本文**不采用**一步接法，坚持 Vantage 现有的两步接法。四条理由：

1. **解开了「极验 `pass_token` 一次性」与「用户可重试」的语义冲突。**（最关键）
   极验的 `pass_token` 在 `/validate` 成功后即失效——「一次性」由极验保证。而 §2 第 6 条要求「用户划过滑块后打错密码不必重滑」。若走一步接法，第二次提交密码就得**再走一遍极验**（再弹一次窗、再过一次人机），体验直接崩。
   两步接法下，极验的 `pass_token` 只在 `/captcha/verify` 这一个点上被消费 **一次**；之后用户重试携带的是**我们自己**的 `captcha_token`（`captcha:ok:<token>`，TTL 120s，成功才消费）。两个需求各自在自己的层里成立，互不干扰。
2. **闸门位置不变。** `/captcha/verify` 仍然发生在验密之前，§2 第 4 条的「先卡验证、后跑 Argon2」自然保持。
3. **端点与错误码不变。** 前端只需换 `<GeetestCaptcha>` 内部实现，`Login.vue` 的「401 带 `details.captcha_required` → 就地展开 → 成功后自动重提」这套流程完全复用（§7.2）。
4. **限流边界不变。** 对外发起请求的动作被关在 `/captcha/verify` 一个端点里，`ratelimit:captcha:<ip>` 继续罩着它（§8.4）。

⚠️ **代价（要说清楚）**：多一次 HTTP 往返（浏览器 → 我们的服务端 → 极验），以及极验 `gen_time` 与我们收到请求之间多了一段网络延迟。极验对 `gen_time` 有时效要求，务必在超时预算里留出余量（§8.1）。

---

## 4. 极验 v4 协议与算法

### 4.1 三端时序

```
浏览器(C)                     服务端(B, vantage-core)              极验(G)
   │                                  │                              │
   │ ① 页面加载 → 加载 gt4.js ────────┼─────────────────────────────▶│ (静态资源)
   │ ② POST /auth/captcha/challenge ─▶│                              │
   │ ◀── {provider:'geetest', captcha_id, product:'popup', ...} ─────│
   │ ③ initGeetest4(...) → appendTo(登录表单里的**隐藏**容器) → onReady
   │                                  │                              │
   │ …（用户输错密码 → 服务端回 401 + details.captcha_required）…    │
   │                                  │                              │
   │ ④ 容器显示 → **出现官方按钮** → 用户点它 ─┼──────────────────────▶│ 出题/交互/判定
   │ ◀── onSuccess → getValidate() = {lot_number, captcha_output,    │
   │        pass_token, gen_time} ────┼──────────────────────────────│
   │ ⑤ POST /auth/captcha/verify {4 个参数} ─▶│                       │
   │                                  │ ⑥ 计算 sign_token            │
   │                                  │ ⑦ POST /validate ───────────▶│
   │                                  │ ◀── {result:'success'|'fail',│
   │                                  │      reason, captcha_args}   │
   │ ◀── 200 {captcha_token, expires_in} ─ 或 400 captcha_invalid ───│
   │ ⑧ POST /auth/login {username, password, captcha_token} ─▶│      │
   │ ◀── 200 / 401                                                 │
```

⚠️ 与自建版的关键差异：**第 ①②③ 步即使「首次登录不要求验证」也要做**（见 §7.1 的说明）。这是极验「行为验证需要采集页面上的用户行为」这一机制推出来的，与自建版「首次进入页面不预加载」不同。契约层面没变（首次登录仍然**不出现验证**），变的是前端的资源加载时机。

🔑 第 ④ 步的「显示官方按钮」= **把隐藏容器改为可见**——按钮 DOM 在第 ③ 步就已生成，只是被 CSS 藏起来了。这样既满足官方「页面加载时初始化」，又不违反 §2 第 1 条。完整做法与理由见 §7.3。

### 4.2 二次校验接口（`/validate`）

| 项 | 值 |
|---|---|
| 地址 | `https://gcaptcha4.geetest.com/validate?captcha_id=<captchaId>`（⚠️ 官方示例写 `http://`，我们一律用 **HTTPS**；`captcha_id` 放 **URL query**，便于异常时按 id 定位日志） |
| 方法 / 类型 | `POST`，`application/x-www-form-urlencoded` |
| 超时 | 官方 demo 用 5000ms；本文建议 **3000ms**（§8.1） |
| 请求参数 | `lot_number`、`captcha_output`、`pass_token`、`gen_time`、`sign_token` |
| 成功响应 | `{ "result": "success", "reason": "", "captcha_args": { used_type, user_ip, lot_number, scene, referer } }` |
| 校验失败 | `{ "result": "fail", "reason": "pass_token expire", "captcha_args": {...} }` |
| 请求异常 | ⛔ **完全不同的形状**：`{ "status": "error", "code": "-50005", "msg": "illegal gen_time", "desc": {...} }` |

### 4.3 `sign_token` 算法（⛔ 最容易写错的一处）

```js
import { createHmac } from 'node:crypto';

/**
 * 极验 v4 签名：**key = captcha_key（私钥），message = lot_number（流水号）**。
 * ⛔ 反过来（key=lot_number, message=captcha_key）会 100% 校验失败，
 *    而极验返回的 reason 很含糊，容易白查半天 —— 这行加注释比加测试更值。
 */
export function signToken(lotNumber, captchaKey) {
  return createHmac('sha256', captchaKey).update(lotNumber, 'utf8').digest('hex');
}
```

⚠️ **另一个容易踩的坑**：官方 Node demo 用 `axios({ url, method:'POST', params: datas })`——axios 的 `params` 是拼到 **URL query** 上的，也就是说那份 demo 实际是把 5 个参数放在 query 里 POST 的（Python demo 则是放 body）。**两种极验都接受**，但本文统一为「`captcha_id` 在 URL，其余 5 个在 body」，因为：① 与官方文档的参数表一致；② `sign_token` 不适合进 URL（会进 access log）。

### 4.4 域名与容灾

| 用途 | 域名 |
|---|---|
| 服务端二次校验（主 / 备） | `gcaptcha4.geetest.com` ／ `gcaptcha4.geevisit.com`、`gcaptcha4.gsensebot.com` |
| 浏览器脚本与静态资源（主 / 备） | `static.geetest.com` ／ `static.geevisit.com`，另有 `dn-staticdown.qbox.me` |

极验官方容灾口径（原文要点）：
- **前端 load 异常** → 容灾模式表现 =「初始化失败，验证码一键通过」；
- **后端 validate 异常** → 容灾模式表现 =「validate 请求失败，**默认 result 成功**，登录不受影响」。

⛔ **极验自己在 FAQ 里点破了一个常见误解**：前端异常时生成的 `pass_token` 是**本地伪造**的，只要服务端 `validate` 还通，二次校验就会返回 `pass_token error` → **「一键通过」并不等于真能登录**。所以容灾真正放行的**只有一个场景**：服务端 `validate` 也坏了。§9.1 的矩阵把这件事摊开。

### 4.5 极验侧错误码（服务端）

请求层异常（HTTP 非 200 或 body 带 `status:"error"`）的 `code` 是**负数字符串**（如 `-50005` illegal `gen_time`）。⚠️ 我们的审计与日志**可以**记这个 code，但 ⛔ **不得**把它直接放进对外响应（`docs/api.md` §0 的响应体极简原则：对外只有 `error.code` 白名单内的值）。

---

## 5. 后端改动清单（逐文件）

| # | 文件 | 动作 | 要点 |
|---|---|---|---|
| 1 | `server/src/utils/geetest.js` | **新增** | 纯函数：`signToken()`、`buildValidateUrl()`、`buildValidateBody()`、`parseValidateResponse()`。⛔ 零网络、零 Redis → 可纯单测 |
| 2 | `server/src/services/captcha/providers/geetest.provider.js` | **新增** | `name='geetest'`；`isConfigured()`；`issueChallenge()` 只返回公开配置（不回答案，因为没有答案）；`verifyChallenge()` 调 `/validate` 并归一化结果 |
| 3 | `server/src/services/captcha/providers/slider.provider.js` | **新增（迁移）** | 把 `captcha.service.js` 里 `issueChallenge`/`verifyChallenge` 的滑块实现**原样搬过来**（含 Redis 写入、`maxAttempts`、审计） |
| 4 | `server/src/services/captcha/providers/index.js` | **新增** | 工厂：按 `config.security.captcha.provider` 返回实例；未知值 → 启动期错误（C12） |
| 5 | `server/src/services/captcha.service.js` | **改** | 保留策略/计数/闸门/token；`issueChallenge`/`verifyChallenge` 改为**委托** provider；`verifyChallenge` 增加「provider 不可用」分支（§9） |
| 6 | `server/src/routes/auth.js` | **改** | 两个端点的 body/response schema **按 provider 分支构造**；`/captcha/verify` 的 `unavailable` 分支映射为 `captcha_unavailable`(503) 或按 C13 放行 |
| 7 | `server/src/config/index.js` | **改** | `security.captcha` 增加 `provider`/`geetest.{captchaId,captchaKey,apiServer,timeoutMs,failMode,product,language}`；**新增启动期校验**（§8.1） |
| 8 | `server/.env.example` | **改** | 新增 8 个变量并写清「哪种 provider 需要哪些」 |
| 9 | `server/src/utils/errors.js` | **改** | 新增 `captcha_unavailable`(503)（C14） |
| 10 | `server/src/utils/redisKeys.js` | **改** | 仅注释：`captcha:` 前缀标注「仅 slider provider 使用」；`TTL_S.captcha` 不变（仍是一次性凭证的 TTL） |
| 11 | `server/src/services/settings.service.js` | **不改** | `enabled`/`after_failures` 两个 key 不变；`provider` ⛔ **不进 settings**（C12 理由见 §8.2） |
| 12 | `server/src/services/auth.service.js` | **不改** | login 的调用面（`requireForLogin`/`assertLoginToken`/`consumeLoginToken`/`bumpLoginFailure`）**签名不变** |
| 13 | `server/test/slider.test.js` | **不改** | `utils/slider.js` 原样保留 |
| 14 | `server/test/geetest.test.js` | **新增** | `utils/geetest.js` 纯函数单测（签名向量、响应解析、异常形状） |
| 15 | `server/test/auth.captcha.geetest.test.js` | **新增** | 集成用例 AC-G1…AC-G12，**注入 fake `fetch`**（⛔ 测试绝不真连极验） |
| 16 | `server/test/auth.captcha.test.js` | **改** | 全部改成 `provider='slider'` 下运行（若 C12 选 G1-a 则文件保留；若选 G1-b 则随实现删除） |

### 5.1 为什么不引 npm 包

- 官方**没有** v4 的 Node 服务端 SDK，只有各语言 demo（手动 HMAC + 一次 HTTP POST）。我们要写的核心代码不到 60 行。
- npm 上的 `geetest` 包最新版 `4.1.2` 发布于 **2017-05**，依赖已废弃的 `request@^2.54`（`docs/slider-captcha.md` §2.1 已记录）。
- Node ≥22（`server/package.json` 的 `engines`）自带全局 `fetch`（undici），超时用 `AbortSignal.timeout(ms)` → **零新增依赖**。这与仓库「依赖越少越好」的取向一致，也与自研 TOTP、自建滑块的取向一致。

### 5.2 `verifyChallenge` 的两种失败必须分开

```js
// providers/geetest.provider.js 的返回（示例）
{ ok: false, reason: 'validate_failed', vendorReason: 'pass_token expire' }  // ← 用户/伪造者没通过
{ ok: false, reason: 'unavailable', unavailable: true, httpStatus: null }   // ← 极验/网络不可用
```

⛔ 把两者混为一谈的直接后果见 §9.4 教训一。

---

## 6. 端点契约差异（`api.md` §4.1 要改的地方）

### 6.1 `POST /api/v1/auth/captcha/challenge`

| 项 | `provider=selfbuilt`（现状） | `provider=geetest` |
|---|---|---|
| 请求体 | 无 | 无 |
| 限流 / 开关 | `ratelimit:captcha:<ip>`；`enabled=false` → 404 | 同 |
| 成功响应 | `{captcha_id, bg_svg, piece_svg, width, height, expires_in}` | `{provider:'geetest', captcha_id, product:'popup', language}`（✅ C16：`product` 默认 `popup` = **官方按钮 + 验证弹窗**） |

⚠️ geetest 分支**没有 `expires_in`**：题目由极验云端管理，我们没有可承诺的有效期（真正的 TTL 是我们自己发的一次性凭证，它出现在 `/captcha/verify` 的响应里）。
✅ 两个分支都带 `provider` 字段（便于前端与排障），值为 `'slider'` / `'geetest'`。⚠️ 这会在自建分支上**新增一个字段**，属未发布代码的契约微调，可接受。

### 6.2 `POST /api/v1/auth/captcha/verify`

| 项 | `provider=selfbuilt`（现状） | `provider=geetest` |
|---|---|---|
| 请求体 | `{captcha_id, x, y?, track}` | `{lot_number, captcha_output, pass_token, gen_time}` |
| ⛔ 是否收 `captcha_id` | 是（题目 id） | **否**——服务端用自己的配置值。⛔ 不让客户端指定 `captcha_id`，否则等于把「用哪个验证 id」交给调用方 |
| 成功响应 | `{captcha_token, expires_in:120}` | **同** |
| 失败 | 400 `captcha_invalid`，`details.reason` ∈ `mismatch`/`track_suspicious`/`expired`/`not_found`/`too_many_attempts` | 400 `captcha_invalid`，`details.reason` ∈ `validate_failed`（`details.vendor_reason` 附极验原文）/`unavailable`（503，见 C13） |
| 审计 | `auth.captcha_failed`（`reason` + 可选 `delta_px`） | `auth.captcha_failed`（`reason` + `vendor_reason` + 可选 `vendor_code`）；⛔ **不记** `pass_token`/`captcha_output`/`lot_number` |

⚠️ **`details.reason` 枚举变了**：自建版的 `mismatch`/`track_suspicious`/`too_many_attempts` 在极验下**不存在**。前端 i18n 需要新增键、旧键保留（自建分支仍用）。`api.md` §4.1 的枚举表与 §6.2 用例 17/18 需要按 provider 分列。

### 6.3 `POST /api/v1/auth/login`

✅ **请求体与响应体零改动**（`captcha_token` 仍是可选字段）。这正是 §3.4 保两步契约换来的好处。

---

## 7. 前端改动清单

> ✅ **已落地（S8，2026-10-03）**：`web/src/utils/geetest.ts`（`gt4.js` 装载器）、
> `web/src/components/GeetestCaptcha.vue`、`Login.vue` 接入、`api/private.ts` 的双提供方类型、i18n。
> 本节仍是**验收依据**（逐条口径未改）；落地要点与偏差见 **§16.7**。

### 7.1 `gt4.js` 的引入方式（C15）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **(a) 动态注入** ✅ **已采纳（S8）** | `Login.vue` `onMounted` → 先 `POST /captcha/challenge`，若 `provider==='geetest'` 再往 `document.head` 注入 `https://static.geetest.com/v4/gt4.js`，`onload` 后 `initGeetest4` | **`provider≠geetest` 或验证码关闭时零外链**；`captcha_id` 从服务端拿 → 换部署不用重构建前端 | 略偏离官方「页面加载时初始化」（见下） |
| (b) 静态 `<script>` | 写在 `web/index.html` | 最贴合官方要求（行为采集最早开始） | 只要页面打开就加载第三方脚本，**即使验证码已被关闭**；`captcha_id` 仍需运行时获取 |
| (c) 自托管 loader | 把 `gt4.js` 拷进 `web/public/` | 少一跳、可做 SRI | ⛔ loader 仍会动态拉取极验 CDN 的真实库 → 依赖没消失，且**我们自托管的版本会过期**（极验靠更新 JS 对抗新型破解），反而更弱 |

**推荐 (a)**，并说明取舍：官方担心的是「等到用户点击才初始化 → 采不到页面行为数据」。方案 (a) 在 `onMounted`（页面加载后立刻）就完成初始化，**不是**等点击，因此不触发该问题；换来的「关闭时零外链」对一个自托管产品更重要。

### 7.2 `Login.vue` 的接入点（现有结构**不动**）

| 现有分支 | 变更 |
|---|---|
| `onMounted` | ➕ 调 `captchaChallenge()`；`provider==='geetest'` → 注入 gt4.js → `initGeetest4` → 回调里 `appendTo('#vantage-captcha-slot')`（**隐藏容器**）→ 保存 `captchaObj`（绑定 `onReady`/`onSuccess`/`onError`/`onClose`/`onFail`） |
| 401 且 `details.captcha_required===true` | **显示容器**（`captchaRequired=true`）→ 登录表单里**就地出现极验官方按钮**；⛔ 不再挂载自家滑块组件；保留已填密码用户名 |
| 400 `captcha_required`（兜底路径） | 同 |
| 用户点击官方按钮 | 极验自己出题 / 交互 / 判定 → `onSuccess` 触发 |
| `onSuccess` | `captchaObj.getValidate()` → **先判 `false`**（见 §7.5 坑一）→ `captchaVerify(validate)` → 自动重提登录 |
| `captcha_invalid` | 展示服务端消息；**按钮保持可见**允许重试；若需重新验证则先 `reset()`（见 §7.5 坑二） |
| `401 invalid_credentials`（密码又错） | ⚠️ 一次性凭证未被消费 → 应**直接再提交**，⛔ 不要要求用户再点一次验证（§2 第 6 条）；若凭证已过期（>120s）→ 先 `reset()` 再让用户点按钮 |
| 首次进入页面 | ⛔ **按钮不可见**：DOM 在第 ③ 步已生成，但容器 `v-show="false"`（见 §7.3） |

### 7.3 `product` 取值与「官方按钮怎么出现」（✅ C16 已定）

✅ **已定（Owner 2026-10-03）：用极验的官方按钮。** 因此 `product` 取 **`popup`**（备选 `float`），⛔ **不用 `bind`**。

⚠️ 本文初稿曾建议 `bind`（隐藏按钮式）+ `showCaptcha()`，理由是"别在首次登录就露出验证入口"。**该建议已被推翻**——Owner 要的正是那个官方按钮的观感。改法不是放弃「首次零摩擦」，而是**先把按钮藏起来、到需要时再显示**。

| `product` | 表现 | 结论 |
|---|---|---|
| **`popup`** ✅ 已定 | `appendTo()` 后在宿主页渲染**官方按钮**；点击后弹出**带遮罩的**验证窗 | 观感最"产品级"，遮罩能挡误操作 |
| `float` | 同上，但二级验证是**浮动层**（无遮罩） | 可用；比 `popup` 轻，切换只需改 env（⛔ 不用改前端代码） |
| ⛔ `bind` | **不渲染按钮**，`appendTo()` 无效，只能靠 `showCaptcha()` 唤起 | 与已定需求相反，**不用** |

**实现方式（同时满足官方要求与 §2 第 1 条）**：

1. `onMounted` 就 `initGeetest4` —— 满足官方「行为验证要求初始化在业务页面加载时同时初始化」，行为数据从页面打开即开始采集；
2. 在 `initGeetest4` 回调里**照官方 demo 的写法立刻 `appendTo('#vantage-captcha-slot')`** —— 官方按钮的 DOM 此时生成；
3. 但该 slot 容器默认 **`v-show="false"`** → 用户首次登录**看不到任何东西**；
4. 密码错一次后（401 带 `details.captcha_required` / 400 `captcha_required`）→ `captchaRequired=true` → 容器可见 → **官方按钮就出现在登录表单里**；
5. 用户点按钮 → 极验弹窗 → 通过 → `onSuccess` → 我们 `captchaVerify()` → 自动重提登录。

🔑 **为什么不"等需要时再 `appendTo`"**：官方只说明 `appendTo` 把按钮插入宿主页面，**没说可以晚调**；而"页面加载时初始化"是官方明确要求。**初始化与 `appendTo` 都在加载时完成、只用 CSS 控制可见性**，是唯一既满足官方要求、又不违反「首次不出现」的组合。
⚠️ **代价要说清楚**：官方按钮的 DOM 从页面加载起就存在于登录页 —— 对爬虫/自动化工具而言，「这个页面用了极验」是可探测的。可接受：这不是秘密。

⚠️ **必须在真机核对的点（§10.3 第 2 条）**：容器从隐藏切到可见后，官方按钮与验证弹窗是否正常渲染与定位（尤其 `popup` 的遮罩层）。若 `display:none` 导致极验内部尺寸计算异常，退路有两条：① 容器改用「`visibility:hidden` + 不占位」；② 直接 `v-if` 挂载/卸载 slot 并在显示时重新 `appendTo`。

### 7.4 i18n（`web/src/locales/{zh-CN,en-US}.ts`）

⚠️ 一个必须接受的事实：**极验验证窗内的文案不受我们的 i18n 控制**。我们只能通过 `language` 参数（`zho`/`eng`/…）让极验自己切，且**图片上的文字不随语言变**。因此：

| 类别 | key | 处理 |
|---|---|---|
| 保留 | `captcha.loading`、`captcha.unavailable`、`captcha.verified`、`captcha.required`、`error.captcha_required`、`error.captcha_invalid` | 复用 |
| 新增 | `error.captcha_unavailable`、`captcha.vendorFailed`、`captcha.closed`（用户关掉验证窗的提示） | 新增 |
| 前端失效（自建分支仍用） | `captcha.hint`、`captcha.retry`、`captcha.refresh`、`captcha.expired`、`captcha.failed`、`captcha.suspicious`、`captcha.tooManyAttempts` | 保留不动，geetest 分支不引用 |

⚠️ 错误码 key 的实际命名是 **`error.*`（单数）**，不是 `errors.*`（`slider-captcha-selfbuilt.md` §7.4 已更正过一次，此处保持一致）。

### 7.5 前端已知坑（⛔ 逐条对照检查）

**坑一（最像 hzgrzy 那次事故的一个）**：`getValidate()` 在**未成功验证时返回 `false`**。若前端写成 `const v = captchaObj.getValidate(); captchaVerify(v)`，未成功时会提交 `{lot_number: undefined, ...}` → 服务端 400 `schema_invalid`，用户看到的却是「验证失败」，永远过不去。
➡️ 必须：`if (v === false) { 提示并 return; }`。
（对照：hzgrzy 的 `ArticleDetail.vue` 降级时传 `{}`，导致 `data.captcha` 根本没设置 → 文章评论**永远** 400「请完成行为验证」。同一类错误。）

**坑二**：⚠️ **不要在 `onSuccess` 之后就 `reset()`**。官方的 `reset()` 文档把「验证成功但用户名密码错误」列为典型场景，看起来正好对应我们的流程——**对我们恰恰是反的**：我们的设计是「验证通过 → 发一次性 `captcha_token`（120s 内可复用）→ 密码错也不消费 → 直接重提」，用户**不需要**重新验证（§2 第 6 条）。若在 `onSuccess` 后立刻 `reset()`，前端会退回"未验证"态 → 用户再点登录时 `getValidate()` 返回 `false`（撞上坑一）→ 明明刚验证过却提交不了。
➡️ 正确时机：**只在"确实需要用户重新验证"时才 `reset()`** —— ① 我们的 `captcha_token` 已过期或被拒（400 `captcha_invalid`）且策略仍要求验证；② 用户关闭了验证窗（`onClose`）后想重来。

**坑三**：`onError` 的 `error.code` 是**极验自己的错误码**（如 `60000` 用户配置错误），⛔ 不要与我们的 `error.code` 混用，也不要直接展示给用户（文案用 `captcha.vendorFailed`）。

**坑四**：`onClose`（用户关掉验证窗）必须提示，否则用户关闭后点登录无反应，看起来像卡死。

**坑五**：`captcha_id` ⛔ **不要**写进前端构建期 env（`VITE_GEETEST_CAPTCHA_ID`）——那样每个部署都要重新构建前端产物，而 `/captcha/challenge` 已经能下发它。

---

## 8. 配置与运行前提

### 8.1 环境变量（`server/src/config/index.js` + `server/.env.example`）

| 变量 | 默认 | 范围 / 取值 | 说明 |
|---|---|---|---|
| `CAPTCHA_PROVIDER` | **`geetest`**（✅ C12 已定 = G1-a） | `geetest` \| `selfbuilt` \| `none` | 提供方。`selfbuilt` = 自建滑块（S1–S4，零外部依赖，内网/离线部署用）；`none` = 整条链路不生效（等同 `enabled=false`）。⚠️ **默认值由 `selfbuilt` 改为 `geetest`** → 既有部署升级到本版本时会因缺密钥而**启动失败**，这是刻意的（见下方启动期校验），运维必须显式选择：配极验密钥，或改回 `selfbuilt`/`none` |
| `GEETEST_CAPTCHA_ID` | — | 32 位 hex | 极验后台获取；**公开**（会下发给前端） |
| `GEETEST_CAPTCHA_KEY` | — | 32 位 hex | ⛔ **机密**，只出现在服务端 |
| `GEETEST_API_SERVER` | `gcaptcha4.geetest.com` | 域名 | 留出切备用域名的能力（§4.4） |
| `GEETEST_TIMEOUT_MS` | `3000` | 500–10000 | 二次校验超时。⚠️ 官方 demo 用 5000；本文建议 3000，因为闸门在验密之前，超时直接体现为登录卡顿 |
| `GEETEST_FAIL_MODE` | **`open`**（✅ C13 已定） | `open` \| `closed` | 极验不可达时放行还是拒绝，见 §9。⛔ 选 `open` 的**连带义务**：§9.3 第 1/2/4 项必须一起实现——`open` 意味着故障时用户**看不到任何异常**，唯一的可见性就是审计与 error 日志 |
| `GEETEST_PRODUCT` | **`popup`**（✅ C16 已定 = 官方按钮） | `popup` \| `float` | 通过 challenge 响应下发给前端。⛔ 不接受 `bind`（渲染不出官方按钮，见 §7.3）；`popup` ↔ `float` 互切**不需要改前端代码** |
| `GEETEST_LANGUAGE` | `zho` | 见 §7.4 | 由服务端按面板 locale 下发，避免前端硬编码 |

✅ **新增启动期校验（⛔ 这一条是本方案最重要的防呆）**：

```js
if (provider === 'geetest') {
  if (!geetest.captchaId || !geetest.captchaKey) {
    errors.push('CAPTCHA_PROVIDER=geetest 时必须同时配置 GEETEST_CAPTCHA_ID 与 GEETEST_CAPTCHA_KEY');
  }
}
```

理由见 §9.4 教训一：**「配了极验但没给密钥」绝不允许变成一个跑得起来、却在运行时静默放行的进程**。宁可启动就失败（`CONFIG_INVALID`，现有报错会指回 `server/.env.example`）。

### 8.2 为什么不把 `provider` 放进 settings 表（C12）

`security.login_captcha.enabled` / `after_failures` 是**运行时策略**（面板可改，30s 缓存，改了立即生效），适合放 settings。`provider` 不同：
1. 它改变的是**信任边界与外部依赖**（是否需要密钥、是否会外联），属于部署决策，不是运行时策略；
2. 它需要凭据，而凭据在 env 里——放 settings 会出现「切到 geetest 但密钥没配」的中间态；
3. 省掉一个白名单 key 就省掉一次 `docs/api.md` §4.10 + `docs/database.md` §5.4 + 前端设置页的联动改动。
➡️ **`provider` 走 env（改要重启）**。⚠️ 代价：切换/回滚需要重启进程（§13 给出不停机的回滚路径）。

### 8.3 极验后台准备工作（Owner 执行）

1. 注册极验账号 → 创建「行为验证第四代」应用 → 取得 `captcha_id` 与 `captcha_key`。
2. **报备调用域名**（`referer` 校验）：面板域名与端口必须一致，否则线上会直接 `result: fail`。
3. 确认套餐量级与 QPS 上限（免费版有限制）。
4. 若需要验证宕机容灾，需**联系极验开启容灾测试**（官方文档明确要求）——否则无法真实验证 §9.1 的场景 C/D。

### 8.4 Redis 键空间变化（`docs/database.md` §7）

| 键 | 自建 | geetest | 说明 |
|---|---|---|---|
| `captcha:<captcha_id>` | ✅ 用 | ⛔ **不用** | 极验不出题给服务端存，没有答案可存 |
| `captcha:ok:<token>` | ✅ | ✅ | 不变（值 = 解出验证的 IP，TTL 120s） |
| `login:fail:ip:<ip>` | ✅ | ✅ | 不变 |
| `login:fail:acct:<hash>` | ✅ | ✅ | 不变 |
| `ratelimit:captcha:<ip>` | ✅ | ✅ **更重要** | geetest 下 `/captcha/verify` 会对外发请求，此桶同时是**外呼放大器**的闸门 |
| `captcha:vendor:down` | — | ➕ 建议（C19） | 极验不可达后的短时熔断标记（TTL 30s），避免每次登录都干等 3s 超时 |

### 8.5 网络放行与连通性自检（可直接复制）

**必须放行的域名**（服务端出口 + 浏览器出口都要）：

```
gcaptcha4.geetest.com    gcaptcha4.geevisit.com    gcaptcha4.gsensebot.com
static.geetest.com       static.geevisit.com       dn-staticdown.qbox.me
```

**服务端连通性自检**（PowerShell，拷贝即用）：

```powershell
# 1) DNS + TCP 443 可达
Test-NetConnection gcaptcha4.geetest.com -Port 443

# 2) 验签跑通（用你自己的 captcha_key 替换；期望输出 64 位 hex）
node -e "const c=require('crypto');console.log(c.createHmac('sha256',process.argv[1]).update('test_lot_number','utf8').digest('hex'))" "你的_GEETEST_CAPTCHA_KEY"
```

**浏览器侧自检**：登录页 F12 → Network → 过滤 `geetest`。应能看到 `gt4.js` 与后续验证库资源全部 200；若被拦，就是 §9.1 场景 B。

---

## 9. 失败模式决策（✅ C13 已定 = `open`；本节保留完整论证，供回看与「将来切 `closed`」时参考）

### 9.1 场景矩阵

| # | 场景 | 浏览器侧表现 | 服务端 `validate` | 按极验官方默认的最终结果 | 备注 |
|---|---|---|---|---|---|
| A | 一切正常 | 正常出题 | 可达 | `success` → 通过；`fail` → 拒绝 | 预期路径 |
| **B** | **浏览器 ↔ 极验不通**（内网、CDN 被拦、DNS 污染） | 初始化失败 → **一键通过**（伪造本地 `pass_token`） | **可达** → `fail`（`pass_token error`） | ⛔ **用户无法登录** | 🔥 **最贵的坑**：前端看似"通过了"，服务端却拒；报错文案是「人机验证未通过」，会被误判成 Vantage 的 bug |
| C | 服务端 ↔ 极验不通 | 前端正常（或也失败） | 请求异常 / 非 200 | ✅ **放行**（fail-open，官方口径） | C13 要拍板的场景 |
| D | 两端都不通 | 一键通过 | 异常 | ✅ 放行（B 的伪造 token 无人校验） | 等价于「人机验证这一层不存在」 |
| E | `provider=geetest` 但未配密钥 | — | 不发出请求 | ⛔ **本文要求：启动即拒绝**（§8.1） | 见 §9.4 教训一 |
| F | 用户真的没通过验证 | `onFail`/`onError` | 可达 → `fail` | 400 `captcha_invalid` | 预期路径 |

### 9.2 fail-open vs fail-closed 的论证

| | fail-open（放行） | fail-closed（拒绝） |
|---|---|---|
| 安全性 | 极验坏掉时**人机验证层整体消失**，只剩登录限流 + Argon2 + TOTP + 审计 | 该层始终有效 |
| 可用性 | 登录不受影响 | ⛔ **极验一坏，全员登录不了** |
| 对 Vantage 的具体后果 | 故障期间攻击者少一层摩擦（但仍受 10 次/300s 限流约束） | ⛔ **运维在故障期间进不去自己的监控面板**——而监控面板最需要被访问的时刻，恰恰是系统出问题的时候 |
| 官方口径 | ✅ 极验明确要求（「保证不会因为接口请求超时或服务未响应而阻碍业务流程」） | 与官方口径相反 |
| 与自建版一致性 | ❌ 自建版是 fail-closed | ✅ 一致 |

🔑 **✅ 已采纳（C13，2026-10-03）：`failMode` 默认 `open`（fail-open）**，理由：

1. **故障相关性**：Vantage 是**监控系统**。极验不可达与前端的网络故障、上游故障高度相关——正是运维需要登录排查的时刻。把人机验证做成「故障时自锁门」是方向性错误。
2. **backstop 仍然存在**：即使这一层失效，攻击者面对的仍是 `ratelimit:login:<ip>`（10 次/300s）+ Argon2id（19MiB/次）+ TOTP + 全量审计。人机验证本来就是**补充层**，不是身份边界（`slider-captcha.md` §2 已明确这一取向）。
3. **窗口很窄**：由 §4.4，只有**服务端 `validate` 也坏**才真正放行（场景 B 并不会被放行）。这是一个「极验整体不可用」的窄窗口，不是「前端被拦就能绕过」。
4. **提供 `closed` 开关**：高安全部署可以自己承担可用性风险。

⚠️ **同时必须写进文档、且不能对外美化的话**：默认 `open` 意味着**「极验不可达 = 人机验证这一层不存在」**。⛔ 不要在任何对外材料里把它描述成「始终生效的人机验证」。

### 9.3 fail-open 的连带义务（C13 选 `open` 后，第 1/2/4 项**必做**；第 3/5 项见 C19）

🔑 为什么 1/2/4 是**必做**而不是「建议」：`open` 的语义是「极验坏了也让人登进去」，而它的**副作用是故障对用户完全不可见**——用户照常登录成功，没有任何提示。也就是说，**如果我们不主动记审计、不打 error 日志，就没人会知道这一层曾经失效过**。这不是可选优化，是选 `open` 的前提条件。

1. ✅ **必做 · 审计**：新增 `auth.captcha_unavailable`（`detail`: `{ http_status?, vendor_code?, elapsed_ms, fail_mode }`）。⛔ 不记原始响应体（可能含 `user_ip`/`referer`）。
2. ✅ **必做 · `logger.error`**：极验不可达是 P2 级事件，必须能在日志里一眼看到。
3. **短时熔断（C19，建议）**：首次失败后写 `captcha:vendor:down`（TTL 30s）；期间 `/captcha/verify` 直接返回 `unavailable`，不再等 3s 超时。否则极验挂掉时**每次登录都要干等超时**，体验比拒绝登录还糟。
4. ✅ **必做 · 超时预算**：`GEETEST_TIMEOUT_MS=3000`，且 ⛔ **不重试**（重试会把 3s 变成 6s/9s，并把请求量翻倍打到已经出问题的极验上）。
5. **并发上限（C19，建议）**：`/captcha/verify` 是全站唯一对外发起请求的匿名端点。`ratelimit:captcha:<ip>` 挡不住分布在多个 IP 的调用方 → 建议加**进程级出站并发信号量**（如 32），超限直接 `unavailable`。

### 9.4 两条不能犯的错

**教训一：⛔ 绝不允许「未配置/不可用」被静默当成「验证通过」。**
前车之鉴（另一项目的真实事故）：代码写成「先 `if (!captcha) return 400`，再 `geetest.verify()`」，而 `verify()` 在**未配置时直接放行** → 两道判断自相矛盾；`.env` 里密钥为空时，前端降级传的对象过不了第一道检查 → 该功能**永久 400**，排查很久才发现根因是「未配置」这一状态被两处按相反方向解释。
本方案的对应防线：
- `isConfigured()===false` 时 → 出题端点 **404**（与 `enabled=false` 同口径），**登录永不因验证被拒**；
- `provider=geetest` 却缺密钥 → **启动即 `CONFIG_INVALID`**（§8.1），连跑都跑不起来；
- `verifyChallenge()` 的 `unavailable` 与 `ok:false` **是两个不同的返回分支**（§5.2），由编排层显式按 `failMode` 处理。
➡️ 一句话：**「读不到/连不上」必须在类型上就不可能被误读成「通过」。**

**教训二：⛔ 前端不得自行判定对错。**
与自建版同一条（`api.md` §4.1）：前端「显示成功」不等于通过。极验的 `onSuccess` 也必须经服务端 `/validate` 才能算数（这正是 §4.4 场景 B 的教育意义——前端"一键通过"在服务端会被拒）。⛔ 不许为了「让内网用户能登录」而在前端加放行分支：那等于把验证码变成装饰品。

---

## 10. 测试与验收

### 10.1 单元测试（`server/test/geetest.test.js`，零网络）

| 用例 | 断言 |
|---|---|
| 签名向量 | `signToken('abc', 'k')` 与独立计算的 `createHmac('sha256','k').update('abc').digest('hex')` 相等；⛔ key/message 写反时**不相等**（防止未来有人"顺手"调换参数） |
| URL 拼装 | `captcha_id` 在 query，其余 5 个在 body |
| 响应解析（成功） | `{result:'success'}` → `{ok:true}` |
| 响应解析（校验失败） | `{result:'fail', reason:'pass_token expire'}` → `{ok:false, reason:'validate_failed', vendorReason:'pass_token expire'}` |
| 响应解析（请求异常形状） | `{status:'error', code:'-50005', msg:'illegal gen_time'}` → **`unavailable:true`**（⛔ 不可当成 `validate_failed`，否则审计与 fail-mode 全错） |
| 响应解析（脏数据） | `null` / `''` / 非 JSON / 缺 `result` → `unavailable:true`，⛔ 不抛到 500 |

### 10.2 集成用例（`server/test/auth.captcha.geetest.test.js`）

夹具沿用 `auth.2fa.test.js` 的思路：真 PGlite + `buildApp` + `fake-redis-hash` + `app.inject()`，**外加注入 `fetchImpl`**（⛔ 测试绝不真连极验）。

| # | 用例 | 期望 |
|---|---|---|
| **AC-G1** | 首次登录（无失败计数）不带任何凭证 | ✅ 200 登录成功；⛔ 全程不出现 `captcha_required`（沿用 §2 第 1 条，**核心断言**） |
| **AC-G2** | 密码错 1 次 | 401 + `details.captcha_required:true`；`login:fail:ip:*` 与 `login:fail:acct:*` 均为 1 |
| **AC-G3** | 失败后再提交且缺凭证 | 400 `captcha_required`（⛔ 不是 401） |
| **AC-G4** | challenge（provider=geetest） | 200 `{provider:'geetest', captcha_id, product, language}`；⛔ 响应里**没有** `bg_svg`/`piece_svg` |
| **AC-G5** | verify：极验 `success` | 200 `{captcha_token, expires_in}`；`captcha:ok:<token>` 已写入且值 = 本次 IP |
| **AC-G6** | verify：极验 `fail` | 400 `captcha_invalid`（`details.reason='validate_failed'`）；审计 `auth.captcha_failed` 一条；⛔ 响应不含 `pass_token` |
| **AC-G7** | verify：`fetch` 抛错（断网）且 `failMode=open` | 200 + 发放 token；审计 `auth.captcha_unavailable` 一条 |
| **AC-G8** | 同上但 `failMode=closed` | 503 `captcha_unavailable` |
| **AC-G9** | verify：极验返回 HTTP 500 / 非 JSON | 同 AC-G7（按 `unavailable` 处理，⛔ 不是 `validate_failed`） |
| **AC-G10** | 同一 `captcha_token` 登录成功后再次使用 | 400 `captcha_invalid`（一次性） |
| **AC-G11** | 换 IP 用同一 `captcha_token` | 400 `captcha_invalid`（token 绑定 IP） |
| **AC-G12** | `provider=geetest` 但缺 `GEETEST_CAPTCHA_KEY` | 启动期 `CONFIG_INVALID`（⛔ 不是"跑起来后静默放行"） |

**沿用（provider 无关，`auth.captcha.test.js` 已覆盖，⛔ 换提供方后必须仍全绿）**：自建版 AC-1（首次登录免验证）、AC-2（失败计数）、AC-3（缺凭证 400）、AC-5（token 一次性）、AC-11（绑定 IP）、AC-12（代理池按账号计数）、AC-13（`enabled=false` 时出题 404 + 登录行为与接入前逐字节相同）。

**作废（仅自建语义）**：自建版 AC-4/6/7/8/9/10（题目比对、容差、轨迹、`too_many_attempts`、题目过期）——它们随 `provider=selfbuilt` 保留在 `auth.captcha.test.js` 里，**不迁移**。

### 10.3 手工验收（Owner，真机）

1. 全新部署、`provider=geetest`、密钥齐备 → 首次登录**看不到极验按钮**（⚠️ 同时开 F12 确认 `gt4.js` 已加载、`initGeetest4` 已成功、slot 里已有 DOM —— 按钮只是被 CSS 藏起来了，见 §7.3。若这里连 DOM 都没有，说明实现退回了"晚 appendTo"，与官方要求不符）。
2. 故意输错一次密码 → **登录表单里就地出现极验官方按钮**（不用重输密码、不用刷新）；**点击该按钮** → 弹出官方验证窗 → 通过后自动重提登录。
3. 完成验证 → 自动重提登录 → 进入面板。
4. 验证通过后**再故意输错密码** → ⛔ **不应要求重新验证**（凭证未被消费，§2 第 6 条）；直接重提即可。若这里又要用户点一遍验证，说明凭证被提前消费了、或前端在 `onSuccess` 里误调了 `reset()`（§7.5 坑二）。
5. 连错 10 次触发登录限流 → 429 + `Retry-After`（与验证码层互不干扰）。
6. `security.login_captcha.enabled=false` → 登录响应与未接入验证码时**逐字节相同**；`/captcha/challenge` 返回 404。
7. 内网模拟场景 B：在浏览器侧屏蔽 `static.geetest.com` → 观察现象是否为「点登录无反应/提示验证失败且永远过不去」，**并与本文 §9.1 场景 B 的描述核对**（这条是为了确认我们对容灾行为的理解与线上一致）。

---

## 11. 实施分块（S5–S9）

| 块 | 内容 | 验收 | 预估 |
|---|---|---|---|
| **S5** | `utils/geetest.js` 纯函数 + `test/geetest.test.js` | §10.1 全绿 | 0.5 天 |
| **S6** | provider 抽象重构：`providers/{index,slider.provider,geetest.provider}.js` + `captcha.service.js` 委托化 | ⛔ **既有 `auth.captcha.test.js` 在 `provider=selfbuilt` 下必须全绿**（纯重构，零行为变化） | 1 天 |
| **S7** | 路由 schema 分支 + 配置/`.env.example` + `captcha_unavailable` + 启动期校验 + 审计/熔断 | §10.2 AC-G1…AC-G12 | 1 天 |
| **S8** | 前端：`GeetestCaptcha.vue` + `Login.vue` 接入 + i18n | §7.5 五坑逐条核对；登录页真机联调 | ✅ 已落地（2026-10-03，见 §16.7；⏳ 真机联调仍待 Owner） |
| **S9** | 文档回填（§14）+ Owner 真机验收（§10.3 + 极验后台报备） | 验收清单全过 | 0.5 天 |

⚠️ **S6 的顺序不能颠倒**：先把自建实现搬进 provider 并保证既有测试全绿（纯重构），再加极验。反过来做，一旦回归失败就分不清是「重构坏了」还是「极验接错了」。

---

## 12. 开放决策（C12–C19）

| # | 决策 | 本文建议 | 影响 |
|---|---|---|---|
| ~~**C12**~~ | ~~提供方策略：**G1-a** 加 provider 开关，极验为默认、自建保留为可选项；**G1-b** 彻底替换（删除自建代码）~~ | ✅ **已定（2026-10-03）= G1-a**：新增 `CAPTCHA_PROVIDER`，默认 `geetest`；自建滑块保留为可选 provider，`utils/slider.js`、`SliderCaptcha.vue`、`test/slider.test.js`、`test/auth.captcha.test.js` **全部保留** | 已生效：§5 第 3/13/16 项保留；`CAPTCHA_PROVIDER` 默认 `geetest`（§8.1） |
| ~~**C13**~~ | ~~极验不可达时：放行 or 拒绝（`GEETEST_FAIL_MODE` 默认值）~~ | ✅ **已定（2026-10-03）= `open`**（§9.2）；§9.3 第 1/2/4 项随之升为**必做**，高安全部署可自行切 `closed` | 已生效：§8.1 的 `GEETEST_FAIL_MODE` 默认 `open`；`captcha_unavailable`(503) 默认**不出现**（只在 `closed` 下出现） |
| **C14** | `/captcha/verify` 在 `failMode=closed` 下的错误码 | 新增 `captcha_unavailable`(503)。⚠️ 注意 `errors.js` 的 `expose` 规则：**5xx 的 message 会被折叠成「服务内部错误」**，`details` 不下发 → 前端必须按 **`error.code`** 匹配文案，不能依赖 message | `errors.js` + `api.md` §1.3（26→27 条）+ 前端 i18n |
| **C15** | `gt4.js` 引入方式 | 动态注入（§7.1 方案 a） | 决定「关闭时是否仍外链」 |
| ~~**C16**~~ | ~~`product` / `language` 传参~~ | ✅ **已定（2026-10-03）= 用极验官方按钮**：`product='popup'`（备选 `float`），⛔ 不用 `bind`；按钮 DOM 在页面加载时生成、容器默认隐藏，**密码错后才显示**；`language` 仍由服务端下发跟随面板 locale | 已生效：§8.1 的 `GEETEST_PRODUCT` 默认 `popup`；§7.2/§7.3/§7.5 已重写 |
| **C17** | 是否把用户名通过 `userInfo` 传给极验 | ⛔ **不传**。传了等于把账号交给第三方，且与「登录响应不得携带账号线索」的既有原则冲突 | 隐私面 + 与 §2 第 5 条的一致性 |
| **C18** | 端点形状：保持两步 vs 改为一步 | ✅ **保持两步**（§3.4 四条理由） | 决定 `api.md` §4.1 的改动量与前端接入方式 |
| **C19** | 是否加「极验不可达」短时熔断（`captcha:vendor:down`，TTL 30s）与出站并发上限 | ✅ **建议都加**（§9.3 第 3/5 条） | 决定故障期间的登录延迟 |

---

## 13. 回滚方案

| 场景 | 操作 | 是否需要重启 | 影响面 |
|---|---|---|---|
| 想临时关掉人机验证 | `PATCH` 设置 `security.login_captcha.enabled=false`（或直接改 `settings` 表后删 `settings:cache`） | ❌ 不需要 | 出题端点立即 404；登录行为与未接入验证码时逐字节相同 |
| 极验线上异常，想切回自建 | `.env` 改 `CAPTCHA_PROVIDER=selfbuilt` + 重启 | ✅ 需要 | ⚠️ 前提是 C12 选了 G1-a（保留了自建代码） |
| 极验彻底不可用 | `CAPTCHA_PROVIDER=none` + 重启（等价于 `enabled=false`，但更彻底：不加载任何验证相关路由） | ✅ 需要 | 登录零摩擦；⛔ 人机验证层消失，靠限流 + Argon2 + TOTP 兜底 |
| 回滚前端 | `Login.vue` 恢复引用 `SliderCaptcha.vue` | 需重新构建前端 | 与 `provider=selfbuilt` 配套 |

🔑 若 C12 选 **G1-b（彻底替换）**，则上表第 2 行不存在——**回滚只剩「关掉」和「完全不要」两档**。这是 G1-b 的真实代价，请一并计入决策。

---

## 14. 文档回填清单（S9）

> ✅ **2026-10-03 已完成「指向 + 状态」与**字面契约**两层回填**（Owner 要求「同时更新相关文档」）：`docs/api.md`（§0 状态列、§1.3 错误码 +1、§4.1 两个端点的**双 provider 逐字段对照**、§4.1.0 人机验证行、§6.2 极验用例段、§7 C 系列）、`docs/database.md`（§7 键表 + `captcha:vendor:down` + 前缀列表）、`docs/frontend.md`（§4.2 人机验证小节）、`docs/slider-captcha.md`（C1 状态）、`docs/slider-captcha-selfbuilt.md`（状态行）。
> ✅ **字面契约已随 S7 并入本文档体系**（双 provider 分支、`details.reason` 新枚举、`captcha_unavailable` 错误码）——`docs/api.md` §4.1 现在描述的是**代码实际行为**。
> 下面清单里**尚未做完**的只有第 3 条的「`frontend.md:103` 公开域措辞」与第 6 条（前端落地后重述），其余已随本轮完成。

1. `docs/api.md`：§0 端点索引的状态列；§1.2 ② CSRF 豁免范围（不变，⛔ 但 `/captcha/verify` 的 body 形状要注明按 provider 分支）；§1.3 错误码总表 **+1**（`captcha_unavailable`，⚠️ 5xx message 折叠规则要写明）；§1.4 限流表（`ratelimit:captcha` 的说明改为「出题/验题 + 对外二次校验的闸门」）；§4.1 两个端点的**双 provider 分支**（§6）；§4.1.1 ④ Redis 键（geetest 下 `captcha:<id>` 不用）、⑦ 落地表新增 S5–S9；§4.10 白名单**不变**（provider 走 env，§8.2）；§6.2 用例 15–18 标注适用 provider；§7 新增 C12–C19。
2. `docs/database.md`：§5.4 白名单**不变**；§7 Redis 键表（`captcha:` 标注仅 selfbuilt；➕ `captcha:vendor:down` 若采纳 C19）；§7 前缀列表补 `captcha:vendor:`。
3. `docs/frontend.md` §4.2：登录页人机验证小节改为「按 `provider` 分支」+ 指向本文 §7；⚠️ **顺带修掉既有问题**：`frontend.md:103` 关于 `/login` 公开域隔离的表述与 `web/src/router/index.ts:89` 的实现矛盾（实际实现是「`isPublicDomain && to.name !== 'login'`」，登录页要走私有客户端才能访问 `/auth/captcha/*`）——本轮已决定**保留代码、修正文档**。
4. `docs/slider-captcha.md`：§2.1 的极验条目更新为「✅ 已采纳（本文）」，C1 标注为「已被 C12 部分取代（自建降级为可选 provider）」；§4/§5/§7 的草案标记改为「已被本文取代」。
5. `docs/slider-captcha-selfbuilt.md`：状态行改为「✅ 已落地，且在 C12=G1-a 下**保留为 `provider=selfbuilt`**；权威契约中与提供方无关的部分（§2 触发语义、§6.4 token 语义、§8.2 设置项、§10.3 的 AC-1/2/3/5/11/12/13）**继续有效**」。
6. `docs/api.md` §4.1 里那句「登录页已联通」的表述：⚠️ 经核对（`Login.vue` 当时仍是骨架）该表述与事实不符，应改为实际状态；本文落地后按 §7 重述。
7. **建议（不属本次范围）**：统一验收用例编号——现在 `slider-captcha-selfbuilt.md` 用 AC-1…AC-13、`api.md` §6.2 用 15–18、本文用 AC-G1…AC-G12，三套并存。建议后续收敛为「`api.md` 为唯一编号源，其他文档只引用」。

---

## 15. 参考资料

- 极验 v4 产品与流程：https://docs.geetest.com/gt4/overview/flowchart
- 极验 v4 服务端部署（含各语言 demo 索引）：https://docs.geetest.com/gt4/deploy/server
- 极验 v4 服务端二次校验 API：https://docs.geetest.com/gt4/apirefer/api/server
- 极验 v4 客户端（Web）部署：https://docs.geetest.com/gt4/deploy/client/web
- 极验 v4 Web API（`initGeetest4` 与实例方法）：https://docs.geetest.com/gt4/apirefer/api/web
- 极验 v4 **业务容灾**（本文 §4.4/§9 的依据）：https://docs.geetest.com/gt4/bypass
- 官方 Node demo：https://github.com/GeeTeam/gt4_node_express_demo ｜ `routes/index.js`（签名 + 异常放行示例）
- 官方多端前端 demo（含 Vue3 分支）：https://github.com/geetestweb/gt4-public-client-demo
- `gt4.js` 资源地址：https://static.geetest.com/v4/gt4.js
- 极验合规指南 / 隐私政策：https://docs.geetest.com/gt4/compliance ｜ https://www.geetest.com/Private/gt4
- 本仓库相关：`docs/slider-captcha.md`（选型，含 `geetest@4.1.2` npm 包状态）、`docs/slider-captcha-selfbuilt.md`（自建实现，现为可选 provider）、`docs/api.md` §4.1、`docs/database.md` §7

---

## 16. 落地记录（2026-10-03，S5–S7）

> ⛔ 本节记的是**代码实际长什么样**。凡与上文设计不一致处，**以本节为准**，并逐条说明为什么改。

### 16.1 新增/改动的文件

| 文件 | 动作 |
|---|---|
| `server/src/utils/geetest.js` | **新增**：签名 / 参数拼装 / 响应解析 / `reason` 清洗（零网络，可纯单测） |
| `server/src/services/captcha/providers/selfbuilt.provider.js` | **新增**：自建滑块的出题与判定（从 `captcha.service.js` **原样迁出**） |
| `server/src/services/captcha/providers/geetest.provider.js` | **新增**：极验二次校验 + 熔断（`fetchImpl` 可注入） |
| `server/src/services/captcha/providers/index.js` | **新增**：按配置选提供方的工厂 + `CaptchaProvider` 接口定义 |
| `server/src/services/captcha.service.js` | **改**：只留编排（策略/闸门/两层计数/一次性凭证/审计），出题与验题改为委托 |
| `server/src/routes/auth.js` | **改**：两个端点的 body/response schema **按提供方在构造期选定**；handler 原样透传 `request.body` |
| `server/src/config/index.js` | **改**：`security.captcha.provider` + `security.captcha.geetest.*` + 启动期校验 + 冻结更新 |
| `server/src/app.js` | **改**：`buildApp` 增加 `fetchImpl` 注入（仅测试用） |
| `server/src/utils/errors.js` | **改**：新增 `captcha_unavailable`(503) |
| `server/src/utils/redisKeys.js` | **改**：新增 `captcha:vendor:down:` 前缀 + `keys.captchaVendorDown()` + `TTL_S.captchaVendorDown = 30` |
| `server/.env.example` | **改**：新增人机验证段（含此前漏登记的 `RATELIMIT_CAPTCHA_PER_MINUTE`） |
| `server/test/geetest.test.js` | **新增**：纯函数单测（含 **RFC 4231 的 HMAC-SHA256 官方向量**） |
| `server/test/auth.captcha.geetest.test.js` | **新增**：AC-G1…AC-G12 + AC-G12b，⛔ 全程打桩 `fetchImpl` |
| `server/test/auth.captcha.test.js` | **改**：显式 `CAPTCHA_PROVIDER: 'selfbuilt'`；取题响应键集合按**意图**更新（加入 `provider`） |

`utils/slider.js`、`web/src/components/SliderCaptcha.vue`、`test/slider.test.js` **未动**（这是 C12 = G1-a 的承诺）。

### 16.2 与本方案的 4 处偏差（⚠️ 第 1 条待 Owner 追认）

**偏差 1（待追认）：`CAPTCHA_PROVIDER` 未设置时是「自动推断」，不是写死 `geetest`。**
- 本文 §8.1 写默认 `geetest`；实现为：**有极验密钥 → `geetest`；没有 → `selfbuilt`；显式写 `geetest` 却缺密钥 → 启动失败**。
- 为什么改：写死默认会让**所有既有部署**（以及 14 个调用 `loadConfig()` 的测试文件）在升级后因缺密钥**直接起不来**。而"没有极验可用"时回退到自建滑块**严格优于**整个服务挂掉 —— 回退之后依然有人机验证。填了密钥（用极验的必要前提）默认就是极验，与 C12 的意图一致。
- ⛔ 保留的硬约束不变：**显式声明 `geetest` 却没有密钥 = 拒绝启动**（`CONFIG_INVALID`）。这是 C12/C13 组合下最重要的一道防呆。

**偏差 2（纯命名统一）：提供方名一律 `selfbuilt`。**
- 本文 §3.2/§3.3/§6.1 里写的 `slider.provider.js` / `name: 'slider'` / `provider:'slider'` **已按实现更正为 `selfbuilt`**，与 `CAPTCHA_PROVIDER` 的取值字面一致（一个概念只留一个名字，避免"配置写 selfbuilt、响应回 slider"这类无谓漂移）。

**偏差 3（必须的修正）：fail-open 的落点比 §9.3 更靠前 —— 提到「链路是否存在」这一层。**
- 实现：`failMode=open` 且处于熔断窗口时，`isUsable()` 为 false ⇒ **出题端点 404 + `requireForLogin()` 直接返回 false**（整条链路按"不存在"处理）。
- 为什么必须：若只在 `/captcha/verify` 里放行，极验挂掉时前端**连 `gt4.js` 都拉不到、点不出官方按钮**，用户压根拿不到 `captcha_token`，登录会被服务端 400 `captcha_required` **卡死** —— "服务端放行"就成了一厢情愿。把"不可用"上提到链路存在性，才能真正做到"故障时登录不受阻"。
- `closed` 模式下熔断**不**影响链路存在性：仍然要求凭证，但立即 503（而不是每次干等超时）。

**偏差 4：审计从提供方上移到编排层（§3.3 的原意，落地时把滑块那份也一并上移）。**
- 原来自建实现自己在 `verifyChallenge` 里写 `auth.captcha_failed`；现在统一由 `captcha.service.js` 写，`detail` 增加 `provider` 字段。`reason` / `delta_px` / `attempts` 口径不变，故既有断言不受影响。

### 16.3 已采纳的开放项

- **C14 已采纳**：`captcha_unavailable`(503) 登记进 `errors.js`（`docs/api.md` §1.3 由 26 → 27 条）。
- **C19 第 3 条已采纳**：熔断 `captcha:vendor:down:<provider>`（TTL 30s）已实现。⛔ **第 5 条（进程级出站并发信号量）仍未做**。
- **C17 / C18 按建议执行**：不传 `userInfo`；保持两步端点契约（`/auth/login` 形状零改动）。

### 16.4 剩余工作

| 项 | 状态 |
|---|---|
| **S8 前端**：`GeetestCaptcha.vue` + `Login.vue` 接入 + i18n | ✅ **已落地（2026-10-03，见 §16.7）**；⏳ 真机联调待 Owner（§10.3 第 1–2 条 + 本文 §16.7 的"待真机核对"） |
| **S9 收尾**：Owner 真机验收（§10.3）+ 极验后台报备调用域名 | ⏳ 未做 |
| 出站并发上限（C19 第 5 条） | ⏳ 未做 |
| `docs/frontend.md:103` 关于 `/login` 公开域隔离的措辞（与 `web/src/router/index.ts:89` 矛盾） | ⏳ 未做（既有问题，本轮已决定"保留代码、修正文档"） |

### 16.5 验证状态（⚠️ 诚实说明）

- ⛔ **未跑 `node --check`、未跑 `npm test`**：本机 pwsh 在该沙箱下仍不可用（`SetNamedSecurityInfoW failed (Win32 5)`），修它需要 `danger-full-access` 提权（Owner 此前已拒绝）。按既有分工，执行类验证由 Owner 完成（§16.6 给了可复制的命令）。
- ✅ 代码经人工逐行复核，过程中自查出**两处真实缺陷**并已修掉，记在这里供参考：
  1. provider 文件位于 `services/captcha/providers/`（三层深），相对导入写成 `../../utils/*` → 应为 `../../../utils/*`（运行时 `ERR_MODULE_NOT_FOUND`）。
  2. provider 直接收了路由透传的 `request.body`，却按**驼峰**解构（`captchaId` / `lotNumber`），而线上字段是 **snake_case**（`captcha_id` / `lot_number`）→ 解构全为 `undefined`，且 **schema 拦不住**（字段都在，只是没人读），表现为"**每一次**验题都返回 `captcha_invalid(not_found)`"。
     🔑 教训：**「校验通过」与「读到了值」是两件事** —— schema 只保证字段存在与类型，⛔ 不保证有人读了它。

### 16.6 验收步骤（Owner 执行，可直接复制）

```powershell
cd D:\phpstudy_pro\WWW\Vantage\server

# 1) 语法检查 + 全量测试（含新增的 2 个测试文件）
node --check src/utils/geetest.js
node --check src/services/captcha.service.js
node --check src/services/captcha/providers/geetest.provider.js
node --check src/services/captcha/providers/selfbuilt.provider.js
node --check src/services/captcha/providers/index.js
node --check src/routes/auth.js
node --check src/config/index.js
node --check src/app.js
npm test

# 2) 提供方推断自检（不需要数据库）：期望依次打印 selfbuilt / geetest
node --input-type=module -e "const {loadConfig}=await import('./src/config/index.js');const base={DATABASE_URL:'postgres://u:p@127.0.0.1:5432/v',SECRET_KEY:Buffer.alloc(32,1).toString('base64')};console.log('无密钥 ->',loadConfig(base,{skipEnvFile:true}).security.captcha.provider);console.log('有密钥 ->',loadConfig({...base,GEETEST_CAPTCHA_ID:'647f5ed2ed8acb4be36784e01556bb71',GEETEST_CAPTCHA_KEY:'b09a7aafbfd83f73b35a9b530d0337bf'},{skipEnvFile:true}).security.captcha.provider);"

# 3) 极验连通性与签名自检（captcha_key 换成自己的）
Test-NetConnection gcaptcha4.geetest.com -Port 443
node -e "const c=require('crypto');console.log(c.createHmac('sha256',process.argv[1]).update('test_lot_number','utf8').digest('hex'))" "你的_GEETEST_CAPTCHA_KEY"
```

⚠️ 第 2 步若"无密钥"那行抛 `CONFIG_INVALID`，说明偏差 1 的实现没生效（应当回退 `selfbuilt` 而不是拒绝启动）。
⚠️ 第 1 步 `npm test` 若在 `auth.captcha.geetest.test.js` 失败，**优先看与 `fetchCalls` 有关的断言** —— 那是"只发一次、参数与签名正确"的唯一守门人。

### 16.7 S8 前端落地记录（2026-10-03）

> ⛔ 与 §16.2 同样口径：本节记的是**代码实际长什么样**，凡与 §7 不一致处以此为准。

| 文件 | 动作 | 要点 |
|---|---|---|
| `web/src/utils/geetest.ts` | **新增** | `gt4.js` **装载器**（幂等、失败不缓存、可重试）+ `initGeetest4`/实例/`getValidate()` 的类型声明。⛔ 零网络逻辑、零判定 |
| `web/src/components/GeetestCaptcha.vue` | **新增** | 加载脚本 → `initGeetest4` → **立刻** `appendTo` 隐藏容器；`visible` 只控制容器显示；`onSuccess` → `getValidate()`（⚠️ 判 `false`）→ `authApi.captchaVerify` → `emit('success', token)` |
| `web/src/views/Login.vue` | **改** | `onMounted` → `prepareCaptcha()` 取 `provider`（⚠️ 首屏取失败——404/429/网络——则在"确实被要求验证"那一刻重试一次，避免用户无路可走）；`geetest` 分支**常驻挂载**极验组件、`selfbuilt` 分支仍按需挂载滑块；`captcha_invalid` 时 `geetestRef.reset()`；触发语义（§2 的 8 条）**一条未改** |
| `web/src/api/private.ts` | **改** | challenge/verify 的**判别联合**类型（`SelfbuiltCaptchaChallenge` / `GeetestCaptchaChallenge`、`SelfbuiltCaptchaVerifyBody` / `GeetestCaptchaValidate`）；新增共享的 `captchaReasonOf()` |
| `web/src/components/SliderCaptcha.vue` | **改（最小）** | 题目类型收窄为 `SelfbuiltCaptchaChallenge`（响应带 `provider` 后必须判别；拿到非 `selfbuilt` 一律按"不可用"处理）；`reasonOf` 改用共享实现。⛔ 行为与交互零改动 |
| `web/src/locales/{zh-CN,en-US}.ts` | **改** | 新增 `captcha.vendorFailed`、`captcha.closed`（坑三/坑四的文案）、`error.captcha_unavailable`（503）；`captcha.loading` 与 `view.login.captchaFallback` 的措辞**去掉"滑块"限定**（两个提供方共用） |

**§7.5 五坑的对照检查（⛔ 逐条）**

| 坑 | 落点 |
|---|---|
| 一：`getValidate()` 未通过时返回 `false` | `onVendorSuccess()` 先 `if (!validate)` → 提示并**不提交** |
| 二：⛔ 不在 `onSuccess` 后 `reset()` | 通过后**不** reset（token 120s 可复用）；只在 ① 服务端 400 `captcha_invalid` ② 用户关窗 时 reset |
| 三：⛔ 不展示极验的 `error.code` | `onVendorError()` 丢掉入参，只给 `captcha.vendorFailed` |
| 四：`onClose` 必须有反馈 | `onVendorClose()` → `captcha.closed` 提示 + reset |
| 五：`captcha_id` ⛔ 不进构建期 env | 全部来自 `/auth/captcha/challenge` 响应（`GeetestCaptchaChallenge`） |

**实施期的 4 处自主决定（与 §7 的差异，逐条说明理由）**

1. **脚本注入排在 `challenge` 之后**（§4.1 的时序图是 ① 加载脚本 → ② challenge）。理由：要先把 `provider` 问出来才知道**要不要**拉极验的脚本 —— 这正是 §7.1 方案 (a) 的前提（"关闭/自建时零外链"）。官方要求的是"**不要等到用户点击才初始化**"，本实现仍在页面加载阶段完成初始化，未触发该问题。
2. **`success(null)` 作为一条显式信号**：极验组件在"验题端点返回 404（链路此刻不生效）"时**不带 token** 直接触发自动重提登录（fail-open 在前端的落点，§16.2 偏差 3）。⛔ 它不是"前端放行"：服务端若仍要求凭证，会以 400 `captcha_required` 拒绝。
3. **`visible=false` 用 `v-show`（`display:none`）实现**：即 §7.3 第 3 步的原样落地。⚠️ 因此 §7.3 的"真机核对点"**依然有效**（容器由隐藏切可见后，官方按钮与 `popup` 遮罩是否正常渲染）——若真机发现 `display:none` 影响极验内部尺寸计算，按 §7.3 的两条退路改（① `visibility:hidden` 不占位；② `v-if` + 显示时重新 `appendTo`）。
4. **`initGeetest4` 显式传 `protocol: 'https://'`**：官方 Web API 文档对"本地 / 混合开发"明确要求手动指定协议头（否则可能取到 `file:` 协议）。这与 §4.2「服务端 `validate` 一律 HTTPS」口径一致，也能避免面板自身跑在 `http://`（自托管内网常见）时把极验的资源与接口请求降级成明文。`appendTo` 传的是 **DOM 元素**（官方允许"id 选择器**或** DOM 元素"），因此不需要在页面里钉一个全局 id。

**⏳ 待真机核对（Owner，$0 成本，只需一次登录）**

1. 全新会话打开 `/login`：**看不到任何验证入口**，但 F12 → Network 里应能看到 `gt4.js` 与后续验证库资源；Elements 里 `#vantage-captcha-slot`（`.geetest-captcha__slot`）内**已有极验的 DOM**（只是 `display:none`）。
2. 故意输错一次密码 → 同一表单内**就地出现极验官方按钮**（不必重输密码、不必刷新）→ 点它 → 官方验证窗 → 通过 → 应**自动重提登录**。
3. 通过后再打错一次密码 → 应**不要求重新验证**（`captcha_token` 120s 内可复用）；若此时才提示需要验证，说明服务端把 token 消费掉了（与 §2 第 6 条不符，需回查服务端）。
4. 把 `CAPTCHA_PROVIDER` 改成 `selfbuilt` 重启后端：登录页应回到自建滑块（前端**不用重新构建**，因为选组件是运行时按 `provider` 判定的）。
5. 验证码关闭（`security.login_captcha.enabled=false`）时：登录页**零极验外链**、无任何验证入口。
