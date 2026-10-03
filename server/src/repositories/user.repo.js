/**
 * Vantage · 面板账号数据访问（`users` + `user_recovery_codes`）
 *
 * 依据：docs/database.md §5.3（users）、§5.4（user_recovery_codes / settings）、§11（凭证只存哈希）；
 *       docs/api.md §4.1（登录 / 改密 / 2FA）、§4.9（⛔ 任何接口都不得返回 password_hash / totp_secret_enc）
 *
 * 分层：routes → services → repositories（设计 §5.1）。⛔ 本模块**只做 SQL**，不做业务判断：
 *   「密码对不对」「该不该 403」「要不要踢下线」全部由服务层决定；这里只负责把行搬进搬出。
 *
 * ⛔ 两列只允许在鉴权路径读取，且**永不**进日志/响应/请求对象：
 *     `password_hash`（Argon2id 哈希）、`totp_secret_enc`（AES-256-GCM 密文信封）。
 *     面板可见的用户对象一律走 `toPublicUser()`，别自己拼 SELECT 列。
 *
 * ⚠️ 多语句不变式（TOTP 重置、恢复码整批替换）**必须在事务内调用**（用 `db/pg.js` 的
 *    `withTransaction()` 包起来），否则可能出现「绑定已清、恢复码还在」这类半完成状态。
 */

// -----------------------------------------------------------------------------
// 行 → 领域对象
// -----------------------------------------------------------------------------

/**
 * 面板可安全展示的用户对象（⛔ 白名单式构造，不做整体解构）。
 * @param {object} row `users` 行（或含同名列的查询结果）
 * @returns {{ id: string, username: string, display_name: string|null, role: string, status: string, totp_enabled: boolean }}
 */
export function toPublicUser(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name ?? null,
    role: row.role,
    status: row.status,
    totp_enabled: row.totp_enabled === true,
  };
}

// -----------------------------------------------------------------------------
// users
// -----------------------------------------------------------------------------

/**
 * 鉴权用查询：按登录名取密码哈希、TOTP 状态与账号状态。
 *
 * 🔑 用 `lower(username)` 匹配：库里的唯一索引就是 `lower(username)`（迁移 0002），
 *    若这里写成 `username = $1`，则「Admin」查不到「admin」，同时该索引也会失去作用。
 *
 * ⚠️ 返回值含 `passwordHash` / `totpSecretEnc` —— 调用方**只允许**在鉴权路径本地使用。
 *    ⛔ 不要把整个对象挂到 `request` 上、更不要进日志（那等于把 2FA 密钥密文与密码哈希一起落盘）。
 *
 * @param {import('pg').Pool | import('pg').PoolClient} runner
 * @param {string} username
 * @returns {Promise<null | { id: string, username: string, displayName: string|null, role: string, status: string, passwordHash: string|null, totpSecretEnc: string|null, totpEnabled: boolean, disabledAt: Date|null }>}
 */
export async function findUserForAuth(runner, username) {
  const { rows } = await runner.query(
    `SELECT id, username, display_name, role, status, password_hash, totp_secret_enc, totp_enabled, disabled_at
       FROM users
      WHERE lower(username) = lower($1)`,
    [username],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    passwordHash: row.password_hash,
    totpSecretEnc: row.totp_secret_enc,
    totpEnabled: row.totp_enabled === true,
    disabledAt: row.disabled_at,
  };
}

/**
 * 鉴权用查询（**按 id**）：改密路径需要当前哈希，但手里只有会话里的 user_id。
 * ⚠️ 与 `findUserForAuth` 的差别只在 WHERE 条件（id vs lower(username)）——
 *    ⛔ 不要为了省一个函数把 uuid 传进 findUserForAuth：`lower(uuid)` 永远匹配不到，
 *    调用方会把"查无此人"误判成"账号被删"，我在联调时就这么炸过一次。
 *
 * ⚠️ 返回值含 `passwordHash` / `totpSecretEnc` —— 同样只允许在鉴权路径本地使用。
 *
 * @param {import('pg').Pool | import('pg').PoolClient} runner
 * @param {string} userId
 * @returns {Promise<null | { id: string, username: string, displayName: string|null, role: string, status: string, passwordHash: string|null, totpSecretEnc: string|null, totpEnabled: boolean, disabledAt: Date|null }>}
 */
