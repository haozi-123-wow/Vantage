/**
 * Vantage · Agent 与凭证管理路由（`/api/v1/agents`，docs/api.md §4.4）
 *
 * 本文件只做 **HTTP 语义**（会话三态 + RBAC + CSRF、请求体 schema、201 响应形状），
 * 业务规则（名字/显示名/标签的归一化、凭证签发、审计、安装命令组装）全在
 * `services/agentAdmin.service.js`。
 *
 * 🔑 守卫顺序固定为 `loadPanelSession → requireFullSession → requireRole('admin') → requireCsrf`：
 *   - `requireFullSession` 挡两种受限态（`setup_required` / `totp_pending`）——
 *     **发凭证**是比"看数据"重得多的操作，⛔ 不允许在只过了密码的会话里做；
 *   - `requireRole('admin')`（✅ §4.4：本节**全部仅 admin**）；
 *   - `requireCsrf`：写请求（⛔ 无会话时才放行，见 authPanel.js 的说明）。
 *
 * ⚠️ 响应里含**明文凭证**（仅此一次）——`app.js` 的 `onSend` 已对 `/api/*` 统一加
 *    `Cache-Control: no-store`，这是这段响应唯一可以依赖的缓存防线，⛔ 不要再自己拼字符串绕开它。
 */

import { createPanelAuth } from '../middleware/authPanel.js';
import {
  AGENT_DISPLAY_NAME_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  AGENT_TAGS_MAX,
  AGENT_TAG_MAX_LENGTH,
  createAgent,
} from '../services/agentAdmin.service.js';
import { prepareIp } from '../utils/ip.js';

/** 请求体：⛔ 只认这三个字段（`additionalProperties: false`；`removeAdditional: false` ⇒ 多给字段直接 400） */
const CREATE_AGENT_BODY_SCHEMA = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    // 长度上界与 `services/agentAdmin.service.js` 的常量同源（schema 挡类型/长度，服务层挡控制字符与重复项）
    name: { type: 'string', minLength: 1, maxLength: AGENT_NAME_MAX_LENGTH },
    display_name: { type: 'string', maxLength: AGENT_DISPLAY_NAME_MAX_LENGTH },
    tags: {
      type: 'array',
      maxItems: AGENT_TAGS_MAX,
      items: { type: 'string', minLength: 1, maxLength: AGENT_TAG_MAX_LENGTH },
    },
  },
};

/**
 * 201 响应（⚠️ 这是全站**唯一**会返回明文凭证的响应体）。
 * `install_hint` 是**对象**而不是契约初稿里的 `string`：前端要分三段展示
 * （一键命令 / 交互式 / `--key-file`）+ 一条风险提示，一个字符串塞不下 —— 已同步 `docs/api.md` §4.4。
 */
const CREATED_AGENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'name', 'display_name', 'tags', 'public_slug', 'status', 'created_at',
    'agent_key', 'agent_secret', 'install_hint',
  ],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    display_name: { type: ['string', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
    public_slug: { type: 'string' },
    // 新 Agent 恒为 `offline`（还没上报过）；⚠️ 它是**连接状态**，不是凭证生命周期
    status: { type: 'string', enum: ['online', 'offline', 'disabled'] },
    created_at: { type: 'string' },
    // ⛔ 明文凭证仅此一次；这两个字段不进日志、不进审计、不落库
    agent_key: { type: 'string' },
    agent_secret: { type: 'string' },
    install_hint: {
      type: 'object',
      additionalProperties: false,
      required: ['center_url', 'script_url', 'one_liner', 'interactive', 'key_file', 'security_note', 'warnings'],
      properties: {
        center_url: { type: 'string' },
        // 以下三个在未配置脚本地址时**全为 null**（⛔ 不给带占位符的假命令）
        script_url: { type: ['string', 'null'] },
        one_liner: { type: ['string', 'null'] },
        interactive: { type: ['string', 'null'] },
        key_file: { type: ['string', 'null'] },
        security_note: { type: 'string' },
        warnings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
    },
  },
};

/**
 * 注册 Agent 管理路由。
 * @param {import('fastify').FastifyInstance} app
 */
export async function registerAgentAdminRoutes(app) {
  const { config, deps, log } = app;
  const pool = deps.db.app;
  const redis = deps.redis;

  const panel = createPanelAuth({ redis, config, logger: log });

  // POST /api/v1/agents —— 添加 Agent（签发凭证；明文仅此一次）
  app.post(
    '/api/v1/agents',
    {
      schema: { body: CREATE_AGENT_BODY_SCHEMA, response: { 201: CREATED_AGENT_SCHEMA } },
      preHandler: [panel.loadPanelSession, panel.requireFullSession, panel.requireRole('admin'), panel.requireCsrf],
    },
    async (request, reply) => {
      /**
       * `install_hint` 里的中心地址优先取 `PUBLIC_ORIGIN`（✅ 反代后面板对外地址，同时也是 WS Origin 白名单的基准）；
       * 未配置时退化为"按当前请求推导"——管理员此刻正是从这个地址访问面板的，
       * 它是可得的最好近似，但会附一条 warning 提醒去配置 `PUBLIC_ORIGIN`（见 buildInstallHint）。
       */
      const configuredOrigin = config.http.publicOrigin ?? '';
      const origin = configuredOrigin !== '' ? configuredOrigin : `${request.protocol}://${request.hostname}`;

      const created = await createAgent({
        pool,
        config,
        logger: log,
        input: request.body ?? {},
        actor: request.session.userId,
        ip: prepareIp(request.ip).ip,
        origin,
        originSource: configuredOrigin !== '' ? 'config' : 'request',
      });

      reply.code(201);
      return created;
    },
  );
}
