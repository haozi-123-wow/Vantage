-- =============================================================================
-- Vantage · 数据库与角色初始化（**由 DBA / 超级用户执行一次**）
--
-- 依据：docs/database.md §2（角色划分）、§10（初始化：scripts/ 提供建库脚本，✅ 密钥不写进脚本）
--
-- ⛔ 本文件不创建表：表结构一律走 `npm run migrate`（server/migrations/）。
--    本脚本只做三件事：建角色 → 建库 → 授权连接。
--
-- 用法（在能连接 PG 超级用户的机器上）：
--
--   # ① 不带口令创建（推荐）：建完后用 psql 的 \password 交互式设置（输入不回显、不进 history）
--   psql -U postgres -f server/scripts/init-db.sql
--   psql -U postgres -c "\password vantage_migrator"
--   psql -U postgres -c "\password vantage_app"
--
--   # ② 直接带口令（⚠️ 口令会出现在本机 shell history 与 ps 输出里，仅适合一次性/本地环境）
--   psql -U postgres -v app_password='...' -v migrator_password='...' -f server/scripts/init-db.sql
--
--   # 自定义库名
--   psql -U postgres -v db_name=vantage_prod -f server/scripts/init-db.sql
--
-- 完成后：
--   1) 把两条连接串填进 server/.env（DATABASE_URL 用 vantage_app；MIGRATOR_DATABASE_URL 用 vantage_migrator）
--   2) 执行 `npm run migrate`（会顺带应用迁移 0008 把细粒度 DML 权限授予 vantage_app）
-- =============================================================================

\set ON_ERROR_STOP on

\if :{?db_name}
\else
  \set db_name vantage
\endif

\echo ''
\echo '=== Vantage 数据库初始化 ==='
\echo '目标库名：' :db_name
\echo ''

-- -----------------------------------------------------------------------------
-- 1. 角色（不存在才创建；⛔ 已存在的角色不会被改动，避免误改现有权限）
-- -----------------------------------------------------------------------------
SELECT format('CREATE ROLE %I LOGIN', 'vantage_migrator')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vantage_migrator')
\gexec

SELECT format('CREATE ROLE %I LOGIN', 'vantage_app')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vantage_app')
\gexec

-- 可选：只读排障/BI 角色（docs/database.md §2）
SELECT format('CREATE ROLE %I LOGIN', 'vantage_ro')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vantage_ro')
\gexec

-- 可选口令（仅当用 -v xxx_password=... 传入时执行）
\if :{?migrator_password}
ALTER ROLE vantage_migrator PASSWORD :'migrator_password';
\else
\echo '提示：未提供 migrator_password，请稍后执行  psql -U postgres -c "\password vantage_migrator"'
\endif

\if :{?app_password}
ALTER ROLE vantage_app PASSWORD :'app_password';
\else
\echo '提示：未提供 app_password，请稍后执行  psql -U postgres -c "\password vantage_app"'
\endif

\if :{?ro_password}
ALTER ROLE vantage_ro PASSWORD :'ro_password';
\endif

-- 角色默认不允许建库/建角色（最小权限基线）
ALTER ROLE vantage_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE vantage_app      NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE vantage_ro       NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- -----------------------------------------------------------------------------
-- 2. 数据库（owner = vantage_migrator，因为迁移与分区维护都要 DDL）
-- -----------------------------------------------------------------------------
SELECT format('CREATE DATABASE %I OWNER vantage_migrator ENCODING ''UTF8''', :'db_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name')
\gexec

-- -----------------------------------------------------------------------------
-- 3. 连接权限收紧：⛔ 默认禁止 PUBLIC 连接，只放行三个角色
--    （docs/database.md §11：数据库只监听本地/容器内网，且权限最小化）
-- -----------------------------------------------------------------------------
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO vantage_migrator;
GRANT CONNECT ON DATABASE :"db_name" TO vantage_app;
GRANT CONNECT ON DATABASE :"db_name" TO vantage_ro;

\echo ''
\echo '✔ 角色与数据库已就绪。下一步：'
\echo '   1) 在 server/.env 填写 DATABASE_URL（vantage_app）与 MIGRATOR_DATABASE_URL（vantage_migrator）'
\echo '   2) cd server && npm run migrate'
\echo '   3) npm run migrate:status 应显示全部「已应用」'
\echo ''
