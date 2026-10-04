/**
 * 测试替身 · 内存版 Redis（**hash / set / TTL** 语义版）
 *
 * 为什么与 `fake-redis.js` 分开而不是合并：
 *   `fake-redis.js` 是**字符串键**模型，专为 Agent 上报链路服务（nonce / batch 占位 / 固定窗口限流），
 *   里面那段 `eval` 是照着限流 Lua 的契约手写的——它的价值就在于"简单到能一眼看出 TTL 语义对不对"。
 *   面板会话要的是 hash + set + 滑动续期 + 多键批量（multi/pipeline），把两套命令塞进同一个 store
 *   会让那份简单性消失，而且任何一侧的改动都可能悄悄影响另一侧的既有断言。
 *   因此：**各自独立，按用途分文件**（与 fake-pg / fake-redis 并存同一取向）。
 *
 * ⚠️ `multi()` 与 `pipeline()` 在这里是**同一个实现**：本替身不模拟 MULTI/EXEC 的原子性
 *    （单进程同步执行，命令之间没有其它写入者插进来的机会），只保证命令顺序与返回值形状
 *    与 ioredis 的 `[[err, result], ...]` 一致。凡是要靠真实原子性才能成立的正确性，
 *    必须由**真活体测试**（VANTAGE_LIVE_TEST）覆盖，⛔ 不能靠这个替身背书。
 */

/**
 * @param {{ now?: () => number }} [options] `now` 可注入，用于模拟"时间流逝"而无需真的等待
 */
