-- =============================================================================
-- Vantage · vantage-core 迁移 0003：被监控主机、凭证与 IP 追踪
-- 依据：docs/database.md §5.1（agents）、§5.2（单套凭证 + 到期提醒）、
--       §5.5（agent_ip_history）、§5.6（ip_change_events）
-- 决策：R1（不做新旧凭证并存）、R2（name 唯一）、R9（public_slug）、R18（状态机三态）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- agents — 被监控主机 + 单套凭证哈希 + 当前状态/当前 IP
-- -----------------------------------------------------------------------------
CREATE TABLE agents (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT        NOT NULL,                  -- 主机名/别名，唯一
  public_slug        TEXT        NOT NULL,                  -- 公开接口唯一对外标识（⛔ 不是内部 UUID）
  display_name       TEXT,                                  -- 公开视图显示名
  agent_key_hash     TEXT        NOT NULL,                  -- ⛔ 明文永不入库/入日志
  agent_secret_enc   TEXT        NOT NULL,                  -- HMAC secret 的密文（AES-256-GCM）
  tags               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  status             TEXT        NOT NULL DEFAULT 'offline',
  last_ip            INET,                                  -- 当前主出口 IP（IP 变化比较基准）
  last_seen_at       TIMESTAMPTZ,                           -- 每次上报即心跳
  last_agent_ts      BIGINT,                                -- 最后一次上报的 agent_ts（漂移检测）
  clock_drift_ms     BIGINT,                                -- 最近一次计算的漂移
  reported_ip        INET,                                  -- Agent 自报出口 IP（与 last_ip 双源比对）
  host_info          JSONB,                                 -- 最近一次 host 对象快照
  capabilities       JSONB,                                 -- 能力声明快照（host.capabilities）
  ip_flapping        BOOLEAN     NOT NULL DEFAULT false,
  flapping_since     TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at         TIMESTAMPTZ,                           -- 最后一次**手动**轮换时间（从未轮换为 NULL）
  rotate_reminder_at TIMESTAMPTZ,                           -- 上次「该轮换凭证」提醒时间（按日期去重）
  disabled_at        TIMESTAMPTZ,

  -- ✅ 决策 R2：name 唯一
  CONSTRAINT agents_name_key        UNIQUE (name),
  -- ✅ 决策 R9：公开标识唯一
  CONSTRAINT agents_public_slug_key UNIQUE (public_slug),
  -- ✅ 决策 R18：状态机只有三态，⛔ 不引入 abnormal
  CONSTRAINT agents_status_ck       CHECK (status IN ('online', 'offline', 'disabled')),
  -- 公开标识格式：8–12 位、小写/大写/数字但排除易混的 0 O 1 l I。
  -- 附带收益：内部 UUID（36 位含连字符）**必然**不满足本约束，从库层面杜绝公开 URL 泄露内部 ID。
  CONSTRAINT agents_public_slug_format_ck
    CHECK (public_slug ~ '^[2-9A-HJ-NP-Za-km-z]{8,12}$'),
  CONSTRAINT agents_tags_ck         CHECK (vantage_jsonb_is_array(tags)),
  -- ✅ 本轮修订：secret 必须**可逆存储**（HMAC 验签要中心解出 secret 重算签名），
  -- 故存 AES-256-GCM 密文而非哈希；本约束确保落库的一定是本模块产出的密文信封，
  -- 万一有人误写明文（如 sk-xxx）会直接被库拒绝。
  CONSTRAINT agents_secret_envelope_ck
    CHECK (agent_secret_enc ~ '^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]*={0,2}$'),
  CONSTRAINT agents_key_hash_ck     CHECK (agent_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agents_host_info_ck    CHECK (host_info IS NULL OR vantage_jsonb_is_object(host_info)),
  CONSTRAINT agents_capabilities_ck CHECK (capabilities IS NULL OR vantage_jsonb_is_object(capabilities)),
  -- 单方向一致性约束（避免误拦历史数据修正）
  CONSTRAINT agents_flapping_ck     CHECK (NOT ip_flapping OR flapping_since IS NOT NULL),
  CONSTRAINT agents_disabled_ck     CHECK (status <> 'disabled' OR disabled_at IS NOT NULL)
);

COMMENT ON TABLE  agents IS
  '被监控主机与单套凭证（✅ R1：不做新旧并存/自动轮换，旧凭证轮换后立即失效）';
COMMENT ON COLUMN agents.public_slug IS
  '公开接口唯一标识（✅ R9）；随机短 ID，不随 name/display_name 变化，⛔ 公开响应与 URL 不含内部 UUID';
COMMENT ON COLUMN agents.agent_key_hash IS
  'agent_key 的 HMAC-SHA256(pepper=SECRET_KEY) 哈希（**不可逆**，用于身份校验 X-Agent-Key）；明文仅在创建/轮换时返回一次';
COMMENT ON COLUMN agents.agent_secret_enc IS
  'HMAC secret 的 AES-256-GCM 密文（v1:iv:tag:ct）。⚠️ 必须可逆：中心要解出 secret 才能重算上报签名；⛔ 明文不落库、不入日志';
COMMENT ON COLUMN agents.rotated_at IS '最后一次手动轮换时间；轮换提醒阈值取自 settings.credential_rotate.reminder_days（默认 90 天）';
COMMENT ON COLUMN agents.status IS 'online / offline / disabled（✅ R18；「有告警/时钟漂移/Flapping」用派生徽标表达，不进状态机）';

CREATE INDEX agents_tags_gin_idx        ON agents USING GIN (tags);
CREATE INDEX agents_status_idx          ON agents (status);
CREATE INDEX agents_last_seen_idx       ON agents (last_seen_at);            -- 离线判定扫描
CREATE INDEX agents_rotate_reminder_idx ON agents ((COALESCE(rotated_at, created_at)));  -- 轮换提醒扫描

-- -----------------------------------------------------------------------------
-- agent_ip_history — IP 出现区间（双源：remote / agent_reported）
-- -----------------------------------------------------------------------------
CREATE TABLE agent_ip_history (
  id         BIGSERIAL   PRIMARY KEY,
  agent_id   UUID        NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  ip         INET        NOT NULL,
  source     TEXT        NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen  TIMESTAMPTZ NOT NULL,           -- 同一 IP 连续上报只更新此列（UPSERT）

  CONSTRAINT agent_ip_history_source_ck CHECK (source IN ('remote', 'agent_reported')),
  CONSTRAINT agent_ip_history_window_ck CHECK (last_seen >= first_seen)
);

COMMENT ON TABLE agent_ip_history IS
  'IP 出现区间；仅记录主出口 IP（私网/回环/虚拟网卡在写入前过滤）。保留 180 天（✅ R10）';

CREATE UNIQUE INDEX agent_ip_history_upsert_uidx
  ON agent_ip_history (agent_id, ip, source);                                -- ON CONFLICT 目标
CREATE INDEX agent_ip_history_agent_seen_idx
  ON agent_ip_history (agent_id, last_seen DESC);
CREATE INDEX agent_ip_history_last_seen_idx
  ON agent_ip_history (last_seen);                                           -- 保留期分批 DELETE

-- -----------------------------------------------------------------------------
-- ip_change_events — IP 变化事件 + Flapping 事件（✅ 永久保留，决策 #11）
-- -----------------------------------------------------------------------------
CREATE TABLE ip_change_events (
  id           BIGSERIAL   PRIMARY KEY,
  agent_id     UUID        NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  old_ip       INET,                          -- 首次记录 IP 时为 NULL
  new_ip       INET        NOT NULL,
  same_subnet  BOOLEAN,                       -- §8「是否同网段」
  changed_at   TIMESTAMPTZ NOT NULL,
  source       TEXT,                          -- remote / agent_reported
  kind         TEXT        NOT NULL DEFAULT 'change',
  change_count INT,                           -- 触发 Flapping 判定时 10 分钟窗口内的变化次数
  subnet_prev  CIDR,                          -- 便于「跨网段变化」规则复算
  subnet_next  CIDR,

  CONSTRAINT ip_change_events_kind_ck   CHECK (kind IN ('change', 'flapping')),
  CONSTRAINT ip_change_events_source_ck CHECK (source IS NULL OR source IN ('remote', 'agent_reported')),
  CONSTRAINT ip_change_events_count_ck  CHECK (change_count IS NULL OR change_count >= 0)
);

COMMENT ON TABLE ip_change_events IS
  'IP 变化与 Flapping 事件（决策 #39：Flapping 只记一条事件，期间暂停 IP 变化类告警）；✅ 永久保留';

CREATE INDEX ip_change_events_agent_idx ON ip_change_events (agent_id, changed_at DESC);
CREATE INDEX ip_change_events_kind_idx  ON ip_change_events (kind, changed_at DESC);
