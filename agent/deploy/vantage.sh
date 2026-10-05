#!/bin/sh
# =============================================================================
# vantage.sh — Vantage Agent 安装 / 升级 / 卸载 / 运维脚本
#
# 依据：docs/agent-install-script.md（设计定稿 2026-10-05，A-T10/A-T11/A-T12/A-T13）
#       docs/agent.md §6/§9/§12、docs/api.md §4.4、Vantage-DESIGN §12.2/§12.4
#
# ⛔ 三条不可违背的红线（违反任何一条都算重大缺陷）：
#   1. 不存在 --key <明文> / --secret <明文>：凭证只经「受限文件 / 环境变量 / /dev/tty」传递，
#      落地成 0600 文件后立即 unset；脚本⛔ 不把凭证写进日志、stdout、--help。
#   2. 信任根 = 脚本内嵌的发布公钥（openssl 验签 SHA256SUMS.sig）。⛔ 不自我更新、⛔ 不二次 curl|sh、
#      ⛔ 不存在「运行期从网络换公钥」的路径。
#   3. 单向：脚本只做「下载产物 + 一次真实上报（冒烟）」；⛔ 不读中心任何指令、不接收任何下发配置。
#
# 运行环境：POSIX sh（dash / busybox ash 兼容；⛔ 不用 pipefail、[[ ]]、数组）。
# =============================================================================

set -eu

SCRIPT_VERSION='2026.10.05'

# ---------------------------------------------------------------------------
# 源链（✅ Q1：自建站 → 国内镜像 → GitHub）
# ⚠️ 步 0：把下面两个占位串替换成真实地址；含 < > 的占位符会被自动跳过并打 WARN。
# ---------------------------------------------------------------------------
SELF_HOSTED_SOURCE='https://<自建站>'
MIRROR_SOURCE='https://<镜像>'
GITHUB_SOURCE='https://github.com/haozi-123-wow/Vantage'

# ---------------------------------------------------------------------------
# 信任根：发布公钥（ECDSA P-256，PEM）。
# ⚠️ 步 0：用 build-release.sh 生成的 verify.pem 替换 <PLACEHOLDER-PUBKEY>。
#    占位状态下一律拒绝安装（fail closed）；测试可用 --no-verify（会留痕 verified=false）。
# >>> RELEASE_PUBKEY
RELEASE_PUBKEY='<PLACEHOLDER-PUBKEY>'
# <<< RELEASE_PUBKEY

# ---------------------------------------------------------------------------
# 路径常量
# ---------------------------------------------------------------------------
AGENT_BIN='/usr/local/bin/vantage-agent'
AGENT_BIN_NEW="${AGENT_BIN}.new"
AGENT_BIN_PREV="${AGENT_BIN}.prev"
CONF_DIR='/etc/vantage'
CONF_FILE="${CONF_DIR}/config.yaml"
STATE_FILE="${CONF_DIR}/install-state"
UNIT_FILE='/etc/systemd/system/vantage-agent.service'
UNIT_NAME='vantage-agent'
SELF_BIN='/usr/local/bin/vantage.sh'
DEFAULT_RUN_USER='vantage'
DEFAULT_DATA_DIR='/var/lib/vantage'
DEFAULT_KEY_FILE="${CONF_DIR}/agent.key"
DEFAULT_SECRET_FILE="${CONF_DIR}/agent.secret"

# ---------------------------------------------------------------------------
# 模板（与 agent/deploy/vantage-agent.service、config.minimal.yaml 逐字一致；
# tests/static-assert.sh 会做 diff 校验，⛔ 不要只改一处）
# ---------------------------------------------------------------------------
# >>> UNIT_TEMPLATE
UNIT_TEMPLATE='[Unit]
Description=Vantage Agent - 主机指标采集与上报
Documentation=https://github.com/haozi-123-wow/Vantage
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=@AGENT_USER@
Group=@AGENT_USER@
ExecStart=@AGENT_BIN@ --config @CONF_FILE@
ReloadSignal=SIGHUP
Restart=always
RestartSec=5s
TimeoutStopSec=10s

# —— 加固（docs/agent.md §9）——
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
# ⛔ 不放宽任何 capability（ICMP 权限属 Agent 运行侧，见 A-T13；脚本不提供开关）
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=@DATA_DIR@

# —— 资源 ——
TasksMax=64
# MemoryHigh / MemoryMax：⏭ 移交 A-T11（Q3）——等真机内存曲线后再定
# OOMPolicy=continue

[Install]
WantedBy=multi-user.target'
# <<< UNIT_TEMPLATE

# >>> CONFIG_TEMPLATE
CONFIG_TEMPLATE='# 由 vantage.sh install 生成；字段全表见 docs/agent.md §8。
# ⚠️ Agent 对未知字段一律拒绝：加字段前先查文档，别凭记忆写。
center:
  url: "@CENTER_URL@"
  timeout: 10s
agent:
  id: "@AGENT_ID@"
  key_file: "@KEY_FILE@"
  secret_file: "@SECRET_FILE@"
host:
  alias: "@HOST_ALIAS@"
# —— 以下均为缺省值，按需打开（reload 后热加载）——
# log:
#   level: info                           # debug/info/warn/error；format: text|json
#   # file 留空 = 走 stdout（systemd 收进 journald）；日志去处见 A-T11（Q5）
# collect:
#   disk:    { enabled: true, interval: 60s }
#   process: { enabled: true, interval: 60s, top_n: 10 }
# probes:
#   - { name: "site-health", type: http, url: "https://example.com/healthz", expect_status: [200], interval: 30s }
# filters:
#   disk: { exclude_fs: ["tmpfs","devtmpfs","overlay"] }
# resource:
#   gomemlimit_mb: 48'
# <<< CONFIG_TEMPLATE

# ---------------------------------------------------------------------------
# 参数默认值
# ---------------------------------------------------------------------------
CMD=''
CENTER=''
AGENT_ID=''
KEY_FILE="$DEFAULT_KEY_FILE"
SECRET_FILE="$DEFAULT_SECRET_FILE"
TAG=''
SOURCE=''
RUN_USER="$DEFAULT_RUN_USER"
DATA_DIR="$DEFAULT_DATA_DIR"
HOST_ALIAS=''
DRY_RUN=0
FORCE=0
ASSUME_YES=0
QUIET=0
VERBOSE=0
JSON_OUT=0
INSECURE_HTTP=0
VERIFY=1
SMOKE_TEST=1
NO_START=0
PURGE=0
REMOVE_USER=0

TMP_V=''
TTY_ECHO_OFF=0

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
cleanup() {
  if [ "$TTY_ECHO_OFF" = 1 ]; then
    if [ -w /dev/tty ]; then stty echo < /dev/tty 2>/dev/null || true; fi
    TTY_ECHO_OFF=0
  fi
  if [ -n "$TMP_V" ] && [ -d "$TMP_V" ]; then rm -rf "$TMP_V" 2>/dev/null || true; fi
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

info()  { if [ "$QUIET" = 0 ]; then printf '%s\n' "$*" >&2; fi; }
warn()  { printf '警告：%s\n' "$*" >&2; }
debug() { if [ "$VERBOSE" = 1 ]; then printf '[debug] %s\n' "$*" >&2; fi; }
die()   { code=$1; shift; printf '错误：%s\n' "$*" >&2; exit "$code"; }

# do_or_print CMD... ：dry-run 时只打印，不执行
do_or_print() {
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] $*"; return 0; fi
  "$@"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

require_root() {
  if [ "$(id -u)" != '0' ]; then
    die 3 "需要 root 权限：请用 sudo 执行（例如：curl -fsSL <script_url> | sudo sh -s -- $CMD ...）"
  fi
}

# write_file PATH <<'EOF' ... ：原子写文件（同目录 tmp + mv）；dry-run 打印内容
write_file() {
  path=$1
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] 将写入 $path（内容如下）"
    cat >&2
    return 0
  fi
  dir=$(dirname "$path")
  tmp="$path.tmp.$$"
  cat > "$tmp"
  chmod 0644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$path"
}

