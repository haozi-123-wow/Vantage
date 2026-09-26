# Vantage 数据库迁移（`server/migrations/`）

> 上位文档：`docs/database.md`（数据契约）、`Vantage-DESIGN-v0.7.md` §9/§15（决策表）。
> 决策依据编号（R1–R19、#11/#18/#38/#39/#47/#57 等）沿用上位文档口径。

## 1. 怎么用

```bash
cd server
npm run migrate:status    # 查看已应用 / 待应用 / 校验和漂移
npm run migrate           # 应用所有未执行的迁移（幂等，可重复跑）
```

前置条件：
1. 已按 `server/scripts/init-db.sql` 建好库与角色（`vantage_migrator` 有 DDL 权限）；
2. `server/.env` 里的 `MIGRATOR_DATABASE_URL` 指向 `vantage_migrator`（缺省回退 `DATABASE_URL`）。

运行器特性（`scripts/migrate.js`）：

| 特性 | 说明 |
|---|---|
| 记录表 | `schema_migrations(version, filename, checksum, applied_at, execution_ms)`，由运行器自建 |
| 并发保护 | 全库 `pg_advisory_lock(8787001)`，多实例/多人同时迁移会串行等待 |
| 事务 | 每个文件在**单事务**内执行，失败自动 ROLLBACK 且不写记录 |
| 校验和 | 已应用文件被改动 → 直接报错（**迁移只前进不回滚**，修正请新增文件） |
| 非事务语句 | ⛔ 不得使用 `CREATE INDEX CONCURRENTLY` / `VACUUM` 等（会破坏「单事务」语义） |
| 重跑单文件 | `node scripts/migrate.js --only=0008_privileges --force`（仅用于 `GRANT` 这类可重入脚本） |

## 2. 文件与文档的对应关系

| 文件 | 内容 | 文档章节 |
|---|---|---|
| `0001_helpers.sql` | `updated_at` 触发器函数、指标名校验函数、JSONB 形状判定函数 | §4、§5.7.2 |
| `0002_accounts.sql` | `users`、`user_recovery_codes`、`settings` | §5.3、§5.4（R3/R4/R16） |
| `0003_agents.sql` | `agents`、`agent_ip_history`、`ip_change_events` | §5.1、§5.2、§5.5、§5.6（R1/R2/R9/R18） |
| `0004_metrics.sql` | `metrics_raw`（按天分区）+ `metrics_raw_default` + 分区辅助函数 + `metrics_1m`/`metrics_5m` | §5.7、§5.7.3、§5.8（R5/R14） |
| `0005_telemetry.sql` | `process_snapshots`、`probe_results` | §5.9、§5.10（R10） |
| `0006_alerting.sql` | `channels`、`silences`、`alert_rules`、`alert_events`、`notification_log` | §5.4、§5.11、§5.12（R8/R11/R12） |
| `0007_audit.sql` | `audit_logs` | §5.13（R10） |
| `0008_privileges.sql` | 把 DML 授权给 `vantage_app`、只读授权给 `vantage_ro`（角色不存在则静默跳过） | §2（R13） |

共 16 张业务表（含 `metrics_raw_default` 兜底分区共 17 个物理表名）。

## 3. 除文档要求外，本脚本额外补齐的工程细节

> 以下均为「文档标 ➕ 建议」或文档未写但**实现必需**的项；如需回退请改迁移文件而不是手工改库。

**约束（防守性 CHECK）**

