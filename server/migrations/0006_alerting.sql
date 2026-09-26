-- =============================================================================
-- Vantage · vantage-core 迁移 0006：告警与通知
-- 依据：docs/database.md §5.4（channels / silences）、§5.11（alert_rules）、§5.12（事件与通知日志）
-- 决策：#23（通道令牌桶）、R8（基名/全名两种引用语义）、R11（规则只存 channels.id 数组）、
--       R12（非阈值参数统一 params JSONB + 按 kind 白名单）、#39（Flapping 期间暂停 IP 类告警）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- channels — 通知通道配置（通道是凭证与模板的**唯一归属方**，密钥全局只存一份）
-- -----------------------------------------------------------------------------
CREATE TABLE channels (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  config     JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- 敏感项（SMTP 密码/加签 secret）应用层加密
  template   JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- 每通道独立模板
  rate_limit JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- 令牌桶参数（速率/突发）
  enabled    BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT channels_kind_ck       CHECK (kind IN ('smtp', 'wecom', 'dingtalk', 'feishu', 'webhook')),
  CONSTRAINT channels_name_key      UNIQUE (name),       -- ➕ 补齐：通道显示名唯一，便于面板选择
  CONSTRAINT channels_config_ck     CHECK (vantage_jsonb_is_object(config)),
  CONSTRAINT channels_template_ck   CHECK (vantage_jsonb_is_object(template)),
  CONSTRAINT channels_rate_limit_ck CHECK (vantage_jsonb_is_object(rate_limit))
);

COMMENT ON TABLE  channels IS
  '通知通道（smtp/wecom/dingtalk/feishu/webhook）。规则只引用 channels.id；⛔ 删除被引用通道返回 409 channel_in_use，不级联删除';
COMMENT ON COLUMN channels.config IS
  '通道参数；SMTP 密码/Webhook 加签 secret 等敏感项必须应用层加密（密钥来自 env，⛔ 不入库）';
COMMENT ON COLUMN channels.enabled IS
  '关={false} 时规则保留关联但跳过发送，并写 notification_log(ok=false, error=channel_disabled)';

DROP TRIGGER IF EXISTS channels_touch_updated_at ON channels;
CREATE TRIGGER channels_touch_updated_at
  BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION vantage_touch_updated_at();

-- -----------------------------------------------------------------------------
-- silences — 静默窗口 / 维护期（target 与 alert_rules.target 同构）
-- -----------------------------------------------------------------------------
CREATE TABLE silences (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,                        -- 维护说明
  target     JSONB       NOT NULL,                        -- {agents:[..]} / {tags:[..]} / {all:true}
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  created_by UUID        REFERENCES users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT silences_target_ck CHECK (vantage_jsonb_is_object(target)),
  CONSTRAINT silences_window_ck CHECK (ends_at > starts_at)
);

COMMENT ON TABLE silences IS
  '静默窗口/维护期；过期后 7 天清理（✅ R10：DELETE WHERE ends_at < now() - interval ''7 day''）';

CREATE INDEX silences_window_idx    ON silences (ends_at);
CREATE INDEX silences_starts_at_idx ON silences (starts_at);

