# Vantage 滑动验证码 · 自建实现方案（路线 A）

> **性质**：实施规范（可直接照着写代码；**不含实现代码**）。
> **依据**：`docs/slider-captcha.md`（选型结论 **C1 = A 自研**）、`docs/api.md` §1.3（错误码）/§1.4（限流）/§4.1（登录与会话）/§4.10（settings 白名单）、`docs/database.md` §7（Redis 键空间契约）、`docs/frontend.md` §4.2（登录页）。
> **本轮 Owner 明确的需求**：① 用户**第一次**登录**不出现**验证码；② **出现密码错误后**，后续登录引入人机验证。
> **状态**：✅ **已落地（S1–S4）**——S1 原语 + 单测、S2 服务/端点/限流/失败计数、S3 前端组件与登录页集成、S4 文档登记；⏳ 待 Owner 跑 `npm test`（`server/test/slider.test.js`、`server/test/auth.captcha.test.js`）与真机拖拽验证。
> 📝 **2026-10-03 变更（不改本实现）**：Owner 决定人机验证**改用极验 GeeTest v4**（**C12 = G1-a**）——本文这套自建实现**降级为可选 provider（`CAPTCHA_PROVIDER=selfbuilt`）并完整保留，⛔ 不删代码**（它是内网/离线部署的唯一可用选项，也是极验不可用时的回滚目标）。变更方案见 `docs/geetest-captcha.md`。
> 📝 **2026-10-03 前端 S8 落地**：`Login.vue` 现在按 `/auth/captcha/challenge` 响应里的 `provider` **运行时选组件**（`geetest` → `GeetestCaptcha.vue`，`selfbuilt` → 本方案的 `SliderCaptcha.vue`）。⚠️ 对本组件是**最小改动**：题目类型收窄为 `SelfbuiltCaptchaChallenge`、`reasonOf` 改为共享实现；**交互、emit 契约与行为零变化**（`CAPTCHA_PROVIDER=selfbuilt` 时与 S3 完全一致）。
> **本文哪些部分在 `provider=geetest` 下继续有效**：§2（触发语义与登录检查顺序，⛔ 8 条契约一条都不改）、§5.3（登录端点改动）、§6.4（token 绑定与消费时机）、§8.2（两个 settings 项）、§10.3 的 **AC-1/2/3/5/11/12/13**（提供方无关）。
> **哪些只在 `provider=selfbuilt` 下适用**：§4.1 的 `captcha:<id>` 题目键、§6（出题与判定算法）、§7.3（`bind`/滑块交互口径被极验方案取代）、AC-4/6/7/8/9/10。
> ❓ 待追认项见 §12：本轮**已按本文建议实现**（阈值 1、按账号维度计数、成功后不重置、token 绑定 IP、程序化 SVG 底图），如与 Owner 判断不同请按 §12 回退。

---

## 0. 结论：可行吗？

**✅ 可行**，而且这正是验证码**该有的**出场时机（把摩擦加在攻击者身上，而不是加在每一次正常登录上）。但要做到位，有**一处必须改、一处必须补**：

| # | 问题 | 结论 |
|---|---|---|
| ⚠️ 1 | **不能复用现有的登录限流计数**来决定是否要滑块 | `ratelimit:login:<ip>` 按既定口径是「**成功与失败都计数**」（`docs/api.md` §1.4）。若拿它当触发器，会出现"窗口内正常登录 3 次后，第 4 次也要滑块"——与"第一次不需要、出错才要"的意图不符。**必须新增一个只记失败的计数器** `login:fail:*` |
| ⚠️ 2 | **"首次尝试免费"给代理池留了一次免费机会** | 若只按 IP 记失败，攻击者用代理池每个 IP 只试 1 次 → 失败计数永远停在 0 → **滑块永远不会出现**。必须**同时按账号维度**记失败（`login:fail:acct:<hash>`），否则这套策略对分布式喷洒基本无效 |

除这两点外，其余都顺着既有架构走：Redis 存答案、服务端校验、一次性 token、fail-closed。

**行为预期（说清楚再动手）**：阈值默认 = **1**（一次密码错就要滑块）。因此**用户手误一次密码，在本窗口（默认 300s）内的后续登录都会看到滑块**——这是本需求的直接推论，不是 bug。可配（§8），也可整体关闭。

---

## 1. 组件与职责（新增/改动清单）