| 位置 | 补齐内容 | 理由 |
|---|---|---|
| `agents.public_slug` | 字符集 CHECK `^[2-9A-HJ-NP-Za-km-z]{8,12}$` | 落实 R9「随机短 ID、避开易混字符」；**顺带从库层面杜绝公开 URL 泄露内部 UUID**（UUID 含连字符、长度 36，必然不匹配） |
| `agents.agent_secret_enc` | 密文信封 CHECK `^v1:iv:tag:ct$` | ⚠️ 实现期修订：HMAC 验签需中心**解出** secret 重算，故该列由文档的「只存哈希」改为 **AES-256-GCM 密文**；本约束确保落库的一定是密文信封，误写明文会被直接拒绝 |
| `agents.agent_key_hash` | `^[0-9a-f]{64}$` | 固定 HMAC-SHA256 十六进制形态，防止误存明文 |
| `agents.ip_flapping` / `status` | 单方向一致性 CHECK | 只拦「说自己是 Flapping/禁用却没有时间戳」的非法态，不拦历史数据修正 |
| `users` | `password_hash IS NOT NULL OR oidc_subject IS NOT NULL` | 文档 §5.3 明确要求：⛔ 不允许空密码本地登录 |
| `users` | TOTP 已启用 ⇒ 密钥与绑定时间必须存在 | 防止「totp_enabled=true 但无密钥」把账号锁死 |
| `alert_rules.expr` | `CHECK (expr IS NULL)` | ⚠️ **零 RCE 兜底**：本期不落任何表达式。将来接 CEL/expr-lang 沙箱时必须**显式删除本约束**并在文档登记 |
| `alert_rules` | 阈值类必填 metric/op/threshold；`metric_match` 与 metric 形态自洽 | 把 §5.11 的白名单规则下沉到库层（接口层仍要校验 `params`） |
| `alert_events` | `resolved_at >= started_at`、`status='resolved' ⇒ resolved_at 非空` | 事件时间线自洽 |
| `notification_log` | `attempt >= 1`；`ok OR error IS NOT NULL` | 失败必须留原因，排障依赖它 |
| `metrics_raw` | 指标名规范校验 + 拒绝 NaN/±Infinity + `labels` 必须为对象 | 拒绝非有限浮点与畸形序列名，避免污染降采样与图表。⚠️ 实现坑：PG 的 `isfinite()` **没有 `float8` 重载**，必须写成 `value NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)`（PG 里 `NaN = NaN` 为真，故该写法能正确拦下 NaN） |
| `process_snapshots.top` | `jsonb_array_length(top) <= 50` | 与上报 schema 数组上限一致（§5.2） |
| `channels.name` / `alert_rules.name` | `UNIQUE` | 文档未要求；面板按名选择时重名会直接导致误配，故加唯一约束 |

**索引（为保留期清理服务）**

文档只提到 PK 前缀索引，但 §8.2 的清理任务是**按时间列单条件批量 DELETE**：这类语句用不上
`(agent_id, metric, bucket)` 前缀。因此额外建了这些单列索引：

`metrics_1m(bucket)`、`metrics_5m(bucket)`、`probe_results(checked_at)`、
`process_snapshots(ts)`、`agent_ip_history(last_seen)`、`notification_log(ts)`、`audit_logs(ts)`、
`silences(ends_at)`、`silences(starts_at)`。

**分区辅助**

`vantage_metrics_raw_partition_name(date)` / `vantage_ensure_metrics_raw_partition(date)` /
`vantage_metrics_raw_partitions()`，并在迁移时预建「今天 + 未来 7 天」分区。
- BRIN 索引建在**每个分区上**（由 `vantage_ensure_metrics_raw_partition` 负责），而不是父表上的分区索引
  —— 避免依赖分区索引对 BRIN 的支持范围；
- `vantage_metrics_raw_partitions()` 供 Drop 任务按 UTC 日期枚举过期分区，⛔ 不靠字符串猜表名。

**其它**

- `updated_at` 由触发器 `vantage_touch_updated_at()` 维护（`users` / `channels` / `alert_rules` / `settings`）；
- `gen_random_uuid()` 用 PG 13+ 内置函数，**不需要 pgcrypto 扩展**；
- 时序三表（`metrics_raw` / `metrics_1m` / `metrics_5m`）**故意不建 `agents` 外键**：高写入量路径上外键校验
  成本高，越权由接入层「body 内 agent_id 必须与签名者一致」保证（§6.2）；其余表全部带 FK。

## 4. 已知陷阱（踩过一次就别再踩）

1. **DEFAULT 分区与 attach 冲突**：若某天的行已经落进 `metrics_raw_default`，之后为该天 `CREATE TABLE ... PARTITION OF`
   会因「更新 DEFAULT 分区约束失败」而报错（PG 会锁住并扫描 DEFAULT 分区）。
   → 对策：core 每日预建未来 ≥7 天分区（`PARTITION_PRE_CREATE_DAYS`），并把该错误当作**告警**上报。
2. **`alert_events_firing_uidx` 对 `metric IS NULL` 不去重**：唯一索引中 NULL 互不相等，因此
   `offline` / `ip_change` / `clock_drift` 这类**无 metric** 的事件型规则不会被此索引去重。
   → 对策：由告警引擎的状态机保证「同一规则+主机同时只有一条 firing」，或后续补一个
   `UNIQUE (rule_id, agent_id, COALESCE(metric,'')) WHERE status='firing'`（**需先拍板**，见 §6）。
