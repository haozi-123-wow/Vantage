/**
 * 测试替身 · 内存版 Redis（只实现本服务真正用到的那几条命令）
 *
 * 为什么不用真的 Redis：单元/路由测试必须能在**离线**环境下跑（CI、本机、无外网）。
 * 真机连通性另有一组"活体测试"（test/report.live.test.js），用真实 PG + Redis 覆盖，
 * 需显式设置 VANTAGE_LIVE_TEST=1 才会执行。
 *
 * ⚠️ `eval` 这里**内联实现了** middleware/rateLimit.js 里那段 Lua 的语义。
 *    这是刻意的：fake 不解析 Lua，而是照着"计数 + 首次设 TTL"的契约实现，
 *    于是"每次请求都续期 TTL"这种错误写法在测试里会立刻暴露（计数器永不清零 → 稳定速率下永久 429）。
 */

export function createFakeRedis({ now = () => Date.now() } = {}) {
  /** key → { value, expiresAt } */
  const store = new Map();
  /** 逐条记录已执行命令，便于断言（如「非 gzip 请求不应写 nonce」） */
  const commands = [];
  const published = [];

  const alive = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };

  const ttlOf = (entry) => (entry.expiresAt === null ? -1 : Math.ceil((entry.expiresAt - now()) / 1000));

  const redis = {
    commands,
    published,
    /** 测试用：直接种一个键（如预置 nonce / batch 占位） */
    seed(key, value, ttlS = 600) {
      store.set(key, { value: String(value), expiresAt: now() + ttlS * 1000 });
    },
    has(key) {
      return alive(key) !== null;
    },
    keys() {
      return [...store.keys()].filter((key) => alive(key) !== null);
    },

    async set(key, value, ...flags) {
      commands.push({ cmd: 'set', key, value, flags });
      const hasNx = flags.some((flag) => String(flag).toUpperCase() === 'NX');
      if (hasNx && alive(key)) return null;
      let ttlS = null;
      const exIndex = flags.findIndex((flag) => String(flag).toUpperCase() === 'EX');
      if (exIndex !== -1) ttlS = Number(flags[exIndex + 1]);
      store.set(key, { value: String(value), expiresAt: ttlS === null ? null : now() + ttlS * 1000 });
      return 'OK';
    },

    async del(...keys) {
      commands.push({ cmd: 'del', keys });
      let removed = 0;
      for (const key of keys.flat()) if (store.delete(key)) removed += 1;
      return removed;
    },

    async ttl(key) {
      const entry = alive(key);
      return entry ? ttlOf(entry) : -2;
    },

    /** 仅用于断言「限流键是否被错误续期」等场景 */
    async incr(key) {
      commands.push({ cmd: 'incr', key });
      const entry = alive(key);
      const next = (entry ? Number(entry.value) : 0) + 1;
      store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    },

    /**
     * 只实现本服务真正用到的两段脚本语义（fake 不解析 Lua，照契约实现）：
     *
     *  ① **固定窗口限流**（middleware/rateLimit.js）：INCR，且**仅当 n === 1** 时设 TTL。
     *     刻意照这个契约实现，于是"每次请求都续期 TTL"这种错误写法会在测试里立刻暴露
     *     （计数器永不清零 → 稳定速率下永久 429）。
     *  ② **cron 锁的安全释放**（services/cron.service.js）：GET 与期望 token 相等才 DEL。
     *     ⚠️ 少了这一支，锁永远不会被释放，测试会误报"任务卡死"。
     *
     * @returns {Promise<[number, number] | number>}
     */
    async eval(script, numKeys, ...args) {
      const key = args[0];

      if (String(script).includes("'DEL'")) {
        const token = String(args[1]);
        commands.push({ cmd: 'eval:release-lock', key });
        const entry = alive(key);
        if (entry && entry.value === token) {
          store.delete(key);
          return 1;
        }
        return 0; // 不是持有者 → 不动别人的锁
      }

      const windowS = Number(args[1]);
      commands.push({ cmd: 'eval:fixed-window', key, windowS });
      const entry = alive(key);
      const next = (entry ? Number(entry.value) : 0) + 1;
      let expiresAt = entry?.expiresAt ?? null;
      if (next === 1 || expiresAt === null) expiresAt = now() + windowS * 1000;
      store.set(key, { value: String(next), expiresAt });
      return [next, ttlOf(store.get(key))];
    },

    async publish(channel, payload) {
      published.push({ channel, payload });
      return 1;
    },

    pipeline() {
      const queued = [];
      const chain = {
        publish(channel, payload) {
          queued.push({ channel, payload });
          return chain;
        },
        async exec() {
          const results = queued.map(({ channel, payload }) => {
            published.push({ channel, payload });
            return [null, 1];
          });
          return results;
        },
      };
      return chain;
    },

    async ping() {
      return 'PONG';
    },

    async info() {
      return 'used_memory:1048576\r\nmaxmemory_policy:noeviction\r\nevicted_keys:0\r\n';
    },
  };

  return redis;
}
