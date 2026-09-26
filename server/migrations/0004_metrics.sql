-- =============================================================================
-- Vantage · vantage-core 迁移 0004：指标时序层
-- 依据：docs/database.md §5.7（metrics_raw，按天分区）、§5.7.3（分区与索引）、
--       §5.8（metrics_1m / metrics_5m，不分区 + 分批 DELETE）、§8.1 保留期矩阵
-- 决策：#11/#38（保留期与降采样）、R5（维度写进指标名，主键 (agent_id, metric, ts) 不变）、
--       R14（降采样层不分区）、R19（维度值变化视为新序列，不迁移历史）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- metrics_raw — 原始 15s 指标（按天 RANGE 分区）
--   ✅ 权威时间是中心接收时间 server_ts（= ts，分区键）
--   ✅ 维度写进 metric 全名，故主键 (agent_id, metric, ts) 足以区分挂载点/网卡/GPU
--   ⛔ 不建 agent_id 外键：时序层为高写入量路径，外键校验成本高；
--      越权由接入层「body 内 agent_id 必须与签名者一致」保证（§6.2 跨机越权）
-- -----------------------------------------------------------------------------
CREATE TABLE metrics_raw (
  agent_id UUID             NOT NULL,
  metric   TEXT             NOT NULL,   -- 序列全名：基名 或 基名{维度=值,...}
  value    DOUBLE PRECISION NOT NULL,
  labels   JSONB            NOT NULL DEFAULT '{}'::jsonb,  -- 由 metric 反解的便利副本，⛔ 非权威
  ts       TIMESTAMPTZ      NOT NULL,   -- server_ts（权威时间）

  PRIMARY KEY (agent_id, metric, ts),
  CONSTRAINT metrics_raw_metric_ck CHECK (vantage_is_valid_metric_name(metric)),
  CONSTRAINT metrics_raw_labels_ck CHECK (vantage_jsonb_is_object(labels)),
  -- 拒绝 NaN / ±Infinity：否则会污染 1m/5m 的 avg/min/max 并让图表出现断点或爆轴。
  -- ⚠️ 注意 PG 的 isfinite() 只有 date/timestamp/interval 重载，**没有 float8 版本**，
  --    因此这里必须用 NOT IN 逐值比较（PG 中 NaN = NaN 为真，故 `x <> 'NaN'` 能正确筛掉 NaN）。
  CONSTRAINT metrics_raw_value_ck
    CHECK (value NOT IN ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision))
) PARTITION BY RANGE (ts);

COMMENT ON TABLE  metrics_raw IS
  '原始指标层（15s，按天分区 metrics_raw_YYYYMMDD）；✅ 保留 15 天，按分区 DROP（秒级、无 VACUUM 压力）';
COMMENT ON COLUMN metrics_raw.metric IS
  '序列全名（维度写在名字里，§5.7.2）；基名如 disk.used_pct，全名如 disk.used_pct{device=sda1,mount=/data}';
COMMENT ON COLUMN metrics_raw.labels IS
  '维度便利副本（由 metric 反解，便于排查/前端直读）；⛔ 非权威、不参与唯一性，两者不一致以 metric 为准';
COMMENT ON COLUMN metrics_raw.ts IS 'server_ts（中心接收时间，决策 #16）；agent_ts 仅存 agents.last_agent_ts 用于漂移检测';

-- 兜底 DEFAULT 分区：分区维护任务失败时写入不报错（运维再拆出）
-- ⚠️ 陷阱：DEFAULT 分区若已落入某天的行，之后为该天 CREATE 分区会因「约束冲突」而失败
--    （PG 需要 ACCESS EXCLUSIVE 锁定并扫描 DEFAULT 分区）。因此 core 必须**预建未来 7 天**分区，
--    并在该错误发生时告警（见 docs/database.md §5.7.3）。
CREATE TABLE metrics_raw_default PARTITION OF metrics_raw DEFAULT;

-- -----------------------------------------------------------------------------
-- 分区维护辅助（由 core 定时任务调用；DDL 使用 vantage_migrator 连接）
-- -----------------------------------------------------------------------------

-- 分区名：metrics_raw_YYYYMMDD（UTC 日）
CREATE OR REPLACE FUNCTION vantage_metrics_raw_partition_name(p_day date) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 'metrics_raw_' || to_char(p_day, 'YYYYMMDD');
$$;

-- 幂等建某天分区（含 BRIN 索引）
CREATE OR REPLACE FUNCTION vantage_ensure_metrics_raw_partition(p_day date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_name  text := vantage_metrics_raw_partition_name(p_day);
  v_start timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_end   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
BEGIN
  IF to_regclass(format('public.%I', v_name)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF metrics_raw FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end);

    -- BRIN 适合只追加、按时间天然聚集的分区表，体积远小于 btree。
    -- 单独建在每个分区上（而非父表上的分区索引），避免依赖分区索引对 BRIN 的支持范围。
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING BRIN (ts) WITH (pages_per_range = 32)',
      v_name || '_ts_brin', v_name);
  END IF;

  RETURN v_name;
