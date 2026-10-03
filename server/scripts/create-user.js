#!/usr/bin/env node
/**
 * Vantage · 面板账号运维 CLI（首管员 / 重置密码 / 重置 2FA）
 *
 * 为什么必需：`users` 表是**空的**，而登录接口不会自己长出第一个账号（docs/api.md §4.1.1 ⑥）。
 * 本脚本是「面板打不开时唯一的门」——M2 的 `POST /api/v1/users` 上线后它仍保留为离线救援工具。
 *
 * 用法
 *   node scripts/create-user.js --username admin --role admin --password-stdin
 *   node scripts/create-user.js --username ops --role user --display-name "运维（只读）" --password-stdin
 *   node scripts/create-user.js --list
 *   node scripts/create-user.js --reset-password ops --password-stdin
 *   node scripts/create-user.js --reset-2fa ops            # 离线版「恢复渠道二」（docs/api.md §4.9）
 *
 * ⛔ 密码只走 stdin 或交互式无回显输入：**不进 shell 历史、不进 `ps`、不进日志**。
 * ⛔ 任何输出都不打印密码、哈希或 TOTP 密钥；`--list` 的列由 `user.repo.js` 白名单保证。
 * ⚠️ 会话在 Redis 而不在 PG：本脚本**不会**踢掉在线会话（见 `--reset-password` 的提示）。
 *
 * 依据：docs/api.md §4.1.1 ⑥、docs/database.md §5.3/§5.4
 */

import readline from 'node:readline';

import { getConfig } from '../src/config/index.js';
import { createPool, withTransaction } from '../src/db/pg.js';
import {
  countAdmins,
  findUserForAuth,
  insertUser,
  listUsers,
  resetTotp,
  updatePasswordHash,
} from '../src/repositories/user.repo.js';
import { hashPassword } from '../src/utils/crypto.js';
import { createLogger } from '../src/utils/log.js';

/** 密码策略：与 docs/api.md §4.1.1 ⑧ D4 的建议一致（❓ 待 Owner 拍板，落地时两处一起改） */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

const HELP = `
Vantage 面板账号工具

  --username <登录名>       必需（建号时）。登录名大小写不敏感（库内 UNIQUE(lower(username))）
  --role <admin|user>       可选，默认 user。⚠️ 首个账号必须显式写 --role admin
  --display-name <显示名>   可选
  --email <邮箱>            可选（大小写不敏感唯一）
  --password-stdin          从 stdin 读取密码（**推荐**：不进 shell 历史与 ps）
  --list                    列出全部账号（⛔ 不含密码哈希 / TOTP 密钥）
  --reset-password <登录名> 重置密码
  --reset-2fa <登录名>      清除 TOTP 绑定并作废全部恢复码（离线版恢复渠道二）
  --help                    显示本帮助

不带 --password-stdin 时会在交互式终端里**无回显**地提示输入两次。
`;

function parseArgs(argv) {
  const args = { passwordStdin: false, list: false, resetPassword: null, reset2fa: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--list') args.list = true;
    else if (token === '--username') args.username = argv[++i];
    else if (token === '--role') args.role = argv[++i];
    else if (token === '--display-name') args.displayName = argv[++i];
    else if (token === '--email') args.email = argv[++i];
    else if (token === '--password-stdin') args.passwordStdin = true;
    else if (token === '--reset-password') args.resetPassword = argv[++i];
    else if (token === '--reset-2fa') args.reset2fa = argv[++i];
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`未知参数：${token}（用 --help 查看用法）`);
  }
  return args;
}

/** 读取 stdin 全部内容并取第一行（`printf %s "$PW" | ...` 与 `echo "$PW" | ...` 都能用） */
async function readPasswordFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

/**
 * 交互式无回显输入。
 * ⚠️ 靠 readline 的 `_writeToOutput`（内部 API）静音回显——这是社区通用做法，
 *    但它不是稳定契约；所以**推荐用 `--password-stdin`**，交互路径只作为手工操作的兜底。
 */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error(
          '当前不是交互式终端，无法安全地提示输入密码：请改用 --password-stdin\n' +
            '  例：printf %s "$VANTAGE_ADMIN_PW" | node scripts/create-user.js --username admin --role admin --password-stdin',
        ),
      );
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    const originalWrite = rl._writeToOutput.bind(rl);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl._writeToOutput = originalWrite;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    rl.on('error', reject);
  });
}

function assertPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw new Error(`密码至少 ${PASSWORD_MIN} 个字符`);
  }
  if (password.length > PASSWORD_MAX) {
    throw new Error(`密码不得超过 ${PASSWORD_MAX} 个字符`);
  }
}

/** 取新密码：stin 优先；否则交互式问两次（防手误把自己锁在门外） */
async function obtainNewPassword(useStdin, { confirm = true } = {}) {
  let password;
  if (useStdin) {
    password = await readPasswordFromStdin();
  } else {
    password = await promptHidden('新密码（输入不回显）：');
    if (confirm) {
      const again = await promptHidden('再输一次：');
      if (again !== password) throw new Error('两次输入不一致，已放弃');
    }
  }
  assertPasswordPolicy(password);
  return password;
}

