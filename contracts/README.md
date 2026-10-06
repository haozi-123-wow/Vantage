# contracts/ —— 两端共享的接口契约

这个目录里的文件不是测试代码，而是接口定义。

`vantage-agent`（Go）与 `vantage-core`（Node）两端的测试都必须逐字节消费同一份文件。这是唯一能挡住「两边各自实现都对、拼在一起不通」的手段，典型症状是 401 `signature_invalid` 或 400 `schema_invalid`，而且极难排查。

## 为什么与测试代码分开存放

`server/test/` 与 `agent/` 下的测试都会随公开仓库上传，契约文件仍然单独放在这里，因为它属于接口定义：

- 契约需要有唯一的存放位置。散落在两侧的测试目录里，「改一侧忘一侧」是迟早的事。
- 契约要能被文档直接引用，`docs/*.md` 与 README 里可以写「见 `contracts/metric-names.json`」。
- 两侧测试都读同一份文件；放在任何一侧的测试目录里，都会让另一侧产生跨目录的怪依赖。

只有一条要求：不要只改一侧。只改一侧，另一侧的测试会立刻变红，这正是设计意图。

## 文件清单

| 文件 | 内容 | 消费方 |
|---|---|---|
| `agent-signature.json` | HMAC 签名的固定向量（固定 secret / body / ts / nonce → 期望的 canonical 与签名） | Go `internal/auth/sign_test.go`、Node `test/sign.test.js` |
| `metric-names.json` | 指标序列命名与维度转义的向量（含长度边界、转义单射性、非法输入） | Go `internal/metric/metric_test.go`、Node `test/metric.test.js` |
| `wire/report-full.json` | Agent 线上黄金字节：覆盖每一个可选字段的完整上报 | Go `internal/model/wire_test.go`（生成并逐字节比对）、Node `test/agentwire.test.js`（送进真实链路） |
| `wire/report-minimal.json` | 只带中心必填项的最小上报 | 同上 |
| `wire/heartbeat.json` | 心跳报文 | 同上 |

## 规则

- 改契约的顺序是：先改文档（`docs/api.md` / `docs/database.md` / `docs/agent.md`），再改这里的向量，最后改两端实现。反过来做会让「文档写的」和「代码做的」长期不一致。
- 任何一侧单独改向量文件都属违规，另一侧的测试会立刻变红，这正是设计意图。
- `wire/*.json` 由 Go 侧生成：
  ```
  cd agent && go test ./internal/model/ -run TestWireFixtures -update
  ```
  它们是紧凑的线上字节，不是格式化过的 JSON，所以 diff 会很长，这是有意的：签名与发送用的就是这些字节，格式化过的版本证明不了任何事。
- 这里的 secret / key 全是公开的测试值，不得用于生产（文件内已标注）。生成这些文件时只允许用本地路径，以及文档示例中的保留地址（如 `203.0.113.x`、`example.com`）。
