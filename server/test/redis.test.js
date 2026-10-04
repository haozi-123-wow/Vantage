/**
 * Redis 连接配置与键空间契约测试
 *
 * 覆盖两件容易出事、且出事后极难查的事：
 *
 *  A) **连接凭据的来源与优先级**（对齐 docs/database.md §7/§11 与 .env.example 的说明）
 *     - ioredis 用 `lodash.defaults` **按参数顺序**填充选项 → URL 里的凭据会压过显式 `password`；
 *       因此代码必须在同时提供两者时**摘掉 URL 里的凭据**，保证只有一处来源；
 *     - ioredis 用 WHATWG `new URL()` 解析连接串 → 口令里的裸 `/` 直接抛 `Invalid URL`（启动即崩）、
 *       裸 `#` 会被当 fragment **静默解析错**，所以内联形态必须百分号编码。
 *     - ⛔ 无论哪种情况，日志里都不得出现口令（`redactUrl` 必须能扛住未编码的 `/ ? #`）。
 *
 *  B) **键空间前缀与 TTL**（✅ R15：单实例 + 键名前缀隔离；决策 #36：nonce TTL ≥ 签名窗口）
 *     键名是跨模块契约（接入层写、cron/告警读、排障手工查），本文件同时钉住定时任务命名。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, redactUrl } from '../src/config/index.js';
import { createRedis, resolveRedisTarget } from '../src/db/redis.js';
import { CHANNEL, CRON_TASKS, KEY_PREFIX, TTL_S, keys } from '../src/utils/redisKeys.js';

// -----------------------------------------------------------------------------
// A. 连接凭据
// -----------------------------------------------------------------------------

test('无口令形态：原样返回，且不报警告', () => {
  for (const url of ['redis://127.0.0.1:6379/0', 'redis://127.0.0.1:6379', 'rediss://redis.internal:6380/1']) {
    const target = resolveRedisTarget({ url });
    assert.equal(target.url, url, 'URL 往返必须无损（端口/库号/rediss 都不能丢）');
    assert.equal(target.source, 'none');
    assert.deepEqual(target.warnings, []);
  }
});

test('内联口令形态：走 URL，不额外传选项', () => {
  const target = resolveRedisTarget({ url: 'redis://:s3cr3t@127.0.0.1:6379/2' });
  assert.equal(target.source, 'url');
  assert.equal(target.url, 'redis://:s3cr3t@127.0.0.1:6379/2');
  assert.equal(target.password, undefined);
  assert.deepEqual(target.warnings, []);
});

test('分立变量形态：URL 只留地址与库号，凭据走选项', () => {
  const target = resolveRedisTarget({
    url: 'redis://127.0.0.1:6379/0',
    username: 'vantage',
    password: 'p@ss:word/带符 都不需要编码',
  });
  assert.equal(target.source, 'discrete');
  assert.equal(target.url, 'redis://127.0.0.1:6379/0');
  assert.equal(target.username, 'vantage');
  assert.equal(target.password, 'p@ss:word/带符 都不需要编码');
  assert.deepEqual(target.warnings, []);
});

test('两种都给：必须摘掉 URL 里的凭据并告警（⛔ 否则改 .env 会毫无效果）', () => {
  const target = resolveRedisTarget({
    url: 'redis://olduser:oldpw@127.0.0.1:6379/3',
    username: 'vantage',
    password: 'newpw',
  });
  // URL 里的凭据必须被丢弃，且库号保留
  assert.equal(target.url, 'redis://127.0.0.1:6379/3');
  assert.equal(target.source, 'discrete');
  assert.equal(target.password, 'newpw');
  assert.equal(target.warnings.length, 1);
  assert.match(target.warnings[0], /丢弃 URL 中的凭据/);
});

test('非法 URL 给出可操作提示，且提示里已脱敏（裸 / 会崩、裸 # 会静默解析错）', () => {
  // 裸 `/`：ioredis 会抛 TypeError: Invalid URL —— 我们提前换成带编码指引的中文错误
  assert.throws(
    () => resolveRedisTarget({ url: 'redis://:p/ss@127.0.0.1:6379/0' }),
    (err) => {
      assert.match(err.message, /不是合法 URL/);
      assert.match(err.message, /%2F/); // 给出编码对照表
      assert.match(err.message, /REDIS_PASSWORD/); // 给出更省事的替代方案
      assert.equal(err.message.includes('p/ss'), false, '⛔ 错误消息不得回显口令');
      return true;
    },
  );

  // 裸 `#`：WHATWG 当 fragment，不报错但解析结果错——这里只断言我们把口令脱敏后原样保留 URL
  const target = resolveRedisTarget({ url: 'redis://:pw@127.0.0.1:6379/0#frag' });
  assert.equal(target.source, 'url');
  assert.equal(redactUrl('redis://:pw@127.0.0.1:6379/0#frag').includes('pw'), false);
});

test('createRedis：构造出的客户端确实带着预期口令与库号，且日志不泄露', () => {
  const logged = [];
  const logger = {
    info: (...a) => logged.push(a),
    warn: (...a) => logged.push(a),
    error: (...a) => logged.push(a),
    debug: (...a) => logged.push(a),
  };

  // ① 分立变量：URL 无凭据 + 选项带口令
  const discrete = createRedis({
    url: 'redis://127.0.0.1:6379/4',
    username: 'vantage',
    password: 'p@ss/word#no-encoding-needed',
    lazyConnect: true, // 仅测试：不真连
    logger,
  });
  assert.equal(discrete.options.password, 'p@ss/word#no-encoding-needed');
  assert.equal(discrete.options.username, 'vantage');
  assert.equal(discrete.options.db, 4);
  assert.ok(discrete.options.lazyConnect);
  discrete.disconnect();

  // ② 内联形态：ioredis 从 URL 解出口令（必须先百分号编码）
  const inline = createRedis({ url: 'redis://:p%40ss%2Fword@127.0.0.1:6379/0', lazyConnect: true, logger });
  assert.equal(inline.options.password, 'p@ss/word');
  inline.disconnect();

  // ③ 冲突形态：生效的是分立变量，URL 里的旧口令必须被彻底丢弃
  const conflicted = createRedis({
    url: 'redis://olduser:oldpw@127.0.0.1:6379/1',
    password: 'newpw',
    lazyConnect: true,
    logger,
  });
  assert.equal(conflicted.options.password, 'newpw');
  assert.equal(conflicted.options.db, 1);
  conflicted.disconnect();
  assert.ok(
    logged.some((args) => typeof args[0] === 'string' && args[0].includes('丢弃 URL 中的凭据')),
    '冲突时必须打 warn',
  );

  // ⛔ 日志中不得出现任何口令明文
  const flat = JSON.stringify(logged);
  for (const secret of ['newpw', 'oldpw', 'p@ss/word', 'p@ss/word#no-encoding-needed']) {
    assert.equal(flat.includes(secret), false, `日志泄露了口令：${secret}`);
  }
});

test('配置层：REDIS_PASSWORD / REDIS_USERNAME 被正确读入，且约束合理', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/vantage',
    SECRET_KEY: Buffer.alloc(32, 5).toString('base64'),
  };

  const without = loadConfig(base, { skipEnvFile: true });
  assert.equal(without.redis.password, undefined, '未设置时不应有默认口令');
  assert.equal(without.redis.username, undefined);
  assert.equal(without.redis.url, 'redis://127.0.0.1:6379/0');

  const withPw = loadConfig({ ...base, REDIS_PASSWORD: 's3cr3t' }, { skipEnvFile: true });
  assert.equal(withPw.redis.password, 's3cr3t');

  // ACL 用户必须配套口令，否则是静默的半配置状态
  assert.throws(
    () => loadConfig({ ...base, REDIS_USERNAME: 'vantage' }, { skipEnvFile: true }),
    (err) => {
      assert.equal(err.code, 'CONFIG_INVALID');
      assert.match(err.details.join('\n'), /REDIS_USERNAME 已设置但 REDIS_PASSWORD 为空/);
      return true;
    },
  );

  // 空值等同于未设置（.env 里留空是常见写法）
  const emptyPw = loadConfig({ ...base, REDIS_PASSWORD: '' }, { skipEnvFile: true });
  assert.equal(emptyPw.redis.password, undefined);
});

test('redactUrl：无论口令含何种字符，都不得漏出明文（含畸形 URL 兜底）', () => {
  const cases = [
    ['postgres://vantage_app:s3cr3t@127.0.0.1:5432/vantage', 'postgres://vantage_app:***@127.0.0.1:5432/vantage'],
    ['redis://:pw@127.0.0.1:6379/0', 'redis://:***@127.0.0.1:6379/0'],
    ['redis://user:pw@127.0.0.1:6379/0', 'redis://user:***@127.0.0.1:6379/0'],
    ['postgres://127.0.0.1:5432/vantage', 'postgres://127.0.0.1:5432/vantage'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactUrl(input), expected, input);
  }

  // 未编码的特殊字符：脱敏**不得静默失效**（这正是它最容易漏的场景）
  for (const nasty of [
    'redis://:p/ss@127.0.0.1:6379/0',
    'redis://:p#ss@127.0.0.1:6379/0',
    'redis://:p?ss@127.0.0.1:6379/0',
    'postgres://u:p/ss@h/db',
  ]) {
    const redacted = redactUrl(nasty);
    assert.ok(redacted.includes('***'), `未脱敏：${nasty} -> ${redacted}`);
    for (const leak of ['p/ss', 'p#ss', 'p?ss']) {
      assert.equal(redacted.includes(leak), false, `泄露了口令片段：${redacted}`);
    }
  }

  assert.equal(redactUrl(undefined), undefined);
  assert.equal(redactUrl('not-a-url'), 'not-a-url');
});

// -----------------------------------------------------------------------------
// B. 键空间
// -----------------------------------------------------------------------------

test('所有键都带隔离前缀，且前缀互不重复（避免跨用途误命中 SCAN 结果）', () => {
  const prefixes = Object.values(KEY_PREFIX);
  const unique = new Set(prefixes);
  assert.equal(unique.size, prefixes.length, '前缀不得重复');

  for (const key of [
    keys.rateLimitAgent('11111111-2222-3333-4444-555555555555'),
    keys.rateLimitPublic('203.0.113.1'),
    keys.rateLimitLogin('203.0.113.1'),
    keys.rateLimitWs('203.0.113.1'),
    keys.nonce('11111111-2222-3333-4444-555555555555', 'abc'),
    keys.batch('01J000000000000000000000AA'),
    keys.session('sid'),
    keys.userSessions('11111111-2222-3333-4444-555555555555'),
    keys.alertCooldown('rule', 'agent'),
    keys.ipRecent('agent'),
    keys.snapshotAgent('agent'),
    keys.snapshotPublicHosts,
    keys.snapshotPublicSummary,
    keys.notifyTokenBucket('channel'),
    keys.cronLock('create_partitions'),
  ]) {
    assert.ok(
      prefixes.some((prefix) => key.startsWith(prefix)),
      `键未使用登记过的前缀：${key}`,
    );
    // ⛔ 键名里不得出现空格/换行（会影响 Redis CLI 与日志排查）
    assert.doesNotMatch(key, /[\s]/);
  }

  assert.equal(keys.settingsCache, KEY_PREFIX.settingsCache);
});

test('nonce TTL 必须 ≥ 签名窗口（✅ 决策 #36；docs/database.md §7）', () => {
  const config = loadConfig(
    {
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/vantage',
      SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
      SIGNATURE_WINDOW_S: '300',
      NONCE_TTL_S: '600',
    },
    { skipEnvFile: true },
  );

  assert.equal(TTL_S.nonce, 600);
  assert.equal(TTL_S.batch, 600, '幂等键 TTL 应等于决策 #18 的 10min');
  assert.ok(
    TTL_S.nonce >= config.security.signatureWindowS,
    `nonce TTL（${TTL_S.nonce}s）必须 ≥ 签名窗口（${config.security.signatureWindowS}s），否则重放窗口未被覆盖`,
  );
});

test('定时任务名与 docs/database.md §8.2 表格一一对应', () => {
  assert.deepEqual(Object.values(CRON_TASKS).sort(), [
    'aggregate_1m',
    'aggregate_5m',
    'create_partitions',
    'credential_rotate_reminder',
    'drop_partitions',
    'flapping_recover',
    'offline_sweep',
    'purge_downsampled',
    'purge_non_timeseries',
  ]);
  // 锁键必须能从任务名稳定派生（多实例下只跑一次，✅ R13）
  for (const task of Object.values(CRON_TASKS)) {
    assert.equal(keys.cronLock(task), `cron:lock:${task}`);
  }
});

test('Pub/Sub 频道：落库后扇出用 live:metrics，设置变更用 live:settings', () => {
  assert.equal(CHANNEL.liveMetrics, 'live:metrics');
  assert.equal(CHANNEL.settingsChanged, 'live:settings');
  assert.ok(CHANNEL.liveMetrics.startsWith('live:'));
});
