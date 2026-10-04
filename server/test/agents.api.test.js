/**
 * `POST /api/v1/agents`（管理员添加 Agent）测试
 *
 * 依据：docs/api.md §4.4（含「决策 #37 修订」的三条硬约束）、§2.1（两份凭证的分工）、
 *       docs/agent.md §6.1/§12.1、docs/database.md §5.1/§5.2（✅ R1 单套凭证）
 *
 * 为什么用**真 PGlite + 真 buildApp**：
 *   本端点的全部价值都落在"库里的东西与返回的明文必须是同一对凭证"上 ——
 *   ① 库里必须只存 `agent_key_hash`（HMAC-pepper）与 `agent_secret_enc`（AES-GCM 信封）；
 *   ② 返回的明文必须**真的能通过上报鉴权**（否则管理员会拿到一对"看起来对但用不了"的凭证，
 *      而这要等到上机之后才会发现）。
 *   故本文件的核心用例是**端到端**的：调接口建 Agent → 用返回的 key/secret 签一份真实上报 → 200。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { BOOTSTRAP_SQL, applyOne, loadMigrations } from '../scripts/migrate.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { sessionCookieName } from '../src/middleware/authPanel.js';
import {
  buildInstallHint,
  normalizeAgentInput,
  INSTALL_SECURITY_NOTE,
} from '../src/services/agentAdmin.service.js';
import { createSession } from '../src/services/session.service.js';
import { createLogger } from '../src/utils/log.js';
import { buildSignedRequest, makeReportBody, newNonce } from './helpers/agent-client.js';
import { createFakeRedisHash } from './helpers/fake-redis-hash.js';

// -----------------------------------------------------------------------------
// 真库（PGlite）
// -----------------------------------------------------------------------------
const db = await PGlite.create();
await db.exec('CREATE ROLE vantage_migrator LOGIN; CREATE ROLE vantage_app LOGIN; CREATE ROLE vantage_ro LOGIN;');
await db.exec(BOOTSTRAP_SQL);

const migrations = loadMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
const migrator = {
  query: (sql, params) => (Array.isArray(params) && params.length > 0 ? db.query(sql, params) : db.exec(sql)),
};
for (const migration of migrations) {
  await applyOne(migrator, migration, false);
}

async function run(sql, params = []) {
  if (Array.isArray(params) && params.length > 0) {
    const result = await db.query(sql, params);
    return { rows: result.rows ?? [], rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  }
  const results = await db.exec(sql);
  const last = Array.isArray(results) ? results.at(-1) : results;
  return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
}

/**
 * PGlite → node-pg 适配器。
 * ⚠️ 必须带 `connect()`：上报落库走 `withTransaction()`（`db/pg.js` 的 `pool.connect()` → BEGIN/COMMIT），
 *    少了它，端到端上报会在落库那一步抛 `pool.connect is not a function` 并被折叠成 500
 *    —— 而错误信息看起来像"业务出错"，与真正的失败原因隔了很远（本文件第一版就是这么挂的）。
 *    与 `auth.2fa.test.js` / `user.repo.test.js` 的适配器同款。
 */
const pool = { query: run, connect: async () => ({ query: run, release: () => {} }) };

after(async () => {
  await db.close();
});

const SILENT = createLogger({ level: 'silent' });
const SECRET_KEY = Buffer.alloc(32, 31).toString('base64');

/** 默认配置：**未配置**安装脚本地址（= 仓库当前状态），用于验"不给假命令"这条路 */
function makeConfig(overrides = {}) {
  return loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
      SECRET_KEY,
      ...overrides,
    },
    { skipEnvFile: true },
  );
}

const CONFIG = makeConfig({
  AGENT_INSTALL_SCRIPT_URL: 'https://mirror.example.com/vantage.sh',
  PUBLIC_ORIGIN: 'https://vantage.example.com',
});
const CONFIG_NO_SCRIPT = makeConfig();
const COOKIE = sessionCookieName(CONFIG);

const USER_ID = '77777777-8888-9999-aaaa-bbbbbbbbbb00';
const OTHER_USER_ID = '77777777-8888-9999-aaaa-bbbbbbbbbb01';