# 单引号转义整条命令（su -c 回退路径用；⛔ 不用 eval）
quote_cmd() {
  out=''
  for a in "$@"; do
    esc=$(printf '%s' "$a" | sed "s/'/'\\\\''/g")
    out="$out '$esc'"
  done
  printf '%s' "$out"
}

run_as_user() {
  u=$1; shift
  if need_cmd runuser; then
    runuser -u "$u" -- "$@"
  else
    su -s /bin/sh -c "$(quote_cmd "$@")" "$u"
  fi
}

run_with_timeout() {
  t=$1; shift
  if need_cmd timeout; then timeout "$t" "$@"; else "$@"; fi
}

sha256_of() {
  if need_cmd sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif need_cmd shasum; then shasum -a 256 "$1" | awk '{print $1}'
  elif need_cmd busybox; then busybox sha256sum "$1" | awk '{print $1}'
  else return 1
  fi
}

# yaml_get FILE SECTION KEY
yaml_get() {
  awk -v sec="$2" -v key="$3" '
    /^[^ \t#]/ { s=$0; sub(/:.*/, "", s); cur=s }
    cur==sec {
      line=$0; sub(/^[ \t]+/, "", line)
      if (index(line, key ":") == 1) {
        sub("^" key ":[ \t]*", "", line)
        gsub(/^["\047]|["\047]$/, "", line)
        print line; exit
      }
    }' "$1" 2>/dev/null || true
}

sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

duration_seconds() {
  case "${1:-}" in
    '') echo 0 ;;
    *ms) echo 1 ;;
    *s) printf '%s' "${1%s}" | grep -Eq '^[0-9]+$' && printf '%s' "${1%s}" || echo 0 ;;
    *m) printf '%s' "${1%m}" | grep -Eq '^[0-9]+$' && echo $(( ${1%m} * 60 )) || echo 0 ;;
    *) echo 0 ;;
  esac
}

source_chain() {
  if [ -n "$SOURCE" ]; then
    printf '%s\n' "${SOURCE%/}"
    return 0
  fi
  for s in "$SELF_HOSTED_SOURCE" "$MIRROR_SOURCE" "$GITHUB_SOURCE"; do
    [ -n "$s" ] || continue
    case "$s" in
      *'<'*|*'>'*) warn "跳过未配置的源（占位符）：$s" >&2; continue ;;
    esac
    printf '%s\n' "${s%/}"
  done
}

asset_url() { # SRC TAG NAME
  case "$1" in
    *github.com*) printf '%s/releases/download/%s/%s' "$1" "$2" "$3" ;;
    *) printf '%s/%s/%s' "$1" "$2" "$3" ;;
  esac
}

fetch() { # URL OUTFILE
  ua="vantage-install/$SCRIPT_VERSION"
  if [ "$INSECURE_HTTP" = 1 ]; then
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 300 -A "$ua" -o "$2" "$1"
  else
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 \
      --connect-timeout 10 --max-time 300 -A "$ua" -o "$2" "$1"
  fi
}

fetch_latest_tag() { # SRC
  case "$1" in
    *github.com*)
      eff=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$1/releases/latest" 2>/dev/null) || return 1
      printf '%s' "${eff##*/}"
      ;;
    *)
      fetch "$1/latest.txt" "$TMP_V/latest.txt" >/dev/null 2>&1 || return 1
      tr -d ' \r\n' < "$TMP_V/latest.txt"
      ;;
  esac
}

pubkey_configured() {
  case "$RELEASE_PUBKEY" in
    *'<PLACEHOLDER-PUBKEY>'*) return 1 ;;
    '') return 1 ;;
    *) return 0 ;;
  esac
}

verify_signature() { # SUMS SIG PUBKEY
  openssl dgst -sha256 -verify "$3" -signature "$2" "$1" >/dev/null 2>&1
}

verify_sha256() { # SUMS ASSET_NAME ASSET_FILE
  want=$(awk -v n="$2" '$2 == n { print $1; exit }' "$1")
  [ -n "$want" ] || return 1
  got=$(sha256_of "$3") || return 1
  [ "$want" = "$got" ]
}

