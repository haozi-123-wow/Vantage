/**
 * 面板账号仓储层测试（**真 PostgreSQL / PGlite 上跑真 SQL**）
 *
 * 依据：docs/database.md §5.3（users）、§5.4（user_recovery_codes）、docs/api.md §4.1 / §4.1.1 ⑦ B2
 *
 * 为什么必须是真库：本用例要验证的东西**全是数据库语义**，替身证明不了——
 *   `lower(username)` 唯一索引、`role/status/login_method` 的 CHECK、`password_hash 或 oidc_subject` 的
 *   「至少一种登录方式」约束、`unnest` 批量插入、恢复码「用后即废」的并发安全写法（单语句 UPDATE）、
 *   以及事务回滚。fake-pg 只能证明 SQL 被"发出去过"。
 *
 * ⚠️ 事务：`replaceRecoveryCodes()` / `resetTotp()` 是**多语句不变式**，必须在事务内调用。
 *    本文件的适配器因此额外提供 `connect()`（`withTransaction` 需要），这也是它比 cron.test.js
 *    的适配器多一个方法的原因。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { withTransaction } from '../src/db/pg.js';
import {
  consumeRecoveryCode,
  countActiveRecoveryCodes,
  countAdmins,
  disableTotp,
  enableTotp,
  findUserForAuth,
  findUserById,
  insertUser,
  listUsers,
  replaceRecoveryCodes,
  resetTotp,
  setTotpSecret,
  toPublicUser,
  touchLogin,
  updatePasswordHash,
} from '../src/repositories/user.repo.js';

// -----------------------------------------------------------------------------
// 真库准备：与生产同一条迁移代码路径（roles 必须先建，0008 才生效）
// -----------------------------------------------------------------------------
const db = await PGlite.create();
await db.exec('CREATE ROLE vantage_migrator LOGIN; CREATE ROLE vantage_app LOGIN; CREATE ROLE vantage_ro LOGIN;');
await db.exec(BOOTSTRAP_SQL);

const migrations = loadMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
const migratorClient = {
  query: (sql, params) => (Array.isArray(params) && params.length > 0 ? db.query(sql, params) : db.exec(sql)),
};
for (const migration of migrations) {
  await applyOne(migratorClient, migration, false);
}

/** PGlite → node-pg 适配器（差异说明见 cron.test.js，两处必须抹平） */
async function run(sql, params = []) {
  if (Array.isArray(params) && params.length > 0) {
    const result = await db.query(sql, params);
    return { rows: result.rows ?? [], rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  }
  const results = await db.exec(sql);
  const last = Array.isArray(results) ? results.at(-1) : results;
  return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
}

/** 池形状：query + connect（后者供 withTransaction 使用） */
const pool = {
  query: run,
  connect: async () => ({ query: run, release: () => {} }),
};

after(async () => {
  await db.close();
});

/** settings.updated_by 是 ON DELETE RESTRICT，但用例不写 settings，故直接清 users 即可（恢复码级联删） */
beforeEach(async () => {
  await run('DELETE FROM users');
});

const FAKE_HASH = '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdGhhc2g';

async function seedUser(overrides = {}) {
  const row = await insertUser(pool, {
    username: 'admin',
    passwordHash: FAKE_HASH,
    role: 'admin',
    ...overrides,
  });
  return row.id;
}

async function pgError(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

// -----------------------------------------------------------------------------
// users：查询与唯一性
// -----------------------------------------------------------------------------

test('findUserForAuth：登录名大小写不敏感（库内唯一索引就是 lower(username)）', async () => {
  await seedUser({ username: 'Admin' });

  const lower = await findUserForAuth(pool, 'admin');
  const upper = await findUserForAuth(pool, 'ADMIN');
  assert.ok(lower, '小写查询必须命中');
  assert.equal(lower.username, 'Admin', '回传的是库里的原始大小写');
  assert.equal(upper.id, lower.id);
  assert.equal(lower.role, 'admin');
  assert.equal(lower.status, 'active');
  assert.equal(lower.passwordHash, FAKE_HASH, '鉴权路径必须能拿到密码哈希');
  assert.equal(lower.totpSecretEnc, null);
  assert.equal(lower.totpEnabled, false);

  assert.equal(await findUserForAuth(pool, 'nobody'), null);
});

test('登录名唯一：大小写不同也算重复（23505 + 索引名）', async () => {
  await seedUser({ username: 'admin' });
  const err = await pgError(() => seedUser({ username: 'ADMIN' }));
  assert.equal(err?.code, '23505');
  assert.equal(err?.constraint, 'users_username_lower_uidx');
});

test('邮箱唯一：大小写不敏感；email 为 NULL 可有多行（部分唯一索引）', async () => {
  await seedUser({ username: 'a', email: 'Ops@Example.com' });
  const err = await pgError(() => seedUser({ username: 'b', email: 'ops@example.com' }));
  assert.equal(err?.code, '23505');
  assert.equal(err?.constraint, 'users_email_lower_uidx');

  await seedUser({ username: 'c' });
  await seedUser({ username: 'd' });
  const { rows } = await run(`SELECT count(*)::int AS n FROM users WHERE email IS NULL`);
  assert.equal(rows[0].n, 2, 'NULL 邮箱不受唯一索引约束');
});

// -----------------------------------------------------------------------------
// users：约束与敏感列边界
// -----------------------------------------------------------------------------

test('CHECK 约束：role / status / login_method 非法值一律 23514', async () => {
  const roleErr = await pgError(() => seedUser({ username: 'x', role: 'root' }));
  assert.equal(roleErr?.code, '23514');
  assert.equal(roleErr?.constraint, 'users_role_ck');

  const id = await seedUser({ username: 'y' });
  const statusErr = await pgError(() => run(`UPDATE users SET status = 'locked' WHERE id = $1`, [id]));
  assert.equal(statusErr?.code, '23514');
  assert.equal(statusErr?.constraint, 'users_status_ck');

  const methodErr = await pgError(() => touchLogin(pool, id, { method: 'magic' }));
  assert.equal(methodErr?.code, '23514');
  assert.equal(methodErr?.constraint, 'users_login_method_ck');
});

test('「至少一种登录方式」：无密码且无 SSO 的账号必须插不进去（防空密码本地登录）', async () => {
  const err = await pgError(() =>
    run(`INSERT INTO users (username, password_hash, role) VALUES ('nopass', NULL, 'user')`),
  );
  assert.equal(err?.code, '23514');
  assert.equal(err?.constraint, 'users_login_available_ck');
});

test('敏感列边界：findUserForAuth 带哈希；findUserById / listUsers / toPublicUser ⛔ 不带', async () => {
  const id = await seedUser({ username: 'admin', passwordHash: FAKE_HASH });
  await setTotpSecret(pool, id, 'v1:aXY=:dGFn:Y3Q=');

  const byId = await findUserById(pool, id);
  const listed = (await listUsers(pool))[0];
  for (const [label, obj] of [
    ['findUserById', byId],
    ['listUsers', listed],
    ['toPublicUser', toPublicUser(await findUserById(pool, id))],
  ]) {
    assert.equal('password_hash' in obj, false, `${label} 不得含 password_hash`);
    assert.equal('passwordHash' in obj, false, `${label} 不得含 passwordHash`);
    assert.equal('totp_secret_enc' in obj, false, `${label} 不得含 totp_secret_enc`);
    assert.equal('totpSecretEnc' in obj, false, `${label} 不得含 totpSecretEnc`);
  }
  assert.equal(byId.username, 'admin');
  assert.equal(toPublicUser(byId).totp_enabled, false, '写入种子但未 enable ⇒ 对外仍是"未启用"');
});

test('listUsers：带可用恢复码计数，按登录名排序', async () => {
  const idA = await seedUser({ username: 'zeta' });
  await seedUser({ username: 'alpha' });
  await replaceRecoveryCodes(pool, idA, ['h1', 'h2', 'h3']);
  await consumeRecoveryCode(pool, idA, 'h1');

  const rows = await listUsers(pool);
  assert.deepEqual(rows.map((r) => r.username), ['alpha', 'zeta']);
  assert.equal(rows[1].recovery_codes_left, 2, '已用掉的恢复码不计入剩余');
});

test('updatePasswordHash / touchLogin：命中返回 true，登录三列一起写', async () => {
  const id = await seedUser({ username: 'admin' });
  assert.equal(await updatePasswordHash(pool, id, '$argon2id$new'), true);
  assert.equal((await findUserForAuth(pool, 'admin')).passwordHash, '$argon2id$new');
  assert.equal(await updatePasswordHash(pool, '11111111-2222-4333-8444-555555555555', 'x'), false);

  await touchLogin(pool, id, { ip: '203.0.113.7', method: 'totp' });
  const { rows } = await run(
    `SELECT last_login_at, last_login_ip, last_login_method FROM users WHERE id = $1`,
    [id],
  );
  assert.ok(rows[0].last_login_at instanceof Date);
  assert.equal(rows[0].last_login_ip, '203.0.113.7');
  assert.equal(rows[0].last_login_method, 'totp');

  await touchLogin(pool, id, { ip: null });
  const after2 = await run(`SELECT last_login_ip, last_login_method FROM users WHERE id = $1`, [id]);
  assert.equal(after2.rows[0].last_login_ip, null, 'IP 未知时写 NULL，不得抛错');
  assert.equal(after2.rows[0].last_login_method, 'password', '默认登录方式为 password');
});

// -----------------------------------------------------------------------------
// TOTP 绑定状态机
// -----------------------------------------------------------------------------

test('setTotpSecret：只写种子，⛔ 不动 totp_enabled（防"绑定被静默降级"）', async () => {
  const id = await seedUser({ username: 'admin' });
  const result = await setTotpSecret(pool, id, 'v1:iv:tag:ct');
  assert.deepEqual(result, { id, totpEnabled: false });

  const row = await findUserForAuth(pool, 'admin');
  assert.equal(row.totpSecretEnc, 'v1:iv:tag:ct');
  assert.equal(row.totpEnabled, false, '未通过 enable 验码前绝不生效');

  // 已启用后再 setup：本模块仍只覆盖种子、不改状态（"已启用禁止重新 setup"是服务层判断）
  await enableTotp(pool, id);
  await setTotpSecret(pool, id, 'v1:iv2:tag2:ct2');
  const after = await findUserForAuth(pool, 'admin');
  assert.equal(after.totpEnabled, true);
  assert.equal(after.totpSecretEnc, 'v1:iv2:tag2:ct2');
});

test('enableTotp：有种子才置 true 并写 bound_at；无种子返回 null（不靠 CHECK 抛 500）', async () => {
  const id = await seedUser({ username: 'admin' });
  assert.equal(await enableTotp(pool, id), null, '没有种子时不得启用');

  await setTotpSecret(pool, id, 'v1:iv:tag:ct');
  const enabled = await enableTotp(pool, id);
  assert.equal(enabled.id, id);
  assert.ok(enabled.totpBoundAt instanceof Date);

  const row = await findUserForAuth(pool, 'admin');
  assert.equal(row.totpEnabled, true);
});

test('disableTotp：同时清空 totp_enabled / 种子 / 绑定时间', async () => {
  const id = await seedUser({ username: 'admin' });
  await setTotpSecret(pool, id, 'v1:iv:tag:ct');
  await enableTotp(pool, id);

  assert.equal(await disableTotp(pool, id), true);
  const row = await findUserForAuth(pool, 'admin');
  assert.equal(row.totpEnabled, false);
  assert.equal(row.totpSecretEnc, null);
  const { rows } = await run(`SELECT totp_bound_at FROM users WHERE id = $1`, [id]);
  assert.equal(rows[0].totp_bound_at, null);
});

// -----------------------------------------------------------------------------
// 一次性恢复码
// -----------------------------------------------------------------------------

test('replaceRecoveryCodes：整批替换（旧码立即作废）、空数组=清空', async () => {
  const id = await seedUser({ username: 'admin' });
  assert.equal(await replaceRecoveryCodes(pool, id, ['old1', 'old2']), 2);
  assert.equal(await countActiveRecoveryCodes(pool, id), 2);

  assert.equal(await replaceRecoveryCodes(pool, id, ['new1', 'new2', 'new3']), 3);
  assert.equal(await countActiveRecoveryCodes(pool, id), 3);
  assert.equal(await consumeRecoveryCode(pool, id, 'old1'), false, '重新生成后旧码必须立即失效');
  assert.equal(await consumeRecoveryCode(pool, id, 'old2'), false);

  assert.equal(await replaceRecoveryCodes(pool, id, []), 0);
  assert.equal(await countActiveRecoveryCodes(pool, id), 0, '空数组 = 清空全部恢复码');
  assert.equal(await consumeRecoveryCode(pool, id, 'new1'), false);
});

test('consumeRecoveryCode：用后即废（同码第二次 false），且不跨用户', async () => {
  const idA = await seedUser({ username: 'a' });
  const idB = await seedUser({ username: 'b' });
  await replaceRecoveryCodes(pool, idA, ['hashA']);
  await replaceRecoveryCodes(pool, idB, ['hashB']);

  assert.equal(await consumeRecoveryCode(pool, idA, 'hashA'), true);
  assert.equal(await consumeRecoveryCode(pool, idA, 'hashA'), false, '一次性：第二次必须失败');
  assert.equal(await consumeRecoveryCode(pool, idA, 'hashB'), false, 'B 的码不能在 A 名下使用');
  assert.equal(await consumeRecoveryCode(pool, idB, 'hashB'), true);
  assert.equal(await countActiveRecoveryCodes(pool, idA), 0);

  const { rows } = await run(`SELECT used_at FROM user_recovery_codes WHERE user_id = $1`, [idA]);
  assert.ok(rows[0].used_at instanceof Date, '用过的码留痕（used_at）而不是删除');
});

test('resetTotp：一次清掉绑定 + 作废全部恢复码（事务内调用）', async () => {
  const id = await seedUser({ username: 'admin' });
  await setTotpSecret(pool, id, 'v1:iv:tag:ct');
  await enableTotp(pool, id);
  await replaceRecoveryCodes(pool, id, ['r1', 'r2']);

  const result = await withTransaction(pool, (client) => resetTotp(client, id));
  assert.deepEqual(result, { userUpdated: true, codesDeleted: 2 });

  const row = await findUserForAuth(pool, 'admin');
  assert.equal(row.totpEnabled, false);
  assert.equal(row.totpSecretEnc, null);
  assert.equal(await countActiveRecoveryCodes(pool, id), 0);
  assert.equal(await consumeRecoveryCode(pool, id, 'r1'), false, '恢复码必须已被作废');
});

test('事务契约：replaceRecoveryCodes 出错回滚后旧码仍在（证明"必须在事务内"是有效防线）', async () => {
  const id = await seedUser({ username: 'admin' });
  await replaceRecoveryCodes(pool, id, ['keep1', 'keep2']);

  await assert.rejects(
    withTransaction(pool, async (client) => {
      await replaceRecoveryCodes(client, id, ['brand-new']);
      throw new Error('模拟插入后失败');
    }),
    /模拟插入后失败/,
  );

  assert.equal(await countActiveRecoveryCodes(pool, id), 2, '回滚后旧码必须还在');
  assert.equal(await consumeRecoveryCode(pool, id, 'keep1'), true);
  assert.equal(await consumeRecoveryCode(pool, id, 'brand-new'), false);
});

// -----------------------------------------------------------------------------
// 管理员计数（「最后一个管理员」保护的基础）
// -----------------------------------------------------------------------------

test('countAdmins：只数 role=admin 且 status=active', async () => {
  assert.equal(await countAdmins(pool), 0);

  await seedUser({ username: 'admin1', role: 'admin' });
  await seedUser({ username: 'user1', role: 'user' });
  assert.equal(await countAdmins(pool), 1);

  const disabled = await seedUser({ username: 'admin2', role: 'admin' });
  await run(`UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1`, [disabled]);
  assert.equal(await countAdmins(pool), 1, '被禁用的管理员不计入');
});