3. **时序表无 FK**（有意为之，见上）；删除 Agent 用 `status='disabled'` 软删，⛔ 不物理删除（§4 约定）。
4. **`metrics_1m` / `metrics_5m` 不分区**：长期跑必须监控表膨胀率与 `n_dead_tup`，必要时手动 `VACUUM (ANALYZE)`。
5. **新增表后要重跑 `0008_privileges.sql`**：迁移运行器不会自动重跑，`vantage_app` 会因此缺权限。
6. `0008` 里的 `ALTER DEFAULT PRIVILEGES FOR ROLE vantage_migrator` 要求执行迁移的角色**是
   `vantage_migrator` 的成员**；否则只授权当前角色创建的对象（会打印 NOTICE）。

## 5. 新增迁移的规则

1. 文件名 `NNNN_描述.sql`（4 位数字前缀，全局唯一，字典序即执行序）；
2. **只前进不回滚**：修正历史错误请新增文件，⛔ 不要改已应用的文件（校验和会拦住你）；
3. 尽量**幂等**：用 `IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP ... IF EXISTS`；
4. 必须是**事务可容纳**的语句；
5. 在文件头写清「依据（文档章节 + 决策编号）」，便于日后追溯；
6. 表/列若与文档冲突，**先改文档再加迁移**——文档是契约，库是契约的落地。

## 6. 待 Owner 拍板（实现期新发现，不阻塞 M1）

| # | 议题 | 现状 | 影响 |
|---|---|---|---|
| M-1 | `nonce_reused` 的 HTTP 状态码 | `docs/api.md` §1.3 曾写 401，§2.1 与 §6 验收用例写 **409**；已按 409 统一（更具体者胜），文档已同步修订 | 仅影响文档一致性，代码已按 409 实现 |
| M-2 | 无 metric 的事件型规则并发去重 | 见 §4 陷阱 2；当前依赖引擎状态机 | 若要库层兜底，需加 `COALESCE(metric,'')` 的部分唯一索引 |
| M-3 | `agent_secret` 存储形态 | ✅ 已拍板（本轮）：列改名 `agent_secret_enc`、AES-256-GCM 加密、`X-Agent-Key` 补回请求头；文档（设计 §9、`docs/database.md` §5.1、`docs/api.md` §2.1、`docs/agent.md` §6.2）已同步 | 已闭环 |
| M-4 | BRIN 的 `pages_per_range`（当前 32）与是否真需要 BRIN | 文档标 ➕ 建议、待压测 | 仅性能，可在压测后调整 |

## 7. 验证状态

- ✅ **已在真实 PostgreSQL 上完整跑通**：`npm test` 中的 `test/schema.test.js` 会把 8 个迁移文件
  逐条应用到一个**进程内 PostgreSQL**（PGlite/WASM，真解析器 + 真执行器），并断言：
  17 张表与分区形态、`vantage_metrics_raw_partitions()` 的 8 个日分区与幂等建分区、
  JS `buildMetric()` 产出与库层校验器同源、主键/唯一/CHECK/FK/触发器行为、
  `DEFAULT` 分区陷阱可复现、保留期 DELETE 语句可用、迁移 0008 的授权与「无 DDL」断言。
- 🐞 该测试在首次运行时**抓出一个真实缺陷**：`isfinite(double precision)` 在 PostgreSQL 中不存在
  （`isfinite` 只有 date/timestamp/interval 重载），已改为 `NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)`。
  ⛔ 这条约束若没被验证过，会在首次建表时直接失败。
- ⚠️ 版本差异：PGlite 内置的是 PostgreSQL **18.x**，部署目标是 **16**。所用特性均为 PG 9.4–13 起稳定的
  语法，因此 16 上同样成立；但**首次上真库前仍建议在一台 PG 16 上跑一次 `npm run migrate`** 作为最终确认。
- ⚠️ 运行器本身（连接、advisory lock、`--status`、校验和漂移拦截）的**网络路径**未在本机实测
  （本机当前没有运行中的 PG，Docker 守护进程未启动）；其纯逻辑分支已被 `test/migrations.test.js` 覆盖。