| 层 | 文件 | 动作 |
|---|---|---|
| 纯函数 | `server/src/utils/slider.js` | **新增**：出题（缺口坐标、SVG 合成）、校验（容差 + 轨迹判定）、常量 |
| 素材 | `server/assets/captcha/`（可选） | **新增**：0–6 张底图；**默认走程序化 SVG，零素材**（§6.1） |
| 服务 | `server/src/services/captcha.service.js` | **新增**：出题、验题、失败计数、一次性 token 的发放与消费 |
| 路由 | `server/src/routes/auth.js` | **改**：新增 2 个端点；`LOGIN_BODY_SCHEMA` 加可选 `captcha_token` |
| 认证服务 | `server/src/services/auth.service.js` | **改**：登录入口插"是否要求滑块"判定；失败路径 `failLogin()` 里 INCR 失败计数；失败响应带提示 |
| 限流 | `server/src/middleware/rateLimit.js` | **改**：新增 `createCaptchaRateLimiter`（复用同一段固定窗口 Lua） |
| 键空间 | `server/src/utils/redisKeys.js` | **改**：新增 4 个键（§4.1）——⛔ 必须先登记进 `docs/database.md` §7 |
| 错误码 | `server/src/utils/errors.js` | **改**：`captcha_required`(400)、`captcha_invalid`(400) |
| 设置 | `server/src/services/settings.service.js` | **改**：白名单加 2 个 key + 新增 `getSettingInt()`（现有只有 `getSettingBool`） |
| 配置 | `server/src/config/index.js` | **改**：`rateLimit.captchaPerMinute`、`security.captcha.{ttlS,tolerancePx,maxAttempts}` |
| 前端 | `web/src/components/SliderCaptcha.vue` | **新增**：滑块组件（Vue3 `<script setup>` + TS） |
| 前端 | `web/src/views/Login.vue`、`web/src/store/auth.ts`、`web/src/api/private.ts`、`web/src/locales/{zh-CN,en-US}.ts` | **改**：见 §7 |

---

## 2. 触发语义（把"第一次不要、出错才要"钉死）

### 2.1 两个失败计数器

| 计数器 | 键 | 何时 +1 | TTL |
|---|---|---|---|
| 按 IP | `login:fail:ip:<ip>` | 登录失败（**任何原因**：账号不存在 / 密码错 / 已禁用） | `rateLimit.loginWindowS`（默认 300s） |
| 按账号 | `login:fail:acct:<sha256(lower(username))[:16]>` | 同上（`username` 非空时） | 同上 |

**⛔ 为什么按账号也要记**："首次尝试免费"是需求的一部分，但代理池可以让每个 IP 都停在 0 次失败——按账号记才能把"分散打同一个账号"重新收敛到同一个计数器上。
**⛔ 为什么账号键要哈希**：Redis 键会进 `MONITOR`/慢日志/运维截图，直接写明文用户名等于把"谁在被攻击"泄漏给任何能看到 Redis 的人。哈希口径复用 `utils/crypto.js` 的 `sha256Hex()`（截断 16 字符足够避免碰撞）。

### 2.2 是否要求滑块的判定

```
requireCaptcha =
     settings['security.login_captcha.enabled'] === true
  && ( failIp >= settings['security.login_captcha.after_failures']
     || failAcct >= settings['security.login_captcha.after_failures'] )
```

- 默认 `enabled=true`、`after_failures=1` → **第 1 次尝试永不要求**（此时两个计数器都是 0）；**一旦失败过一次，本窗口内后续每次登录都要求**。
- 阈值可配 1–10（§8）。`enabled=false` 时整条链路不生效（连出题端点也 404，见 §5.1）。
- ⛔ **判定不得依赖账号是否存在**：`requireCaptcha` 只用 IP / 提交的 username（哈希后）与设置项算出，**不查库** → 既不会给"账号是否存在"提供计时侧信道，也不破坏既有的**等时校验**（`auth.service.js` 的假哈希机制原样保留）。

### 2.3 登录检查顺序（顺序是安全属性，⛔ 不可调换）

```
① 登录限流        ratelimit:login:<ip>     （既有，10 次/300s，超限 429）
② 读设置 + 两个失败计数
③ 若 requireCaptcha：校验 captcha_token    ← 必须在验密码之前！
      缺 token / 无效 / 过期 / IP 不匹配 → 400 captcha_required | captcha_invalid
④ 查库 + 验密码（既有等时校验不变）
⑤ 失败 → failLogin()：两个计数器 INCR → 401 invalid_credentials
        + details.captcha_required: true（让前端**当场**展示滑块）
⑥ 成功 → 消费 token（DEL captcha:ok:<token>）→ 走既有会话/2FA 流程
```