extract_agent() { # TARBALL DESTDIR  → 成功时 $DESTDIR/vantage-agent 就绪
  dest=$2
  mkdir -p "$dest"
  if ! tar --no-same-owner -xzf "$1" -C "$dest" 2>/dev/null; then
    tar -xzf "$1" -C "$dest" 2>/dev/null || return 1
  fi
  # ⛔ 防路径穿越与符号链接：产物里不允许出现任何链接
  if [ -n "$(find "$dest" -type l 2>/dev/null)" ]; then
    warn "产物里含符号链接，拒绝安装"
    return 1
  fi
  found=$(find "$dest" -maxdepth 3 -type f -name 'vantage-agent' 2>/dev/null | head -n 1)
  [ -n "$found" ] || { warn "产物里找不到 vantage-agent"; return 1; }
  if need_cmd od; then
    magic=$(dd if="$found" bs=1 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')
    if [ -n "$magic" ] && [ "$magic" != '7f454c46' ]; then
      warn "vantage-agent 不是 ELF 可执行文件（magic=$magic）"
      return 1
    fi
  fi
  if [ "$found" != "$dest/vantage-agent" ]; then
    cp -p "$found" "$dest/vantage-agent" || return 1
  fi
  chmod 0755 "$dest/vantage-agent"
  return 0
}

# ---------------------------------------------------------------------------
# 用法
# ---------------------------------------------------------------------------
usage() {
  cat <<'USAGE'
vantage.sh — Vantage Agent 安装 / 升级 / 卸载 / 运维脚本（POSIX sh）

用法：
  curl -fsSL <script_url> | sudo sh -s -- install --center <url> --agent-id <uuid>
  sudo vantage.sh {start|stop|restart|reload|status|upgrade|uninstall} [...]

子命令：
  install      安装（已装且配置一致 → 自动走 upgrade 分支）
  upgrade      换二进制，配置与凭证原样保留（替换前先做 --check 与真实上报预演）
  uninstall    停服务并删除 unit 与二进制；默认保留配置/凭证/日志，--purge 才彻底清理
  start|stop|restart|reload   透传 systemctl（reload = SIGHUP 热重载）
  status       服务状态、版本、最后上报时间、最近失败、生效配置摘要、凭证权限体检
  version      打印脚本版本
  help         本帮助

install 参数：
  --center <url>          必填，中心地址（默认强制 https；测试环境可加 --insecure-http）
  --agent-id <uuid>       必填，中心创建 Agent 时生成的 UUID
  --key-file <path>       凭证落点，默认 /etc/vantage/agent.key
  --secret-file <path>    凭证落点，默认 /etc/vantage/agent.secret
  --version <tag>         目标版本（如 v0.1.0）；默认取源链上的 latest
  --source <url>          只使用指定源（不回退）；默认按内置源链依次尝试
  --user <name>           运行用户，默认 vantage
  --data-dir <path>       预留写入目录，默认 /var/lib/vantage
  --host-alias <name>     写入 config.yaml 的 host.alias，默认本机 hostname
  --smoke-test            安装中执行一次真实上报（默认开）
  --no-smoke-test         关闭真实上报（中心暂不可达时用；装完需自行确认上报）
  --no-start              装完不启动（此时默认跳过冒烟上报）
  --force                 允许覆盖已有 config.yaml（原文件先备份为 config.yaml.bak.<时间戳>）
  --dry-run               只打印将执行的动作与将写入的文件内容，不写盘、不发上报

通用开关：
  -y, --yes               跳过交互确认（⛔ 不能跳过 uninstall --purge 的确认）
  -q, --quiet             安静模式
  -v, --verbose           详细日志
  --json                  仅 status：输出 JSON
  --insecure-http         允许 http 源/中心（⛔ 仅测试环境，会打 WARN）
  --no-verify             跳过发布签名校验（⛔ 唯一逃生门；会留痕 verified=false）

凭证的三种形式（与面板给出的三段命令一一对应）：
  ① 环境变量：VANTAGE_KEY=… VANTAGE_SECRET=… sh -c 'curl … | sudo -E sh -s -- install …'
     ⚠️ 会进 shell history，且安装期间 root 可读 /proc/<pid>/environ；建议执行 history -d。
  ② 交互式：不加任何凭证参数，脚本从 /dev/tty 提示输入（最安全，不进 history）。
  ③ 文件：  先把明文写入两个 0600 文件（如 /etc/vantage/agent.key），再传 --key-file/--secret-file；
     脚本只读取内容并校正属主权限，⛔ 不覆盖内容。

⛔ 本脚本不存在 --key/--secret 明文参数（ps 与 /proc/<pid>/cmdline 对同机用户可见）。
⛔ 脚本不会自我更新，也不会读取中心下发的任何内容。

安装会把脚本自身放到 /usr/local/bin/vantage.sh，便于日常 sudo vantage.sh status/reload；
若本次是通过管道执行的（$0 是 sh），脚本会打印一条另存命令供你复制。

退出码：0 成功 | 2 用法错误 | 3 前置检查/配置冲突 | 4 凭证问题 | 5 下载失败 |
        6 校验失败 | 7 服务操作失败 | 8 安装或升级验证失败
USAGE
}

# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
take_value() { # OPTNAME VALUE?
  if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
    die 2 "$1 缺少参数值（--help 查看用法）"
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      # ⛔ 红线：明文档拒绝明文凭证参数（即使有人绕过文档照抄网上写法）
      --key|--secret|--key=*|--secret=*|--password|--password=*)
        die 2 "本脚本不接受 --key/--secret/--password 明文参数：凭证请用环境变量、/dev/tty 或 --key-file（见 --help）" ;;
      --center) take_value "$1" "${2-}"; CENTER=$2; shift 2 ;;
      --center=*) CENTER=${1#*=}; shift ;;
      --agent-id) take_value "$1" "${2-}"; AGENT_ID=$2; shift 2 ;;
      --agent-id=*) AGENT_ID=${1#*=}; shift ;;
      --key-file) take_value "$1" "${2-}"; KEY_FILE=$2; shift 2 ;;
      --key-file=*) KEY_FILE=${1#*=}; shift ;;
      --secret-file) take_value "$1" "${2-}"; SECRET_FILE=$2; shift 2 ;;
      --secret-file=*) SECRET_FILE=${1#*=}; shift ;;
      --version) take_value "$1" "${2-}"; TAG=$2; shift 2 ;;
      --version=*) TAG=${1#*=}; shift ;;
      --source) take_value "$1" "${2-}"; SOURCE=$2; shift 2 ;;
      --source=*) SOURCE=${1#*=}; shift ;;
      --user) take_value "$1" "${2-}"; RUN_USER=$2; shift 2 ;;
      --user=*) RUN_USER=${1#*=}; shift ;;
      --data-dir) take_value "$1" "${2-}"; DATA_DIR=$2; shift 2 ;;
      --data-dir=*) DATA_DIR=${1#*=}; shift ;;
      --host-alias) take_value "$1" "${2-}"; HOST_ALIAS=$2; shift 2 ;;
      --host-alias=*) HOST_ALIAS=${1#*=}; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --force) FORCE=1; shift ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      -q|--quiet) QUIET=1; shift ;;
      -v|--verbose) VERBOSE=1; shift ;;
      --json) JSON_OUT=1; shift ;;
      --insecure-http) INSECURE_HTTP=1; shift ;;
      --no-verify) VERIFY=0; shift ;;
      --smoke-test) SMOKE_TEST=1; shift ;;
      --no-smoke-test) SMOKE_TEST=0; shift ;;
      --no-start) NO_START=1; shift ;;
      --purge) PURGE=1; shift ;;
      --remove-user) REMOVE_USER=1; shift ;;
      -h|--help) CMD='help'; shift ;;
      --) shift; break ;;
      -*) die 2 "未知选项：$1（--help 查看用法）" ;;
      *)
        if [ -z "$CMD" ]; then CMD=$1; else die 2 "多余的位置参数：$1"; fi
        shift ;;
    esac
  done

  case "$CMD" in
    install|upgrade|uninstall|start|stop|restart|reload|status|version|help) : ;;
    '') usage >&2; die 2 "缺少子命令（--help 查看用法）" ;;
    *) usage >&2; die 2 "未知子命令：$CMD" ;;
  esac
}

