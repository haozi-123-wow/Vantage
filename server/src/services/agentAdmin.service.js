/**
 * Vantage · Agent 与凭证管理（**面板侧**，docs/api.md §4.4）
 *
 * 依据：docs/api.md §4.4（含「决策 #37 修订」的三条硬约束）、§2.1（两份凭证的分工）、
 *       docs/agent.md §6.1（凭证来源与三家形式）/§12.1（`vantage.sh` 安装参数）、
 *       docs/database.md §5.1/§5.2（✅ R1：单套凭证、不做新旧并存）
 *
 * 🔑 本模块存在的唯一理由：**凭证的明文只在这里出现一次**
 *
 *   管理员添加 Agent 时，中心生成一对凭证并**只回显这一次**：
 *     · `agent_key`（`vk_`）→ 上报时的身份（`X-Agent-Key` 对库里的 `agent_key_hash`，HMAC-pepper 不可逆）
 *     · `agent_secret`（`vs_`）→ 算 HMAC 签名用（**不上行**；库里存 AES-256-GCM 密文，因为验签要重算）
 *   之后中心**再也取不回明文**（哈希不可逆、密文只能用于验签前的解封）。丢了只能轮换
 *   （`POST /api/v1/agents/{id}/rotate`，旧凭证立即失效，⛔ 无并存过渡期）。
 *
 * ⛔ 三条红线（违反其一即等于把凭证泄露给"能看日志/能看 ps 的人"）：
 *   1. 明文凭证**不进日志**（含 error 级、含 debug 级的对象展开）；
 *   2. 明文凭证**不进审计**（`audit_logs.detail` 只写 id/slug/tags 这类非敏感标识）；
 *   3. 生成的安装命令⛔ **不使用 `--key <明文>` 参数形式**（`ps` / `/proc/$PID/cmdline` 对同机低权用户可见），
 *      只给「env 内联（并提示善后）」/「交互式」/「`--key-file`」三种形式。
 *
 * ⚠️ 与 `scripts/create-agent.js` 的关系：那是**离线救援**的孪生实现（同用 `utils/crypto.js` 的原语、
 *    同样的"名字冲突 409 / slug 撞车重试"处置）。两者都在，是刻意的：
 *    中心挂了/没有面板时，仍然必须能给新机器发凭证（否则"加一台机"这件事被中心自身的可用性绑死）。
 */

import { randomUUID } from 'node:crypto';

import { insertAgent } from '../repositories/agent.repo.js';
import { insertAuditLog } from '../repositories/audit.repo.js';
import {
  generateAgentKey,
  generateAgentSecret,
  generatePublicSlug,
  hashAgentCredential,
  sealAgentSecret,
} from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';

/** 主机名 / 显示名上限（与 `docs/frontend.md` §4.6 的表单一致；⛔ 不放宽到无上限） */
export const AGENT_NAME_MAX_LENGTH = 128;
export const AGENT_DISPLAY_NAME_MAX_LENGTH = 128;
export const AGENT_TAGS_MAX = 32;
export const AGENT_TAG_MAX_LENGTH = 32;

/** 公开标识长度（`docs/database.md` §5.1：8–12 位，取 10）与撞车重试次数 */
const PUBLIC_SLUG_LENGTH = 10;
const MAX_SLUG_ATTEMPTS = 5;

/**
 * 凭证落地的文件路径（`docs/agent.md` §8 的 `config.yaml` 默认值）。
 * ⚠️ 这两个路径会**出现在给管理员复制的一键命令里**，⛔ 不要改成相对路径或 /tmp。
 */
const AGENT_KEY_FILE = '/etc/vantage/agent.key';
const AGENT_SECRET_FILE = '/etc/vantage/agent.secret';

/** env 形式的风险提示（docs/api.md §4.4 决策 #37 修订第 4 条：面板**必须**标注） */
export const INSTALL_SECURITY_NOTE =
  'env 形式会进入 shell history，且本机 root 可经 /proc/$PID/environ 读到 key 与 secret；' +
  '脚本把凭证写入受限文件后应立即 unset，建议执行 history -d 清理，或改用交互式 / --key-file 形式。';

/** 控制字符（含换行/制表）一律拒绝：它们会破坏日志、审计可读性与生成出来的 shell 命令 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * 归一化并校验请求体（**业务规则**；类型/长度上界由路由的 JSON schema 先挡一遍）。
 *
 * @param {object} raw
 * @returns {{ name: string, displayName: string|null, tags: string[] }}
 * @throws {AppError} `schema_invalid`
 */
