-- =============================================================================
-- Vantage · vantage-core 迁移 0007：审计日志
-- 依据：docs/database.md §5.13（audit_logs）、§11 安全与合规
-- 决策：R10（保留 365 天）；设计 §13 安全清单「面板侧操作留审计日志」为必做项
-- =============================================================================

CREATE TABLE audit_logs (
  id         BIGSERIAL   PRIMARY KEY,
  actor      TEXT        NOT NULL,                    -- 面板用户 uuid / 'agent:<id>' / 'system'
  actor_type TEXT        NOT NULL,
  action     TEXT        NOT NULL,                    -- agent.create / agent.rotate / rule.update / login / settings.update …
  target     TEXT,
  ip         INET,
  detail     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT audit_logs_actor_type_ck CHECK (actor_type IN ('user', 'agent', 'system')),
  CONSTRAINT audit_logs_detail_ck     CHECK (vantage_jsonb_is_object(detail))
);

COMMENT ON TABLE  audit_logs IS
  '审计日志（✅ 保留 365 天，R10）；登录/会话/凭证/规则/通道/设置变更均须留痕';
COMMENT ON COLUMN audit_logs.detail IS
  '⛔ 脱敏后的变更详情：禁止写入 key、secret 明文、Cookie、SMTP 密码；settings 变更记 key/旧值/新值';

CREATE INDEX audit_logs_ts_idx     ON audit_logs (ts DESC);
CREATE INDEX audit_logs_ts_plain_idx ON audit_logs (ts);              -- 保留期分批 DELETE
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor, ts DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, ts DESC);