# ---------------------------------------------------------------------------
# 前置检查（§6.1）
# ---------------------------------------------------------------------------
precheck() {
  require_root
  command -v systemctl >/dev/null 2>&1 || die 3 "找不到 systemctl：本脚本只支持 systemd（Alpine/openrc 与无 init 容器不在支持范围）"
  [ -d /run/systemd/system ] || die 3 "systemd 未在管（/run/systemd/system 不存在）：容器内无 init 时请改用宿主机的 systemd"
  if [ -r /etc/os-release ]; then
    os_pretty=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release | head -n 1)
    debug "发行版：${os_pretty:-unknown}"
  else
    warn "读不到 /etc/os-release（仅影响日志提示，继续）"
  fi
  for c in curl tar openssl; do
    command -v "$c" >/dev/null 2>&1 || die 3 "缺少命令 $c：请先安装（Debian/Ubuntu: apt-get install -y $c；RHEL 系: dnf install -y $c）"
  done
  if ! need_cmd sha256sum && ! need_cmd shasum && ! need_cmd busybox; then
    die 3 "缺少 sha256 校验工具（sha256sum / shasum / busybox 至少其一）"
  fi
  if [ "$VERIFY" = 1 ]; then
    pubkey_configured || die 6 "脚本未嵌入发布公钥（步 0 未完成）：无法校验产物签名。请先回填公钥，或在测试环境用 --no-verify"
  else
    warn "⛔ --no-verify：已跳过发布签名校验，本次安装不会被证明来自可信发布（将记录 verified=false）"
  fi
  case "$(uname -m)" in
    x86_64|amd64) ARCH='amd64' ;;
    aarch64|arm64) ARCH='arm64' ;;
    *) die 3 "不支持的架构：$(uname -m)（本期只支持 x86_64 / aarch64）" ;;
  esac
  free_kb=$(df -Pk /usr/local/bin 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "$free_kb" ] && [ "$free_kb" -lt 51200 ] 2>/dev/null; then
    die 3 "/usr/local/bin 可用空间不足 50MB（当前 ${free_kb}KB）"
  fi
  case "$CENTER" in
    '') die 2 "--center 必填（--help 查看用法）" ;;
    https://*) : ;;
    http://*) [ "$INSECURE_HTTP" = 1 ] || die 2 "--center 必须是 https://（⛔ 非 https 会被 Agent 自身拒绝；仅测试环境可用 --insecure-http）" ;;
    *) die 2 "--center 必须是完整 URL（https://…）" ;;
  esac
  printf '%s' "$AGENT_ID" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' \
    || die 2 "--agent-id 必须是合法 UUID（中心创建 Agent 时生成的那个）"
  [ -n "$RUN_USER" ] || die 2 "--user 不能为空"
  [ "$KEY_FILE" != "$SECRET_FILE" ] || die 4 "--key-file 与 --secret-file 不能是同一个文件（Agent 侧也会拒绝）"
  TMP_V=$(mktemp -d "${TMPDIR:-/tmp}/vantage-install.XXXXXX") || die 3 "无法创建临时目录"
  chmod 0700 "$TMP_V"
}

# ---------------------------------------------------------------------------
# 取版本 / 下载 / 校验 / 解包（§4.1–4.3、§6.3）
# ---------------------------------------------------------------------------
fetch_release() {
  verify_failed=0
  ok=0
  for src in $(source_chain); do
    info "源：$src"
    src_tag=$TAG
    if [ -z "$src_tag" ]; then
      if ! src_tag=$(fetch_latest_tag "$src"); then
        warn "  无法解析最新版本（latest），换下一个源"
        continue
      fi
      case "$src_tag" in ''|*'<'*) warn "  latest 解析结果不可用：$src_tag"; continue ;; esac
    fi
    asset="vantage-agent_${src_tag}_linux_${ARCH}.tar.gz"
    d="$TMP_V/src"
    rm -rf "$d"; mkdir -p "$d"
    if ! fetch "$(asset_url "$src" "$src_tag" "$asset")" "$d/$asset" 2>/dev/null; then
      warn "  下载失败：$asset"
      continue
    fi
    if ! fetch "$(asset_url "$src" "$src_tag" SHA256SUMS)" "$d/SHA256SUMS" 2>/dev/null; then
      warn "  下载失败：SHA256SUMS"
      continue
    fi
    if [ "$VERIFY" = 1 ]; then
      if ! fetch "$(asset_url "$src" "$src_tag" SHA256SUMS.sig)" "$d/SHA256SUMS.sig" 2>/dev/null; then
        warn "  ⛔ 缺少 SHA256SUMS.sig（严格模式要求签名）：该源产物不可信"
        verify_failed=1
        continue
      fi
      printf '%s\n' "$RELEASE_PUBKEY" > "$d/release.pub"
      if ! verify_signature "$d/SHA256SUMS" "$d/SHA256SUMS.sig" "$d/release.pub"; then
        warn "  ⛔ 签名校验失败：该源的产物不可信（可能被替换或投毒），拒绝使用"
        verify_failed=1
        continue
      fi
      debug "  签名校验通过"
    fi
    if ! verify_sha256 "$d/SHA256SUMS" "$asset" "$d/$asset"; then
      warn "  ⛔ sha256 校验失败：下载不完整或与清单不符"
      verify_failed=1
      continue
    fi
    if ! extract_agent "$d/$asset" "$d/unpack"; then
      warn "  解包失败或产物内容不合规"
      verify_failed=1
      continue
    fi
    TAG=$src_tag
    SRC_USED=$src
    ASSET=$asset
    UNPACKED_BIN="$d/unpack/vantage-agent"
    ok=1
    break
  done
  if [ "$ok" != 1 ]; then
    if [ "$verify_failed" = 1 ]; then
      die 6 "所有源都无法提供可信产物（签名或 sha256 未通过）"
    fi
    die 5 "所有源都下载失败（原因见上）。可用 --source <url> 指定单一源，或用 --version <tag> 固定版本"
  fi
  info "已获取 ${ASSET}（源：${SRC_USED}${TAG:+，版本：$TAG}）"
}

# ---------------------------------------------------------------------------
# 用户与目录（§6.4）
# ---------------------------------------------------------------------------
ensure_user_and_dirs() {
  if ! id "$RUN_USER" >/dev/null 2>&1; then
    info "创建运行用户：$RUN_USER"
    do_or_print useradd --system --no-create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER" \
      || die 7 "创建用户 $RUN_USER 失败"
  else
    debug "运行用户已存在：$RUN_USER（复用）"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] 将创建目录 $CONF_DIR (0750 root:$RUN_USER)、$DATA_DIR (0750 $RUN_USER)"
    return 0
  fi
  mkdir -p "$CONF_DIR" "$DATA_DIR"
  chown "root:$RUN_USER" "$CONF_DIR" 2>/dev/null || chown root "$CONF_DIR"
  chmod 0750 "$CONF_DIR"
  chown "$RUN_USER:$RUN_USER" "$DATA_DIR" 2>/dev/null || chown "$RUN_USER" "$DATA_DIR"
  chmod 0750 "$DATA_DIR"
}

# ---------------------------------------------------------------------------
# 凭证（§6.2，安全核心）
# ---------------------------------------------------------------------------
read_single_line() { # FILE
  lines=$(awk 'END {print NR}' "$1" 2>/dev/null || echo 0)
  if [ "${lines:-0}" -gt 1 ]; then
    # 允许多行但只取第一行会让用户以为写进去了全部；这里明确拒绝
    return 1
  fi
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$1" | tr -d '\r\n'
}

read_secret_tty() { # PROMPT
  p=$1
  if [ ! -r /dev/tty ]; then return 1; fi
  printf '%s' "$p" > /dev/tty
  if stty -echo < /dev/tty 2>/dev/null; then TTY_ECHO_OFF=1; fi
  IFS= read -r line < /dev/tty || line=''
  stty echo < /dev/tty 2>/dev/null || true
  TTY_ECHO_OFF=0
  printf '\n' > /dev/tty
  printf '%s' "$line"
}

write_restricted_file() { # PATH VALUE
  p=$1; v=$2
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] 将写入 $p（0600，属 $RUN_USER；内容 <redacted>）"
    return 0
  fi
  ( umask 077; printf '%s\n' "$v" > "$p" ) || die 4 "写入 $p 失败"
  chown "$RUN_USER:$RUN_USER" "$p" 2>/dev/null || chown "$RUN_USER" "$p"
  chmod 0600 "$p"
}

# 校正已有凭证文件的属主/权限（✅ Q6：已存在则只读取内容，⛔ 不覆盖）
fix_credential_perms() { # PATH
  p=$1
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] 将校正 $p 属主/权限为 $RUN_USER:0600"; return 0; fi
  chown "$RUN_USER:$RUN_USER" "$p" 2>/dev/null || chown "$RUN_USER" "$p" || die 4 "chown $p 失败"
  chmod 0600 "$p" || die 4 "chmod 600 $p 失败"
}