/** 把 PG 的唯一约束错误翻成人话（否则只能看到一个 23505） */
function friendlyUniqueError(err, fields) {
  if (err?.code !== '23505') return err;
  if (/users_username_lower_uidx/.test(err.constraint ?? '')) {
    return new Error(`登录名「${fields.username}」已存在（大小写不敏感）：请换名，或先用 --list 确认`);
  }
  if (/users_email_lower_uidx/.test(err.constraint ?? '')) {
    return new Error(`邮箱「${fields.email}」已被占用（大小写不敏感）`);
  }
  return err;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP.trim());
    return;
  }

  const config = getConfig();
  const logger = createLogger({ level: 'warn' });
  const pool = createPool({
    connectionString: config.db.url,
    applicationName: 'vantage-core/cli:create-user',
    max: 2,
    statementTimeoutMs: 15_000,
    logger,
  });

  try {
    // ---- --list：只读，绝不返回 password_hash / totp_secret_enc -------------
    if (args.list) {
      const rows = await listUsers(pool);
      if (rows.length === 0) {
        console.log('（尚无任何面板账号：用 --username ... --role admin --password-stdin 建第一个）');
        return;
      }
      console.table(
        rows.map((row) => ({
          登录名: row.username,
          角色: row.role,
          状态: row.status,
          显示名: row.display_name ?? '',
          邮箱: row.email ?? '',
          二次验证: row.totp_enabled ? `已绑定（${fmtTime(row.totp_bound_at)}）` : '未绑定',
          恢复码: row.totp_enabled ? row.recovery_codes_left : '',
          最后登录: row.last_login_at ? `${fmtTime(row.last_login_at)} ${row.last_login_ip ?? ''}`.trim() : '从未',
          创建时间: fmtTime(row.created_at),
        })),
      );
      return;
    }

    // ---- --reset-2fa：恢复渠道二（DB 侧）------------------------------------
    if (args.reset2fa !== null) {
      if (!args.reset2fa) throw new Error('--reset-2fa 需要一个登录名（可先用 --list 查询）');
      const target = await findUserForAuth(pool, args.reset2fa);
      if (!target) throw new Error(`未找到账号「${args.reset2fa}」（可先用 --list 查询）`);

      const result = await withTransaction(pool, (client) => resetTotp(client, target.id));
      console.log(`
✅ 已重置账号「${target.username}」的二次验证
   清空 TOTP 绑定：${result.userUpdated ? '是' : '否（账号不存在？）'}
   作废恢复码  ：${result.codesDeleted} 条（该用户全部恢复码行，含已使用过的）
   该用户下次登录**只用密码**；如需 2FA，请登录后在面板里重新绑定。
${sessionHint()}`);
      return;
    }

    // ---- --reset-password ---------------------------------------------------
    if (args.resetPassword !== null) {
      if (!args.resetPassword) throw new Error('--reset-password 需要一个登录名（可先用 --list 查询）');
      const target = await findUserForAuth(pool, args.resetPassword);
      if (!target) throw new Error(`未找到账号「${args.resetPassword}」（可先用 --list 查询）`);

      const password = await obtainNewPassword(args.passwordStdin);
      await updatePasswordHash(pool, target.id, await hashPassword(password));
      console.log(`
✅ 已重置账号「${target.username}」的密码
${sessionHint()}`);
      return;
    }

    // ---- 建号（默认动作）----------------------------------------------------
    if (!args.username) throw new Error('缺少 --username（或用 --list / --reset-password / --reset-2fa / --help）');
    const role = args.role ?? 'user';
    if (role !== 'admin' && role !== 'user') throw new Error(`--role 只能是 admin 或 user（当前：${role}）`);

    const password = await obtainNewPassword(args.passwordStdin);
    let created;
    try {
      created = await insertUser(pool, {
        username: args.username,
        displayName: args.displayName ?? null,
        email: args.email ?? null,
        role,
        passwordHash: await hashPassword(password),
      });
    } catch (err) {
      throw friendlyUniqueError(err, { username: args.username, email: args.email });
    }

    console.log(`
✅ 面板账号已创建（⛔ 密码不在此回显）
   id       : ${created.id}
   username : ${created.username}
   role     : ${created.role}
   状态     : ${created.status}（二次验证未绑定 → 登录后可在面板里绑定）`);

    // 首管员提醒：最容易踩的坑是建了 user 角色却以为自己是管理员
    const admins = await countAdmins(pool);
    if (admins === 0) {
      console.log(`
⚠️ 库里**没有任何启用的管理员**（role=admin 且 status=active）。
   如果你想要的是首管员，请删掉这个账号改用：--role admin`);
    } else if (created.role !== 'admin') {
      console.log(`\nℹ️ 当前启用的管理员数量：${admins}`);
    }
  } finally {
    await pool.end();
  }
}

function fmtTime(value) {
  if (!value) return '';
  return value instanceof Date ? value.toISOString().replace('T', ' ').slice(0, 16) : String(value);
}

/** 会话在 Redis，不在 PG —— 每次改凭证后都要说清楚"这一半没做" */
function sessionHint() {
  return `⚠️ 在线会话不会被本脚本终止（会话在 Redis，不在 PG）：
   该用户若已登录，旧会话最长存活到绝对 TTL（默认 24h）。
   要立即踢下线：用面板的「全部下线」，或删除 Redis 键 session:* / user_sessions:<user_id>。`;
}

main().catch((err) => {
  console.error(`\n✖ ${err?.message ?? err}\n`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
