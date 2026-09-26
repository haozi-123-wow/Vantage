/**
 * Vantage · Agent 鉴权中间件（解压 → 体积上限 → 验签 → 解析 → 一致性）
 *
 * 依据：docs/api.md §1.5（中间件顺序**固定**）、§2.1（请求头/签名算法/错误码）、
 *       docs/database.md §6.2（跨机越权）、Vantage-DESIGN-v0.7.md §5.2、§6.2、§6.6、决策 #17/#35/#37
 *
 * 顺序（⛔ 不可调整，每一处都有具体理由）
 *   ① Content-Type 必须是 application/json（§2.1 标为必需）
 *   ② Content-Encoding 只接受 gzip / identity —— 其它一律 415
 *   ③ **压缩后**字节上限：先看 Content-Length（快路径），再在流内计数（防 chunked 绕过）
 *   ④ gzip 解压：用 zlib 的 `maxOutputLength` 卡**解压输出**上限（zip bomb 防护，
 *      ⛔ 必须先于 `JSON.parse`，否则炸弹在解析阶段就把内存吃掉）
 *   ⑤ 鉴权头格式 → ⑥ 取 Agent 行 → ⑦ `X-Agent-Key` 校验（证明身份）
 *   ⑧ 解出 `agent_secret` → **HMAC 验签**（⚠️ 此时还没有 `JSON.parse`，✅ 决策 #35）
 *   ⑨ 时间窗（> 5min 硬上限才拒；≤ 5min 只记漂移，✅ 决策 #17）
 *   ⑩ 把原始字节交回 Fastify 的 JSON 解析器（保持 schema 校验与错误码处理走标准路径）
 *
 * 🔑 为什么自己解压、而不复用 @fastify/compress 的请求解压
 *   - 它的解压流没有输出上限，zip bomb 会在它把数据交给解析器之前就吃掉内存；
 *   - 它拿不到「压缩前/解压后」两个字节数，无法分别落实 1MB / 4MB 两个上限（✅ 决策 #47）。
 *   为此 app.js 以 `globalDecompression: false` 注册 compress（响应压缩不受影响）。
 */

import { Readable } from 'node:stream';
import zlib from 'node:zlib';

import { openAgentSecret, verifyAgentCredential } from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';
import { prepareIp } from '../utils/ip.js';
import { insertAuditLog } from '../repositories/audit.repo.js';
import { findAgentForAuth } from '../repositories/agent.repo.js';
import {
  TIMESTAMP_HARD_LIMIT_S,
  evaluateTimestampSkew,
  parseAgentAuthHeaders,
  toCanonicalPath,
  verifySignature,
} from '../utils/sign.js';

/** 允许的 Content-Encoding（空 = 未压缩） */
const ALLOWED_ENCODINGS = new Set(['', 'identity', 'gzip']);

/**
 * 读干一个流，并对**累计字节数**设上限。
 * ⛔ 超限时**不要 destroy 原始请求流**：HTTP/1.1 里请求流与响应共用同一个 socket，
 *    销毁它就等于把响应也一起掐掉（客户端只会看到"连接被重置"，而非 413）。
 *    Node 会在响应结束后自行把未读完的请求体 dump 掉。
 */