export function normalizeAgentInput(raw = {}) {
  const fail = (field, reason) => {
    throw new AppError('schema_invalid', { details: { field, reason } });
  };

  if (typeof raw.name !== 'string') fail('name', 'string_required');
  const name = raw.name.trim();
  if (name === '') fail('name', 'empty');
  if (name.length > AGENT_NAME_MAX_LENGTH) fail('name', 'too_long');
  // ⚠️ 用 trim 后的长度再判一次：`"a" + 128 个空格` 这种输入不该通过（schema 只能看原始长度）
  if (CONTROL_CHARS_RE.test(name)) fail('name', 'control_chars_not_allowed');

  let displayName = null;
  if (raw.display_name !== undefined && raw.display_name !== null) {
    if (typeof raw.display_name !== 'string') fail('display_name', 'string_required');
    const trimmed = raw.display_name.trim();
    // 空串按"未提供"处理（面板里清空输入框就会发空串）
    if (trimmed !== '') {
      if (trimmed.length > AGENT_DISPLAY_NAME_MAX_LENGTH) fail('display_name', 'too_long');
      if (CONTROL_CHARS_RE.test(trimmed)) fail('display_name', 'control_chars_not_allowed');
      displayName = trimmed;
    }
  }

  const tags = [];
  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags)) fail('tags', 'array_required');
    if (raw.tags.length > AGENT_TAGS_MAX) fail('tags', 'too_many');
    for (const tag of raw.tags) {
      if (typeof tag !== 'string') fail('tags', 'string_required');
      const trimmed = tag.trim();
      if (trimmed === '') fail('tags', 'empty_item');
      if (trimmed.length > AGENT_TAG_MAX_LENGTH) fail('tags', 'item_too_long');
      if (CONTROL_CHARS_RE.test(trimmed)) fail('tags', 'control_chars_not_allowed');
      // 重复标签会让「按标签筛选」的语义变模糊（一条主机在两个相同标签下出现两次没有意义）
      if (tags.includes(trimmed)) fail('tags', 'duplicate_item');
      tags.push(trimmed);
    }
  }

  return { name, displayName, tags };
}

/**
 * 组装安装提示（**纯函数**，便于单测；⛔ 不依赖 DB/请求）。
 *
 * 🔑 与 `docs/api.md` §4.4 初稿的一处**有意偏离**：契约里 `install_hint` 写的是 `string`，
 *    但前端规格（`docs/frontend.md` §4.6）要求三种形式**分开展示**（一键命令在显眼处、
 *    另两种折叠在次要位置）并显示风险提示 —— 一个字符串塞不下"三段命令 + 一条风险提示"。
 *    故实现为**对象**，并已同步 `docs/api.md` §4.4。
 *
 * ⚠️ 脚本地址未配置时，三个命令字段一律 `null` + 一条 `install_script_not_configured` 警告：
 *    ⛔ 不返回带 `<mirror>` 占位符的假命令（会 curl 到错地址还被 `sudo sh` 执行的那类事故，
 *    恰恰来自"看起来能用"的糊弄值）。
 *
 * @param {object} input
 * @param {string} input.origin 面板/中心对外地址（`PUBLIC_ORIGIN`，缺省时由请求推导）
 * @param {'config'|'request'} input.originSource 地址来源（用于决定要不要提示"请配置 PUBLIC_ORIGIN"）
 * @param {string} input.scriptUrl `AGENT_INSTALL_SCRIPT_URL`（可为空串）
 * @param {string} input.agentKey 明文 key（`vk_…`）
 * @param {string} input.agentSecret 明文 secret（`vs_…`）
 * @param {string} input.agentId Agent UUID
 * @returns {{ center_url: string, script_url: string|null, one_liner: string|null,
 *            interactive: string|null, key_file: string|null, security_note: string,
 *            warnings: Array<{code: string, message: string}> }}
 */
export function buildInstallHint(input) {
  const { origin, originSource, scriptUrl, agentKey, agentSecret, agentId } = input;
  const warnings = [];

  if (scriptUrl === '' || scriptUrl === null || scriptUrl === undefined) {
    warnings.push({
      code: 'install_script_not_configured',
      message:
        '未配置 AGENT_INSTALL_SCRIPT_URL，安装命令暂不可用：请先落地 vantage.sh（docs/agent.md §12.1），' +
        '或按下面的 key/secret 手工写 config.yaml + 两个 0600 文件。',
    });
    return {
      center_url: origin,
      script_url: null,
      one_liner: null,
      interactive: null,
      key_file: null,
      security_note: INSTALL_SECURITY_NOTE,
      warnings,
    };
  }

  if (originSource === 'request' && !origin.startsWith('https://')) {
    warnings.push({
      code: 'center_url_not_https',
      message:
        `中心地址是从当前请求推导出来的（${origin}），且不是 https：Agent 侧默认拒绝非 https 的 center.url，` +
        '请配置 PUBLIC_ORIGIN 为对外可访问的 https 地址。',
    });
  }

  const installArgs = `--center ${origin} --agent-id ${agentId}`;
  return {
    center_url: origin,
    script_url: scriptUrl,
    // 形式①：面板默认给这条（env 内联，复制即用）——⚠️ 两个凭证都进 history，故附风险提示
    one_liner:
      `VANTAGE_KEY=${agentKey} VANTAGE_SECRET=${agentSecret} ` +
      `sh -c 'curl -fsSL ${scriptUrl} | sudo -E sh -s -- install ${installArgs}'`,
    // 形式②：交互式 / stdin（最安全；脚本执行后提示输入 key 与 secret）
    interactive: `curl -fsSL ${scriptUrl} | sudo sh -s -- install ${installArgs}`,
    // 形式③：长期方案（凭证落在 0600 文件里，⛔ 永不进命令行/env）
    key_file:
      `curl -fsSL ${scriptUrl} | sudo sh -s -- install ${installArgs} ` +
      `--key-file ${AGENT_KEY_FILE} --secret-file ${AGENT_SECRET_FILE}`,
    security_note: INSTALL_SECURITY_NOTE,
    warnings,
  };
}