export function createFakeRedisHash({ now = () => Date.now() } = {}) {
  /** key → { type: 'string'|'hash'|'set', value: string|Map, expiresAt: number|null } */
  const store = new Map();
  /** 逐条记录已执行命令，便于断言"到底写了哪些键" */
  const commands = [];

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

  const hset = async (key, ...args) => {
    commands.push({ cmd: 'hset', key });
    // ioredis 支持两种形态：hset(key, field, value) 与 hset(key, { f: v })
    const pairs =
      typeof args[0] === 'object' && args[0] !== null ? Object.entries(args[0]) : [[args[0], args[1]]];

    let entry = alive(key);
    if (!entry) {
      entry = { type: 'hash', value: new Map(), expiresAt: null };
      store.set(key, entry);
    }
    if (entry.type !== 'hash') throw new Error('WRONGTYPE：键不是 hash');

    let created = 0;
    for (const [field, value] of pairs) {
      if (!entry.value.has(field)) created += 1;
      // Redis 只能存字符串：null/undefined 一律落成空串（读回时由服务层归一为 null）
      entry.value.set(field, value === null || value === undefined ? '' : String(value));
    }
    return created;
  };

  const hget = async (key, field) => {
    const entry = alive(key);
    if (!entry) return null;
    if (entry.type !== 'hash') throw new Error('WRONGTYPE：键不是 hash');
    return entry.value.get(field) ?? null;
  };

  const hgetall = async (key) => {
    const entry = alive(key);
    if (!entry) return {};
    if (entry.type !== 'hash') throw new Error('WRONGTYPE：键不是 hash');
    return Object.fromEntries(entry.value);
  };

  const sadd = async (key, ...members) => {
    commands.push({ cmd: 'sadd', key, members });
    let entry = alive(key);
    if (!entry) {
      entry = { type: 'set', value: new Set(), expiresAt: null };
      store.set(key, entry);
    }
    if (entry.type !== 'set') throw new Error('WRONGTYPE：键不是 set');
    let added = 0;
    for (const member of members.flat()) {
      if (!entry.value.has(String(member))) {
        entry.value.add(String(member));
        added += 1;
      }
    }
    return added;
  };

  const srem = async (key, ...members) => {
    commands.push({ cmd: 'srem', key, members });
    const entry = alive(key);
    if (!entry) return 0;
    if (entry.type !== 'set') throw new Error('WRONGTYPE：键不是 set');
    let removed = 0;
    for (const member of members.flat()) if (entry.value.delete(String(member))) removed += 1;
    return removed;
  };

  const smembers = async (key) => {
    const entry = alive(key);
    if (!entry) return [];
    if (entry.type !== 'set') throw new Error('WRONGTYPE：键不是 set');
    return [...entry.value];
  };

  /**
   * hash 字段自增（滑块题目的 `attempts` 计数用它）——返回**自增后**的值，与 ioredis 一致。
   * ⚠️ 键不存在时按 hash 新建（Redis 的 HINCRBY 正是如此），⛔ 不要抛错。
   */
  const hincrby = async (key, field, increment = 1) => {
    commands.push({ cmd: 'hincrby', key, field, increment });
    let entry = alive(key);
    if (!entry) {
      entry = { type: 'hash', value: new Map(), expiresAt: null };
      store.set(key, entry);
    }
    if (entry.type !== 'hash') throw new Error('WRONGTYPE：键不是 hash');
    const next = (Number(entry.value.get(field)) || 0) + Number(increment);
    entry.value.set(field, String(next));
    return next;
  };

  /**
   * 字符串自增（通用计数用）。
   * ⛔ 不要用它替代固定窗口的那段 Lua：`INCR` 之后再 `EXPIRE` 是**两步非原子**，
   *    崩在中间会留下没有 TTL 的计数器（见 utils/redisCounter.js 的说明）。
   */
  const incr = async (key) => {
    commands.push({ cmd: 'incr', key });
    let entry = alive(key);
    if (!entry) {
      entry = { type: 'string', value: '0', expiresAt: null };
      store.set(key, entry);
    }
    if (entry.type !== 'string') throw new Error('WRONGTYPE：键不是 string');
    const next = (Number(entry.value) || 0) + 1;
    entry.value = String(next);
    return next;
  };

  /** 键是否存在（返回 0/1，与 Redis 单键 EXISTS 一致；过期的键按不存在处理） */
  const exists = async (key) => (alive(key) ? 1 : 0);

  const expire = async (key, ttlS) => {
    commands.push({ cmd: 'expire', key, ttlS });
    const entry = alive(key);
    if (!entry) return 0;
    entry.expiresAt = now() + Number(ttlS) * 1000;
    return 1;
  };

  const del = async (...keys) => {
    commands.push({ cmd: 'del', keys });
    let removed = 0;
    for (const key of keys.flat()) if (store.delete(key)) removed += 1;
    return removed;
  };

  const ttl = async (key) => {
    const entry = alive(key);
    return entry ? ttlOf(entry) : -2;
  };

  const get = async (key) => {
    const entry = alive(key);
    if (!entry) return null;
    if (entry.type !== 'string') throw new Error('WRONGTYPE：键不是 string');
    return entry.value;
  };

  const set = async (key, value, ...flags) => {
    commands.push({ cmd: 'set', key, value, flags });
    let ttlS = null;
    const exIndex = flags.findIndex((flag) => String(flag).toUpperCase() === 'EX');
    if (exIndex !== -1) ttlS = Number(flags[exIndex + 1]);
    store.set(key, {
      type: 'string',
      value: String(value),
      expiresAt: ttlS === null ? null : now() + ttlS * 1000,
    });
    return 'OK';
  };

  /**
   * 只实现本服务用到的 Lua 契约：**固定窗口限流**（middleware/rateLimit.js 的
   * `FIXED_WINDOW_LUA`，Agent 与登录限流共用）—— INCR，且仅当 n === 1 时设 TTL。
   * 刻意照契约实现而不是解析 Lua：与 fake-redis.js 相同的理由，
   * "每次请求都续期 TTL"这类错误写法会立刻暴露（计数器永不清零 → 永久 429）。
   *
   * @returns {Promise<[number, number]>} [当前计数, 剩余秒数]
   */
  const evalScript = async (script, numKeys, ...args) => {
    const key = args[0];
    const windowS = Number(args[1]);
    commands.push({ cmd: 'eval:fixed-window', key, windowS });
    const entry = alive(key);
    const next = (entry && entry.type === 'string' ? Number(entry.value) : 0) + 1;
    let expiresAt = entry?.expiresAt ?? null;
    if (next === 1 || expiresAt === null) expiresAt = now() + windowS * 1000;
    store.set(key, { type: 'string', value: String(next), expiresAt });
    return [next, ttlOf(store.get(key))];
  };

  /** 测试用：种一个 hash（如伪造一条"已过期但有集合成员"的僵尸会话） */
  const seedHash = (key, fields, ttlS = null) => {
    store.set(key, {
      type: 'hash',
      value: new Map(Object.entries(fields).map(([f, v]) => [f, v === null ? '' : String(v)])),
      expiresAt: ttlS === null ? null : now() + ttlS * 1000,
    });
  };

  const seedSet = (key, members, ttlS = null) => {
    store.set(key, {
      type: 'set',
      value: new Set(members.map(String)),
      expiresAt: ttlS === null ? null : now() + ttlS * 1000,
    });
  };

  /** 批量命令链：multi() 与 pipeline() 共用一个实现（原子性差异见文件头） */
  function chain() {
    const queued = [];
    const api = {
      hset,
      hget,
      hgetall,
      hincrby,
      incr,
      exists,
      sadd,
      srem,
      smembers,
      expire,
      del,
      ttl,
      get,
      set,
      eval: evalScript,
    };
    const builder = {};
    for (const name of Object.keys(api)) {
      builder[name] = (...args) => {
        queued.push([name, args]);
        return builder;
      };
    }
    builder.exec = async () => {
      const results = [];
      for (const [name, args] of queued) {
        try {
          results.push([null, await api[name](...args)]);
        } catch (err) {
          results.push([err, null]);
        }
      }
      return results;
    };
    return builder;
  }

  return {
    commands,
    has: (key) => alive(key) !== null,
    keys: () => [...store.keys()].filter((key) => alive(key) !== null),
    seedHash,
    seedSet,
    hset,
    hget,
    hgetall,
    hincrby,
    incr,
    exists,
    sadd,
    srem,
    smembers,
    expire,
    del,
    ttl,
    get,
    set,
    eval: evalScript,
    multi: chain,
    pipeline: chain,
  };
}
