#!/bin/sh
# =============================================================================
# agent/deploy/publish-release.sh — 签名 + 三源发布 + 回读自检（维护者工具）
#
# 依据：docs/agent-install-script.md §4.5
#   ⛔ 私钥只从环境变量 VANTAGE_RELEASE_KEY 指向的文件读取，绝不入库/入日志/入命令行。
#
# 用法：
#   VANTAGE_RELEASE_KEY=~/vantage-release.key \
#     sh publish-release.sh --version v0.1.0 --dist dist \
#        [--github] \
#        [--self-hosted-dest user@host:/srv/vantage-dl] [--self-hosted-url https://dl.example.com] \
#        [--mirror-dest   user@host:/srv/vantage-mirror] [--mirror-url   https://mirror.example.com]
#
# 环境变量等价物：VANTAGE_SELF_HOSTED_DEST / VANTAGE_SELF_HOSTED_URL /
#                VANTAGE_MIRROR_DEST / VANTAGE_MIRROR_URL / VANTAGE_GITHUB_REPO
# =============================================================================

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(dirname "$(dirname "$HERE")")

VERSION=''
DIST=''
DO_GITHUB=0
SELF_DEST=${VANTAGE_SELF_HOSTED_DEST:-}
SELF_URL=${VANTAGE_SELF_HOSTED_URL:-}
MIRROR_DEST=${VANTAGE_MIRROR_DEST:-}
MIRROR_URL=${VANTAGE_MIRROR_URL:-}
GH_REPO=${VANTAGE_GITHUB_REPO:-haozi-123-wow/Vantage}

usage() { sed -n '2,20p' "$0" | sed -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:-}; shift 2 ;;
    --version=*) VERSION=${1#*=}; shift ;;
    --dist) DIST=${2:-}; shift 2 ;;
    --dist=*) DIST=${1#*=}; shift ;;
    --github) DO_GITHUB=1; shift ;;
    --self-hosted-dest) SELF_DEST=${2:-}; shift 2 ;;
    --self-hosted-dest=*) SELF_DEST=${1#*=}; shift ;;
    --self-hosted-url) SELF_URL=${2:-}; shift 2 ;;
    --self-hosted-url=*) SELF_URL=${1#*=}; shift ;;
    --mirror-dest) MIRROR_DEST=${2:-}; shift 2 ;;
    --mirror-dest=*) MIRROR_DEST=${1#*=}; shift ;;
    --mirror-url) MIRROR_URL=${2:-}; shift 2 ;;
    --mirror-url=*) MIRROR_URL=${1#*=}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$VERSION" ] || { printf '缺少 --version\n' >&2; exit 2; }
[ -n "$DIST" ] || { printf '缺少 --dist（build-release.sh 的输出目录）\n' >&2; exit 2; }
[ -f "$DIST/SHA256SUMS" ] || { printf '找不到 %s/SHA256SUMS\n' "$DIST" >&2; exit 2; }

KEY=${VANTAGE_RELEASE_KEY:-}
if [ -z "$KEY" ] || [ ! -f "$KEY" ]; then
  printf '⛔ 需要 VANTAGE_RELEASE_KEY=<离线私钥路径>（当前：%s）\n' "${KEY:-未设置}" >&2
  exit 3
fi

# ---------------------------------------------------------------------------
# 1) 一致性预检：脚本里的公钥必须与私钥配对（否则发出去的包没人能验证）
# ---------------------------------------------------------------------------
command -v openssl >/dev/null 2>&1 || { printf '缺少 openssl\n' >&2; exit 3; }

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t vantage-publish)
trap 'rm -rf "$TMP"' EXIT

awk '/^# >>> RELEASE_PUBKEY$/{i=1;next} /^# <<< RELEASE_PUBKEY$/{i=0} i' "$DIST/vantage.sh" \
  | sed -e "1s/^RELEASE_PUBKEY='//" -e "\$s/'\$//" > "$TMP/script.pub"
openssl pkey -in "$KEY" -pubout -out "$TMP/key.pub" 2>/dev/null

if cmp -s "$TMP/script.pub" "$TMP/key.pub"; then
  printf '✅ 脚本内嵌公钥与私钥配对\n'
else
  printf '⛔ 脚本内嵌公钥与本次私钥不配对：发出去的包将没人能验签。\n' >&2
  printf '   请先用 build-release.sh --keygen 生成/回填公钥，再重新打包。\n' >&2
  exit 3
fi

# ---------------------------------------------------------------------------
# 2) 签名
# ---------------------------------------------------------------------------
printf -- '-- 签名 SHA256SUMS …\n'
openssl dgst -sha256 -sign "$KEY" -out "$DIST/SHA256SUMS.sig" "$DIST/SHA256SUMS"
ls -l "$DIST/SHA256SUMS.sig"
if grep -q 'PRIVATE KEY' "$DIST/SHA256SUMS.sig" 2>/dev/null; then
  printf '⛔ 产物里出现了私钥内容，立刻终止\n' >&2
  exit 4
fi

ASSETS="$DIST/vantage-agent_${VERSION}_linux_amd64.tar.gz $DIST/vantage-agent_${VERSION}_linux_arm64.tar.gz $DIST/SHA256SUMS $DIST/SHA256SUMS.sig $DIST/vantage.sh"