🔑 **为什么 ③ 必须在 ④ 之前**：若先验密码再验滑块，攻击者不需要过滑块就能让服务端跑满 Argon2（19MiB × 每次），等于**免费拿到一个 DoS 放大器**。先卡滑块，未过滑块的请求连慢哈希都不会触发。

---

## 3. 交互时序

**路径 A：第一次登录（无失败计数）——⛔ 不出现滑块**

```
浏览器 ── POST /auth/login {username,password} ──▶ 服务端
                                                  ①限流 ②计数=0 → 不要求滑块
                                                  ④验密码 → 成功
浏览器 ◀── 200 {user,roles,csrf,totp_required} ── 服务端
```

**路径 B：密码错一次 → 引入人机验证**

```
浏览器 ── POST /auth/login {username,password(错)} ─▶ 服务端
                                                    ①限流 ②计数=0 → 不要求
                                                    ④验密码 → 失败
                                                    ⑤INCR 两个计数器 → 401
浏览器 ◀── 401 {error:{code:invalid_credentials,
                       details:{captcha_required:true}}} ─ 服务端
        ↓ 前端**就地**展开滑块（密码保留在表单里，用户无需重输）
浏览器 ── POST /auth/captcha/challenge ────────────▶ 服务端
浏览器 ◀── 200 {captcha_id,bg_svg,piece_svg,width,height,expires_in} ─
        ↓ 用户拖动
浏览器 ── POST /auth/captcha/verify {captcha_id,x,track} ─▶ 服务端
浏览器 ◀── 200 {captcha_token,expires_in} ───────── 服务端
        ↓ 自动重提（带 token）
浏览器 ── POST /auth/login {username,password,captcha_token} ─▶ 服务端
                                                    ②计数=1 → 要求滑块
                                                    ③token 有效 → 放行
                                                    ④验密码 → 成功
                                                    ⑥消费 token
浏览器 ◀── 200 {...} ───────────────────────────── 服务端
```

**兜底路径（前端没处理上面的 `details`）**：直接再提交 → 服务端 ③ 缺 token → **400 `captcha_required`** → 前端据此展开滑块。
⛔ **两条路径都要实现**：`details.captcha_required` 是体验优化，`400 captcha_required` 才是**服务端强制**的契约（不依赖前端自觉）。

---

## 4. 存储

### 4.1 Redis 键（⛔ 需登记进 `docs/database.md` §7 后才可实现）

| 键 | 结构 | TTL | 写入时机 | 内容 |
|---|---|---|---|---|
| `captcha:<captcha_id>` | hash | `CAPTCHA_TTL_S`（120s） | 出题 | `x`、`y`、`created_at`、`attempts`（失败次数，≥3 即作废） |
| `captcha:ok:<captcha_token>` | string | `CAPTCHA_TTL_S`（120s） | 验题通过 | 值 = **解出该题的 IP**（防 token 转让，§6.4） |
| `login:fail:ip:<ip>` | string | `loginWindowS`（300s） | 登录失败 | 失败计数 |
| `login:fail:acct:<hash16>` | string | `loginWindowS`（300s） | 登录失败 | 失败计数 |
| `ratelimit:captcha:<ip>` | string | 60s | 出题 / 验题 | 固定窗口计数（复用 `FIXED_WINDOW_LUA`） |

- 计数用既有 Lua（`INCR` + 仅首次 `EXPIRE`）——⛔ 不要手写"INCR 后每次都 EXPIRE"（会把 TTL 无限续期，见 `middleware/rateLimit.js` 头部的两种错误写法）。
- ⛔ 答案与 token 只在 Redis：**不入 PG、不进日志、不进响应**。

### 4.2 键前缀登记

`KEY_PREFIX` 新增 `captcha: 'captcha:'`、`captchaOk: 'captcha:ok:'`、`loginFailIp: 'login:fail:ip:'`、`loginFailAcct: 'login:fail:acct:'`、`rateLimitCaptcha: 'ratelimit:captcha:'`；`TTL_S` 新增 `captcha: 120`。
⛔ 与 `totp:used:<uid>` 同一约定：**键名唯一来源是 `redisKeys.js` + `database.md` §7 表格**，⛔ 不允许散落字符串拼接。

---

## 5. 接口契约

### 5.1 `POST /api/v1/auth/captcha/challenge` — 取题

| 项 | 值 |
|---|---|
| 认证 / CSRF | 无（免登录、与会话无关，理由同 `/auth/login`） |
| 限流 | `ratelimit:captcha:<ip>`，默认 30 次/分钟（比登录桶宽松——"换一张"是正常操作） |
| 审计 | ⛔ 不记（否则取题噪声淹没审计） |
| 开关关闭时 | **404 `not_found`**（⛔ 不用 403：不暴露"存在但被关"） |

