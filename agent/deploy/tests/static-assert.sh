#!/bin/sh
# =============================================================================
# agent/deploy/tests/static-assert.sh — vantage.sh 红线静态断言
#
# 依据：docs/agent-install-script.md §10（安全红线）、§12.1（本机可做的验证）
# 用法：sh agent/deploy/tests/static-assert.sh [vantage.sh 路径]
# 退出码：0 = 全部通过；1 = 有失败项
# =============================================================================

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
DEPLOY=$(dirname "$HERE")
S=${1:-"$DEPLOY/vantage.sh"}

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  OK   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

[ -f "$S" ] || { printf '找不到脚本：%s\n' "$S" >&2; exit 1; }

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t vantage-assert)
trap 'rm -rf "$TMP"' EXIT

printf '== 静态断言：%s ==\n' "$S"

# --- 1. 语法 ---------------------------------------------------------------
if sh -n "$S" 2>"$TMP/syn.err"; then
  ok 'sh -n 语法检查通过'
else
  bad "sh -n 语法检查失败：$(cat "$TMP/syn.err" 2>/dev/null)"
fi

# --- 2. ⛔ 不存在接受 --key/--secret 明文的分支 ------------------------------
if grep -q -- '--key|--secret|--key=\*|--secret=\*' "$S"; then
  ok '存在 --key/--secret 的显式拒绝分支（红线 #1）'
else
  bad '找不到 --key/--secret 的显式拒绝分支（红线 #1）'
fi
if grep -Eq '^[[:space:]]*--key\)|^[[:space:]]*--secret\)|^[[:space:]]*--key=\*\)|^[[:space:]]*--secret=\*\)' "$S"; then
  bad '发现接受 --key/--secret 明文的解析分支（红线 #1 严重违反）'
else
  ok '没有任何接受 --key/--secret 明文的解析分支'
fi

# --- 3. ⛔ 无 eval ----------------------------------------------------------
if grep -Eq '(^|[^A-Za-z_])eval([^A-Za-z_]|$)' "$S"; then
  bad '脚本里出现 eval（红线 #8：命令注入面）'
else
  ok '无 eval（红线 #8）'
fi

# --- 4. env 形式落地后立即 unset（红线 #2） --------------------------------
w=$(grep -n 'write_restricted_file "\$KEY_FILE"' "$S" | head -n 1 | cut -d: -f1)
u=$(grep -n 'unset VANTAGE_KEY' "$S" | head -n 1 | cut -d: -f1)
if [ -n "$w" ] && [ -n "$u" ] && [ "$u" -gt "$w" ]; then
  ok "unset VANTAGE_KEY 出现在凭证落盘之后（写盘 L$w → unset L$u）"
else
  bad "unset VANTAGE_KEY 缺失或早于写盘（写盘 '${w:-无}' / unset '${u:-无}'）"
fi

# --- 5. ⛔ --purge 的确认不能被 -y 跳过（红线 #7） ---------------------------
awk '/^cmd_uninstall\(\) \{/,/^\}/' "$S" > "$TMP/uninstall.txt"
if [ -s "$TMP/uninstall.txt" ]; then
  if grep -q 'ASSUME_YES' "$TMP/uninstall.txt"; then
    bad 'uninstall 分支里出现 ASSUME_YES：-y 可能跳过 --purge 的确认（红线 #7）'
  else
    ok 'uninstall 分支不含 ASSUME_YES：-y 无法跳过 --purge 确认（红线 #7）'
  fi
  if grep -q "!= 'yes'" "$TMP/uninstall.txt"; then
    ok '--purge 需要输入 yes 才继续'
  else
    bad '--purge 缺少 yes 确认'
  fi
else
  bad '无法提取 cmd_uninstall 函数体'
fi

# --- 6. --help / version 无凭证样例、且无需 root -----------------------------
if sh "$S" help > "$TMP/help.txt" 2>&1; then
  ok 'help 子命令可直接运行（无需 root）'
  if grep -Eq 'v[ks]_[A-Za-z0-9]{4,}' "$TMP/help.txt"; then
    bad '--help 输出里出现形似真实凭证的字符串（红线 #3）'
  else
    ok '--help 输出不含凭证样例（红线 #3）'
  fi
  if grep -q '退出码' "$TMP/help.txt"; then
    ok '--help 里写明退出码'
  else
    bad '--help 未写明退出码'
  fi