let app = null;
let redis = null;

beforeEach(async () => {
  if (app) await app.close();
  await run('DELETE FROM audit_logs');
  // ⚠️ 顺序由外键决定（全部 ON DELETE RESTRICT）：先删引用 agents 的行，最后才删 agents。
  //    少删一张表 → 后面**每一条**用例的 beforeEach 都会炸在"删除被引用行"上，
  //    而报错信息看起来像业务失败（本文件第一版就漏了 agent_ip_history，因为只有端到端
  //    "真的上报一次"那条用例会写它 —— 典型的"只有一条用例踩到"的清理漏洞）。
  await run(`DELETE FROM agent_ip_history WHERE agent_id IN (SELECT id FROM agents)`);
  await run(`DELETE FROM ip_change_events WHERE agent_id IN (SELECT id FROM agents)`);
  await run(`DELETE FROM metrics_raw WHERE agent_id IN (SELECT id FROM agents)`);
  await run(`DELETE FROM probe_results WHERE agent_id IN (SELECT id FROM agents)`);
  await run(`DELETE FROM process_snapshots WHERE agent_id IN (SELECT id FROM agents)`);
  await run(`DELETE FROM alert_events WHERE agent_id IN (SELECT id FROM agents)`);
  await run('DELETE FROM agents');

  redis = createFakeRedisHash();
  app = await buildApp({ config: CONFIG, logger: SILENT, db: { app: pool, migrator: null }, redis });
});

/** 铸造一个会话（`full` = 完整态；`role` 决定 RBAC） */
async function mintSession({ state = 'full', role = 'admin', userId = USER_ID } = {}) {
  const { sid, session } = await createSession(redis, CONFIG, {
    userId,
    roles: [role],
    totpOk: state === 'full',
    setupRequired: state === 'setup_required',
  });
  return { cookies: { [COOKIE]: sid }, csrf: session.csrf };
}

/** 发一次创建请求（默认带上合法 CSRF） */
async function createAgentRequest(payload, { session } = {}) {
  const s = session ?? (await mintSession());
  return app.inject({
    method: 'POST',
    url: '/api/v1/agents',
    cookies: s.cookies,
    headers: { 'x-csrf-token': s.csrf },
    payload,
  });
}

// -----------------------------------------------------------------------------
// 201：凭证签发（本端点的核心）
// -----------------------------------------------------------------------------

test('201：返回形状 + 明文凭证只此一次 + 库里只存哈希与密文（⛔ 不含明文）', async () => {
  const res = await createAgentRequest({ name: 'web-01', display_name: '上海-Web-01', tags: ['prod', 'web'] });
  assert.equal(res.statusCode, 201);
  const body = res.json();

  assert.deepEqual(Object.keys(body).sort(), [
    'agent_key', 'agent_secret', 'created_at', 'display_name', 'id', 'install_hint',
    'name', 'public_slug', 'status', 'tags',
  ]);
  assert.equal(body.name, 'web-01');
  assert.equal(body.display_name, '上海-Web-01');
  assert.deepEqual(body.tags, ['prod', 'web']);
  // 新 Agent 还没上报过 ⇒ 连接状态是 offline（⛔ 不是凭证口径的 "active"）
  assert.equal(body.status, 'offline');
  assert.match(body.agent_key, /^vk_[A-Za-z0-9_-]{40,}$/);
  assert.match(body.agent_secret, /^vs_[A-Za-z0-9_-]{40,}$/);
  assert.match(body.public_slug, /^[2-9A-HJ-NP-Za-km-z]{8,12}$/);
  assert.ok(Date.parse(body.created_at) > 0);

  // 库内：只有哈希与密文，⛔ 任何一列都不得出现明文
  const { rows } = await run(
    `SELECT id, name, public_slug, display_name, tags, status, agent_key_hash, agent_secret_enc
       FROM agents WHERE id = $1`,
    [body.id],
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.status, 'offline');
  assert.match(row.agent_key_hash, /^[0-9a-f]{64}$/, 'key 只落 HMAC-pepper 哈希（不可逆）');
  assert.notEqual(row.agent_key_hash, body.agent_key);
  assert.match(row.agent_secret_enc, /^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]*={0,2}$/, 'secret 落 AES-256-GCM 信封');
  assert.equal(
    JSON.stringify(row).includes(body.agent_key) || JSON.stringify(row).includes(body.agent_secret),
    false,
    '⛔ 明文凭证绝不出现在库里',
  );

  // ⛔ 审计同样不得含明文
  const { rows: audits } = await run(`SELECT action, actor, actor_type, target, detail FROM audit_logs`);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'agent.create');
  assert.equal(audits[0].actor, USER_ID);
  assert.equal(audits[0].actor_type, 'user');
  assert.equal(audits[0].target, 'web-01');
  assert.equal(audits[0].detail.agent_id, body.id);
  assert.equal(JSON.stringify(audits[0]).includes(body.agent_secret), false);
  assert.equal(JSON.stringify(audits[0]).includes(body.agent_key), false);
});