store_credentials() {
  key=''; secret=''; cred_src=''

  if [ -s "$KEY_FILE" ] && [ -s "$SECRET_FILE" ]; then
    cred_src='file'
    key=$(read_single_line "$KEY_FILE") || die 4 "$KEY_FILE 必须是单行文本（当前有多行）"
    secret=$(read_single_line "$SECRET_FILE") || die 4 "$SECRET_FILE 必须是单行文本（当前有多行）"
    info "凭证来源：文件（$KEY_FILE / $SECRET_FILE）"
  elif [ -n "${VANTAGE_KEY:-}" ] && [ -n "${VANTAGE_SECRET:-}" ]; then
    cred_src='env'
    key=$VANTAGE_KEY
    secret=$VANTAGE_SECRET
    info "凭证来源：环境变量"
  elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
    cred_src='tty'
    info "凭证来源：交互式输入（不回显）"
    if [ "$DRY_RUN" = 1 ]; then
      info "[dry-run] 将提示输入 key 与 secret"
      key='DRYRUN'; secret='DRYRUN'
    else
      i=0
      while [ $i -lt 3 ]; do
        key=$(read_secret_tty '请输入 agent_key（vk_…）：')
        [ -n "$key" ] && break
        i=$((i+1)); warn "输入为空，请重试"
      done
      i=0
      while [ $i -lt 3 ]; do
        secret=$(read_secret_tty '请输入 agent_secret（vs_…，输入时不显示）：')
        [ -n "$secret" ] && break
        i=$((i+1)); warn "输入为空，请重试"
      done
    fi
  else
    die 4 "拿不到凭证：本机没有可用的 /dev/tty，也没有 VANTAGE_KEY/VANTAGE_SECRET。请改用：① 面板给的一键命令（env 形式）；② 预先写入 $KEY_FILE 与 $SECRET_FILE 后用 --key-file/--secret-file（见 --help）"
  fi

  case "$key" in
    vk_*) : ;;
    vs_*) die 4 "$KEY_FILE 里是 secret（vs_ 开头），而这里要的是 key——请把 --key-file 与 --secret-file 两个路径对调" ;;
    *) die 4 "凭证格式不对：key 应以 vk_ 开头（当前前几位：$(printf '%s' "$key" | cut -c1-4)…）" ;;
  esac
  case "$secret" in
    vs_*) : ;;
    vk_*) die 4 "$SECRET_FILE 里是 key（vk_ 开头），而这里要的是 secret——请把 --key-file 与 --secret-file 两个路径对调" ;;
    *) die 4 "凭证格式不对：secret 应以 vs_ 开头（当前前几位：$(printf '%s' "$secret" | cut -c1-4)…）" ;;
  esac
  case "$key$secret" in
    *'
'*) die 4 "凭证里含换行，拒绝使用（防截断/防注入）" ;;
  esac

  if [ "$cred_src" = 'file' ]; then
    fix_credential_perms "$KEY_FILE"
    fix_credential_perms "$SECRET_FILE"
  else
    write_restricted_file "$KEY_FILE" "$key"
    write_restricted_file "$SECRET_FILE" "$secret"
  fi

  # ⛔ 必须在写盘之后立即清理（✅ 决策 #37）
  unset VANTAGE_KEY VANTAGE_SECRET 2>/dev/null || true
  key=''; secret=''

  if [ "$cred_src" = 'env' ]; then
    warn "环境变量形式会把凭证留在 shell history 里，且安装期间 root 可读 /proc/<pid>/environ"
    warn "如需清理请执行 history -d（或改用交互式 / --key-file 形式）"
  fi
}

# ---------------------------------------------------------------------------
# config.yaml（§6.5）
# ---------------------------------------------------------------------------
render_config() {
  host_alias=$HOST_ALIAS
  if [ -z "$host_alias" ]; then
    host_alias=$(hostname 2>/dev/null || printf 'unknown')
  fi
  printf '%s\n' "$CONFIG_TEMPLATE" \
    | sed -e "s|@CENTER_URL@|$(sed_escape "$CENTER")|g" \
          -e "s|@AGENT_ID@|$(sed_escape "$AGENT_ID")|g" \
          -e "s|@KEY_FILE@|$(sed_escape "$KEY_FILE")|g" \
          -e "s|@SECRET_FILE@|$(sed_escape "$SECRET_FILE")|g" \
          -e "s|@HOST_ALIAS@|$(sed_escape "$host_alias")|g"
}

write_config() {
  if [ -f "$CONF_FILE" ]; then
    cur_id=$(yaml_get "$CONF_FILE" agent id)
    cur_center=$(yaml_get "$CONF_FILE" center url)
    if [ "$cur_id" = "$AGENT_ID" ] && [ "$cur_center" = "$CENTER" ]; then
      info "已存在 config.yaml 且与本次参数一致 → 原样保留（✅ Q10）"
      return 0
    fi
    case "$CONF_FILE" in
      *'<'*) : ;;
    esac
    if [ "$FORCE" != 1 ]; then
      die 3 "该机已有 config.yaml，且指向 agent '${cur_id:-未知}' / center '${cur_center:-未知}'，与本次的 agent '$AGENT_ID' / center '$CENTER' 不一致。
      请二选一：
        ① 确认要覆盖：重跑并加 --force（原文件会先备份为 ${CONF_FILE}.bak.<时间戳>）
        ② 手工备份后删除 $CONF_FILE，再重跑本命令
      ⛔ 脚本不会静默覆盖（会冲掉你手调的采集/探活/过滤规则）"
    fi
    bak="${CONF_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    do_or_print cp -p "$CONF_FILE" "$bak"
    info "已备份原配置 → $bak"
  fi
  info "写入 $CONF_FILE"
  if [ "$DRY_RUN" = 1 ]; then
    render_config >&2
    return 0
  fi
  render_config | write_file "$CONF_FILE"
  chown "root:$RUN_USER" "$CONF_FILE" 2>/dev/null || chown root "$CONF_FILE"
  chmod 0640 "$CONF_FILE"
}

config_matches_args() { # 已装分支用：不写配置，但要确保参数与现网一致
  [ -f "$CONF_FILE" ] || return 0
  cur_id=$(yaml_get "$CONF_FILE" agent id)
  cur_center=$(yaml_get "$CONF_FILE" center url)
  if [ "$cur_id" != "$AGENT_ID" ] || [ "$cur_center" != "$CENTER" ]; then
    die 3 "该机现有 config.yaml 指向 agent '${cur_id:-未知}' / center '${cur_center:-未知}'，与本次参数不一致 → 拒绝继续。
      如确实要换 Agent，请先备份并删除 $CONF_FILE，再带 --force 重跑（会丢失原有采集/探活配置）"
  fi
  return 0
}

run_config_check() {
  info "离线自检：vantage-agent --check"
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] runuser -u $RUN_USER -- $AGENT_BIN --config $CONF_FILE --check"; return 0; fi
  if ! run_as_user "$RUN_USER" "$AGENT_BIN" --config "$CONF_FILE" --check; then
    die 3 "配置与凭证自检未通过（原因见上方 Agent 输出）
      常见原因：凭证文件权限不是 0600 / key 与 secret 放反 / config.yaml 有拼错的字段"
  fi
}

