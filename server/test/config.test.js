/**
 * 配置加载与校验测试 —— 对齐 src/config/index.js 的快速失败契约
 *
 * 目的不是"测试 dotenv"，而是钉住三件容易悄悄退化的事：
 *  1) 缺必需项时**一次性列出全部问题**（而不是报一个改一个）；
 *  2) **真实环境变量优先于 .env**（容器/编排覆盖文件）；
 *  3) 跨字段的隐含约束（nonce TTL ≥ 签名窗口、解压上限 ≥ 压缩上限、绝对会话 ≥ 滑动会话）必须被拦住。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { SERVER_ROOT, loadConfig, loadEnvFile, redactUrl } from '../src/config/index.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://vantage_app:pw@127.0.0.1:5432/vantage',
  SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
};

function cfg(overrides = {}) {
  return loadConfig({ ...BASE_ENV, ...overrides }, { skipEnvFile: true });
}

test('最小合法配置：默认值符合文档口径', () => {
  const config = cfg();

  // HTTP / 日志
  assert.equal(config.http.host, '127.0.0.1'); // 默认只监听回环，公网走反代
  assert.equal(config.http.port, 8787);
  assert.equal(config.http.trustProxy, 'loopback');
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.log.level, 'debug'); // dev 默认 debug

  // DB
  assert.equal(config.db.poolMax, 10);
  assert.equal(config.db.statementTimeoutMs, 15000);
  assert.equal(config.db.migratorUrl, config.db.url, '未配置 MIGRATOR_DATABASE_URL 时应回退 DATABASE_URL');

  // ✅ 决策 #47 体积上限
  assert.equal(config.security.maxCompressedBytes, 1024 * 1024);
  assert.equal(config.security.maxDecompressedBytes, 4 * 1024 * 1024);

  // ✅ 决策 #36：nonce TTL ≥ 签名窗口
  assert.equal(config.security.signatureWindowS, 300);
  assert.equal(config.security.nonceTtlS, 600);
  // ✅ 决策 #17：严格模式是 opt-in，默认必须是关的（开了会把"轻微时钟漂移"变成整机掉线）
  assert.equal(config.security.signatureStrict, false);

  // ✅ 决策 #39（设计 §8）：Flapping 判据默认 10 分钟 / 超过 3 次，
  //    与 alert_rules.params 里 ip_change.mode='frequent' 的 window_s/changes 同口径
  assert.equal(config.flapping.windowS, 600);
  assert.equal(config.flapping.changes, 3);

  // ✅ §18.1 会话
  assert.equal(config.security.session.slidingTtlS, 1800);
  assert.equal(config.security.session.absoluteTtlS, 86400);
  assert.equal(config.security.session.maxPerUser, 3);
  assert.equal(config.security.session.cookieName, 'vantage_sid');
  assert.equal(config.security.session.cookieSameSite, 'lax');

  // ✅ R10 保留期
  assert.deepEqual(
    {
      raw: config.retention.metricsRawDays,
      m1: config.retention.metrics1mDays,
      m5: config.retention.metrics5mDays,
      probe: config.retention.probeResultsDays,
      proc: config.retention.processSnapshotsDays,
      ip: config.retention.agentIpHistoryDays,
      notify: config.retention.notificationLogDays,
      audit: config.retention.auditLogsDays,
      silence: config.retention.silenceKeepAfterEndDays,
    },
    { raw: 15, m1: 90, m5: 365, probe: 90, proc: 30, ip: 180, notify: 180, audit: 365, silence: 7 },
  );
  assert.equal(config.retention.partitionPreCreateDays, 7); // ✅ §5.7.3

  // ✅ §5.3 离线判定
  assert.equal(config.heartbeat.offlineMultiplier, 3);

  // 冻结：防止运行期被模块意外改写
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.security));
  assert.ok(Object.isFrozen(config.flapping));
});

test('Flapping 参数可配且有边界（配错会让防抖变成"要么永不触发、要么一上线就触发"）', () => {
  assert.deepEqual(
    { windowS: cfg({ FLAPPING_WINDOW_S: '120', FLAPPING_CHANGES: '5' }).flapping.windowS,
      changes: cfg({ FLAPPING_WINDOW_S: '120', FLAPPING_CHANGES: '5' }).flapping.changes },
    { windowS: 120, changes: 5 },
  );

  for (const [overrides, pattern] of [
    [{ FLAPPING_WINDOW_S: '30' }, /FLAPPING_WINDOW_S 不得小于 60/],
    [{ FLAPPING_CHANGES: '0' }, /FLAPPING_CHANGES 不得小于 1/],
    [{ FLAPPING_CHANGES: 'x' }, /FLAPPING_CHANGES 必须是整数/],
  ]) {
    assert.throws(
      () => cfg(overrides),
      (err) => {
        assert.match(err.details.join('\n'), pattern, JSON.stringify(overrides));
        return true;
      },
    );
  }
});

test('生产环境收紧：日志 info、Cookie Secure 默认开', () => {
  const prod = cfg({ NODE_ENV: 'production' });
  assert.equal(prod.isProd, true);
  assert.equal(prod.log.level, 'info');
  assert.equal(prod.security.session.cookieSecure, true);

  const dev = cfg({ NODE_ENV: 'development' });
  assert.equal(dev.security.session.cookieSecure, false);
});

test('缺少必需项 → 一次性列出全部问题并给出可操作提示', () => {
  assert.throws(
    () => loadConfig({ LOG_LEVEL: 'info' }, { skipEnvFile: true }),
    (err) => {
      assert.equal(err.code, 'CONFIG_INVALID');
      const joined = err.details.join('\n');
      assert.match(joined, /DATABASE_URL 未设置/);
      assert.match(joined, /SECRET_KEY 未设置/);
      assert.match(err.message, /共 2 项/);
      assert.match(err.message, /\.env\.example/); // 指向样例文件
      return true;
    },
  );
});

test('格式类问题逐个被拦下', () => {
  const cases = [
    [{ SECRET_KEY: Buffer.alloc(16).toString('base64') }, /SECRET_KEY 必须是 base64 编码的 32 字节/],
    [{ DATABASE_URL: 'mysql://x:y@z/db' }, /必须以 postgres:\/\/ 或 postgresql:\/\//],
    [{ PORT: 'abc' }, /PORT 必须是整数/],
    [{ PORT: '70000' }, /PORT 不得大于 65535/],
    [{ NODE_ENV: 'staging' }, /NODE_ENV 只能是/],
    [{ LOG_LEVEL: 'verbose' }, /LOG_LEVEL 只能是/],
    [{ COOKIE_NAME: 'has space' }, /COOKIE_NAME 格式不合法/],
    [{ COOKIE_SECURE: 'maybe' }, /COOKIE_SECURE 必须是布尔值/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.throws(
      () => cfg(overrides),
      (err) => {
        assert.equal(err.code, 'CONFIG_INVALID');
        assert.match(err.details.join('\n'), pattern, JSON.stringify(overrides));
        return true;
      },
      JSON.stringify(overrides),
    );
  }
});

test('连接串里的口令含未编码特殊字符 → 启动前给出编码指引（⛔ 不泄露口令）', () => {
  // pg-connection-string 内部就是 new URL()：裸 `/` 或 `#` 会让驱动抛 Invalid URL，
  // 这种报错完全看不出是口令的问题，所以在配置层提前拦下并说清怎么改。
  assert.throws(
    () => cfg({ DATABASE_URL: 'postgres://u:p/ss@127.0.0.1:5432/vantage' }),
    (err) => {
      const joined = err.details.join('\n');
      assert.match(joined, /不是合法 URL/);
      assert.match(joined, /%2F/); // 编码对照表
      assert.equal(joined.includes('p/ss'), false, '⛔ 错误消息不得回显口令');
      return true;
    },
  );
  assert.throws(() => cfg({ DATABASE_URL: 'postgres://u:p#ss@h/db' }), /不是合法 URL/);

  // 百分号编码后必须通过（这是文档给出的正解）
  assert.doesNotThrow(() => cfg({ DATABASE_URL: 'postgres://u:p%2Fss@127.0.0.1:5432/vantage' }));
  assert.doesNotThrow(() => cfg({ DATABASE_URL: 'postgres://u:p%40ss@127.0.0.1:5432/vantage' }));
});

test('跨字段约束：这些组合必须被拒绝（否则是静默的安全/功能缺陷）', () => {
  const cases = [
    // nonce 短于签名窗口 → 重放窗口重新打开（docs/database.md §7）
    [{ NONCE_TTL_S: '120', SIGNATURE_WINDOW_S: '300' }, /NONCE_TTL_S 必须 ≥ SIGNATURE_WINDOW_S/],
    // 解压上限小于压缩上限 → 正常请求被误拒
    [{ MAX_COMPRESSED_BYTES: '4194304', MAX_DECOMPRESSED_BYTES: '1048576' }, /MAX_DECOMPRESSED_BYTES 不得小于/],
    // 绝对会话短于滑动会话 → 会话永不到期或立刻过期，语义错乱
    [{ SESSION_ABSOLUTE_TTL_S: '600', SESSION_SLIDING_TTL_S: '1800' }, /SESSION_ABSOLUTE_TTL_S 不得小于/],
    // 原始层比降采样层后过期 → 会出现「原始在、1m 已删」的空洞
    [{ RETENTION_METRICS_RAW_DAYS: '120', RETENTION_METRICS_1M_DAYS: '90' }, /RETENTION_METRICS_RAW_DAYS 应小于/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.throws(
      () => cfg(overrides),
      (err) => {
        assert.match(err.details.join('\n'), pattern, JSON.stringify(overrides));
        return true;
      },
    );
  }
});

test('真实环境变量优先于 .env 文件（容器/编排可覆盖）', () => {
  // 用仓库里的 .env.example 当"文件"，避免测试写临时文件
  const envFile = path.join(SERVER_ROOT, '.env.example');
  const env = { HOST: '10.0.0.9' }; // 已存在的键不得被文件覆盖
  const result = loadEnvFile(envFile, env);

  assert.equal(result.loaded, true);
  assert.equal(env.HOST, '10.0.0.9', '已存在的环境变量必须胜出');
  assert.equal(env.PORT, '8787', '文件中缺失的键应被补入');
  assert.ok(result.keys.includes('SECRET_KEY'));

  // 配置文件不存在时不抛异常（纯环境变量部署是合法场景）
  assert.deepEqual(loadEnvFile(path.join(SERVER_ROOT, 'no-such-file.env'), {}), {
    loaded: false,
    file: path.join(SERVER_ROOT, 'no-such-file.env'),
  });
});

test('日志脱敏助手：隐藏连接串口令', () => {
  assert.equal(
    redactUrl('postgres://vantage_app:s3cr3t@127.0.0.1:5432/vantage'),
    'postgres://vantage_app:***@127.0.0.1:5432/vantage',
  );
  assert.equal(redactUrl('redis://:pw@127.0.0.1:6379/0'), 'redis://:***@127.0.0.1:6379/0');
  assert.equal(redactUrl('postgres://127.0.0.1:5432/vantage'), 'postgres://127.0.0.1:5432/vantage');
  assert.equal(redactUrl(undefined), undefined);
});