**请求**：无 body。

**成功 200**

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | string | ➕ **2026-10-03 新增（S7）**：恒为 `selfbuilt`；前端据此在 `SliderCaptcha.vue` 与 `GeetestCaptcha.vue` 之间选组件（`docs/api.md` §4.1） |
| `captcha_id` | string | ≥16 字节随机（base64url） |
| `bg_svg` | string | 背景图 SVG 文本（含缺口） |
| `piece_svg` | string | 拼图块 SVG 文本 |
| `width` / `height` | number | 逻辑尺寸；⛔ 校验一律用**逻辑坐标**（前端可等比缩放显示） |
| `expires_in` | number | 秒（= `CAPTCHA_TTL_S`） |

⛔ 响应中**不得**出现：缺口坐标、容差、阈值、`attempts` 上限。

### 5.2 `POST /api/v1/auth/captcha/verify` — 验题

**请求体**

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `captcha_id` | string | ✅ | ≤128 |
| `x` | number | ✅ | 逻辑坐标（0 ≤ x ≤ width） |
| `y` | number | ➕ | 仅纵向不动时可省 |
| `track` | array | ✅ | `[[t_ms, x], …]`，**点数上限 200**（防超大 body） |

**成功 200**：`{ captcha_token, expires_in: 120 }`

**错误**

| 状态 | code | `details.reason` |
|---|---|---|
| 400 | `captcha_invalid` | `mismatch`（偏差超容差）/ `track_suspicious` / `expired` / `not_found` / `too_many_attempts` |
| 400 | `schema_invalid` | — |
| 429 | `rate_limited` | — |

**语义**：成功即 `DEL captcha:<id>`（一次性）；失败 `attempts+1`，**≥3 次作废该题**（容差 5px/300px ≈ 1/60 命中率，不设上限等于白送 60 次机会）。

### 5.3 `POST /api/v1/auth/login` 改动

- `LOGIN_BODY_SCHEMA` 新增可选字段 `captcha_token`（string，≤128）；⛔ 该 schema 是 `additionalProperties: false`，**不加就会 400 schema_invalid**。
- 策略要求但缺/无效 token → **400 `captcha_required` / `captcha_invalid`**（⛔ 不复用 401：前端必须能区分"要滑块"与"密码错"）。
- 登录**失败**响应新增 `details.captcha_required: true`（前端据此当场展示滑块；⛔ 不改变 `code` 与 `message`，不引入账号线索）。
  ⚠️ **会触及一条既有断言**：`server/test/auth.test.js` 的「密码错 / 账号不存在 / 已禁用 → 同码同文」用例里有一句 `assert.equal(body.error.details, undefined, '⛔ details 不得携带区分信息')`。该断言的**意图**是"details 里不得出现能区分账号是否存在的字段"，而 `captcha_required` 由 **IP / 提交用户名的计数**算出、**与账号是否存在无关**，因此应按意图**改写**为：「三种失败情形的 `details` 完全一致，且**只允许** `captcha_required` 这一个键」——⛔ 不是把断言删掉了事（删掉就等于放弃了那条防枚举保护）。
- 登录**成功**：消费 token（`DEL captcha:ok:<token>`）。

### 5.4 错误码登记（`docs/api.md` §1.3 与 `utils/errors.js` 同步加）

| code | 状态 | 默认中文消息 |
|---|---|---|
| `captcha_required` | 400 | 请先完成人机验证 |
| `captcha_invalid` | 400 | 人机验证未通过，请重新尝试 |

---

## 6. 算法规范

### 6.1 出题（`utils/slider.js`）

1. 生成缺口逻辑坐标：`x ∈ [width*0.35, width*0.85]`（左端留给拼图块轨道）、`y ∈ [height*0.15, height*0.75]`，用 `crypto.randomInt`（⛔ 不用 `Math.random`）。
2. 背景：**程序化 SVG**（渐变 + 若干随机几何图形 + 细噪点）——零素材、零依赖、离线可用；在 `(x, y)` 处画**深色缺口**，形状与拼图块一致（常见形态：带一个圆形凸起的方块）。
3. 拼图块：同形状 + 半透明高亮填充，作为**独立 SVG** 返回，前端把它放在左侧轨道。
4. ⛔ 不泄露答案的写法（逐条）：
   - 缺口位置只通过**绘制结果**体现，⛔ 不出现在任何属性里（如 `<rect x="…">` 直接可读）；
   - `clipPath`/`mask` 的 `id` 用随机串（防跨题复用与硬编码匹配）；
   - ⛔ 不返回 `x`、不返回 `tolerance`、不返回 `attempts` 上限；
   - ⛔ 图片不落磁盘、不进日志（`bg_svg` 体积控制在 ~10–20KB）。