# ---------------------------------------------------------------------------
# 二进制落盘（§6.3、§6.9）
# ---------------------------------------------------------------------------
install_binary_fresh() {
  info "安装二进制 → $AGENT_BIN"
  do_or_print install -m 0755 -o root -g root "$UNPACKED_BIN" "$AGENT_BIN" || die 7 "写入 $AGENT_BIN 失败"
}

# ---------------------------------------------------------------------------
# 冒烟上报（§6.6）—— 在装 unit 之前
# ---------------------------------------------------------------------------
smoke_timeout() {
  ct=$(duration_seconds "$(yaml_get "$CONF_FILE" center timeout)")
  case "$ct" in ''|*[!0-9]*) ct=10 ;; esac
  [ "$ct" -gt 0 ] 2>/dev/null || ct=10
  echo $(( ct * 2 + 30 ))
}

smoke_report() { # BIN_PATH —— 成功返回 0；失败返回 1（由调用方负责清理与退出码）
  bin=$1
  t=$(smoke_timeout)
  info "冒烟上报（真实上报一次，超时 ${t}s）"
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] runuser -u $RUN_USER -- $bin --config $CONF_FILE --once"
    return 0
  fi
  out="$TMP_V/smoke.out"
  if run_with_timeout "$t" run_as_user "$RUN_USER" "$bin" --config "$CONF_FILE" --once > "$out" 2>&1; then
    cat "$out" >&2
    info "冒烟上报成功 ✅"
    return 0
  fi
  cat "$out" >&2
  if grep -q 'signature_invalid' "$out" 2>/dev/null; then
    warn '401 signature_invalid：key/secret 不匹配，或反向代理改写了 body（中心要求原始字节）'
  elif grep -q 'timestamp_skew' "$out" 2>/dev/null; then
    warn '401 timestamp_skew：本机时钟漂移超过窗口，请启用 NTP/chrony 并校时'
  elif grep -q '429' "$out" 2>/dev/null; then
    warn '429：被中心限流，请核对中心限流阈值与上报周期'
  elif grep -qi 'certificate\|x509' "$out" 2>/dev/null; then
    warn 'TLS 失败：证书问题（自签 CA 用 center.tls.ca_file），或 --center 不是对外可访问的 https'
  elif grep -qi 'connection refused\|no route\|timed out\|timeout\|dial tcp' "$out" 2>/dev/null; then
    warn '网络不通：检查出站防火墙/安全组是否放行中心地址与端口'
  fi
  return 1
}

# ---------------------------------------------------------------------------
# unit 与启动（§6.7）
# ---------------------------------------------------------------------------
render_unit() {
  printf '%s\n' "$UNIT_TEMPLATE" \
    | sed -e "s|@AGENT_USER@|$(sed_escape "$RUN_USER")|g" \
          -e "s|@AGENT_BIN@|$(sed_escape "$AGENT_BIN")|g" \
          -e "s|@CONF_FILE@|$(sed_escape "$CONF_FILE")|g" \
          -e "s|@DATA_DIR@|$(sed_escape "$DATA_DIR")|g"
}

install_unit() {
  info "写入 systemd unit → $UNIT_FILE"
  if [ "$DRY_RUN" = 1 ]; then render_unit >&2; return 0; fi
  render_unit | write_file "$UNIT_FILE" || die 7 "写入 unit 失败"
  systemctl daemon-reload || die 7 "systemctl daemon-reload 失败"
  systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || warn "systemctl enable 失败（不影响本次运行）"
}

service_active() { systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null; }

wait_active() {
  i=0
  while [ $i -lt 10 ]; do
    if service_active; then return 0; fi
    sleep 1
    i=$((i+1))
  done
  return 1
}

# 把脚本自身留到本机，便于日常 `sudo vantage.sh status|reload|upgrade`；
# 通过管道执行时（$0 是 sh）无法自安装，改为打印一条可直接复制的命令。
maybe_self_install() {
  self=$0
  case "$self" in
    ''|sh|*/sh|dash|*/dash|bash|*/bash) self='' ;;
  esac
  if [ -n "$self" ] && [ -f "$self" ]; then
    if do_or_print install -m 0755 -o root -g root "$self" "$SELF_BIN"; then
      info "脚本自身已安装到 $SELF_BIN（日常运维可直接用：sudo vantage.sh status）"
    fi
    return 0
  fi
  info "本次通过管道执行（\$0=${0:-sh}），脚本未在本机留存"
  if [ -n "${SRC_USED:-}" ] && [ -n "${TAG:-}" ]; then
    info "如需日常使用 vantage.sh status/reload/upgrade，可另存一份："
    info "  curl -fsSL $(asset_url "$SRC_USED" "$TAG" vantage.sh) | sudo tee $SELF_BIN >/dev/null && sudo chmod 0755 $SELF_BIN"
  fi
  return 0
}

first_install_rollback() {
  warn "回滚首次安装：停服务、移除本次新建的 unit 与二进制（⛔ 保留 $CONF_DIR）"
  systemctl stop "$UNIT_NAME" >/dev/null 2>&1 || true
  systemctl disable "$UNIT_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload >/dev/null 2>&1 || true
  rm -f "$AGENT_BIN"
  warn "配置与凭证已保留在 $CONF_DIR（修好问题后重跑同一条命令即可，会走 upgrade 分支）"
}

