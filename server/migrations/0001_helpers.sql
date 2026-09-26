-- =============================================================================
-- Vantage · vantage-core 迁移 0001：通用辅助函数与触发器
-- 依据：docs/database.md §4（命名与类型约定）、§5.7.2（指标命名与转义规范）
-- 约定：迁移只前进不回滚（docs/database.md §10）；本文件可重复执行（幂等）
-- 说明：PostgreSQL 16 内置 gen_random_uuid()，无需 pgcrypto 扩展
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. updated_at 自动维护触发器
--    用于 users / channels / alert_rules / settings 等有 updated_at 的表
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vantage_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

COMMENT ON FUNCTION vantage_touch_updated_at() IS
  'BEFORE UPDATE 触发器函数：把 updated_at 置为 now()（服务端 UTC）';

-- -----------------------------------------------------------------------------
-- 2. 指标名校验（同步实现于 server/src/utils/metric.js 的 buildMetric）
--    规范见 docs/database.md §5.7.2：
--      基名          [a-z][a-z0-9_]*（可含 . 分隔的多段，如 disk.used_pct）
--      维度块        {k=v,k=v}，键名 [a-z0-9_]，多个维度按**键名字母序**拼接
--      维度值        禁止裸 { } = , 与空白；这些字符必须百分号编码（%25 %7B %7D %3D %2C %20）
--      全名长度      ≤ 200
--    ⚠️ 本函数是**校验器**（接受 JS 端 buildMetric 产出的超集），不是生产者。
--       它刻意不校验「维度键是否已按字母序排列」——排序恒定性由两端同源实现 + 共用测试向量保证。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vantage_is_valid_metric_name(p_name text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_name IS NOT NULL
     AND char_length(p_name) BETWEEN 1 AND 200
     AND p_name ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\{[a-z0-9_]+=[^{}=,[:space:]]+(,[a-z0-9_]+=[^{}=,[:space:]]+)*\})?$';
$$;

COMMENT ON FUNCTION vantage_is_valid_metric_name(text) IS
  '校验指标序列全名是否符合 §5.7.2 命名与转义规范（长度 ≤200，无裸空白/花括号/等号/逗号）';

-- -----------------------------------------------------------------------------
-- 3. 通用小工具：JSONB 必须为数组 / 对象（CHECK 里直接用，保持可读性）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vantage_jsonb_is_array(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_value IS NOT NULL AND jsonb_typeof(p_value) = 'array';
$$;

CREATE OR REPLACE FUNCTION vantage_jsonb_is_object(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_value IS NOT NULL AND jsonb_typeof(p_value) = 'object';
$$;