test('201 之后：返回的 key/secret 必须**真的能上报**（端到端，⛔ 不是"看起来对"）', async () => {
  const created = (await createAgentRequest({ name: 'web-02' })).json();
  const agent = { id: created.id, plainKey: created.agent_key, plainSecret: created.agent_secret };

  // ① 用刚签发的凭证签一份真实上报 → 200
  const signed = buildSignedRequest({ agent, body: makeReportBody({ agent_id: created.id }) });
  const reported = await app.inject(signed);
  assert.equal(reported.statusCode, 200, `凭证应当可直接用于上报，实际 ${reported.body}`);
  assert.deepEqual(Object.keys(reported.json()).sort(), ['ok', 'server_ts']);

  // 上报成功后该 Agent 的连接状态翻成 online，并记下 last_seen
  const { rows } = await run(`SELECT status, last_seen_at FROM agents WHERE id = $1`, [created.id]);
  assert.equal(rows[0].status, 'online');
  assert.ok(rows[0].last_seen_at instanceof Date);

  // ② 身份确实由 key 决定：换一把 key（签名仍用真 secret）→ 401
  const wrongKey = await app.inject(
    buildSignedRequest({
      agent: { ...agent, plainKey: 'vk_wrong_key_0123456789' },
      body: makeReportBody({ agent_id: created.id, batch_id: undefined, ts: undefined }),
      nonce: newNonce(),
    }),
  );
  assert.equal(wrongKey.statusCode, 401);
  assert.equal(wrongKey.json().error.code, 'signature_invalid');
  assert.equal(wrongKey.json().error.details.header, 'X-Agent-Key');
});

test('409：主机名重复 → already_exists 且指名字段（⛔ 不是"唯一约束错误"）', async () => {
  assert.equal((await createAgentRequest({ name: 'dup-01' })).statusCode, 201);

  const again = await createAgentRequest({ name: 'dup-01' });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, 'already_exists');
  assert.deepEqual(again.json().error.details, { field: 'name' });
  assert.match(again.json().error.message, /dup-01/);

  // 显示名不参与唯一性（只有 name 唯一）
  assert.equal((await createAgentRequest({ name: 'dup-02', display_name: 'dup-01' })).statusCode, 201);
});

// -----------------------------------------------------------------------------
// 400：请求体校验
// -----------------------------------------------------------------------------

test('400：请求体的类型/长度/白名单（service 与 schema 各挡一层）', async () => {
  const cases = [
    [{}, 'missing_name'],
    [{ name: '   ' }, 'blank_name'],
    [{ name: 'a'.repeat(129) }, 'name_too_long'],
    [{ name: 'ok\nname' }, 'control_char_in_name'],
    [{ name: 'ok', display_name: 'x'.repeat(129) }, 'display_too_long'],
    [{ name: 'ok', tags: 'not-an-array' }, 'tags_not_array'],
    [{ name: 'ok', tags: ['a', 'a'] }, 'duplicate_tag'],
    [{ name: 'ok', tags: [''] }, 'empty_tag'],
    [{ name: 'ok', tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }, 'too_many_tags'],
    [{ name: 'ok', tags: ['x'.repeat(33)] }, 'tag_too_long'],
    [{ name: 'ok', unknown_field: 1 }, 'unknown_field'],
  ];

  for (const [payload, label] of cases) {
    const res = await createAgentRequest(payload);
    assert.equal(res.statusCode, 400, `${label} 应当被拒`);
    assert.equal(res.json().error.code, 'schema_invalid', label);
  }

  // 显示名空串按"未提供"处理（面板清空输入框就会发空串）
  const blankDisplay = await createAgentRequest({ name: 'blank-display', display_name: '   ' });
  assert.equal(blankDisplay.statusCode, 201);
  assert.equal(blankDisplay.json().display_name, null);

  // 名字两侧空格会被 trim（避免"web-01"与"web-01 "变成两台机）
  const trimmed = await createAgentRequest({ name: '  spaced-01  ' });
  assert.equal(trimmed.statusCode, 201);
  assert.equal(trimmed.json().name, 'spaced-01');
});

