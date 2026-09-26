#!/usr/bin/env node
/**
 * Vantage · 测试入口（在**同一进程内**顺序加载全部 *.test.js）
 *
 * 为什么不用 `node --test`：
 *   默认的 `node --test` 会为**每个测试文件派生一个子进程**（piped stdio）。
 *   在受限沙箱（本仓库当前的开发环境）里命名管道被禁止，会直接报 `spawn EPERM`，
 *   于是"跑不了测试"会被误读成"代码有问题"。
 *   本脚本改为按文件名顺序 `import()` 每个测试文件，node:test 会自动注册并执行用例，
 *   失败时同样把进程退出码置为 1。
 *
 * 何时仍建议用进程隔离版本（CI / Linux 开发机）：
 *   npm run test:isolated        # = node --test "test/*.test.js"
 *   它能额外捕获"测试文件之间互相污染全局状态"这类问题。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_DIR = path.resolve(import.meta.dirname, '..', 'test');

const files = fs
  .readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .sort((a, b) => a.localeCompare(b, 'en'));

if (files.length === 0) {
  console.error(`未找到任何测试文件：${TEST_DIR}`);
  process.exit(1);
}

console.log(`Vantage 测试：共 ${files.length} 个文件（进程内顺序执行）\n`);

for (const file of files) {
  await import(pathToFileURL(path.join(TEST_DIR, file)).href);
}
