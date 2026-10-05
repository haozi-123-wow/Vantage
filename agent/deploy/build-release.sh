#!/bin/sh
# =============================================================================
# agent/deploy/build-release.sh — 打包发布产物（开发者/维护者工具，⛔ 不进被监控机路径）
#
# 产物（与 docs/agent-install-script.md §4.1 的清单一致）：
#   vantage-agent_<TAG>_linux_amd64.tar.gz
#   vantage-agent_<TAG>_linux_arm64.tar.gz
#   SHA256SUMS          （签名由 publish-release.sh 完成）
#   vantage.sh          （脚本自身的同版本拷贝）
#
# 用法：
#   sh build-release.sh --version v0.1.0 [--out dist]
#   sh build-release.sh --keygen [--out dist]      # 步 0：生成发布密钥对（ECDSA P-256）
# =============================================================================

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
AGENT_DIR=$(dirname "$HERE")
REPO_DIR=$(dirname "$AGENT_DIR")

VERSION=''
OUT="$REPO_DIR/dist"
KEYGEN=0

usage() {
  sed -n '2,20p' "$0" | sed -e 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:-}; shift 2 ;;
    --version=*) VERSION=${1#*=}; shift ;;
    --out) OUT=${2:-}; shift 2 ;;
    --out=*) OUT=${1#*=}; shift ;;
    --keygen) KEYGEN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else printf '缺少 sha256 工具\n' >&2; exit 3
  fi
}

# ---------------------------------------------------------------------------
# --keygen：生成发布密钥对（✅ Q2：ECDSA P-256）
#   ⚠️ release.key 是**私钥**：离线保管、⛔ 不进仓库、⛔ 不进任何自动化；
#      verify.pem 需要回填到 vantage.sh 的 RELEASE_PUBKEY 块。
# ---------------------------------------------------------------------------
if [ "$KEYGEN" = 1 ]; then
  command -v openssl >/dev/null 2>&1 || { printf '缺少 openssl\n' >&2; exit 3; }
  KEY="$OUT/release.key"
  PUB="$OUT/verify.pem"
  if [ -e "$KEY" ]; then
    printf '⛔ %s 已存在，拒绝覆盖（如需轮换请先手工备份并移走旧私钥）\n' "$KEY" >&2
    exit 3
  fi
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$KEY"
  chmod 600 "$KEY"
  openssl pkey -in "$KEY" -pubout -out "$PUB"
  FP=$(openssl pkey -pubin -in "$PUB" -outform DER | sha256sum | cut -c1-16)
  printf '\n✅ 发布密钥对已生成：\n'
  printf '   私钥（⛔ 离线保管，绝不入库/入日志）：%s\n' "$KEY"
  printf '   公钥（需要回填进脚本）：%s\n' "$PUB"
  printf '   公钥指纹（前 16 位，建议公布到官网/DNS TXT 供人工核对）：%s\n\n' "$FP"
  printf '下一步：\n'
  printf '  1) 把 %s 的内容整段替换 vantage.sh 里 RELEASE_PUBKEY=… 之间的内容\n' "$PUB"
  printf '  2) 跑一遍：sh agent/deploy/tests/static-assert.sh\n'
  printf '  3) 用 sh publish-release.sh --version <tag> 对 SHA256SUMS 签名并发布\n'
  exit 0
fi

[ -n "$VERSION" ] || { printf '缺少 --version（如 v0.1.0）\n' >&2; usage >&2; exit 2; }
case "$VERSION" in
  v[0-9]*) : ;;
  *) printf '⛔ 版本号必须以 v 开头（如 v0.1.0），当前：%s\n' "$VERSION" >&2; exit 2 ;;
esac

command -v go >/dev/null 2>&1 || { printf '缺少 go 工具链\n' >&2; exit 3; }
command -v tar >/dev/null 2>&1 || { printf '缺少 tar\n' >&2; exit 3; }

if grep -q '<PLACEHOLDER-PUBKEY>' "$HERE/vantage.sh"; then
  printf '⚠️  警告：vantage.sh 里仍是公钥占位符 —— 本次产物无法通过验签，只能用于 --no-verify 的联调。\n'
  printf '    发布正式版本前请先跑：sh build-release.sh --keygen 并回填公钥。\n\n'
fi

printf '== 打包 %s → %s ==\n' "$VERSION" "$OUT"

for arch in amd64 arm64; do
  stage="$OUT/.stage_${VERSION}_linux_${arch}"
  rm -rf "$stage"
  mkdir -p "$stage"
  printf -- '-- 编译 linux/%s …\n' "$arch"
  (
    cd "$AGENT_DIR"
    CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath \
      -ldflags "-s -w -X vantage-agent/internal/version.Version=$VERSION" \
      -o "$stage/vantage-agent" ./cmd/agent
  )
  [ -x "$stage/vantage-agent" ] || { printf '⛔ 编译产物缺失\n' >&2; exit 4; }
  if [ -f "$REPO_DIR/LICENSE" ]; then cp "$REPO_DIR/LICENSE" "$stage/LICENSE"; fi
  tarball="$OUT/vantage-agent_${VERSION}_linux_${arch}.tar.gz"
  rm -f "$tarball"
  tar -czf "$tarball" -C "$stage" .
  rm -rf "$stage"
  printf '   %s\n' "$(basename "$tarball")"
done

printf -- '-- 生成 SHA256SUMS …\n'
: > "$OUT/SHA256SUMS"
for f in "$OUT"/vantage-agent_"${VERSION}"_linux_*.tar.gz; do
  printf '%s  %s\n' "$(sha256_of "$f")" "$(basename "$f")" >> "$OUT/SHA256SUMS"
done
cat "$OUT/SHA256SUMS"

printf -- '-- 拷贝脚本与模板（发布时一并上传）…\n'
cp "$HERE/vantage.sh" "$OUT/vantage.sh"
cp "$HERE/vantage-agent.service" "$OUT/vantage-agent.service"
cp "$HERE/config.minimal.yaml" "$OUT/config.minimal.yaml"

printf '\n✅ 打包完成：%s\n' "$OUT"
printf '下一步：\n'
printf '  VANTAGE_RELEASE_KEY=<离线私钥路径> sh publish-release.sh --version %s --dist %s\n' "$VERSION" "$OUT"
printf '  ⛔ 私钥绝不要复制进仓库或上传到任何服务器。\n'
