#!/usr/bin/env node
/*
 * agent/deploy/tests/shell-lint.js — 部署脚本的本机结构化校验
 *
 * 为什么需要它：Windows 开发机上 MSYS 的 `sh.exe` 会被沙箱的命名管道限制挡住
 * （`couldn't create signal pipe, Win32 error 5`），跑不了 `sh -n`。
 * 本工具用 Node 做**等价的结构检查 + 红线检查**，让本机也能提前发现低级错误。
 *
 * ⚠️ 它**不能替代** `sh -n` 与真机验证：真正的语法/运行验证仍以
 *    `sh agent/deploy/tests/static-assert.sh` 与 docs/agent-install-script.md §12.2 为准。
 *
 * 用法：
 *   node agent/deploy/tests/shell-lint.js --selftest            # 先证明检查器本身有效
 *   node agent/deploy/tests/shell-lint.js <file.sh> [...]
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 扫描：剔除注释与字符串，输出「可执行代码」文本（供关键字/红线检查用），
//       同时检查引号配平与 heredoc 是否正确闭合。
// ---------------------------------------------------------------------------
function scan(text) {
  const issues = [];
  let i = 0;
  let line = 1;
  let code = '';           // 可执行代码（注释/字符串内容被替换为空格，保留换行）
  let quote = null;        // 跨行引号状态：'\'' 或 '"'
  let quoteLine = 0;
  const heredocs = [];     // 待处理的 heredoc 结束词

  const push = (ch, keep) => { code += keep ? ch : (ch === '\n' ? '\n' : ' '); };
  const advance = (n) => { for (let k = 0; k < n; k++) { if (text[i] === '\n') line++; i++; } };

  while (i < text.length) {
    // heredoc 正文：原样跳过，直到结束词所在行
    if (heredocs.length && (i === 0 || text[i - 1] === '\n')) {
      const end = text.indexOf('\n', i);
      const raw = end === -1 ? text.slice(i) : text.slice(i, end);
      if (raw.trim() === heredocs[heredocs.length - 1]) {
        heredocs.pop();
        code += '\n';
        advance(raw.length + (end === -1 ? 0 : 1));
        continue;
      }
      code += '\n';
      advance(raw.length + (end === -1 ? 0 : 1));
      continue;
    }

    const ch = text[i];

    if (quote) {
      if (ch === '\\' && quote === '"') { push(text[i + 1] || '', false); advance(2); continue; }
      if (ch === quote) { quote = null; }
      push(ch === '\n' ? '\n' : ch, false);
      advance(1);
      continue;
    }

    if (ch === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      advance(stop - i + (end === -1 ? 0 : 1));
      code += '\n';
      continue;
    }

    if (ch === "'" || ch === '"') { quote = ch; quoteLine = line; push(ch, true); advance(1); continue; }
    if (ch === '\\') { push(ch, true); push(text[i + 1] || '', true); advance(2); continue; }

    // heredoc 起始：<<WORD / <<-WORD / <<'WORD'
    if (ch === '<' && text[i + 1] === '<') {
      let j = i + 2;
      if (text[j] === '-') j++;
      let word = '';
      const q = text[j] === "'" || text[j] === '"' ? text[j++] : null;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) word += text[j++];
      if (q) j++;
      if (word) heredocs.push(word);
      while (i < j) { push(text[i], false); advance(1); }
      continue;
    }

    push(ch, true);
    advance(1);
  }

  if (quote) issues.push(`第 ${quoteLine} 行起有未闭合的 ${quote} 引号`);
  if (heredocs.length) issues.push(`有未闭合的 heredoc：${heredocs.join(', ')}`);
  return { code, issues };
}

// ---------------------------------------------------------------------------
// 结构检查：if/fi、case/esac、do/done、函数大括号
// ---------------------------------------------------------------------------
function checkStructure(code) {
  const issues = [];
  const lines = code.split('\n');

  // 按出现顺序对三种块做栈式配对（同一行内的 if…fi 也能正确处理）
  // (?!=) 用来排除 `dd if=…` 这类把 if 当参数名用的假阳性
  const kwRe = /\b(if|fi|case|esac|do|done)\b(?!=)/g;
  const stacks = { if: [], case: [], do: [] };
  const closer = { fi: 'if', esac: 'case', done: 'do' };
  let m;
  while ((m = kwRe.exec(code)) !== null) {
    const kw = m[1];
    const lineNo = code.slice(0, m.index).split('\n').length;
    if (kw === 'if' || kw === 'case' || kw === 'do') stacks[kw].push(lineNo);
    else {
      const open = closer[kw];
      if (stacks[open].length === 0) issues.push(`第 ${lineNo} 行有多余的 ${kw}`);
      else stacks[open].pop();
    }
  }
  for (const key of ['if', 'case', 'do']) {
    const closerName = { if: 'fi', case: 'esac', do: 'done' }[key];
    if (stacks[key].length) {
      issues.push(`第 ${stacks[key].join('、')} 行的 ${key} 没有对应的 ${closerName}`);
    }
  }

  const openers = lines.filter((l) => /^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{/.test(l) && !l.includes('}')).length;
  const closers = lines.filter((l) => /^\}/.test(l)).length;
  if (openers !== closers) issues.push(`函数定义(${openers}) 与行首 }(${closers}) 数量不匹配`);
  return issues;
}

// 与本文件无关的通用红线（供自测复用）
function redlineGeneric(code) {
  const issues = [];
  if (/(^|[^A-Za-z_])eval([^A-Za-z_]|$)/.test(code)) issues.push('出现 eval（红线 #8）');
  if (/\[\[[ \t]/.test(code)) issues.push('出现 [[ ]]（非 POSIX）');
  if (/pipefail/.test(code)) issues.push('出现 pipefail（非 POSIX）');
  if (/^[ \t]*function[ \t]/m.test(code)) issues.push('出现 function 关键字（非 POSIX）');
  if (/^[A-Za-z_][A-Za-z0-9_]*=\(/m.test(code)) issues.push('出现数组赋值（非 POSIX）');
  return issues;
}

// ---------------------------------------------------------------------------
// 红线检查（docs/agent-install-script.md §10）
// ---------------------------------------------------------------------------
function checkRedlines(file, code, fullText, deployDir) {
  const issues = [...redlineGeneric(code)];
  const isAssert = file.endsWith('static-assert.sh');
  if (isAssert) {
    if (!/set -u/.test(code)) issues.push('缺少 set -u');
  } else if (!/set -eu/.test(code)) {
    issues.push('缺少 set -eu');
  }

  if (file.endsWith('vantage.sh')) {
    if (!/--key\|--secret\|--key=\*\|--secret=\*/.test(code)) issues.push('缺少 --key/--secret 显式拒绝分支（红线 #1）');
    if (/^[ \t]*--key\)|^[ \t]*--secret\)/m.test(code)) issues.push('发现接受 --key/--secret 明文的分支（红线 #1 严重违反）');

    const w = fullText.indexOf('write_restricted_file "$KEY_FILE"');
    const u = fullText.indexOf('unset VANTAGE_KEY');
    if (w === -1 || u === -1) issues.push('找不到写凭证或 unset VANTAGE_KEY（红线 #2）');
    else if (!(u > w)) issues.push('unset VANTAGE_KEY 早于凭证落盘（红线 #2）');

    const fnStart = fullText.indexOf('cmd_uninstall() {');
    const fnEnd = fullText.indexOf('\n}', fnStart);
    if (fnStart === -1) issues.push('找不到 cmd_uninstall（红线 #7）');
    else {
      const fn = fullText.slice(fnStart, fnEnd);
      if (/ASSUME_YES/.test(fn)) issues.push('uninstall 分支出现 ASSUME_YES：-y 可能跳过 --purge 确认（红线 #7）');
      if (!/!=[ \t]*'yes'/.test(fn)) issues.push('--purge 缺少 yes 确认（红线 #7）');
    }

    // 可执行代码里不得把网络内容喂给 sh（自我更新，红线 #2）
    const usageStart = code.indexOf('usage() {');
    const usageEnd = code.indexOf('\nUSAGE', usageStart);
    const body = usageStart === -1 ? code : code.slice(0, usageStart) + code.slice(usageEnd === -1 ? code.length : usageEnd);
    if (/curl[^\n]*\|[^\n]*\b(sh|bash)\b/.test(body)) issues.push('可执行代码里出现 curl | sh（红线 #2）');

    if (!/pubkey_configured/.test(code) || !/PLACEHOLDER-PUBKEY/.test(fullText)) issues.push('缺少公钥占位符 fail-closed 检测');
    if (!/require_root/.test(code)) issues.push('缺少 require_root');

    // --help 文案：不得出现形似真实凭证的字符串，且必须写明退出码
    const hs = fullText.indexOf("cat <<'USAGE'");
    const he = fullText.indexOf('\nUSAGE', hs);
    if (hs === -1 || he === -1) issues.push('找不到 usage 的 heredoc');
    else {
      const help = fullText.slice(hs, he);
      if (/v[ks]_[A-Za-z0-9]{4,}/.test(help)) issues.push('--help 文案里出现形似真实凭证的字符串（红线 #3）');
      if (!/退出码/.test(help)) issues.push('--help 未写明退出码');
    }

    // 模板一致性：内嵌块必须与独立模板文件逐字一致
    const extract = (startMark, endMark, varName) => {
      const s = fullText.indexOf(startMark);
      const e = fullText.indexOf(endMark, s);
      if (s === -1 || e === -1) return null;
      let body2 = fullText.slice(s + startMark.length, e);
      body2 = body2.replace(new RegExp('^' + varName + "='"), '');
      body2 = body2.replace(/\n$/, '').replace(/'$/, '');
      return body2;
    };
    const unit = extract('# >>> UNIT_TEMPLATE\n', '# <<< UNIT_TEMPLATE', 'UNIT_TEMPLATE');
    const conf = extract('# >>> CONFIG_TEMPLATE\n', '# <<< CONFIG_TEMPLATE', 'CONFIG_TEMPLATE');
    const readIf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
    const unitFile = readIf(path.join(deployDir, 'vantage-agent.service'));
    const confFile = readIf(path.join(deployDir, 'config.minimal.yaml'));
    if (unit && unitFile && unit.trimEnd() !== unitFile.trimEnd()) issues.push('内嵌 UNIT_TEMPLATE 与 vantage-agent.service 不一致');
    if (conf && confFile && conf.trimEnd() !== confFile.trimEnd()) issues.push('内嵌 CONFIG_TEMPLATE 与 config.minimal.yaml 不一致');
  }
  return issues;
}