async function collectStream(stream, limit, label) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      throw new AppError('payload_too_large', {
        message: `${label}超过上限（${limit} 字节）`,
        details: { limit_bytes: limit, received_bytes: total },
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * 解压（可选）并返回原始 JSON 字节。
 *
 * 🔑 为什么必须把「压缩后字节数」一起返回：Fastify 的正文解析器在读完流之后会做一次
 *    **Content-Length 一致性校验**（`lib/content-type-parser.js`：`payload.receivedEncodedLength
 *    || receivedLength` 必须等于请求头里的 Content-Length）。我们在 preParsing 里把
 *    **解压后**的字节交回去，于是"实际读到的长度"= 解压后长度 ≠ 头里的压缩后长度，
 *    任何真正被压缩过的请求都会被判成 `FST_ERR_CTP_INVALID_CONTENT_LENGTH`（400）——
 *    表现为"小报文（压缩后没变小）能过、大报文全部 400"，极难归因。
 *    Fastify 为此预留了 `receivedEncodedLength`：把它设成压缩后的字节数即可对齐。
 *    （@fastify/compress 的解压流也是靠这个属性过校验的。）
 *
 * @param {import('node:stream').Readable} payload
 * @param {{ gzip: boolean, maxCompressedBytes: number, maxDecompressedBytes: number }} options
 * @returns {Promise<{ body: Buffer, encodedBytes: number, decodedBytes: number }>}
 */
export async function readRawBody(payload, options) {
  const { gzip, maxCompressedBytes, maxDecompressedBytes } = options;

  const encoded = await collectStream(payload, maxCompressedBytes, '请求体（压缩后）');
  const encodedBytes = encoded.length;
  if (!gzip) return { body: encoded, encodedBytes, decodedBytes: encodedBytes };

  const body = await new Promise((resolve, reject) => {
    // ✅ 这里就是 zip bomb 的闸门：maxOutputLength 由 zlib 在**解压过程中**强制，
    //    超出即 ERR_BUFFER_TOO_LARGE，绝不会先分配出 4GB 再判断。
    zlib.gunzip(encoded, { maxOutputLength: maxDecompressedBytes }, (err, decoded) => {
      if (err) {
        if (err.code === 'ERR_BUFFER_TOO_LARGE') {
          reject(
            new AppError('payload_too_large', {
              message: `请求体解压后超过上限（${maxDecompressedBytes} 字节）`,
              details: { max_decompressed_bytes: maxDecompressedBytes },
            }),
          );
          return;
        }
        reject(
          new AppError('invalid_request', {
            message: '请求体不是合法的 gzip 数据，无法解压',
            details: { content_encoding: 'gzip' },
            cause: err,
          }),
        );
        return;
      }
      resolve(decoded);
    });
  });

  return { body, encodedBytes, decodedBytes: body.length };
}

/** 解析 Content-Type：只接受 application/json（允许带 charset 等参数） */
function assertJsonContentType(headers) {
  const raw = headers['content-type'];
  if (typeof raw !== 'string' || !/^\s*application\/json\s*(;|$)/i.test(raw)) {
    throw new AppError('invalid_request', {
      message: 'Content-Type 必须是 application/json（Agent 上报只接受 JSON）',
      details: { header: 'Content-Type' },
    });
  }
}

/** 解析 Content-Encoding：⛔ 只接受 gzip / identity（其余 415，不静默放行） */
function resolveContentEncoding(headers) {
  const raw = headers['content-encoding'];
  if (raw === undefined || raw === null) return { gzip: false };
  const value = String(raw).trim().toLowerCase();
  if (!ALLOWED_ENCODINGS.has(value)) {
    throw new AppError('unsupported_content_encoding', {
      message: `不支持的 Content-Encoding：${value}（本服务只接受 gzip）`,
      details: { content_encoding: value, allowed: ['gzip', 'identity'] },
    });
  }
  return { gzip: value === 'gzip' };
}

/**
 * 创建 `preParsing` 钩子：把「体积 → 解压 → 验签」三步全部前置。
 * @param {{ config: object, db: { app: import('pg').Pool }, logger: object }} deps
 */
export function createAgentBodyGuard({ config, db, logger }) {
  const { maxCompressedBytes, maxDecompressedBytes, secretKey } = config.security;

  return async function agentBodyGuard(request, _reply, payload) {
    assertJsonContentType(request.headers);
    const { gzip } = resolveContentEncoding(request.headers);

    // 快路径：声明了 Content-Length 就先用它挡住超大请求（连读都不读）
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxCompressedBytes) {
      throw new AppError('payload_too_large', {
        message: `请求体超过上限（压缩后 ${maxCompressedBytes} 字节）`,
        details: { max_compressed_bytes: maxCompressedBytes, content_length: declaredLength },
      });
    }

    const raw = await readRawBody(payload, { gzip, maxCompressedBytes, maxDecompressedBytes });
    const rawBody = raw.body;

    // --- 鉴权（⛔ 全程在 JSON.parse 之前，✅ 决策 #35）------------------------
    const auth = parseAgentAuthHeaders(request.headers);

    const agent = await findAgentForAuth(db.app, auth.agentId);
    if (!agent) {
      throw new AppError('agent_unknown_or_disabled', {
        message: 'Agent 不存在',
        details: { agent_id: auth.agentId },
      });
    }

    // ① 身份：X-Agent-Key 对 agent_key_hash（HMAC-pepper，常量时间比较）
    if (!verifyAgentCredential('key', auth.agentKey, agent.agentKeyHash, secretKey)) {
      logger.warn({ agentId: agent.id }, 'Agent 上报被拒绝：X-Agent-Key 与库内哈希不符');
      throw new AppError('signature_invalid', {
        message: 'X-Agent-Key 校验失败',
        details: { header: 'X-Agent-Key' },
      });
    }

    if (agent.status === 'disabled' || agent.disabledAt) {
      logger.warn({ agentId: agent.id }, 'Agent 上报被拒绝：凭证已被禁用');
      throw new AppError('agent_unknown_or_disabled', {
        message: 'Agent 已被禁用',
        details: { agent_id: agent.id },
      });
    }

    // ② 完整性与时效：解出 secret → HMAC 验签
    let secret;
    try {
      secret = openAgentSecret(agent.agentSecretEnc, secretKey, agent.id);
    } catch (err) {
      // 走到这里说明 SECRET_KEY 被换过、或密文被搬到了别的 Agent 行（AAD 不匹配）。
      // 这是**服务端故障**，不是请求问题：必须 500 + error 级日志，让人立刻看到。
      logger.error(
        { err, agentId: agent.id },
        'Agent 密钥解密失败：请确认 SECRET_KEY 未被更换、且 agent_secret_enc 未被跨行搬运（已 500）',
      );
      throw new AppError('internal_error', {
        message: '服务端无法解出该 Agent 的签名密钥（请联系管理员检查 SECRET_KEY）',
        cause: err,
      });
    }

    let signatureOk = false;
    try {
      signatureOk = verifySignature({
        secret,
        signature: auth.signature,
        method: request.method,
        path: toCanonicalPath(request.raw.url),
        timestamp: auth.timestamp,
        nonce: auth.nonce,
        rawBody,
      });
    } catch (err) {
      // 理论上不可达（头格式已在 parseAgentAuthHeaders 校验过）；兜底避免退化成 500
      logger.warn({ err, agentId: agent.id }, '签名 canonical 构造失败');
      throw new AppError('signature_invalid', { cause: err });
    }
    if (!signatureOk) {
      throw new AppError('signature_invalid', {
        message: 'HMAC 签名不匹配',
        details: { header: 'X-Signature' },
      });
    }

    // ③ 时间窗：> 5min 硬上限才拒（✅ 决策 #17；严格模式为 opt-in）
    const receivedAtMs = Date.now();
    const skew = evaluateTimestampSkew(auth.timestamp, receivedAtMs, {
      strict: config.security.signatureStrict === true,
      maxSkewS: config.security.signatureWindowS,
    });
    if (!skew.accept) {
      throw new AppError('timestamp_skew', {
        message: `请求时间戳超出允许窗口（硬上限 ${TIMESTAMP_HARD_LIMIT_S}s）`,
        details: { skew_ms: skew.skewMs, hard_limit_s: TIMESTAMP_HARD_LIMIT_S, reason: skew.reason },
      });
    }
    if (skew.driftAlert) {
      // M1 只记录 + 告警日志；clock_drift 告警事件由 M3 的告警引擎按规则产出
      logger.warn(
        { agentId: agent.id, skewMs: skew.skewMs, agentTs: auth.timestamp, serverTs: receivedAtMs },
        'Agent 时钟漂移超过 60s（已接受并修正，时间列一律用 server_ts）',
      );
    }

    // --- 挂上下文（后续 preHandler / handler 只读这些字段）--------------------
    // ⛔ 刻意只挂"可安全记录"的子集：`agentKeyHash` / `agentSecretEnc` 留在本地变量里，
    //    绝不进 request —— 否则将来有人在某处 `log.info({ agent: request.agent })`
    //    就会把凭证哈希与密文信封写进日志（且很难被发现）。
    request.agent = {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      lastIp: agent.lastIp,
      reportedIp: agent.reportedIp,
      ipFlapping: agent.ipFlapping,
      capabilities: agent.capabilities,
      hostInfo: agent.hostInfo,
    };
    request.agentAuth = auth;
    request.agentBody = { rawBody, gzip, encodedBytes: raw.encodedBytes, decodedBytes: raw.decodedBytes };
    request.receivedAt = receivedAtMs;

    // 把**解压后**的字节交回 Fastify：JSON.parse + schema 校验继续走标准路径
    // （因此 400 的错误码与 details 由 errors.js 统一产出，不必在这里重复实现）。
    // ⚠️ 必须带上 receivedEncodedLength（= 压缩后字节数），否则 Fastify 的
    //    Content-Length 一致性校验会把所有"真的被压缩过"的请求判成 400，见文件头说明。
    const bodyStream = Readable.from(rawBody);
    bodyStream.receivedEncodedLength = raw.encodedBytes;
    return bodyStream;
  };
}

/**
 * 创建上报一致性 preHandler（在 schema 校验之后、限流之后执行）。
 *
 * 检查两件事：
 *  1. **跨机越权**（§6.2）：`body.agent_id` 必须等于签名者的 `X-Agent-Id`，否则拒绝**并记审计**；
 *  2. **首次上报必须带 host/capabilities**（§2.1 + 决策 #55）：这是**有状态**约束，
 *     schema 层无法表达（schema 不知道库里有没有值），只能在这里判。
 *
 * @param {{ db: { app: import('pg').Pool }, logger: object, requireHostOnFirstReport?: boolean }} deps
 */
export function createAgentConsistencyCheck({ db, logger, requireHostOnFirstReport = true }) {
  return async function agentConsistencyCheck(request) {
    const { agent, agentAuth, body } = request;

    if (body.agent_id !== agentAuth.agentId) {
      // ✅ §6.2「请求体中的 agent_id 必须与签名者一致，否则拒绝并记审计」
      // 这是**已通过签名校验**的异常（有人拿 A 的密钥上报 B 的数据），值得留痕；
      // 而 X-Agent-Key 错误这类未认证请求不记审计，避免审计表被刷爆。
      await insertAuditLog(
        db.app,
        {
          actor: `agent:${agentAuth.agentId}`,
          actorType: 'agent',
          action: 'agent.report.identity_mismatch',
          target: body.agent_id,
          ip: prepareIp(request.ip).ip,
          detail: {
            header_agent_id: agentAuth.agentId,
            body_agent_id: body.agent_id,
            batch_id: body.batch_id ?? null,
            path: toCanonicalPath(request.raw.url),
          },
        },
        logger,
      );
      throw new AppError('invalid_request', {
        message: '请求体中的 agent_id 与 X-Agent-Id 不一致（跨机越权）',
        details: { field: 'agent_id' },
      });
    }

    if (!requireHostOnFirstReport) return; // heartbeat 的报文里没有 host 字段（§2.2）

    if (body.host === undefined && !agent.hostInfo) {
      throw new AppError('invalid_request', {
        message: '首次上报必须携带 host 对象（hostname/os/kernel/boot_time，可选 arch 与 capabilities）',
        details: { field: 'host', reason: 'first_report' },
      });
    }

    if (body.host !== undefined && body.host.capabilities === undefined && !agent.capabilities) {
      throw new AppError('invalid_request', {
        message: '首次上报必须携带 host.capabilities（能力声明决定面板展示哪些图表与列）',
        details: { field: 'host.capabilities', reason: 'first_report' },
      });
    }
  };
}