export async function findUserAuthById(runner, userId) {
  const { rows } = await runner.query(
    `SELECT id, username, display_name, role, status, password_hash, totp_secret_enc, totp_enabled, disabled_at
       FROM users
      WHERE id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    passwordHash: row.password_hash,
    totpSecretEnc: row.totp_secret_enc,
    totpEnabled: row.totp_enabled === true,
    disabledAt: row.disabled_at,
  };
}

/**
 * 按主键取**可展示**的用户（`auth/me`、面板用）。⛔ 不含任何敏感列。
 * @param {import('pg').Pool | import('pg').PoolClient} runner
 * @param {string} userId
 */
export async function findUserById(runner, userId) {
  const { rows } = await runner.query(
    `SELECT id, username, display_name, role, status, totp_enabled, totp_bound_at, created_at
       FROM users
      WHERE id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...toPublicUser(row),
    totp_bound_at: row.totp_bound_at ?? null,
    created_at: row.created_at,
  };
}

/**
 * 新建面板账号。
 * ⚠️ `password_hash` 由调用方先算好（`crypto.js` 的 `hashPassword`，Argon2id）——
 *    本模块⛔ 不接受明文密码，避免"明文路过数据层"这种最容易泄漏的路径。
 *
 * @param {import('pg').Pool | import('pg').PoolClient} runner
 * @param {{ username: string, passwordHash: string, role?: 'admin'|'user', displayName?: string|null, email?: string|null }} input
 */
export async function insertUser(runner, input) {
  const { rows } = await runner.query(
    `INSERT INTO users (username, display_name, email, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, username, display_name, email, role, status, totp_enabled, created_at`,
    [
      input.username,
      input.displayName ?? null,
      input.email ?? null,
      input.passwordHash,
      input.role ?? 'user',
    ],
  );
  return rows[0];
}

/**
 * 更新密码哈希（改密与 CLI 重置密码共用）。
 *
 * ⛔ 本函数**不**负责踢会话：会话在 Redis（`user_sessions:<uid>`），属服务层职责
 *    （docs/api.md §4.1「成功 → 轮换 sid + 踢其它会话」）。
 *
 * @returns {Promise<boolean>} 是否命中该用户
 */
export async function updatePasswordHash(runner, userId, passwordHash) {
  const { rowCount } = await runner.query(
    `UPDATE users SET password_hash = $2 WHERE id = $1`,
    [userId, passwordHash],
  );
  return rowCount > 0;
}

/**
 * 记录一次成功登录（⛔ 失败不写：账号不存在的尝试没有 user_id，且不该污染用户行）。
 * @param {import('pg').Pool | import('pg').PoolClient} runner
 * @param {string} userId
 * @param {{ ip?: string|null, method?: 'password'|'totp'|'oidc' }} [info]
 */
export async function touchLogin(runner, userId, info = {}) {
  await runner.query(
    `UPDATE users
        SET last_login_at = now(), last_login_ip = $2::inet, last_login_method = $3
      WHERE id = $1`,
    [userId, info.ip ?? null, info.method ?? 'password'],
  );
}

/**
 * 写入（或覆盖）待确认的 TOTP 密钥。
 *
 * 🔑 **刻意不碰 `totp_enabled`**：绑定分两步（setup 写种子 → enable 验码通过才生效，docs/api.md §4.1）。
 *    如果这里顺手把 `totp_enabled` 置 false，一个服务层的小 bug（漏判"已启用"）就会把
 *    已绑定的用户**静默降级为不要求 2FA** —— 安全能力"悄悄关掉"是最不该发生的一类缺陷。
 *    「已启用时禁止重新 setup」是服务层的判断，本模块只回传当前状态供其断言。
 *
 * @returns {Promise<null | { id: string, totpEnabled: boolean }>} 用户不存在时 null
 */
export async function setTotpSecret(runner, userId, secretEnc) {
  const { rows } = await runner.query(
    `UPDATE users SET totp_secret_enc = $2 WHERE id = $1 RETURNING id, totp_enabled`,
    [userId, secretEnc],
  );
  const row = rows[0];
  return row ? { id: row.id, totpEnabled: row.totp_enabled === true } : null;
}

/**
 * 置 `totp_enabled = true` 并记绑定时间。
 * 🔑 `totp_secret_enc IS NOT NULL` 是**显式守卫**：没有种子就不可能通过验证，
 *    万一被误调用，这里返回 null 让服务层给出 400，而不是靠数据库 CHECK 抛 23514 变成 500。
 * @returns {Promise<null | { id: string, totpBoundAt: Date }>}
 */
export async function enableTotp(runner, userId) {
  const { rows } = await runner.query(
    `UPDATE users
        SET totp_enabled = true, totp_bound_at = now()
      WHERE id = $1 AND totp_secret_enc IS NOT NULL
      RETURNING id, totp_bound_at`,
    [userId],
  );
  const row = rows[0];
  return row ? { id: row.id, totpBoundAt: row.totp_bound_at } : null;
}