/**
 * 生成一套凭证并落库（`POST /api/v1/agents`）。
 *
 * 检查/处置顺序（⛔ 不可调换）：
 *   ① 归一化输入（名字/显示名/标签的业务规则）→ ② 生成 id + 凭证 → ③ 落库
 *   （名字重复 → 409 `already_exists`；slug 撞车 → 换一个 slug 重试）
 *   → ④ 写审计（⛔ 不含凭证）→ ⑤ 组装响应（明文**只在这里出现一次**）。
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.config
 * @param {object} [deps.logger]
 * @param {object} deps.input 请求体
 * @param {string} deps.actor 操作人（面板用户 uuid）
 * @param {string|null} deps.ip
 * @param {string} deps.origin 面板/中心对外地址
 * @param {'config'|'request'} deps.originSource
 */
export async function createAgent({ pool, config, logger, input, actor, ip, origin, originSource }) {
  const { name, displayName, tags } = normalizeAgentInput(input);

  // ⚠️ id 必须先定：secret 的 AES-GCM **AAD 绑定了 agent_id**，先封后换 id 会让密文永远解不开
  const agentId = randomUUID();
  const agentKey = generateAgentKey();
  const agentSecret = generateAgentSecret();
  const agentKeyHash = hashAgentCredential('key', agentKey, config.security.secretKey);
  const agentSecretEnc = sealAgentSecret(agentSecret, config.security.secretKey, agentId);

  let row = null;
  let lastSlugError = null;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && row === null; attempt += 1) {
    const publicSlug = generatePublicSlug(PUBLIC_SLUG_LENGTH);
    try {
      row = await insertAgent(pool, {
        id: agentId,
        name,
        publicSlug,
        displayName,
        tags,
        agentKeyHash,
        agentSecretEnc,
      });
    } catch (err) {
      if (err?.code === '23505' && /agents_name_key/.test(err?.constraint ?? '')) {
        // 名字是**管理员输入**：必须给出可行动的 409，⛔ 不能让它变成一个"唯一约束错误"
        throw new AppError('already_exists', {
          message: `主机名「${name}」已被占用，请换一个名字`,
          details: { field: 'name' },
          cause: err,
        });
      }
      if (err?.code === '23505' && /public_slug/.test(err?.constraint ?? '')) {
        // slug 撞车是随机巧合（58^10 的空间），换一个重试即可 —— 与"名字重复"是两回事
        lastSlugError = err;
        continue;
      }
      throw err;
    }
  }

  if (row === null) {
    // 连撞 5 次基本只可能是 slug 生成器被改坏了（例如字符集退化），必须显式报错而不是静默重试
    logger?.error?.({ err: lastSlugError, name }, 'public_slug 连续冲突，疑似生成器异常');
    throw new AppError('internal_error', {
      message: '生成公开标识连续冲突，请重试',
      cause: lastSlugError,
    });
  }

  await insertAuditLog(
    pool,
    {
      actor,
      actorType: 'user',
      action: 'agent.create',
      target: name,
      ip,
      // ⛔ 只写非敏感标识：明细里的任何凭证都会让审计表变成"另一份凭证库"
      detail: { agent_id: row.id, public_slug: row.public_slug, tags, has_display_name: displayName !== null },
    },
    logger,
  );

  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    tags: Array.isArray(row.tags) ? row.tags : [],
    public_slug: row.public_slug,
    // 新 Agent 还没上报过 ⇒ 连接状态恒为 `offline`（⛔ 不是"active"：那是凭证生命周期口径，
    // 与 agents.status 的三态机（online/offline/disabled，✅ R18）不是同一个东西）
    status: row.status,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    // ⛔ 明文仅此一次：这三个字段不落库、不进日志、不进审计，出参之后中心再也拿不到
    agent_key: agentKey,
    agent_secret: agentSecret,
    install_hint: buildInstallHint({
      origin,
      originSource,
      scriptUrl: config.agentInstall?.scriptUrl ?? '',
      agentKey,
      agentSecret,
      agentId: row.id,
    }),
  };
}
