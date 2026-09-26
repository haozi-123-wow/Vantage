-- =============================================================================
-- Vantage · vantage-core 迁移 0005：非时序观测数据
-- 依据：docs/database.md §5.9（process_snapshots）、§5.10（probe_results）
-- 决策：R10（保留期：process_snapshots 30 天、probe_results 90 天）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- process_snapshots — 进程总数 + Top-N（Top-N 为 JSONB，本层最占空间的表）
-- -----------------------------------------------------------------------------
CREATE TABLE process_snapshots (
  id       BIGSERIAL   PRIMARY KEY,
  agent_id UUID        NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  ts       TIMESTAMPTZ NOT NULL,                        -- server_ts（权威时间）
  total    INT         NOT NULL DEFAULT 0,              -- 进程总数
  top      JSONB       NOT NULL DEFAULT '[]'::jsonb,    -- [{pid,name,cpu,mem}]

  CONSTRAINT process_snapshots_total_ck CHECK (total >= 0),
  -- 数组长度上限与上报 schema 白名单一致（设计 §5.2 数组长度上限）
  CONSTRAINT process_snapshots_top_ck
    CHECK (jsonb_typeof(top) = 'array' AND jsonb_array_length(top) <= 50)
);

COMMENT ON TABLE  process_snapshots IS
  '进程总数 + Top-N 快照（Top-N 落此表，不进入 metrics_raw 时序）；✅ 保留 30 天（R10）';
COMMENT ON COLUMN process_snapshots.top IS
  '[{pid,name,cpu,mem}]，长度 ≤ 50；实时值形如 JSONB，需登录后可见';

CREATE INDEX process_snapshots_agent_ts_idx ON process_snapshots (agent_id, ts DESC);
CREATE INDEX process_snapshots_ts_idx       ON process_snapshots (ts);   -- 保留期分批 DELETE

-- -----------------------------------------------------------------------------
-- probe_results — Agent 本地探活结果（探活目标在 Agent 本地 config.yaml，⛔ 中心不下发）
-- -----------------------------------------------------------------------------
CREATE TABLE probe_results (
  id          BIGSERIAL        PRIMARY KEY,
  agent_id    UUID             NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  probe_name  TEXT             NOT NULL,   -- Agent 本地 config.yaml 中的探活名
  probe_type  TEXT             NOT NULL,   -- ping / http / https / tcp（预留 dns）
  target      TEXT             NOT NULL,
  up          BOOLEAN          NOT NULL,
  latency_ms  DOUBLE PRECISION,
  status_code INT,                         -- 仅 http/https
  error       TEXT,                        -- 失败原因（超时/连接拒绝/状态码不符）
  detail      JSONB,                       -- 可选：body_contains 命中情况等
  checked_at  TIMESTAMPTZ      NOT NULL,   -- server_ts（权威时间）

  CONSTRAINT probe_results_type_ck
    CHECK (probe_type IN ('ping', 'http', 'https', 'tcp', 'dns')),
  CONSTRAINT probe_results_latency_ck
    CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT probe_results_status_code_ck
    CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  CONSTRAINT probe_results_detail_ck
    CHECK (detail IS NULL OR vantage_jsonb_is_object(detail))
);

COMMENT ON TABLE  probe_results IS
  '本地探活结果（闭环：Agent 自采自判，中心只按规则判定与告警）；✅ 保留 90 天（R10）';
COMMENT ON COLUMN probe_results.probe_name IS
  'Agent 本地 config.yaml 中的探活名 —— 中心无权新增/修改探活目标（单向宗旨，设计 §4.6）';

CREATE INDEX probe_results_agent_probe_idx   ON probe_results (agent_id, probe_name, checked_at DESC);
CREATE INDEX probe_results_agent_checked_idx ON probe_results (agent_id, checked_at DESC);
CREATE INDEX probe_results_checked_at_idx    ON probe_results (checked_at);   -- 保留期分批 DELETE
