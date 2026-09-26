-- =============================================================================
-- Vantage · vantage-core 迁移 0008：数据库角色权限（可选，按需生效）
-- 依据：docs/database.md §2（角色表：vantage_migrator / vantage_app / vantage_ro）、
--       §2 落地要求（分区维护走独立 DDL 连接，⛔ DDL 权限不挂在常规请求路径上）
--
-- 说明：
--   1. 本迁移**不创建角色**（CREATE ROLE 需要超级用户，且密码不得写进脚本）。
--      角色由 DBA 事先创建，见 server/scripts/init-db.sql。
--   2. 角色不存在时本迁移**静默跳过**（用 IF EXISTS 守卫），因此对单角色部署无副作用。
--   3. 若将来新增表，需要重新执行本文件（或等价 GRANT）——迁移运行器不会自动重跑，
--      可用 `npm run migrate -- --only 0008_privileges.sql --force` 重新应用。
-- =============================================================================

DO $$
BEGIN
  -- ---------------------------------------------------------------------------
  -- vantage_app：core 运行时连接 —— 仅 DML，⛔ 无 DDL（分区维护必须走 migrator 连接）
  -- ---------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vantage_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO vantage_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vantage_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vantage_app';

    -- 将来由 migrator 建的对象自动授权（含每天新建的 metrics_raw_* 分区）
    IF pg_has_role(current_user, 'vantage_migrator', 'MEMBER') THEN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE vantage_migrator IN SCHEMA public '
              'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vantage_app';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE vantage_migrator IN SCHEMA public '
              'GRANT USAGE, SELECT ON SEQUENCES TO vantage_app';
    ELSE
      RAISE NOTICE '当前角色 % 不是 vantage_migrator 成员：跳过 FOR ROLE vantage_migrator 的默认权限设置（新分区可能缺少 vantage_app 授权）', current_user;
    END IF;

    -- 本迁移自身创建的对象也一并授权
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vantage_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
            'GRANT USAGE, SELECT ON SEQUENCES TO vantage_app';

    -- public schema 上的 CREATE 权限：PG15+ 默认已不授予 PUBLIC，这里显式收紧一次
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM vantage_app';

    RAISE NOTICE 'vantage_app 权限已授予（仅 DML，无 DDL）';
  ELSE
    RAISE NOTICE '角色 vantage_app 不存在：跳过授权（单角色部署可忽略）';
  END IF;

  -- ---------------------------------------------------------------------------
  -- vantage_ro：只读排障/BI 连接 —— ⛔ 禁止 DDL
  -- ---------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vantage_ro') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO vantage_ro';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO vantage_ro';

    IF pg_has_role(current_user, 'vantage_migrator', 'MEMBER') THEN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE vantage_migrator IN SCHEMA public '
              'GRANT SELECT ON TABLES TO vantage_ro';
    END IF;

    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO vantage_ro';
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM vantage_ro';

    RAISE NOTICE 'vantage_ro 权限已授予（只读）';
  ELSE
    RAISE NOTICE '角色 vantage_ro 不存在：跳过授权（可选角色）';
  END IF;
END $$;
