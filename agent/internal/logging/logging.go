// Package logging 构造 Agent 的日志器。
//
// 依据：docs/agent.md §8（log 配置）、§9（日志输出到 journald 或受限日志文件）、
//       §12.3（⛔ 日志、--help、错误信息中不得出现 key/secret）。
//
// 三条落点：
//  1. 默认输出到 **stderr**，交给 systemd/journald 收集（Linux 上这是最省事、最不易丢的方案）；
//     只有显式配置了 `log.file` 才自己写文件。
//  2. 自己写文件时做**按大小轮转**（`max_size_mb` / `max_backups`）。
//     ⚠️ 不引第三方日志库（如 lumberjack）是为了守住"零依赖单文件静态二进制"这条硬指标，
//     而轮转本身只有几十行。
//  3. ⛔ 日志里永不出现凭证：调用方负责不把 key/secret 传进来（`config.Summary()` 已经做了这件事）。
package logging

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"vantage-agent/internal/config"
)

// Level 解析日志级别字符串。
func Level(s string) (slog.Level, error) {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug, nil
	case "info", "":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("未知日志级别 %q（只支持 debug/info/warn/error）", s)
	}
}

// New 按配置构造日志器。
//
// 返回的 `io.Closer` 在进程退出时关闭文件（stderr 时是 no-op）。
func New(cfg config.LogBlock) (*slog.Logger, io.Closer, error) {
	lvl, err := Level(cfg.Level)
	if err != nil {
		return nil, nil, err
	}

	var w io.Writer = os.Stderr
	var closer io.Closer = nopCloser{}
	if cfg.File != "" {
		rw, err := newRotatingWriter(cfg.File, cfg.MaxSizeMB, cfg.MaxBackups)
		if err != nil {
			return nil, nil, err
		}
		w, closer = rw, rw
	}

	opts := &slog.HandlerOptions{Level: lvl}
	var h slog.Handler
	if strings.EqualFold(cfg.Format, "json") {
		h = slog.NewJSONHandler(w, opts)
	} else {
		h = slog.NewTextHandler(w, opts)
	}
	return slog.New(h), closer, nil
}

type nopCloser struct{}

func (nopCloser) Close() error { return nil }

// ---------------------------------------------------------------------------
// 按大小轮转的写入器
// ---------------------------------------------------------------------------

// rotatingWriter 单文件 + 按大小轮转：`agent.log` → `agent.log.1` → `agent.log.2` …
//
// ⚠️ 刻意不做以下两件事，以免把"日志"这件事变成新的故障源：
//   - 不跨进程加锁（Agent 是单进程，多进程同时写同一日志本身就是配置错误）；
//   - 不因为写日志失败而 panic 或中断上报（`Write` 出错只返回错误，调用方是 slog，它会忽略）。
type rotatingWriter struct {
	mu         sync.Mutex
	path       string
	maxBytes   int64
	maxBackups int

	f *os.File
	n int64
}

func newRotatingWriter(path string, maxSizeMB, maxBackups int) (*rotatingWriter, error) {
	if maxSizeMB <= 0 {
		maxSizeMB = 16
	}
	if maxBackups < 0 {
		maxBackups = 0
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("创建日志目录失败（%s）：%w", dir, err)
		}
	}
	w := &rotatingWriter{
		path:       path,
		maxBytes:   int64(maxSizeMB) * 1024 * 1024,
		maxBackups: maxBackups,
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return nil, fmt.Errorf("打开日志文件失败（%s）：%w", path, err)
	}
	w.f = f
	if info, err := f.Stat(); err == nil {
		w.n = info.Size()
	}
	return w, nil
}

func (w *rotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.f == nil {
		return 0, os.ErrClosed
	}
	if w.n+int64(len(p)) > w.maxBytes && w.n > 0 {
		if err := w.rotateLocked(); err != nil {
			// ⛔ 轮转失败不该让上报中断：继续往原文件写，只把错误返回给调用方（slog 会忽略）
			return w.f.Write(p)
		}
	}
	n, err := w.f.Write(p)
	w.n += int64(n)
	return n, err
}

func (w *rotatingWriter) rotateLocked() error {
	if err := w.f.Close(); err != nil {
		return err
	}
	// 从最老的一份开始往后挪：.N 丢弃，.N-1 → .N，…，base → .1
	if w.maxBackups > 0 {
		oldest := fmt.Sprintf("%s.%d", w.path, w.maxBackups)
		_ = os.Remove(oldest)
		for i := w.maxBackups - 1; i >= 1; i-- {
			from := fmt.Sprintf("%s.%d", w.path, i)
			to := fmt.Sprintf("%s.%d", w.path, i+1)
			_ = os.Rename(from, to)
		}
		if err := os.Rename(w.path, w.path+".1"); err != nil && !os.IsNotExist(err) {
			return err
		}
	} else {
		// max_backups=0 → 不留历史，直接截断重来
		if err := os.Remove(w.path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}

	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return err
	}
	w.f = f
	w.n = 0
	return nil
}

func (w *rotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		return nil
	}
	err := w.f.Close()
	w.f = nil
	return err
}

// backups 列出已存在的轮转文件（测试用）。
func (w *rotatingWriter) backups() []string {
	matches, _ := filepath.Glob(w.path + ".*")
	sort.Strings(matches)
	return matches
}