// -----------------------------------------------------------------------------
// 鉴权：三态 + RBAC + CSRF
// -----------------------------------------------------------------------------

test('401 / 403：未登录、受限态、非 admin、缺 CSRF 各挡一层', async () => {
  const noSession = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: { name: 'x' } });
  assert.equal(noSession.statusCode, 401);
  assert.equal(noSession.json().error.code, 'session_expired');

  const pending = await createAgentRequest({ name: 'x' }, { session: await mintSession({ state: 'totp_pending' }) });
  assert.equal(pending.statusCode, 403);
  assert.equal(pending.json().error.code, 'totp_required', '发凭证必须完整态会话（只过了密码不算）');

  const setup = await createAgentRequest({ name: 'x' }, { session: await mintSession({ state: 'setup_required' }) });
  assert.equal(setup.json().error.code, 'totp_setup_required');

  // ✅ §4.4：本节全部仅 admin
  const asUser = await createAgentRequest({ name: 'x' }, { session: await mintSession({ role: 'user', userId: OTHER_USER_ID }) });
  assert.equal(asUser.statusCode, 403);
  assert.equal(asUser.json().error.code, 'role_denied');

  // CSRF：写请求必须带 token（无会话时才豁免）
  const s = await mintSession();
  const noCsrf = await app.inject({
    method: 'POST',
    url: '/api/v1/agents',
    cookies: s.cookies,
    payload: { name: 'no-csrf' },
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json().error.code, 'csrf_invalid');

  // 被拒的请求⛔ 不得留下任何 Agent 行（校验/鉴权在落库之前）
  const { rows } = await run('SELECT count(*)::int AS n FROM agents');
  assert.equal(rows[0].n, 0);
});

// -----------------------------------------------------------------------------
// install_hint：三种形式 + 风险提示 + 未配置时不给假命令
// -----------------------------------------------------------------------------

test('install_hint（已配置脚本地址）：给出三种形式，⛔ 绝不出现 `--key <明文>` 形式', async () => {
  const body = (await createAgentRequest({ name: 'hint-01' })).json();
  const hint = body.install_hint;

  assert.equal(hint.center_url, 'https://vantage.example.com', '取 PUBLIC_ORIGIN（反代后的对外地址）');
  assert.equal(hint.script_url, 'https://mirror.example.com/vantage.sh');
  assert.deepEqual(hint.warnings, [], '配置齐全时不该有警告');

  // 形式①：env 内联的一键命令（两个凭证都在里面）
  assert.ok(hint.one_liner.includes(`VANTAGE_KEY=${body.agent_key}`));
  assert.ok(hint.one_liner.includes(`VANTAGE_SECRET=${body.agent_secret}`));
  assert.ok(hint.one_liner.includes(`--agent-id ${body.id}`));
  assert.ok(hint.one_liner.includes('sudo -E sh -s -- install'), 'sudo 必须带 -E，否则 env 传不进脚本');

  // 形式②：交互式（⛔ 不含任何凭证）
  assert.equal(hint.interactive.includes(body.agent_key), false);
  assert.equal(hint.interactive.includes(body.agent_secret), false);
  assert.ok(hint.interactive.includes(`--agent-id ${body.id}`));

  // 形式③：key 文件（同样不含明文）
  assert.ok(hint.key_file.includes('--key-file /etc/vantage/agent.key'));
  assert.ok(hint.key_file.includes('--secret-file /etc/vantage/agent.secret'));
  assert.equal(hint.key_file.includes(body.agent_secret), false);

  // ⛔ 永久红线：不得出现 `--key <明文>` / `--secret <明文>`（ps 与 /proc/$PID/cmdline 可见）
  for (const command of [hint.one_liner, hint.interactive, hint.key_file]) {
    assert.equal(/\s--key\s/.test(command), false, `命令里出现了 --key 参数形式：${command}`);
    assert.equal(/\s--secret\s/.test(command), false, `命令里出现了 --secret 参数形式：${command}`);
  }

  // 风险提示必须写明 history 与 environ 两个后果（决策 #37 修订第 4 条）
  assert.equal(hint.security_note, INSTALL_SECURITY_NOTE);
  assert.match(hint.security_note, /history/);
  assert.match(hint.security_note, /environ/);
});

