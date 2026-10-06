# agent/deploy — Agent 部署侧交付物

设计与分步实施说明见 [docs/agent-install-script.md](../../docs/agent-install-script.md)（设计定稿）和 `docs/agent-todo.md`。

## 文件

| 文件 | 用途 | 谁执行 |
|---|---|---|
| `vantage.sh` | 唯一入口：`install` / `upgrade` / `uninstall` / `start` / `stop` / `restart` / `reload` / `status` / `version` / `help` | 被监控机（root） |
| `vantage-agent.service` | systemd unit 模板；与 `vantage.sh` 内嵌的 `UNIT_TEMPLATE` 逐字一致（`tests/static-assert.sh` 会 diff 校验） | 由 `install` 落盘 |
| `config.minimal.yaml` | `config.yaml` 模板；同样与脚本内嵌的 `CONFIG_TEMPLATE` 逐字一致 | 由 `install` 渲染 |
| `build-release.sh` | 打包：交叉编译 + `tar.gz` + `SHA256SUMS`；`--keygen` 生成发布密钥对 | 维护者 |
| `publish-release.sh` | 签名 + 推 GitHub/镜像/自建站 + 回读自检 | 维护者 |
| `tests/static-assert.sh` | 安全约束静态断言（POSIX `sh`；在 Linux/真机上跑） | 开发者/CI |
| `tests/shell-lint.js` | 静态断言的 Node 等价检查（块配平 + 安全约束 + 模板一致性，自带自测）；不能替代 `sh -n` 与真机验证 | 开发者 |

## 模板占位符

- unit：`@AGENT_USER@`、`@AGENT_BIN@`、`@CONF_FILE@`、`@DATA_DIR@`
- config：`@CENTER_URL@`、`@AGENT_ID@`、`@KEY_FILE@`、`@SECRET_FILE@`、`@HOST_ALIAS@`

## 步 0（发布准备，必须由维护者在自己终端执行）

```sh
# 1) 生成发布密钥对（ECDSA P-256）：私钥离线保管，公钥回填脚本
sh agent/deploy/build-release.sh --keygen --out dist
#    把 dist/verify.pem 整段替换 vantage.sh 里 RELEASE_PUBKEY='…' 的内容

# 2) 安全约束自检 + 打包
sh agent/deploy/tests/static-assert.sh
sh agent/deploy/build-release.sh --version v0.1.0 --out dist

# 3) 签名并发布到三个源，随后自动回读自检
VANTAGE_RELEASE_KEY=~/vantage-release.key \
VANTAGE_SELF_HOSTED_DEST=user@host:/srv/vantage-dl VANTAGE_SELF_HOSTED_URL=https://dl.example.com \
VANTAGE_MIRROR_DEST=user@host:/srv/vantage-mirror  VANTAGE_MIRROR_URL=https://mirror.example.com \
  sh agent/deploy/publish-release.sh --version v0.1.0 --dist dist --github
```

## 被监控机上的用法（一条命令）

```sh
VANTAGE_KEY=vk_xxx VANTAGE_SECRET=vs_xxx sh -c 'curl -fsSL https://<自建站>/vantage.sh | sudo -E sh -s -- install \
  --center https://vantage.example.com --agent-id <uuid>'
```

脚本不提供 `--key` / `--secret` 明文参数，凭证只能经受限文件、环境变量或 `/dev/tty` 传入。
脚本不自我更新，不做二次 `curl | sh`，也不读取中心下发的任何内容。

## 真机/容器验证

见 [docs/agent-install-script.md §12.2](../../docs/agent-install-script.md)（可复制的正例与 11 条负例）。