END $$;

COMMENT ON FUNCTION vantage_ensure_metrics_raw_partition(date) IS
  '幂等创建某 UTC 日的 metrics_raw 分区（含 BRIN(ts)）；由 core 分区维护任务调用，需 DDL 权限';

-- 列出既有按天分区（供 Drop 过期分区用；DEFAULT 分区不在结果中）
CREATE OR REPLACE FUNCTION vantage_metrics_raw_partitions()
RETURNS TABLE (partition_name text, partition_day date)
LANGUAGE sql STABLE AS $$
  SELECT c.relname::text,
         to_date(substring(c.relname from 'metrics_raw_([0-9]{8})$'), 'YYYYMMDD')
  FROM pg_class c
  JOIN pg_inherits i ON i.inhrelid = c.oid
  JOIN pg_class    p ON p.oid = i.inhparent
  WHERE p.relname = 'metrics_raw'
    AND c.relname ~ '^metrics_raw_[0-9]{8}$'
  ORDER BY 2;
$$;

COMMENT ON FUNCTION vantage_metrics_raw_partitions() IS
  '列出 metrics_raw 的按天分区与对应 UTC 日期；Drop 任务据此删除早于 now()-15d 的分区';

-- 启动/首次迁移时预建「今天 + 未来 7 天」分区（幂等）
DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_day   date;
BEGIN
  FOR v_day IN SELECT generate_series(v_today, v_today + 7, interval '1 day')::date LOOP
    PERFORM vantage_ensure_metrics_raw_partition(v_day);
  END LOOP;
END $$;

-- DEFAULT 分区的 BRIN（其余分区由函数内建）
CREATE INDEX IF NOT EXISTS metrics_raw_default_ts_brin
  ON metrics_raw_default USING BRIN (ts) WITH (pages_per_range = 32);

-- -----------------------------------------------------------------------------
-- metrics_1m / metrics_5m — 降采样层（✅ R14：不分区，每日分批 DELETE）
--   ⛔ 不建 (agent_id, metric, bucket DESC) 额外索引：PK 已是同前缀，PG 可反向扫描（§5.8）
--   ➕ bucket 单列索引：专门服务保留期清理的「按 bucket 批量删除」
-- -----------------------------------------------------------------------------
CREATE TABLE metrics_1m (
  agent_id UUID             NOT NULL,
  metric   TEXT             NOT NULL,   -- 与原始层完全同一命名（含维度全名）
  bucket   TIMESTAMPTZ      NOT NULL,   -- 桶起点，对齐 UTC 整分
  v_avg    DOUBLE PRECISION,
  v_min    DOUBLE PRECISION,
  v_max    DOUBLE PRECISION,
  v_last   DOUBLE PRECISION,
  n        INT,                         -- 桶内样本数（判断数据完整度/画断点）

  PRIMARY KEY (agent_id, metric, bucket),
  CONSTRAINT metrics_1m_metric_ck CHECK (vantage_is_valid_metric_name(metric)),
  CONSTRAINT metrics_1m_n_ck      CHECK (n IS NULL OR n > 0)
);

COMMENT ON TABLE metrics_1m IS
  '1 分钟降采样（✅ 保留 90 天）；不分区，每日分批 DELETE（1 万行/批）+ 依赖 autovacuum';

CREATE INDEX metrics_1m_bucket_idx ON metrics_1m (bucket);   -- 保留期分批 DELETE

CREATE TABLE metrics_5m (
  agent_id UUID             NOT NULL,
  metric   TEXT             NOT NULL,
  bucket   TIMESTAMPTZ      NOT NULL,   -- 桶起点，对齐 UTC 5 分钟
  v_avg    DOUBLE PRECISION,
  v_min    DOUBLE PRECISION,
  v_max    DOUBLE PRECISION,
  v_last   DOUBLE PRECISION,
  n        INT,

  PRIMARY KEY (agent_id, metric, bucket),
  CONSTRAINT metrics_5m_metric_ck CHECK (vantage_is_valid_metric_name(metric)),
  CONSTRAINT metrics_5m_n_ck      CHECK (n IS NULL OR n > 0)
);

COMMENT ON TABLE metrics_5m IS
  '5 分钟降采样（✅ 保留 1 年）；不分区，每日分批 DELETE + 依赖 autovacuum';

CREATE INDEX metrics_5m_bucket_idx ON metrics_5m (bucket);   -- 保留期分批 DELETE