else
  bad "help 子命令运行失败：$(cat "$TMP/help.txt" 2>/dev/null)"
fi
if sh "$S" version > "$TMP/ver.txt" 2>&1; then
  ok "version 子命令可用：$(cat "$TMP/ver.txt")"
else
  bad 'version 子命令运行失败'
fi

# --- 7. 内嵌模板与独立模板文件逐字一致 --------------------------------------
extract_unit() {
  awk '/^# >>> UNIT_TEMPLATE$/{i=1;next} /^# <<< UNIT_TEMPLATE$/{i=0} i' "$1" \
    | sed -e "1s/^UNIT_TEMPLATE='//" -e "\$s/'\$//"
}
extract_conf() {
  awk '/^# >>> CONFIG_TEMPLATE$/{i=1;next} /^# <<< CONFIG_TEMPLATE$/{i=0} i' "$1" \
    | sed -e "1s/^CONFIG_TEMPLATE='//" -e "\$s/'\$//"
}
extract_unit "$S" > "$TMP/unit.exp"
extract_conf "$S" > "$TMP/conf.exp"
if diff -u "$TMP/unit.exp" "$DEPLOY/vantage-agent.service" > "$TMP/unit.diff" 2>&1; then
  ok '内嵌 UNIT_TEMPLATE 与 vantage-agent.service 逐字一致'
else
  bad '内嵌 UNIT_TEMPLATE 与 vantage-agent.service 不一致：'
  sed -n '1,20p' "$TMP/unit.diff"
fi
if diff -u "$TMP/conf.exp" "$DEPLOY/config.minimal.yaml" > "$TMP/conf.diff" 2>&1; then
  ok '内嵌 CONFIG_TEMPLATE 与 config.minimal.yaml 逐字一致'
else
  bad '内嵌 CONFIG_TEMPLATE 与 config.minimal.yaml 不一致：'
  sed -n '1,20p' "$TMP/conf.diff"
fi

# --- 8. POSIX 兼容（⛔ bashism） --------------------------------------------
if grep -Eq '\[\[[[:space:]]' "$S"; then bad '出现 [[ ]]（非 POSIX）'; else ok '无 [[ ]]'; fi
if grep -q 'pipefail' "$S"; then bad '出现 pipefail（非 POSIX）'; else ok '无 pipefail'; fi
if grep -Eq '^[[:space:]]*function[[:space:]]' "$S"; then bad '出现 function 关键字（非 POSIX）'; else ok '无 function 关键字'; fi
if grep -Eq '^[A-Za-z_][A-Za-z0-9_]*=\(' "$S"; then bad '出现数组赋值（非 POSIX）'; else ok '无数组'; fi
if grep -q 'set -eu' "$S"; then ok 'set -eu 存在'; else bad '缺少 set -eu'; fi

# --- 9. ⛔ 运行期不自我更新（不把网络内容喂给 sh） ---------------------------
awk '/^usage\(\) \{/{u=1} u==0{print} /^USAGE$/{u=0}' "$S" | grep -v '^[[:space:]]*#' > "$TMP/body.txt"
if grep -Eq 'curl.*\|.*(sh|bash)' "$TMP/body.txt"; then
  bad '可执行代码里出现 curl | sh（红线 #2：自我更新/二次下载执行）'
else
  ok '可执行代码里没有 curl | sh（红线 #2）'
fi

# --- 10. 步 0 的 fail-closed 机制存在 --------------------------------------
if grep -q 'pubkey_configured' "$S" && grep -q 'PLACEHOLDER-PUBKEY' "$S"; then
  ok '公钥占位符检测存在（步 0 未完成时 fail closed）'
  if grep -q '未嵌入发布公钥' "$S"; then
    ok '未回填公钥时有明确报错信息'
  else
    bad '未回填公钥时缺少明确报错信息'
  fi
else
  bad '缺少公钥占位符检测（fail closed）'
fi

# --- 11. install 必须要求 root ---------------------------------------------
if grep -q 'require_root' "$S"; then ok 'require_root 存在'; else bad '缺少 require_root'; fi

printf '\n== 结果：%d 通过，%d 失败 ==\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
