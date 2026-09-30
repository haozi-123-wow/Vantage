// Package version 提供版本号，进 User-Agent 与日志（docs/agent.md §2、§12.3）。
package version

// Version 由构建时注入：
//
//	go build -ldflags "-X vantage-agent/internal/version.Version=v0.1.0"
var Version = "0.0.0-dev"

// UserAgent 上报请求的 User-Agent（便于中心侧排障）。
func UserAgent() string { return "vantage-agent/" + Version }