# ---------------------------------------------------------------------------
# install-state
# ---------------------------------------------------------------------------
write_state() {
  verified=true
  [ "$VERIFY" = 1 ] || verified=false
  fp=$(pubkey_fingerprint)
  info "写入安装记录 → $STATE_FILE"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  {
    printf 'version=%s\n' "$TAG"
    printf 'arch=%s\n' "$ARCH"
    printf 'asset=%s\n' "${ASSET:-unknown}"
    printf 'source=%s\n' "${SRC_USED:-unknown}"
    printf 'verified=%s\n' "$verified"
    printf 'pubkey_fp=%s\n' "$fp"
    printf 'script_version=%s\n' "$SCRIPT_VERSION"
    printf 'installed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } | write_file "$STATE_FILE"
  chown root:root "$STATE_FILE" 2>/dev/null || true
  chmod 0644 "$STATE_FILE"
}

state_get() {
  if [ -f "$STATE_FILE" ]; then
    sed -n "s/^$1=//p" "$STATE_FILE" | head -n 1
  fi
}

pubkey_fingerprint() {
  if ! pubkey_configured; then printf 'none'; return 0; fi
  if [ "$DRY_RUN" = 1 ]; then printf 'dryrun'; return 0; fi
  f="$TMP_V/fp.pub"
  printf '%s\n' "$RELEASE_PUBKEY" > "$f" 2>/dev/null || { printf 'unknown'; return 0; }
  openssl pkey -pubin -in "$f" -outform DER 2>/dev/null | sha256sum 2>/dev/null | cut -c1-16
}

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------
cmd_install() {
  precheck

  if [ -x "$AGENT_BIN" ]; then
    info "检测到已安装的 $AGENT_BIN → 走 upgrade 分支（配置与凭证保持不动，✅ Q10/Q12）"
    config_matches_args
    cmd_upgrade
    return 0
  fi

  fetch_release
  ensure_user_and_dirs
  store_credentials
  write_config

  info "落盘二进制 → $AGENT_BIN（此时尚未创建 unit）"
  install_binary_fresh

  run_config_check

  if [ "$NO_START" = 1 ]; then
    if [ "$SMOKE_TEST" = 1 ]; then
      debug "--no-start：显式要求冒烟上报"
      if ! smoke_report "$AGENT_BIN"; then
        rm -f "$AGENT_BIN"
        die 8 "冒烟上报失败 → 安装中止（已清理本次落盘的二进制；unit 未创建）
      如果中心当前不可达，可加 --no-smoke-test 跳过这一步（装完需你自行确认上报）"
      fi
    else
      info "--no-start：跳过冒烟上报与服务启动；装完请自行确认上报（vantage.sh status）"
    fi
  else
    if [ "$SMOKE_TEST" = 1 ]; then
      if ! smoke_report "$AGENT_BIN"; then
        rm -f "$AGENT_BIN"
        warn "已清理本次落盘的二进制（unit 未创建）"
        die 8 "冒烟上报失败 → 安装中止。若中心当前不可达，可加 --no-smoke-test 跳过该步"
      fi
    else
      warn "--no-smoke-test：已跳过真实上报，装完请自行确认（vantage.sh status）"
    fi
    install_unit || { first_install_rollback; die 7 "安装 systemd unit 失败"; }
    info "启动服务：systemctl start $UNIT_NAME"
    if ! do_or_print systemctl start "$UNIT_NAME"; then
      first_install_rollback
      die 7 "systemctl start 失败（journalctl -u $UNIT_NAME -n 50 查看原因）"
    fi
    if [ "$DRY_RUN" = 1 ]; then
      info "[dry-run] 将等待服务 active 并检查 journald 启动日志"
    elif ! wait_active; then
      journalctl -u "$UNIT_NAME" -n 20 --no-pager >&2 2>/dev/null || true
      first_install_rollback
      die 8 "服务未在 10s 内变为 active"
    else
      sleep 1
      if journalctl -u "$UNIT_NAME" -n 20 --no-pager 2>/dev/null | grep -q 'panic\|failed'; then
        warn "启动日志里出现 panic/failed，请执行 vantage.sh status 与 journalctl -u $UNIT_NAME 查看"
      fi
    fi
  fi

  write_state

  info ''
  info "✅ 安装完成"
  info "  版本：${TAG:-latest}（源：${SRC_USED:-unknown}，签名校验：$([ "$VERIFY" = 1 ] && echo yes || echo 'no(verified=false)')）"
  info "  该机已冒烟上报一次，应立刻/在一个上报周期内出现在面板"
  maybe_self_install
  info "  下一步：按需编辑 $CONF_FILE（探活/采集/频率）→ sudo vantage.sh reload"
  info "  随时查看：sudo vantage.sh status"
}

# ---------------------------------------------------------------------------
# upgrade（§7.1）
# ---------------------------------------------------------------------------
cmd_upgrade() {
  precheck
  [ -x "$AGENT_BIN" ] || die 3 "尚未安装（找不到 $AGENT_BIN）：请先执行 install"

  if [ -z "$TAG" ]; then
    cur=$(state_get version)
    if [ -z "$cur" ]; then
      cur=$("$AGENT_BIN" --version 2>/dev/null | awk '{print $2}')
    fi
    debug "已装版本：${cur:-unknown}"
  fi

  if [ -n "$TAG" ] && [ -f "$STATE_FILE" ]; then
    cur=$(state_get version)
    if [ "$cur" = "$TAG" ] && [ "$FORCE" != 1 ]; then
      info "已是最新（$TAG）；如需强制重装请加 --force"
      return 0
    fi
  fi

  fetch_release

  info "候选二进制 → $AGENT_BIN_NEW"
  do_or_print install -m 0755 -o root -g root "$UNPACKED_BIN" "$AGENT_BIN_NEW" || die 7 "写入 $AGENT_BIN_NEW 失败"

  info "预演 A（离线自检）"
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] runuser -u $RUN_USER -- $AGENT_BIN_NEW --config $CONF_FILE --check"
  elif ! run_as_user "$RUN_USER" "$AGENT_BIN_NEW" --config "$CONF_FILE" --check; then
    rm -f "$AGENT_BIN_NEW"
    die 8 "预演 A 失败：新版本无法通过配置自检 → ⛔ 线上文件零改动"
  fi

  if [ "$SMOKE_TEST" = 1 ]; then
    info "预演 B（真实上报一次；线上服务仍在跑旧版本）"
    if ! smoke_report "$AGENT_BIN_NEW"; then
      rm -f "$AGENT_BIN_NEW"
      die 8 "预演 B 失败：新版本无法完成一次真实上报 → ⛔ 线上文件零改动（服务仍在跑旧版本，.prev 未被覆盖）"
    fi
  else
    warn "--no-smoke-test：跳过升级前的真实上报预演"
  fi

  old_ver=$("$AGENT_BIN" --version 2>/dev/null | awk '{print $2}')
  info "替换二进制（旧版备份为 $AGENT_BIN_PREV）"
  do_or_print cp -p "$AGENT_BIN" "$AGENT_BIN_PREV" || die 7 "备份旧二进制失败"
  do_or_print mv -f "$AGENT_BIN_NEW" "$AGENT_BIN" || die 7 "替换二进制失败"

  info "重启服务并确认存活"
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] systemctl restart $UNIT_NAME"
  else
    systemctl restart "$UNIT_NAME" || warn "systemctl restart 返回非零"
    if ! wait_active; then
      journalctl -u "$UNIT_NAME" -n 20 --no-pager >&2 2>/dev/null || true
      warn "新版本启动失败 → 自动回滚 $AGENT_BIN_PREV"
      cp -p "$AGENT_BIN_PREV" "$AGENT_BIN" || warn "回滚复制失败，请手工处理"
      systemctl restart "$UNIT_NAME" >/dev/null 2>&1 || true
      die 8 "升级失败并已回滚（当前运行的是旧版本）。排查：journalctl -u $UNIT_NAME -n 100"
    fi
  fi

  write_state
  maybe_self_install
  info "✅ 升级完成：${old_ver:-unknown} → ${TAG:-latest}（源：${SRC_USED:-unknown}）"
  info "  回滚点：$AGENT_BIN_PREV"
}