test('install_hint（未配置脚本地址）：三个命令为 null + 显式警告（⛔ 不给带占位符的假命令）', async () => {
  const noScriptApp = await buildApp({
    config: CONFIG_NO_SCRIPT,
    logger: SILENT,
    db: { app: pool, migrator: null },
    redis,
  });
  try {
    const s = await mintSession();
    const res = await noScriptApp.inject({
      method: 'POST',
      url: '/api/v1/agents',
      cookies: s.cookies,
      headers: { 'x-csrf-token': s.csrf },
      payload: { name: 'no-script-01' },
    });
    assert.equal(res.statusCode, 201, '没有安装脚本地址也要能建 Agent —— 凭证本身是可用的');
    const hint = res.json().install_hint;

    assert.equal(hint.script_url, null);
    assert.equal(hint.one_liner, null);
    assert.equal(hint.interactive, null);
    assert.equal(hint.key_file, null);
    assert.deepEqual(hint.warnings.map((w) => w.code), ['install_script_not_configured']);
    assert.match(hint.warnings[0].message, /AGENT_INSTALL_SCRIPT_URL/);
    // ⚠️ 此时**不再**附"中心地址非 https"那条：没有安装命令可复制，那条提醒只是噪声
    //    （顺序也重要：先判断"有没有命令"，再谈命令里的地址对不对）
    assert.equal(hint.warnings.some((w) => w.code === 'center_url_not_https'), false);
  } finally {
    await noScriptApp.close();
  }
});

// -----------------------------------------------------------------------------
// 纯函数（不需要 DB）
// -----------------------------------------------------------------------------

test('buildInstallHint：未配置 PUBLIC_ORIGIN 时，从请求推导出的 http 地址会被警告', () => {
  const hint = buildInstallHint({
    origin: 'http://127.0.0.1:8787',
    originSource: 'request',
    scriptUrl: 'https://mirror.example.com/vantage.sh',
    agentKey: 'vk_a',
    agentSecret: 'vs_b',
    agentId: 'id-1',
  });
  assert.equal(hint.center_url, 'http://127.0.0.1:8787');
  assert.deepEqual(hint.warnings.map((w) => w.code), ['center_url_not_https']);

  // 配置来的 https 地址则无警告
  const configured = buildInstallHint({
    origin: 'https://vantage.example.com',
    originSource: 'config',
    scriptUrl: 'https://mirror.example.com/vantage.sh',
    agentKey: 'vk_a',
    agentSecret: 'vs_b',
    agentId: 'id-1',
  });
  assert.deepEqual(configured.warnings, []);
});

test('normalizeAgentInput：trim、空显示名、标签去重与长度上限', () => {
  assert.deepEqual(normalizeAgentInput({ name: '  a  ', display_name: '', tags: [' x ', 'y'] }), {
    name: 'a',
    displayName: null,
    tags: ['x', 'y'],
  });
  for (const bad of [
    { name: '' },
    { name: '   ' },
    { name: 'x'.repeat(129) },
    { name: 'ok', tags: ['a', 'a'] },
    { name: 'ok', tags: [''] },
    { name: 'ok', display_name: 'x'.repeat(129) },
  ]) {
    assert.throws(() => normalizeAgentInput(bad), (err) => err.code === 'schema_invalid', JSON.stringify(bad));
  }
});