function analyze(file, deployDir) {
  const text = fs.readFileSync(file, 'utf8');
  const { code, issues: scanIssues } = scan(text);
  const issues = [...scanIssues, ...checkStructure(code), ...checkRedlines(file, code, text, deployDir)];
  return issues;
}

// ---------------------------------------------------------------------------
// 自测：检查器必须能抓出下面的错误，否则它的"绿"没有意义
// ---------------------------------------------------------------------------
function selftest() {
  const cases = [
    ['未闭合 if', 'if true; then\n  echo x\n'],
    ['未闭合 case', 'case x in\na) echo 1 ;;\n'],
    ['未闭合引号', 'echo "abc\n'],
    ['未闭合 heredoc', 'cat <<EOF\nabc\n'],
    ['bash 数组', 'arr=(a b)\n'],
    ['bash [[ ]]', 'if [[ -f x ]]; then :; fi\n'],
    ['eval', 'eval "$cmd"\n'],
  ];
  let bad = 0;
  for (const [name, sample] of cases) {
    const { code, issues: si } = scan(sample);
    const issues = [...si, ...checkStructure(code), ...redlineGeneric(code)];
    const detected = issues.length > 0;
    console.log(`  ${detected ? 'OK  ' : 'FAIL'} 自测·${name}${detected ? ` → ${issues[0]}` : '（未检出！）'}`);
    if (!detected) bad++;
  }
  // 反例：合法脚本不应误报
  const good = '#!/bin/sh\nset -eu\nf() {\n  if [ -f x ]; then\n    case "$1" in\n      a) : ;;\n    esac\n  fi\n}\n';
  const g = [...scan(good).issues, ...checkStructure(scan(good).code), ...redlineGeneric(scan(good).code)];
  console.log(`  ${g.length === 0 ? 'OK  ' : 'FAIL'} 自测·合法样例不误报${g.length ? ` → ${g.join('; ')}` : ''}`);
  if (g.length) bad++;
  return bad;
}

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const here = __dirname;
const deployDir = path.dirname(here);

if (args[0] === '--selftest') {
  console.log('== shell-lint 自测 ==');
  const bad = selftest();
  console.log(bad === 0 ? '\n✅ 检查器自测通过' : `\n❌ 检查器自测有 ${bad} 项失败`);
  process.exit(bad === 0 ? 0 : 1);
}

const files = args.length ? args : [
  path.join(deployDir, 'vantage.sh'),
  path.join(deployDir, 'build-release.sh'),
  path.join(deployDir, 'publish-release.sh'),
  path.join(deployDir, 'tests', 'static-assert.sh'),
];

let fail = 0;
console.log('== shell-lint（本机结构 + 红线检查）==');
for (const f of files) {
  const issues = analyze(f, deployDir);
  if (issues.length === 0) {
    console.log(`  OK   ${path.relative(deployDir, f)}`);
  } else {
    fail++;
    console.log(`  FAIL ${path.relative(deployDir, f)}`);
    for (const it of issues) console.log(`       - ${it}`);
  }
}
console.log(fail === 0 ? '\n✅ 全部通过（注意：这不能替代 sh -n 与真机验证）' : `\n❌ ${fail} 个文件有问题`);
process.exit(fail === 0 ? 0 : 1);
