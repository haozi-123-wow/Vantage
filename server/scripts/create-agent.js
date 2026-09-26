#!/usr/bin/env node
/**
 * Vantage · Agent 凭证签发 / 查询（运维 CLI）
 *
 * 用途：M1 阶段真机联调时给「还没有面板」的场景发凭证（M2 会把它替换为
 *       `POST /api/v1/agents`，本脚本保留为离线救援工具）。
 *
 * 用法
 *   node scripts/create-agent.js --name web-01
 *   node scripts/create-agent.js --name web-01 --display-name "上海-Web-01" --tag prod --tag web
 *   node scripts/create-agent.js --list
 *
 * ⛔ 明文凭证只在创建时打印一次（库里只存 `agent_key_hash` 的 HMAC 与
 *    `agent_secret_enc` 的 AES-256-GCM 密文，二者都无法反推明文 secret 之外的任何东西）。
 *    ⛔ 不要把它写进 shell 脚本或仓库；建议创建后立刻 `history -d` 清理或改用 --key-file 形式。
 *
 * 依据：docs/api.md §4.4（Agent 与凭证管理）、§2.1（两份凭证的分工）、
 *       docs/database.md §5.1/§5.2（✅ R1：单套凭证、不做新旧并存）
 */

import { randomUUID } from 'node:crypto';

import { getConfig } from '../src/config/index.js';
import { createPool } from '../src/db/pg.js';
import {
  generateAgentKey,
  generateAgentSecret,
  generatePublicSlug,
  hashAgentCredential,
  sealAgentSecret,
} from '../src/utils/crypto.js';
import { newUlid } from '../src/utils/ulid.js';
import { createLogger } from '../src/utils/log.js';

function parseArgs(argv) {
  const args = { tags: [], list: false, rotate: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--list') args.list = true;
    else if (token === '--name') args.name = argv[++i];
    else if (token === '--display-name') args.displayName = argv[++i];
    else if (token === '--tag') args.tags.push(argv[++i]);
    else if (token === '--rotate') args.rotate = argv[++i];
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`未知参数：${token}（用 --help 查看用法）`);
  }
  return args;
}

const HELP = `
Vantage Agent 凭证工具

  --name <名称>            必需。主机名/别名（库内有 UNIQUE 约束）
  --display-name <显示名>  可选。公开视图用的显示名
  --tag <标签>             可选，可重复。如 --tag prod --tag web
  --rotate <agent_id>      轮换指定 Agent 的凭证（旧凭证**立即失效**，无宽限期）
  --list                   列出全部 Agent（不涉及明文凭证）
  --help                   显示本帮助
`;

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
    applicationName: 'vantage-core/cli:create-agent',
    max: 2,
    statementTimeoutMs: 15_000,
    logger,
  });

  try {
    if (args.list) {
      const { rows } = await pool.query(
        `SELECT id, name, display_name, public_slug, status, last_ip, last_seen_at,
                COALESCE(rotated_at, created_at) AS credential_since,
                (agent_secret_enc IS NULL) AS secret_missing
           FROM agents
          ORDER BY name`,
      );
      if (rows.length === 0) {
        console.log('（尚无任何 Agent）');
        return;
      }
      console.table(
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          显示名: row.display_name ?? '',
          公开标识: row.public_slug,
          状态: row.status,
          当前IP: row.last_ip ?? '',
          最后上报: row.last_seen_at ? row.last_seen_at.toISOString() : '从未',
          凭证起始: row.credential_since ? row.credential_since.toISOString().slice(0, 10) : '',
        })),
      );
      return;
    }

    if (args.rotate !== null) {
      if (!args.rotate) throw new Error('--rotate 需要一个 agent_id（可先用 --list 查询）');
      const credential = mintCredential(config, args.rotate);
      const { rows } = await pool.query(
        `UPDATE agents
            SET agent_key_hash = $2, agent_secret_enc = $3, rotated_at = now()
          WHERE id = $1
          RETURNING id, name`,
        [args.rotate, credential.keyHash, credential.secretEnc],
      );
      if (rows.length === 0) throw new Error(`未找到 agent_id=${args.rotate}（可先用 --list 查询）`);
      printCredential({ ...credential, agentId: rows[0].id, name: rows[0].name, rotated: true });
      return;
    }

    if (!args.name) throw new Error('缺少 --name（或用 --list / --help）');

    // public_slug 由 CHECK 约束限制字符集（排除易混的 0 O 1 l I），冲突概率极低；
    // 这里仍做有限次重试，避免"随机撞车"变成一个需要人肉理解的唯一约束错误。
    let inserted = null;
    for (let attempt = 0; attempt < 5 && inserted === null; attempt += 1) {
      const slug = generatePublicSlug(10);
      const agentId = randomUUID();
      const payload = mintCredential(config, agentId);
      try {
        const { rows } = await pool.query(
          `INSERT INTO agents (id, name, public_slug, display_name, agent_key_hash, agent_secret_enc, tags, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'offline')
           RETURNING id, name`,
          [
            agentId,
            args.name,
            slug,
            args.displayName ?? null,
            payload.keyHash,
            payload.secretEnc,
            JSON.stringify(args.tags ?? []),
          ],
        );
        inserted = { ...payload, agentId: rows[0].id, name: rows[0].name, publicSlug: slug };
      } catch (err) {
        if (err.code === '23505' && /agents_name_key/.test(err.constraint ?? '')) {
          throw new Error(`主机名「${args.name}」已存在（库内 UNIQUE 约束）：请换名，或先用 --list 确认`);
        }
        if (err.code === '23505' && /public_slug/.test(err.constraint ?? '')) continue; // 换一个 slug 重试
        throw err;
      }
    }
    if (!inserted) throw new Error('生成 public_slug 连续冲突 5 次，请重试');

    printCredential(inserted);

    // 顺手给出一条可直接粘贴的最小联调片段（⚠️ 内含明文 key/secret，仅供本机使用）
    console.log(`\n—— 最小联调示例（Node 22+）——\n${sampleSnippet(inserted, config)}`);
  } finally {
    await pool.end();
  }
}

