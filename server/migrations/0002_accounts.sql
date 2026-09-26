-- =============================================================================
-- Vantage · vantage-core 迁移 0002：面板账号与会话相关（users 及其附属表）
-- 依据：docs/database.md §5.3（users）、§5.4（user_recovery_codes / settings）
-- 决策：#31（面板账号在 PG users）、R3（role 两级）、R4（OIDC 预留字段）、R16（settings 表）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users — 面板账号（权限字段与 SSO 字段为本轮决策，字段名沿用文档建议）
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username          TEXT        NOT NULL,
  display_name      TEXT,
  email             TEXT,
  password_hash     TEXT,                                   -- Argon2id；SSO-only 用户为 NULL
  role              TEXT        NOT NULL DEFAULT 'user',
  totp_secret_enc   TEXT,                                   -- 应用层加密存储，未启用为 NULL
  totp_enabled      BOOLEAN     NOT NULL DEFAULT false,
  totp_bound_at     TIMESTAMPTZ,
  status            TEXT        NOT NULL DEFAULT 'active',
  last_login_at     TIMESTAMPTZ,
  last_login_ip     INET,
  last_login_method TEXT,
  -- OIDC SSO 预留（本期只落库，不实现流程）
  oidc_issuer       TEXT,
  oidc_subject      TEXT,
  oidc_email        TEXT,
  oidc_linked_at    TIMESTAMPTZ,
  oidc_last_sync_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at       TIMESTAMPTZ,

  CONSTRAINT users_role_ck       CHECK (role IN ('admin', 'user')),
  CONSTRAINT users_status_ck     CHECK (status IN ('active', 'disabled')),
  CONSTRAINT users_login_method_ck
    CHECK (last_login_method IS NULL OR last_login_method IN ('password', 'totp', 'oidc')),
  -- 至少一种登录方式：⛔ 不允许「无密码且未绑 SSO」的账号（防空密码本地登录）
  CONSTRAINT users_login_available_ck
    CHECK (password_hash IS NOT NULL OR oidc_subject IS NOT NULL),
  -- TOTP 已启用 ⇒ 密钥与绑定时间必须存在
  CONSTRAINT users_totp_ck
    CHECK (NOT totp_enabled OR (totp_secret_enc IS NOT NULL AND totp_bound_at IS NOT NULL)),
  -- 禁用态与 disabled_at 的一致性（单方向约束，避免误拦历史数据修正）
  CONSTRAINT users_disabled_ck
    CHECK (status <> 'disabled' OR disabled_at IS NOT NULL)
);

COMMENT ON TABLE  users IS '面板账号（本地密码 + TOTP 2FA + 后续 OIDC SSO 预留）';
COMMENT ON COLUMN users.password_hash IS 'Argon2id 哈希；SSO-only 账号为 NULL，且禁止以空密码本地登录';
COMMENT ON COLUMN users.role IS '权限：admin=全部操作（含凭证/用户/规则管理）；user=纯只读（R3/R7）';
COMMENT ON COLUMN users.totp_secret_enc IS 'TOTP 密钥密文（AES-256-GCM，密钥来自 env，不入库）';
COMMENT ON COLUMN users.oidc_subject IS 'OIDC sub；与 oidc_issuer 组成永久唯一身份（部分唯一索引）';

CREATE UNIQUE INDEX users_username_lower_uidx ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_uidx    ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_oidc_identity_uidx  ON users (oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL;

DROP TRIGGER IF EXISTS users_touch_updated_at ON users;
CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION vantage_touch_updated_at();

-- -----------------------------------------------------------------------------
-- user_recovery_codes — 2FA 一次性恢复码（固定 10 个/次）
-- -----------------------------------------------------------------------------
CREATE TABLE user_recovery_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,          -- 只存哈希，明文仅生成时返回一次
  used_at    TIMESTAMPTZ,                   -- 用后置位即作废（一次性）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_recovery_codes IS
  'TOTP 一次性恢复码；重新生成时整批作废/删除，管理员 2fa/reset 会清空该用户全部恢复码';

CREATE INDEX user_recovery_codes_active_idx
  ON user_recovery_codes (user_id) WHERE used_at IS NULL;   -- 查可用码数（剩余 ≤2 提示重生成）
CREATE INDEX user_recovery_codes_user_idx
  ON user_recovery_codes (user_id);                         -- 整批作废/删除

-- -----------------------------------------------------------------------------
-- settings — 面板可改的系统开关（key 白名单，值 JSONB，缺行取代码内默认值）
-- -----------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_by UUID        REFERENCES users (id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ⛔ 不放密钥：通道密钥在 channels.config、TOTP 密钥在 users.totp_secret_enc
  CONSTRAINT settings_value_not_null_ck CHECK (value <> 'null'::jsonb)
);

COMMENT ON TABLE  settings IS
  '面板可改的系统开关/参数（白名单 key：public_view.enabled / security.require_2fa / credential_rotate.* 等）';
COMMENT ON COLUMN settings.key IS
  '开关名；白名单在代码内（server/src/services/settings.service.js），未知 key 一律拒绝';
COMMENT ON COLUMN settings.updated_by IS '最近修改人（每次变更同时写 audit_logs: settings.update）';

DROP TRIGGER IF EXISTS settings_touch_updated_at ON settings;
CREATE TRIGGER settings_touch_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION vantage_touch_updated_at();
