#!/usr/bin/env node
/**
 * Vantage · 分区运维 CLI（metrics_raw 按天分区）
 *
 * 用途：M1.5 的定时任务上线之前/之后的**手工兜底**与核对。
 *       ⚠️ 为什么必须提供手工入口：迁移只预建「今天 +7」天分区，而**建分区任务排在 M3**。
 *       一旦某天的数据先落进 `metrics_raw_default`，再想给那天补建分区会被 PG 拒绝：
 *         ERROR 23514: updated partition constraint for default partition "metrics_raw_default"
 *                      would be violated by some row
 *       此时唯一的补救是**先删掉那天的数据**（= 丢数据）。因此宁可用本脚本提前铺满。
 *
 * 用法
 *   node scripts/partitions.js --list                     # 列出已有按天分区与覆盖情况
 *   node scripts/partitions.js --ensure 90                # 预建「今天 + 90 天」分区（幂等）
 *   node scripts/partitions.js --drop-expired 15 --dry-run # 只看会删哪些（不执行）
 *   node scripts/partitions.js --drop-expired 15          # 真删（⛔ 数据不可恢复）
 *
 * ⛔ DDL 必须用**拥有这些表的账号**（通常是迁移账号）：见 README §2.2 与
 *    docs/database.md §2「PG 的 DDL 靠表属主，不靠库权限」。
 */

import { getConfig } from '../src/config/index.js';
import { createPool } from '../src/db/pg.js';
import {
  dropExpiredPartitions,
  ensureUpcomingPartitions,
  listPartitions,
} from '../src/services/partition.service.js';
import { createLogger } from '../src/utils/log.js';

function parseArgs(argv) {
  const args = { list: false, ensure: null, dropExpired: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--list') args.list = true;
    else if (token === '--ensure') args.ensure = Number(argv[++i]);
    else if (token === '--drop-expired') args.dropExpired = Number(argv[++i]);
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`未知参数：${token}（用 --help 查看用法）`);
  }
  return args;
}

const HELP = `
Vantage 分区运维工具

  --list                    列出已有按天分区、覆盖区间与剩余天数
  --ensure <N>              预建「今天 .. 今天+N 天」分区（幂等；N 建议 ≥ 7，铺 90 更稳）
  --drop-expired <N>        删除 ts 全部早于「now()-N 天」的整日分区
  --dry-run                 与 --drop-expired 同用：只列出将被删除的分区，不执行
  --help                    显示本帮助

⚠️ 分区 Drop 是**按天整块删除**，⛔ 数据不可恢复。执行前请确认：
   该区间的数据是否已经聚合进 metrics_1m / metrics_5m（降采样任务未上线时，删掉就是永久丢失）。
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP.trim());
    return;
  }

  const config = getConfig();
  const logger = createLogger({ level: 'warn' });
  // 分区 DDL：优先用独立迁移账号，单账号部署下回退到运行时账号（✅ 已确认的部署事实）
  const pool = createPool({
    connectionString: config.db.migratorUrl ?? config.db.url,
    applicationName: 'vantage-core/cli:partitions',
    max: 2,
    statementTimeoutMs: 0, // 建/删分区可能重，别被超时打断
    logger,
  });

  try {
    if (args.list || (!args.ensure && args.dropExpired === null)) {
      const info = await listPartitions(pool);
      console.log(`按天分区 ${info.partitions.length} 个`);
      if (info.partitions.length > 0) {
        console.log(`  覆盖：${info.partitions[0].day} → ${info.partitions.at(-1).day}（还剩 ${info.remainingDays} 天）`);
      }
      console.log(`  兜底分区 metrics_raw_default 行数：${info.defaultRows}`);
      if (info.partitions.length > 0 && info.remainingDays < 7) {
        console.log('  ⚠️ 覆盖不足 7 天，请尽快执行 --ensure 90');
      }
      console.table(
        info.partitions.slice(-10).map((p) => ({ 分区: p.name, 日期: p.day, 行数: p.rows })),
      );
      if (info.partitions.length > 10) console.log(`（仅显示最后 10 个；共 ${info.partitions.length} 个）`);
    }

    if (args.ensure !== null) {
      if (!Number.isInteger(args.ensure) || args.ensure < 1 || args.ensure > 3650) {
        throw new Error('--ensure 需要 1..3650 之间的整数（天数）');
      }
      const started = Date.now();
      const result = await ensureUpcomingPartitions(pool, { days: args.ensure, logger });
      console.log(
        `✅ 预建完成：新建 ${result.created.length} 个、已存在 ${result.existed.length} 个；` +
          `覆盖至 ${result.lastDay}（耗时 ${Date.now() - started}ms）`,
      );
      if (result.created.length > 0) console.log('  新建：', result.created.join(', '));
    }

    if (args.dropExpired !== null) {
      if (!Number.isInteger(args.dropExpired) || args.dropExpired < 1 || args.dropExpired > 3650) {
        throw new Error('--drop-expired 需要 1..3650 之间的整数（天数）');
      }
      const result = await dropExpiredPartitions(pool, {
        olderThanDays: args.dropExpired,
        dryRun: args.dryRun,
        logger,
      });
      const verb = args.dryRun ? '将删除' : '已删除';
      console.log(`${verb} ${result.dropped.length} 个分区（截止 ${result.cutoff}）`);
      if (result.dropped.length > 0) console.log('  ', result.dropped.join(', '));
      if (!args.dryRun) {
        console.log(
          '⚠️ 提醒：若降采样任务尚未上线，这些分区里的原始数据已永久丢失（design-deltas §8 M-11）。',
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`\n✖ ${err?.message ?? err}\n`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