/** 生成一套凭证（明文只在这里出现，落库的是哈希与密文） */
function mintCredential(config, agentId) {
  const key = generateAgentKey();
  const secret = generateAgentSecret();
  const id = agentId ?? randomUUID();
  return {
    agentId: id,
    key,
    secret,
    keyHash: hashAgentCredential('key', key, config.security.secretKey),
    secretEnc: sealAgentSecret(secret, config.security.secretKey, id),
  };
}

function printCredential(credential) {
  const bar = '─'.repeat(72);
  console.log(`
${bar}
${credential.rotated ? '✅ 凭证已轮换（⚠️ 旧凭证**立即失效**，必须上机替换后 reload/restart）' : '✅ Agent 凭证已签发（⛔ 明文只显示这一次）'}
${bar}
  agent_id     : ${credential.agentId}
  name         : ${credential.name}${credential.publicSlug ? `\n  public_slug  : ${credential.publicSlug}` : ''}

  VANTAGE_ID     = ${credential.agentId}
  VANTAGE_KEY    = ${credential.key}
  VANTAGE_SECRET = ${credential.secret}
${bar}
⛔ 请立刻写进 Agent 的本地配置文件（如 /etc/vantage/config.yaml，权限 0600），
   并把 shell history 里的这一条清掉：history -d $(history 1 | awk '{print $1}')
${bar}`);
}

function sampleSnippet(credential, config) {
  return `// 一个批次 = 一次签名 = 一次 POST（⛔ canonical 必须与 core 的 utils/sign.js 逐字节一致）
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const body = JSON.stringify({
  agent_id: '${credential.agentId}',
  batch_id: '${newUlid()}',
  ts: Date.now(),
  host: { hostname: 'demo', os: 'linux', kernel: '6.x', boot_time: 0, capabilities: { 'disk.io': true } },
  metrics: { cpu: { usage: 12.5, load: [0.1, 0.2, 0.3] }, mem: { total: 8589934592, used: 2147483648 } },
  probes: [],
});
const raw = Buffer.from(body, 'utf8');
const ts = String(Date.now());
const nonce = crypto.randomBytes(16).toString('hex');
const canonical = ['POST', '/api/v1/agent/report', ts, nonce, crypto.createHash('sha256').update(raw).digest('hex')].join('\\n');
const signature = crypto.createHmac('sha256', '${credential.secret}').update(canonical, 'utf8').digest('hex');

await fetch('http://127.0.0.1:${config.http.port}/api/v1/agent/report', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
    'x-agent-id': '${credential.agentId}',
    'x-agent-key': '${credential.key}',
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-signature': signature,
  },
  body: zlib.gzipSync(raw),
});`;
}

main().catch((err) => {
  console.error(`\n✖ ${err?.message ?? err}\n`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