5. 可选：`server/assets/captcha/` 放 0–6 张底图（`<image href="data:image/jpeg;base64,…">` 内联进 SVG，`clipPath` 裁剪拼图块）——纯字符串拼装，**仍然零图像处理依赖**（⛔ 不引 `sharp`/`canvas`）。素材许可需逐个确认。

> ⚠️ 诚实说明：**程序化底图的缺口比照片更容易被程序定位**。但 §2.5 已确认——照片底的缺口同样能被现成 ONNX/YOLO 模型识别（`captcha-recognizer-js`）。**不要为了"更难识别"引入原生依赖**，收益不成立。

### 6.2 校验（服务端唯一判定点）

| 规则 | 建议值 | 作用 |
|---|---|---|
| 横坐标容差 | `max(CAPTCHA_TOLERANCE_PX, width*0.008)`（默认 5px，300px 宽 ≈ 5px） | 容忍手感误差 |
| 轨迹点数 | ≥ 8 | 挡"一次事件直接给终点" |
| 总时长 | 300ms – 15000ms | 挡瞬移与挂机 |
| 单调性 | x 允许回退 ≤2 次、每次 ≤3px | 真实拖动有抖动；脚本常是完美单调 |
| 速度方差 | > 0（须存在加减速） | 挡匀速机器滑动 |
| 末点一致 | `|track 末点 x − 提交 x| ≤ 2px` | 挡轨迹与提交值不一致 |
| 一次性 | 验过即 `DEL captcha:<id>` | 挡重放 |
| 失败上限 | `attempts ≥ CAPTCHA_MAX_ATTEMPTS`（默认 3）→ 作废 | 挡暴力试位 |
| 时间 | 以 Redis TTL 为准，⛔ 不信前端时间 | 挡本地时钟伪造 |

### 6.3 时钟与过期

`created_at` 只用于排障；**过期判定一律交给 Redis TTL**（`EXISTS` 为空即 `expired`）——避免服务端时钟与 Redis 时钟不一致导致的"题永远不过期"。

### 6.4 token 的绑定与消费（安全细节）

| 项 | 决定 | 理由 |
|---|---|---|
| token 绑定 IP | ✅ `captcha:ok:<token>` 的值 = 解出该题的 IP；登录时比对 | 挡"打码平台批量出 token 转卖"；⚠️ 代价：切换网络（手机流量↔Wi-Fi）需重滑 |
| 消费时机 | **登录成功时才 DEL** | 若"任何一次提交都消费"，用户划过滑块后打错密码就要重滑——体验不可接受 |
| 有效期内的重复提交 | 允许（120s 内 token 可复用，失败不消费） | 用户划过一次后可重试密码；攻击者同样受**登录限流**约束 |
| ⚠️ 诚实结论 | 滑块的真实作用 = 把"每 5 分钟最多 10 次尝试"变成"**每 5 分钟至少一次人机判定**" | ⛔ 不要对外描述为"挡住自动化攻击" |

---

## 7. 前端实现规范

### 7.1 `web/src/components/SliderCaptcha.vue`（新增）