/**
 * 解绑 TOTP（清空种子与绑定时间）。
 * ⚠️ 只动 `users`；恢复码的作废见 `resetTotp()`（两者必须一起做，否则留下悬空的救命码）。
 * @returns {Promise<boolean>}
 */
export async function disableTotp(runner, userId) {
  const { rowCount } = await runner.query(
    `UPDATE users
        SET totp_enabled = false, totp_secret_enc = NULL, totp_bound_at = NULL
      WHERE id = $1`,
    [userId],
  );
  return rowCount > 0;
}

/**
 * 「恢复渠道二」的数据库侧：解绑 TOTP **并**作废该用户全部恢复码。
 *
 * 依据 docs/api.md §4.9（管理员后台 2FA 重置的语义）与 §4.1（自助解绑）。
 * ⛔ **必须在事务内调用**：否则可能出现「绑定已清、恢复码仍是可用凭据」的半完成状态。
 * ⛔ 强制踢下线不在这里——会话在 Redis，由服务层负责（本模块看不到 Redis）。
 *
 * @returns {Promise<{ userUpdated: boolean, codesDeleted: number }>}
 */
export async function resetTotp(runner, userId) {
  const userUpdated = await disableTotp(runner, userId);
  const { rowCount } = await runner.query(
    `DELETE FROM user_recovery_codes WHERE user_id = $1`,
    [userId],
  );
  return { userUpdated, codesDeleted: rowCount };
}

/**
 * 用户列表（CLI `--list` 与后续面板用户管理用）。⛔ 绝不 SELECT `password_hash` / `totp_secret_enc`。
 * @param {import('pg').Pool | import('pg').PoolClient} runner
 * @param {{ limit?: number }} [options]
 */
export async function listUsers(runner, options = {}) {
  const { rows } = await runner.query(
    `SELECT u.id, u.username, u.display_name, u.email, u.role, u.status,
            u.totp_enabled, u.totp_bound_at, u.last_login_at, u.last_login_ip,
            u.last_login_method, u.created_at,
            (SELECT count(*)::int FROM user_recovery_codes c
              WHERE c.user_id = u.id AND c.used_at IS NULL) AS recovery_codes_left
       FROM users u
      ORDER BY u.username
      LIMIT $1`,
    [options.limit ?? 200],
  );
  return rows;
}

/**
 * 统计**启用中的**管理员数量。
 * 用途：CLI 建号后提示「库里还没有管理员」；后续用户管理接口在降级/禁用最后一个管理员前必须查它。
 */
export async function countAdmins(runner) {
  const { rows } = await runner.query(
    `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`,
  );
  return rows[0]?.n ?? 0;
}

// -----------------------------------------------------------------------------
// user_recovery_codes
// -----------------------------------------------------------------------------

/**
 * 整批替换恢复码（重新生成＝旧码**立即作废**，✅ docs/api.md §4.1）。
 * ⛔ **必须在事务内调用**（本函数是两条独立语句：先删后插）。
 * @param {import('pg').Pool | import('pg').PoolClient} runner 事务客户端
 * @param {string} userId
 * @param {string[]} codeHashes 已算好的 HMAC 哈希（明文不经过这里，见 crypto.js hashRecoveryCode）
 * @returns {Promise<number>} 写入条数
 */
export async function replaceRecoveryCodes(runner, userId, codeHashes) {
  await runner.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
  if (codeHashes.length === 0) return 0;
  const { rowCount } = await runner.query(
    `INSERT INTO user_recovery_codes (user_id, code_hash)
     SELECT $1, unnest($2::text[])`,
    [userId, codeHashes],
  );
  return rowCount;
}

/**
 * 消耗一个恢复码（**一次性**：用后置 `used_at` 即作废）。
 *
 * 🔑 为什么做成单条 `UPDATE ... RETURNING` 而不是「先查后改」：
 *    先查后改在并发下会**同一个码被用两次**（两个请求都查到 used_at IS NULL）。
 *    单语句的 `WHERE used_at IS NULL` 由行锁保证只有一个事务能把它置位。
 *
 * @param {import('pg').Pool | import('pg').PoolClient} runner
 * @param {string} userId
 * @param {string} codeHash 归一化后的 HMAC 哈希
 * @returns {Promise<boolean>} 命中且成功作废为 true；不存在/已用过为 false
 */
export async function consumeRecoveryCode(runner, userId, codeHash) {
  const { rowCount } = await runner.query(
    `UPDATE user_recovery_codes
        SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, codeHash],
  );
  return rowCount > 0;
}

/** 该用户可用（未使用）的恢复码数量——前端「剩余 ≤2 强提示重生成」依赖它 */
export async function countActiveRecoveryCodes(runner, userId) {
  const { rows } = await runner.query(
    `SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}