# ---------------------------------------------------------------------------
# uninstall（§7.2）
# ---------------------------------------------------------------------------
cmd_uninstall() {
  require_root
  command -v systemctl >/dev/null 2>&1 || die 3 "找不到 systemctl"

  info "停止并移除服务"
  do_or_print systemctl stop "$UNIT_NAME" 2>/dev/null || true
  do_or_print systemctl disable "$UNIT_NAME" 2>/dev/null || true
  do_or_print rm -f "$UNIT_FILE"
  do_or_print systemctl daemon-reload
  do_or_print rm -f "$AGENT_BIN" "$AGENT_BIN_NEW"
  # ⚠️ 保留 $AGENT_BIN_PREV：默认卸载后仍可手工回滚到上一版；--purge 时一并删除

  if [ "$PURGE" != 1 ]; then
    info ''
    info "✅ 已卸载（配置与凭证**保留**，✅ G9）"
    info "  保留：$CONF_DIR（config.yaml + agent.key + agent.secret + install-state）"
    info "  保留：$AGENT_BIN_PREV（上一版二进制，可手工回滚）"
    info "  彻底清理：sudo vantage.sh uninstall --purge"
    return 0
  fi

  info ''
  info "以下内容将被**永久删除**："
  info "  - $CONF_DIR（配置、凭证、安装记录）"
  info "  - $AGENT_BIN_PREV"
  if [ "$REMOVE_USER" = 1 ]; then info "  - 运行用户 $RUN_USER"; fi
  # ⛔ 这一步不接受 -y 跳过（删除凭证与配置不可逆）
  if [ ! -r /dev/tty ]; then
    die 3 "--purge 需要交互确认，但本机没有可用的 /dev/tty；请在终端里执行（⛔ -y 不能替代这一步）"
  fi
  printf '确认删除？请输入 yes（其它任何输入都视为放弃）：' > /dev/tty
  IFS= read -r ans < /dev/tty || ans=''
  printf '\n' > /dev/tty
  if [ "$ans" != 'yes' ]; then
    info "已取消（未删除任何配置）"
    return 0
  fi
  do_or_print rm -rf "$CONF_DIR"
  do_or_print rm -f "$AGENT_BIN_PREV"
  do_or_print rm -f "$SELF_BIN"
  if [ "$REMOVE_USER" = 1 ]; then
    if do_or_print userdel "$RUN_USER" 2>/dev/null; then info "已删除用户 $RUN_USER"; else warn "删除用户 $RUN_USER 失败（可能有文件属主仍是它），请手工处理"; fi
  fi
  info "✅ 彻底清理完成"
}

# ---------------------------------------------------------------------------
# 控制与状态（§7.3、§7.4）
# ---------------------------------------------------------------------------
cmd_service() { # start|stop|restart|reload
  require_root
  command -v systemctl >/dev/null 2>&1 || die 3 "找不到 systemctl"
  if ! systemctl list-unit-files "$UNIT_NAME.service" >/dev/null 2>&1 || \
     [ ! -f "$UNIT_FILE" ]; then
    die 7 "服务 $UNIT_NAME 尚未安装：请先执行 install（sudo vantage.sh install --center … --agent-id …）"
  fi
  case "$CMD" in
    reload) info "热重载（SIGHUP）：systemctl reload $UNIT_NAME" ;;
    *) info "systemctl $CMD $UNIT_NAME" ;;
  esac
  if ! do_or_print systemctl "$CMD" "$UNIT_NAME"; then
    die 7 "systemctl $CMD 失败：journalctl -u $UNIT_NAME -n 50 查看原因"
  fi
  if [ "$CMD" = 'reload' ]; then
    sleep 1
    if journalctl -u "$UNIT_NAME" -n 30 --no-pager 2>/dev/null | grep -q 'config_reload_failed'; then
      warn "⛔ 新配置校验失败，Agent 已保留旧配置继续运行（这次 reload 并未生效）"
      exit 7
    fi
    info "reload 完成（未发现 config_reload_failed）"
  fi
}

cmd_status() {
  require_root
  active=$(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)
  [ -n "$active" ] || active='unknown'
  since=$(systemctl show -p ExecMainStartTimestamp --value "$UNIT_NAME" 2>/dev/null || true)
  ver=$("$AGENT_BIN" --version 2>/dev/null | awk '{print $2}')
  [ -n "$ver" ] || ver=$(state_get version)
  [ -n "$ver" ] || ver='unknown'
  src=$(state_get source); [ -n "$src" ] || src='unknown'
  verified=$(state_get verified); [ -n "$verified" ] || verified='unknown'
  fp=$(state_get pubkey_fp); [ -n "$fp" ] || fp='unknown'

  last_ok=''; last_err=''
  if need_cmd journalctl; then
    last_ok=$(journalctl -u "$UNIT_NAME" -o short-iso --no-pager -n 5000 2>/dev/null | grep '上报成功' | tail -n 1 || true)
    if [ -z "$last_ok" ]; then
      last_ok=$(journalctl -u "$UNIT_NAME" -o short-iso --no-pager -n 5000 2>/dev/null | grep '心跳已上报' | tail -n 1 || true)
    fi
    last_err=$(journalctl -u "$UNIT_NAME" -o short-iso --no-pager -n 5000 2>/dev/null | grep '上报失败' | tail -n 1 || true)
  fi

  summary=''
  if [ -x "$AGENT_BIN" ] && [ -f "$CONF_FILE" ]; then
    summary=$(run_as_user "$RUN_USER" "$AGENT_BIN" --config "$CONF_FILE" --check 2>&1 | sed -n 's/^生效摘要：//p' | head -n 1 || true)
  fi

  perm_ok='yes'
  for f in "$KEY_FILE" "$SECRET_FILE"; do
    if [ -f "$f" ]; then
      p=$(stat -c '%a %U:%G' "$f" 2>/dev/null || echo 'unknown')
      case "$p" in 600*) : ;; *) perm_ok="no（$f 是 $p）" ;; esac
    else
      perm_ok="no（缺 $f）"
    fi
  done

  if [ "$JSON_OUT" = 1 ]; then
    esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n'; }
    printf '{"active":"%s","since":"%s","version":"%s","source":"%s","verified":"%s","pubkey_fp":"%s","last_report":"%s","last_error":"%s","config_summary":"%s","credential_perms_ok":"%s","script_version":"%s"}\n' \
      "$(esc "$active")" "$(esc "$since")" "$(esc "$ver")" "$(esc "$src")" "$(esc "$verified")" \
      "$(esc "$fp")" "$(esc "$last_ok")" "$(esc "$last_err")" "$(esc "$summary")" "$(esc "$perm_ok")" "$SCRIPT_VERSION"
    return 0
  fi

  printf '服务状态      : %s%s\n' "$active" "$([ -n "$since" ] && printf '（启动于 %s）' "$since")"
  printf '版本          : %s（脚本 %s）\n' "$ver" "$SCRIPT_VERSION"
  printf '来源/校验     : %s / verified=%s（公钥指纹 %s）\n' "$src" "$verified" "$fp"
  printf '最后上报      : %s\n' "${last_ok:-（journald 里没找到“上报成功”记录）}"
  printf '最近失败      : %s\n' "${last_err:-（无）}"
  printf '生效配置摘要  : %s\n' "${summary:-（无法获取，检查 config.yaml 与凭证权限）}"
  printf '凭证权限体检  : %s\n' "$perm_ok"
  if [ -n "$CENTER" ]; then
    :
  else
    center_cfg=$(yaml_get "$CONF_FILE" center url 2>/dev/null || true)
    if [ -n "$center_cfg" ]; then
      if curl -fsS -m 5 "$center_cfg/healthz" >/dev/null 2>&1; then
        printf '中心连通性    : OK（%s/healthz）\n' "$center_cfg"
      else
        printf '中心连通性    : 失败（%s/healthz）——检查出站网络/防火墙\n' "$center_cfg"
      fi
    fi
  fi
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  case "$CMD" in
    help) usage; exit 0 ;;
    version) printf 'vantage.sh %s\n' "$SCRIPT_VERSION"; exit 0 ;;
  esac
  case "$CMD" in
    install) cmd_install ;;
    upgrade) cmd_upgrade ;;
    uninstall) cmd_uninstall ;;
    start|stop|restart|reload) cmd_service ;;
    status) cmd_status ;;
  esac
}

main "$@"