- Vue 3 `<script setup lang="ts">`、Composition API（遵循 `vue-best-practices`）、Element Plus 主题变量配色。
- **props**：`width?`、`height?`（默认取 challenge 响应）。
- **emits**：`success(captchaToken)`、`fail(reason)`、`cancel`。
- **内部流程**：`onMounted` → `captchaChallenge()` → 内联渲染两个 SVG（`v-html` + ⛔ 仅渲染**自己的**服务端响应，⛔ 不渲染任何用户输入） → `pointerdown/move/up` 采集 `track`（含时间戳）→ 松手即 `captchaVerify()` → 成功 `emit('success', token)`。
- 交互细节（✅ 2026-10-03 修订）：**两个拖动面** —— ① 直接拖图片（原有交互，保留）；② 图片下方**滑块轨道 + 手柄**，手柄与拼图块联动（同一个 `pieceX` 同时驱动拼图块的 `translate3d` 与手柄的 `left`；轨道的提示文案复用 `captcha.hint`）。两者都限制在 `[0, width - pieceWidth]`。
- 坐标换算：图片面 `逻辑px = CSSpx / scale`；手柄面 `逻辑px = CSSpx × travelMax / (轨道宽 − 手柄宽)`（拖动开始时量一次，避免每帧测量）。
- `pieceWidth` 取**拼图块自身**宽度：量 SVG **内容包围盒**（`getBBox()` 返回 viewBox 用户单位 = 逻辑 px）。⛔ 不要用 `offsetWidth` —— 服务端 `piece_svg` 与画布**同尺寸**（320×160），量出来恒等于画布宽，只能走 15% 兜底（48px，真实值 44+10=54px），结果是允许拼图块多拖 6px 出画布（被 `overflow:hidden` 裁掉）。⚠️ 交接文档 `bbedfcd6` 曾记「最多只能拖 48px / 拖不到位」——按代码复算：`travelMax = 320 − 48 = 272`，而答案区间是 `[112, 262]`，**够得着**；该结论把"兜底宽度"误当成了"行程上限"。
- 松手若未对齐，**抖动回位**并提示"再试一次"；⛔ 不在前端判定对错（前端判对错 = 纯前端滑块，零防护）。
- 键盘可达（✅ 2026-10-03 修订）：`role="slider"` + `tabindex="0"` 从"整张图"移到**手柄**上（ARIA slider 的惯用位置）；手柄 `←/→` 每次 5px、`Enter` 提交；`aria-valuemin/max/now` 用逻辑坐标。图片拖动面退化为纯指针交互（不参与 Tab 顺序），⛔ 不因此降低键盘可用性。

### 7.2 `Login.vue` 集成（"出错才出现"）

| 触发 | 处理 |
|---|---|
| `POST /auth/login` 返回 401 且 `error.details?.captcha_required === true` | **就地**展开 `SliderCaptcha`，保留已填密码与用户名，提示"为确认是本人操作，请完成验证" |
| `POST /auth/login` 返回 400 `captcha_required` | 同上（兜底路径） |
| 滑块 `success(token)` | **自动重提**登录（携 `captcha_token`），⛔ 不需要用户再点登录 |
| 滑块 `fail` | 展示服务端消息（"验证未通过，请重试"/"验证已过期，已为你换一张"），允许重取题 |
| `captcha_invalid` 且 `reason=expired` | 自动换一张题（重新 challenge） |
| 首次进入页面 | ⛔ **不预加载**滑块、不出题（首次登录必须零摩擦） |

### 7.3 `store/auth.ts` 与 `api/private.ts`

- `login(username, password, captchaToken?)` → `authApi.login({ username, password, captcha_token })`。
- `api/private.ts` 新增 `captchaChallenge()`、`captchaVerify({ captcha_id, x, track })`；`LoginResponse` 类型不变（滑块提示走错误 `details`）。
- ⛔ 不把 `captcha_token` 存入 store / localStorage（一次性的短期凭证，只存在于提交那一瞬间）。

### 7.4 i18n（`zh-CN` / `en-US` 都要加，⛔ 不硬编码）

`captcha.title`（请完成安全验证）、`captcha.hint`（拖动滑块使拼图吻合，**同时用作滑块轨道内的提示文案**）、`captcha.ariaLabel`（**手柄**的无障碍标签：左右方向键每次 5px、回车提交）、`captcha.loading`、`captcha.retry`、`captcha.refresh`、`captcha.cancel`、`captcha.expired`、`captcha.failed`、`captcha.suspicious`、`captcha.tooManyAttempts`、`captcha.unavailable`、`captcha.verified`、`captcha.required`（检测到多次登录失败，请完成验证）。

> ⚠️ 2026-10-03 更正：错误码 key 的实际命名是 **`error.*`（单数）**——即 `error.captcha_required`、`error.captcha_invalid`，本文档此前写的 `errors.*` 与代码不符（`web/src/locales/zh-CN.ts` 的 `error` 段）。

### 7.5 降级与无障碍

1. `security.login_captcha.enabled=false` → 前端**永不**出现滑块（后端也不会返回该错误码）。
2. **键盘/无指针设备**：按 §7.1 的键盘通道走；若仍不可用，登录页给出"改用恢复码登录 / 联系管理员"的说明（Vantage 已有 TOTP 恢复码与管理员 2FA 重置渠道）。
3. **Redis 不可用**：服务端 503 `upstream_unavailable`（fail-closed，⛔ 绝不静默放行），前端提示"服务暂时不可用，请稍后再试"。

---

## 8. 配置与设置项

### 8.1 环境配置（`server/src/config/index.js`，进程级、需重启）