-- -----------------------------------------------------------------------------
-- alert_rules — 告警规则（受控阈值 DSL，⛔ 零 RCE：只做数值比较、绝不 eval）
-- -----------------------------------------------------------------------------
CREATE TABLE alert_rules (
  id           UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT             NOT NULL,
  target       JSONB            NOT NULL,
  kind         TEXT             NOT NULL,
  metric       TEXT,                                       -- 阈值类：基名 或 全名（✅ R8）
  metric_match TEXT,                                       -- ➕ 派生列：base / exact（⛔ 非权威）
  op           TEXT,                                       -- 比较符（受控 DSL）
  expr         TEXT,                                       -- ✅ 扩展位：默认 NULL 且不执行
  threshold    DOUBLE PRECISION,
  duration     INT              NOT NULL DEFAULT 0,        -- 持续时长（秒），§7.1 的 for
  severity     TEXT             NOT NULL,
  channels     JSONB            NOT NULL DEFAULT '[]'::jsonb,  -- ✅ channels.id 数组（R11）
  cooldown     INT              NOT NULL DEFAULT 0,        -- 静默期（秒）
  enabled      BOOLEAN          NOT NULL DEFAULT true,
  params       JSONB            NOT NULL DEFAULT '{}'::jsonb,  -- 非阈值类参数（✅ R12）
  created_by   UUID             REFERENCES users (id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),

  CONSTRAINT alert_rules_kind_ck
    CHECK (kind IN ('threshold', 'offline', 'ip_change', 'probe', 'clock_drift')),
  CONSTRAINT alert_rules_severity_ck
    CHECK (severity IN ('info', 'warn', 'critical')),
  CONSTRAINT alert_rules_op_ck
    CHECK (op IS NULL OR op IN ('>', '>=', '<', '<=')),
  CONSTRAINT alert_rules_metric_match_ck
    CHECK (metric_match IS NULL OR metric_match IN ('base', 'exact')),
  CONSTRAINT alert_rules_target_ck   CHECK (vantage_jsonb_is_object(target)),
  CONSTRAINT alert_rules_channels_ck CHECK (vantage_jsonb_is_array(channels)),
  CONSTRAINT alert_rules_params_ck   CHECK (vantage_jsonb_is_object(params)),
  CONSTRAINT alert_rules_metric_ck
    CHECK (metric IS NULL OR vantage_is_valid_metric_name(metric)),
  CONSTRAINT alert_rules_duration_ck CHECK (duration >= 0),
  CONSTRAINT alert_rules_cooldown_ck CHECK (cooldown >= 0),
  -- 阈值类规则必须给出 指标 + 比较符 + 阈值；非阈值类不必（多为 NULL）
  CONSTRAINT alert_rules_threshold_required_ck
    CHECK (kind <> 'threshold' OR (metric IS NOT NULL AND op IS NOT NULL AND threshold IS NOT NULL)),
  -- metric_match 与 metric 形态必须自洽：无 { → base；有 { → exact（⛔ 不作权威，仅为回显/查询便利）
  CONSTRAINT alert_rules_metric_match_consistent_ck
    CHECK (
      metric_match IS NULL
      OR (metric IS NOT NULL AND ((metric_match = 'base') = (position('{' in metric) = 0)))
    ),
  -- ⚠️ 零 RCE 兜底：本期 expr 一律为 NULL。将来接入 CEL/expr-lang 沙箱时**显式删除本约束**。
  CONSTRAINT alert_rules_expr_disabled_ck CHECK (expr IS NULL)
);

COMMENT ON TABLE  alert_rules IS
  '告警规则（受控阈值 DSL + 四类事件型规则）；⛔ 中心只做数值比较，绝不 eval expr';
COMMENT ON COLUMN alert_rules.metric IS
  '✅ R8：基名（如 disk.used_pct）= 对该基名下每个维度序列分别判定；全名（如 disk.used_pct{mount=/data}）= 只判该单序列';
COMMENT ON COLUMN alert_rules.metric_match IS
  '派生列 base/exact，可由 metric 是否含 { 推出；仅供查询/UI 回显，⛔ 非权威';
COMMENT ON COLUMN alert_rules.channels IS
  '✅ R11：channels.id 数组；通道是凭证与模板的唯一归属方，规则不内联通道参数';
COMMENT ON COLUMN alert_rules.params IS
  '✅ R12：非阈值类参数（probe/ip_change/offline/clock_drift 各自白名单结构），未知键直接拒绝';

CREATE UNIQUE INDEX alert_rules_name_uidx   ON alert_rules (name);   -- ➕ 补齐：规则名唯一
CREATE INDEX        alert_rules_kind_idx    ON alert_rules (kind) WHERE enabled;
CREATE INDEX        alert_rules_enabled_idx ON alert_rules (enabled);

DROP TRIGGER IF EXISTS alert_rules_touch_updated_at ON alert_rules;
CREATE TRIGGER alert_rules_touch_updated_at
  BEFORE UPDATE ON alert_rules
  FOR EACH ROW EXECUTE FUNCTION vantage_touch_updated_at();

-- -----------------------------------------------------------------------------
-- alert_events — 告警触发/恢复事件（✅ 永久保留，决策 #11）
-- -----------------------------------------------------------------------------
CREATE TABLE alert_events (
  id          BIGSERIAL        PRIMARY KEY,
  rule_id     UUID             NOT NULL REFERENCES alert_rules (id) ON DELETE RESTRICT,
  agent_id    UUID             NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  value       DOUBLE PRECISION,                            -- 触发时的实际值
  metric      TEXT,                                        -- 触发序列**全名**（阈值类必填）
  labels      JSONB            NOT NULL DEFAULT '{}'::jsonb,  -- 由全名反解（⛔ 非权威）
  started_at  TIMESTAMPTZ      NOT NULL,
  resolved_at TIMESTAMPTZ,
  status      TEXT             NOT NULL,
  notified_at TIMESTAMPTZ,                                 -- 最后一次成功通知时间

  CONSTRAINT alert_events_status_ck
    CHECK (status IN ('firing', 'resolved', 'suppressed')),
  CONSTRAINT alert_events_metric_ck
    CHECK (metric IS NULL OR vantage_is_valid_metric_name(metric)),
  CONSTRAINT alert_events_labels_ck CHECK (vantage_jsonb_is_object(labels)),
  -- 恢复态必须有恢复时间（单方向约束，避免误拦 suppressed→resolved 的中间态）
  CONSTRAINT alert_events_resolved_ck CHECK (status <> 'resolved' OR resolved_at IS NOT NULL),
  CONSTRAINT alert_events_order_ck    CHECK (resolved_at IS NULL OR resolved_at >= started_at)
);

COMMENT ON TABLE  alert_events IS
  '告警事件（firing/resolved/suppressed）；✅ 永久保留（决策 #11）；⛔ 本期无「ack 认领」语义';
COMMENT ON COLUMN alert_events.metric IS
  '触发序列全名（如 disk.used_pct{mount=/data}）——同一规则在多挂载点上各触发一条的事件区分依据（✅ R8）';

CREATE INDEX alert_events_agent_idx      ON alert_events (agent_id, started_at DESC);
CREATE INDEX alert_events_status_idx     ON alert_events (status, started_at DESC);
CREATE INDEX alert_events_rule_idx       ON alert_events (rule_id, started_at DESC);
CREATE INDEX alert_events_rule_agent_metric_idx ON alert_events (rule_id, agent_id, metric);
-- 同一序列 + 同一规则同时只允许一条 firing 事件（防并发重复触发）
-- ⚠️ 注意：metric 为 NULL 时（offline/ip_change/clock_drift 等事件型规则）NULL 互不相等，
--    本索引**不提供去重**；此类规则的并发去重需由告警引擎侧的状态机保证（见 migrations/README.md）。
CREATE UNIQUE INDEX alert_events_firing_uidx
  ON alert_events (rule_id, agent_id, metric) WHERE status = 'firing';

-- -----------------------------------------------------------------------------
-- notification_log — 每次发送结果（✅ 保留 180 天，R10）
-- -----------------------------------------------------------------------------
CREATE TABLE notification_log (
  id         BIGSERIAL   PRIMARY KEY,
  event_id   BIGINT      NOT NULL REFERENCES alert_events (id) ON DELETE RESTRICT,
  channel_id UUID        REFERENCES channels (id) ON DELETE SET NULL,  -- ➕ 可回溯配置
  channel    TEXT,                                                     -- 设计字段：通道类型快照
  target     TEXT,                                                     -- 实际接收方（邮箱/群机器人）
  ok         BOOLEAN     NOT NULL,
  error      TEXT,
  attempt    INT         NOT NULL DEFAULT 1,                           -- ➕ 重试次数
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_log_attempt_ck CHECK (attempt >= 1),
  -- 失败必须留原因（channel_disabled / 超时 / 非 2xx …），便于排障
  CONSTRAINT notification_log_error_ck   CHECK (ok OR error IS NOT NULL)
);

COMMENT ON TABLE  notification_log IS
  '通知发送明细（✅ 保留 180 天）；channel_id 可空 = 通道已删除（ON DELETE SET NULL，历史仍可查）';
COMMENT ON COLUMN notification_log.channel IS
  '通道类型快照（smtp/wecom/...），与 channel_id 并存：前者用于通道删除后仍能读懂历史';

CREATE INDEX notification_log_event_idx ON notification_log (event_id);
CREATE INDEX notification_log_ts_idx    ON notification_log (ts DESC);
CREATE INDEX notification_log_ts_plain_idx ON notification_log (ts);   -- 保留期分批 DELETE