# ---------------------------------------------------------------------------
# 3) GitHub Releases
# ---------------------------------------------------------------------------
if [ "$DO_GITHUB" = 1 ]; then
  command -v gh >/dev/null 2>&1 || { printf '⛔ 找不到 gh CLI（安装：https://cli.github.com/）\n' >&2; exit 3; }
  printf -- '-- GitHub Release %s（%s）…\n' "$VERSION" "$GH_REPO"
  # shellcheck disable=SC2086
  gh release create "$VERSION" --repo "$GH_REPO" --title "$VERSION" --notes "Vantage Agent $VERSION" $ASSETS
else
  printf -- '-- 跳过 GitHub（未加 --github）\n'
fi

# ---------------------------------------------------------------------------
# 4) 自建站 / 镜像（先传产物，后写 latest.txt，避免 latest 指向半成品）
# ---------------------------------------------------------------------------
push_to() { # DEST(rsync target dir) LABEL
  dest=$1; label=$2
  [ -n "$dest" ] || { printf -- '-- 跳过 %s（未配置目标）\n' "$label"; return 0; }
  command -v rsync >/dev/null 2>&1 || { printf '⛔ 找不到 rsync\n' >&2; exit 3; }
  printf -- '-- 发布到 %s → %s/%s/\n' "$label" "$dest" "$VERSION"
  rsync -a --mkpath "$DIST/vantage-agent_${VERSION}_linux_amd64.tar.gz" \
        "$DIST/vantage-agent_${VERSION}_linux_arm64.tar.gz" \
        "$DIST/SHA256SUMS" "$DIST/SHA256SUMS.sig" \
        "$DIST/vantage.sh" "$DIST/vantage-agent.service" "$DIST/config.minimal.yaml" \
        "$dest/$VERSION/"
  printf '%s\n' "$VERSION" > "$TMP/latest.txt"
  rsync -a "$TMP/latest.txt" "$dest/latest.txt"
}

push_to "$SELF_DEST" '自建站'
push_to "$MIRROR_DEST" '国内镜像'

# ---------------------------------------------------------------------------
# 5) 回读自检（⛔ 不可省）：对每个已配置的源下载→验签→比对 sha256→核对 latest
# ---------------------------------------------------------------------------
check_source() { # URL LABEL
  url=${1%/}; label=$2
  [ -n "$url" ] || { printf -- '-- 跳过回读 %s（未配置 URL）\n' "$label"; return 0; }
  d="$TMP/check_$label"
  rm -rf "$d"; mkdir -p "$d"
  printf -- '-- 回读自检 %s（%s）…\n' "$label" "$url"
  case "$url" in
    *github.com*) base="$url/releases/download/$VERSION" ;;
    *) base="$url/$VERSION" ;;
  esac
  curl -fsSL "$base/SHA256SUMS" -o "$d/SHA256SUMS" || { printf '   ⛔ 取不到 SHA256SUMS\n' >&2; return 1; }
  curl -fsSL "$base/SHA256SUMS.sig" -o "$d/SHA256SUMS.sig" || { printf '   ⛔ 取不到 SHA256SUMS.sig\n' >&2; return 1; }
  if ! openssl dgst -sha256 -verify "$TMP/script.pub" -signature "$d/SHA256SUMS.sig" "$d/SHA256SUMS" >/dev/null 2>&1; then
    printf '   ⛔ 验签失败（该源内容与脚本内嵌公钥不匹配）\n' >&2
    return 1
  fi
  printf '   签名 OK\n'
  for arch in amd64 arm64; do
    name="vantage-agent_${VERSION}_linux_${arch}.tar.gz"
    curl -fsSL "$base/$name" -o "$d/$name" || { printf '   ⛔ 取不到 %s\n' "$name" >&2; return 1; }
    want=$(awk -v n="$name" '$2 == n { print $1; exit }' "$d/SHA256SUMS")
    got=$(sha256sum "$d/$name" | awk '{print $1}')
    [ "$want" = "$got" ] || { printf '   ⛔ %s sha256 不匹配\n' "$name" >&2; return 1; }
    printf '   %s sha256 OK\n' "$name"
  done
  if [ -n "$SELF_URL" ] && [ "${url%/}" = "${SELF_URL%/}" ]; then
    lt=$(curl -fsSL "$url/latest.txt" 2>/dev/null | tr -d ' \r\n' || true)
    [ "$lt" = "$VERSION" ] || { printf '   ⛔ latest.txt 是 %s，应为 %s\n' "${lt:-空}" "$VERSION" >&2; return 1; }
    printf '   latest.txt OK\n'
  fi
  return 0
}

rc=0
check_source "$SELF_URL" self || rc=1
check_source "$MIRROR_URL" mirror || rc=1
if [ "$DO_GITHUB" = 1 ]; then
  check_source "https://github.com/$GH_REPO" github || rc=1
fi

if [ "$rc" = 0 ]; then
  printf '\n✅ 发布完成并通过回读自检：%s\n' "$VERSION"
  printf '   别忘了把公钥指纹同步到官网 / DNS TXT（人工核对通道）。\n'
else
  printf '\n⛔ 有源未通过回读自检（见上）——"发布了一半"比没发更危险，请立即排查。\n' >&2
  exit 5
fi