| 配置 | env | 默认 | 范围 |
|---|---|---|---|
| `rateLimit.captchaPerMinute` | `RATELIMIT_CAPTCHA_PER_MINUTE` | 30 | ≥1 |
| `security.captcha.ttlS` | `CAPTCHA_TTL_S` | 120 | 30–600 |
| `security.captcha.tolerancePx` | `CAPTCHA_TOLERANCE_PX` | 5 | 2–20 |
| `security.captcha.maxAttempts` | `CAPTCHA_MAX_ATTEMPTS` | 3 | 1–10 |

### 8.2 运行时设置（`settings` 表白名单，面板可改、立即生效）

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `security.login_captcha.enabled` | bool | **true** | 总开关；false 时整条链路不生效（出题端点 404） |
| `security.login_captcha.after_failures` | int | **1** | 失败几次后开始要求（1 = 一次密码错就要；建议范围 1–10） |

⛔ 三处必须同步（否则必然漂移）：`SETTING_DEFAULTS`（`settings.service.js`，唯一来源）→ `docs/database.md` §5.4 → `docs/api.md` §4.10 白名单表。
`settings.service.js` 需新增 `getSettingInt(redis, runner, key, { min, max, ttlS, logger })`，口径与既有 `getSettingBool` 一致（类型不对 → **回退默认值** + warn，⛔ 不抛错、不把登录打成 500）。

---

## 9. 审计与日志

| 事件 | action | detail（⛔ 已脱敏） |
|---|---|---|
| 验题失败 | `auth.captcha_failed` | `{ reason: 'mismatch'|'track_suspicious'|'expired'|'replayed'|'too_many_attempts', delta_px? }` |
| 登录被要求滑块（可选，建议**不记**） | — | 记了会产生噪声：攻击者可用它刷审计表 |
| 登录成功且用了滑块 | `auth.login` 的 `detail.captcha_used: true` | 与既有审计同一行，不新增噪音 |

⛔ `detail` 里**不得**出现：答案 x、提交的 x 原值（只可记 `delta_px` 差值）、`captcha_token`、完整 `captcha_id`。

---

## 10. 测试计划

### 10.1 纯函数单测（`server/test/slider.test.js`，零依赖，⛔ 不碰 HTTP/Redis）

- 出题：`x/y` 落在约定区间；`bg_svg`/`piece_svg` 是合法 SVG 片段；**响应字符串中不含答案数值**（用"把 x 写成字符串去 `includes`"的断言钉住，与 TOTP 的"不放宽断言"同一取向）。
- 校验：容差边界（刚好 5px 通过 / 6px 拒绝）；轨迹各条规则各一组正反例；`track` 末点不一致 → 拒。
- 随机性：连续 200 次出题，`x` 不重复且覆盖区间（防"固定缺口"这类致命退化）。

### 10.2 路由集成（`server/test/auth.captcha.test.js`，沿用 `auth.2fa.test.js` 的夹具：真 PGlite + `buildApp` + `fake-redis-hash` + `app.inject()`）

⚠️ `fake-redis-hash.js` 需补两个能力：`incr`（失败计数）与 `exists`（token/题目存在性判定）——⛔ 不要用"种值"绕过去，否则测不到真实路径。

### 10.3 验收用例（供联调，编号 **AC-1…AC-13**）

| # | 用例 | 期望 |
|---|---|---|
| **AC-1** | **首次登录（无失败计数）不带 token** | ✅ 200 成功；⛔ 全程不出现滑块、不返回 `captcha_required`（**本需求的核心断言**） |
| **AC-2** | 密码错 1 次 | 401 `invalid_credentials` + `details.captcha_required:true`；`login:fail:ip:*` 与 `login:fail:acct:*` 均为 1 |
| **AC-3** | 失败后再提交且缺 token | 400 `captcha_required`（⛔ 不是 401） |
| AC-4 | 出题 → 正确滑动 → verify → 带 token 登录 | 200；`captcha:ok:<token>` 已消费 |
| AC-5 | 同一 token 再次登录 | 400 `captcha_invalid`（一次性） |
| AC-6 | 有效期内（120s）token 复用于"密码仍错"的提交 | 允许提交（⛔ 不要求重滑），密码错仍 401 |
| AC-7 | 偏差 > 容差 | 400 `captcha_invalid`（`mismatch`），`attempts+1` |
| AC-8 | 同一题连续错 3 次 | 第 3 次后该 `captcha_id` 作废（`too_many_attempts`） |
| AC-9 | 题目过期（TTL 到）后 verify | 400 `captcha_invalid`（`expired`） |
| AC-10 | `track` 点数 <8 / 时长 <300ms / 匀速 | 400 `captcha_invalid`（`track_suspicious`）+ 审计 `auth.captcha_failed` |
| AC-11 | **换 IP 用同一 token** | 400 `captcha_invalid`（token 绑定 IP） |
| **AC-12** | **代理池场景**：5 个不同 IP 各失败 1 次打同一账号，第 6 次（新 IP） | 400 `captcha_required`（按账号计数兜住分布式喷洒） |
| AC-13 | `security.login_captcha.enabled=false` | 出题端点 404；登录永不因滑块被拒（⛔ 既有测试不得回归；**唯一需要按 §5.3 意图改写**的是那条 `details === undefined` 断言） |

### 10.4 人工验证（Owner）

1. 全新部署 → 首次登录**不应**看到滑块。
2. 故意输错一次 → 立刻出现滑块（**就地**，不用重输密码）。
3. 拖对 → 自动登录成功；拖错 3 次 → 提示换一张。
4. 断外网重跑一遍（应完全可用）。

---

## 11. 落地分块（每块独立可验收）

| 块 | 内容 | 验收 | 估时 |
|---|---|---|---|
| **S1** | `utils/slider.js` + `slider.test.js`（出题/校验/轨迹，零依赖） | §10.1 全绿 | 0.5 天 |
| **S2** | `captcha.service.js` + 2 个端点 + `createCaptchaRateLimiter` + 失败计数 + 错误码 + 键登记 + 设置项/`getSettingInt` | §10.3 的 AC-1…AC-13 | 1 天 |
| **S3** | `SliderCaptcha.vue` + `Login.vue` 集成 + store/api 改造 + i18n | §10.4 的人工验证 + `vue-tsc` 通过 | 1 天 |
| **S4** | 文档回填（`api.md` §1.3/§1.4/§4.1/§4.10、`database.md` §5.4/§7、`frontend.md` §4.2）+ 人工验证清单 | 文档与代码口径一致 | 0.5 天 |

---

## 12. 待追认 / 待确认（❓ 逐条，一次只问一条）

| # | 议题 | 建议 | 状态 |
|---|---|---|---|
| **C6** | **是否同时按账号维度记失败**（防代理池每个 IP 一次免费尝试绕过滑块） | **是**（不加则分布式喷洒基本绕过本策略） | 🔶 **已按建议实现**（`login:fail:acct:<hash>`），待追认 |
| C7 | 阈值默认值 | **1**（一次密码错即要求，符合本轮需求原话）；可配 1–10 | 🔶 已按建议实现（默认 1 + `getSettingInt` 夹取），待追认 |
| C8 | 成功登录后是否重置失败计数 | **不重置**（简单、无绕过面）；代价：本窗口内后续登录仍需滑块 | 🔶 已按建议实现（不重置），待追认 |
| C9 | token 是否绑定 IP | **是**（挡 token 转卖）；代价：换网络需重滑 | 🔶 已按建议实现（值存 IP），待追认 |
| C10 | 底图：程序化 SVG（零素材）还是内置照片 | **程序化 SVG**（照片素材有许可问题，且 §6.1 已论证"更难识别"不成立） | 🔶 已按建议实现（零素材），待追认 |
| C11 | 出题端点限流阈值 | 30 次/分钟 | 🔶 已按建议实现（`RATELIMIT_CAPTCHA_PER_MINUTE=30`），待追认 |

---

## 13. 溯源

| 本文内容 | 来源 |
|---|---|
| 自建路线（C1=A） | `docs/slider-captcha.md` §4（推荐与理由）、§8（C1） |
| 固定窗口 Lua 与"两种错误写法" | `server/src/middleware/rateLimit.js` 头部注释 |
| 失败计数不能复用登录限流计数 | `docs/api.md` §1.4（成功与失败**都计数**）+ `middleware/rateLimit.js` |
| 等时校验 / 假哈希不可破坏 | `server/src/services/auth.service.js`（`dummyPasswordHash`、`failLogin`） |
| 键空间集中登记 | `docs/database.md` §7（⛔ 不新增用途前缀而未登记） |
| `settings` 白名单唯一来源 | `server/src/services/settings.service.js` 的 `SETTING_DEFAULTS` + `docs/api.md` §4.10 |
| 一次性 + 防重放口径 | `docs/api.md` §4.1.1 ④（`totp:used:<uid>` 同款） |
| fail-closed 取向 | `docs/api.md` §1.4（Redis 不可用 → 503，⛔ 不放开） |
| `additionalProperties:false` 的 schema 约束 | `server/src/routes/auth.js` 的 `LOGIN_BODY_SCHEMA` |
| 前端状态机与登录流程 | `web/src/store/auth.ts`、`web/src/views/Login.vue`、`docs/frontend.md` §4.2 |
