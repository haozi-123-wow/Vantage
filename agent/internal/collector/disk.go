// disk.go 实现磁盘采集器（容量 / inode / IO 速率 / 平均延迟）。
//
// 依据：docs/agent.md §3（disk 行）、§4.8（过滤规则）、docs/database.md §5.7.2
//（`disk.total|used`、`disk.inode_used_pct`、`disk.read_bps|write_bps`、`disk.read_iops|write_iops`、
// `disk.latency_ms`，维度 `{device,mount}`）。
//
// 数据源：`{root}/self/mountinfo`（退化 `{root}/mounts`）+ `{root}/diskstats` + **注入的** statfs。
//
// 职责边界：只写 `s.Metrics.Disk`。挂载点被过滤 / statfs 失败 / 指标名超长 → **跳过该条目**并打 WARN，
// ⛔ 绝不让整个采集失败：一个卡住的 NFS 挂载点不该让这台机器的所有磁盘指标消失。
//
// ⚠️ 六个踩坑点（每一个都对应一类真实故障）：
//  1. **挂载点异常长** → 中心指标全名（含维度）超过 200 字符 → 迁移脚本的 CHECK/中心 schema 拒绝
//     → **整批上报 400**，包括 CPU/内存。所以在产出前用 metric.Build 预检**最长的**派生基名
//     （`disk.inode_used_pct`），超长就跳过该挂载点。
//  2. **diskstats 列数随内核版本变化**：2.6 起 11 列、4.18 起加了 discard（14 列）、
//     5.5 起又加了 flush（17/18/20 列）。一律"按位置取 + 逐个判存在"，
//     ⛔ 不要校验总列数也不要假设固定 20 列 —— 数错一列就会把"写扇区数"当成"读扇区数"，
//     面板上表现为两条完全颠倒的曲线，且没有任何报错。
//  3. `Used` 的语义是 **Total − FreeBytes**（贴近 df），不是 Total − AvailBytes：
//     两者在 ext4 上差一个 root 保留块（默认 5%），混用会让"磁盘用量"永远对不上 df。
//  4. `InodeUsed` 是**百分比**（落库 `disk.inode_used_pct`），不是 inode 数量。
//     btrfs 的 statfs 报 Files=0，此时 0/0 会得到 NaN → 中心拒绝非有限数字 → 整批 400，
//     所以 TotalInode=0 时该字段留 nil。
//  5. **同一设备挂载多次**（bind mount、同一 fs 挂两个点）时，IO 差分**每设备每周期只能算一次**：
//     算两次的话第二次的差分是 0，同一块盘的 IO 会在两条序列上一条正常一条恒为 0。
//  6. `(device, mount)` 维度组合必须**唯一**：中心对批内重复序列直接 400
//     （/proc/self/mountinfo 里出现重复挂载点是可能的，比如同一 fs 被 overmount）。
package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"vantage-agent/internal/config"
	"vantage-agent/internal/metric"
	"vantage-agent/internal/model"
)

// diskMetricBaseForCheck 预检指标全名时用的基名：必须是该维度下**最长**的基名。
//
// ⚠️ 只检查 `disk.used_pct` 是不够的：中心会从同一个挂载点派生 9 条序列
//（disk.total / disk.used / disk.used_pct / disk.inode_used_pct / disk.read_bps / …），
// 其中 `disk.inode_used_pct`（19 字符）最长。基名越短越容易"检查通过但实际超长"，
// 所以这里按最长的那条卡。
const diskMetricBaseForCheck = "disk.inode_used_pct"

// diskstats 数字字段的下标（相对设备名之后的下一个字段）。
//
// 位置语义来自内核 Documentation/admin-guide/iostats.rst：
//
//	0 reads_completed  1 reads_merged  2 sectors_read   3 ms_reading
//	4 writes_completed 5 writes_merged 6 sectors_written 7 ms_writing
//	8 ios_in_flight    9 ms_io        10 weighted_ms_io
//	11+ discard/flush（4.18+ / 5.5+ 追加）
const (
	ioReadCompleted  = 0
	ioSectorsRead    = 2
	ioMsReading      = 3
	ioWriteCompleted = 4
	ioSectorsWritten = 6
	ioMsWriting      = 7
	ioMsIO           = 9
)

// ioFieldsMin 至少要有这么多数字字段才认为"列语义可用"。
//
// ⚠️ 需要读到 ms_writing（下标 7）才算完整：更短的行（2.6 之前的老格式、或被裁剪过的输出）
// 里第 4 列的含义与现在**不一样**，硬套现在的位置会把「写完成次数」读成「读取耗时」。
// 少一个 IO 数据点只是图表缺个点，读错列则是画出一条错误的曲线 —— 后者严重得多。
const ioFieldsMin = ioMsWriting + 1

// sectorBytes 扇区大小固定 512 字节。
//
// ⚠️ 这是 /proc/diskstats 的**定义**（内核用 512B 扇区计数，与设备物理扇区无关），
// 不要改成设备的 logical/physical block size。
const sectorBytes = 512

// diskMount 一个候选挂载点。
type diskMount struct {
	mount  string
	device string // 已归一成 diskstats 里的短名（/dev/nvme0n1p2 → nvme0n1p2）
	fsType string

	// major/minor 来自 mountinfo 的第 3 列，用于按设备号兜底匹配 diskstats：
	// LVM 的挂载源是 /dev/mapper/vg-lv，而 diskstats 里的名字是 dm-0，按名字永远匹配不上。
	major    uint64
	minor    uint64
	hasDevNo bool
}

// diskIOStat 一次 diskstats 采样（只保留数字字段，按位置）。
type diskIOStat struct {
	name     string
	major    uint64
	minor    uint64
	hasDevNo bool
	nums     []float64 // 设备名之后的数字字段；长度随内核版本变化
}

// num 取第 i 个数字字段；缺失或该行过短时 ok=false。
func (s diskIOStat) num(i int) (float64, bool) {
	if i < 0 || i >= len(s.nums) {
		return 0, false
	}
	return s.nums[i], true
}

// usable 该行的列语义是否可用（见 ioFieldsMin 的说明）。
func (s diskIOStat) usable() bool { return len(s.nums) >= ioFieldsMin }

// diskIODelta 一个设备本周期的 IO 结果（nil 字段 = 本周期给不出）。
type diskIODelta struct {
	readBps   *float64
	writeBps  *float64
	readIOPS  *float64
	writeIOPS *float64
	latencyMS *float64
}

// diskIODevice 一个设备的 IO 差分器（保存上一次样本）。
type diskIODevice struct {
	readCompleted  rateTracker
	sectorsRead    rateTracker
	writeCompleted rateTracker
	sectorsWritten rateTracker
	msReading      rateTracker
	msWriting      rateTracker
	msIO           rateTracker
}

// update 用本次采样推进所有差分器并算出结果。
func (d *diskIODevice) update(cur diskIOStat, at time.Time) diskIODelta {
	var out diskIODelta

	// --- 吞吐与 IOPS --------------------------------------------------------
	if v, ok := d.sectorsRead.rate(numOr(cur, ioSectorsRead), at); ok {
		out.readBps = f64(v * sectorBytes)
	}
	if v, ok := d.sectorsWritten.rate(numOr(cur, ioSectorsWritten), at); ok {
		out.writeBps = f64(v * sectorBytes)
	}
	if v, ok := d.readCompleted.rate(numOr(cur, ioReadCompleted), at); ok {
		out.readIOPS = f64(v)
	}
	if v, ok := d.writeCompleted.rate(numOr(cur, ioWriteCompleted), at); ok {
		out.writeIOPS = f64(v)
	}

	// --- 平均延迟 = ΔIO 耗时 / Δ完成次数 -----------------------------------
	dMsR, okMsR := d.msReading.delta(numOr(cur, ioMsReading), at)
	dMsW, okMsW := d.msWriting.delta(numOr(cur, ioMsWriting), at)
	ioMillis, hasMillis := 0.0, false
	switch {
	case okMsR && okMsW:
		ioMillis, hasMillis = dMsR+dMsW, true
	case okMsR:
		ioMillis, hasMillis = dMsR, true
	case okMsW:
		ioMillis, hasMillis = dMsW, true
	}
	if hasMillis && ioMillis <= 0 {
		// ⚠️ 有些驱动（旧 md/dm、部分虚拟/loop 设备）**只维护 ms_io**（下标 9），
		//    ms_reading/ms_writing 恒为 0。此时若不用 ms_io 兜底，延迟会永远显示 0 ——
		//    一条"延迟恒为 0"的曲线比没有曲线更误导（看起来像存储性能无限好）。
		if v, ok := d.msIO.delta(numOr(cur, ioMsIO), at); ok && v > 0 {
			ioMillis, hasMillis = v, true
		}
	}
	dRC, okRC := d.readCompleted.delta(numOr(cur, ioReadCompleted), at)
	dWC, okWC := d.writeCompleted.delta(numOr(cur, ioWriteCompleted), at)
	if hasMillis && okRC && okWC {
		// 分子是"总耗时"（读+写），分母也必须是**总完成次数**，两者口径要一致。
		if lat, ok := ratioDelta(ioMillis, dRC+dWC); ok {
			out.latencyMS = f64(lat)
		}
	}
	return out
}

// numOr 取字段值，缺失时给 0 —— ⚠️ 只用于"喂差分器"：
// 字段缺失时差分器算出的是无意义的 0，而 0 速率会被当成有效值上报。
// 所以下面所有 rate/delta 调用点都先经过 usable() 判断整行是否可用，
// 缺失字段只可能出现在"该设备本来就没有这项计数"的场景。
func numOr(s diskIOStat, i int) float64 {
	v, _ := s.num(i)
	return v
}

// diskCollector 磁盘采集器。
type diskCollector struct {
	cfg    *config.Config
	root   string
	statfs StatFSSource
	now    clock
	log    *slog.Logger

	// io 按设备名索引；devIO 按设备号索引，指向**同一个**差分器（两种匹配方式共享进度，
	// 否则同一块盘按名字和按设备号各差分一次，第二条序列的速率会恒为 0）。
	io    map[string]*diskIODevice
	devIO map[[2]uint64]*diskIODevice

	// statfsWarned 每个挂载点只 WARN 一次（网络盘挂住时每周期刷日志会把 journald 写满）。
	// 该挂载点一旦 statfs 成功就把标记清掉，这样"恢复后又坏"还能再提醒一次。
	statfsWarned map[string]bool

	warnMounts    warnOnce
	warnDiskstats warnOnce
	warnName      warnOnce
	warnDup       warnOnce
	warnTooMany   warnOnce

	capProbed bool
	capIO     bool
	capInode  bool
}

// newDiskCollector 构造磁盘采集器（签名由 platform_linux.go 钉死）。
func newDiskCollector(cfg *config.Config, root string, statfs StatFSSource) Collector {
	return &diskCollector{
		cfg:          cfg,
		root:         root,
		statfs:       statfs,
		now:          time.Now,
		log:          slog.Default(),
		io:           map[string]*diskIODevice{},
		devIO:        map[[2]uint64]*diskIODevice{},
		statfsWarned: map[string]bool{},
	}
}

func (c *diskCollector) Name() string { return "disk" }

func (c *diskCollector) Interval() time.Duration { return c.cfg.Collect.Disk.Interval.Std() }

// Capabilities 声明磁盘能力。
//
// ⚠️ 这个接口在**第一次 Collect 之前**就会被调用（首报要带 host.capabilities），
// 所以这里做一次惰性探测；此后以真实采集结果为准（更可信）。
func (c *diskCollector) Capabilities() map[string]bool {
	c.probeCapabilities()
	return map[string]bool{
		"disk.io":    c.capIO,
		"disk.inode": c.capInode,
	}
}

// probeCapabilities 惰性探测：能不能读 diskstats、第一个可用挂载点的 statfs 给不给 inode。
func (c *diskCollector) probeCapabilities() {
	if c.capProbed {
		return
	}
	c.capProbed = true

	if _, err := readFileTrimmed(c.root, "diskstats"); err == nil {
		c.capIO = true
	}
	mounts, err := c.readMounts()
	if err != nil {
		return
	}
	for _, m := range mounts {
		if !c.cfg.Filters.Disk.MountAllowed(m.mount, m.fsType) {
			continue
		}
		if st, err := c.statfs(m.mount); err == nil && st.TotalInode > 0 {
			c.capInode = true
		}
		return // 只看第一个可用挂载点就够了：能力是"这台机器行不行"，不是"每个挂载点都行"
	}
}

// Collect 采集一次。⛔ produced=false 时保持 s.Metrics.Disk 原样。
func (c *diskCollector) Collect(_ context.Context, s *Snapshot) (bool, error) {
	mounts, err := c.readMounts()
	if err != nil {
		c.warnMounts.warn(c.log, "读不到挂载表（self/mountinfo 与 mounts 都失败），本轮跳过磁盘采集",
			"root", c.root, "err", err)
		return false, nil
	}

	stats, devNoIndex, hasDiskstats := c.readDiskStats()

	at := c.now()
	rows := make([]model.Disk, 0, len(mounts))
	seen := make(map[string]bool, len(mounts))
	deltas := make(map[string]diskIODelta, len(stats))

	sawInode := false
	for _, m := range mounts {
		if !c.cfg.Filters.Disk.MountAllowed(m.mount, m.fsType) {
			continue
		}
		device := m.device
		if device != "" && len(device) > model.MaxDeviceLen {
			// 设备名是可选维度（中心用 `disk.device ? {device,mount} : {mount}`）：
			// 超长会让整批 400，所以宁可不带这个维度也要保住该挂载点的容量曲线。
			c.warnName.warn(c.log, "设备名超长，已去掉 device 维度",
				"mount", m.mount, "device_len", len(device), "limit", model.MaxDeviceLen)
			device = ""
		}
		if len(m.mount) > model.MaxMountLen {
			c.warnName.warn(c.log, "挂载点超长，已跳过该挂载点",
				"mount_len", len(m.mount), "limit", model.MaxMountLen)
			continue
		}
		// ⛔ 预检指标全名：超长会在中心变成整批 400（连 CPU/内存一起丢）。
		if err := checkDiskMetricName(device, m.mount); err != nil {
			c.warnName.warn(c.log, "挂载点的指标全名会超长，已跳过（否则中心整批 400）",
				"mount", m.mount, "device", device, "err", err)
			continue
		}
		key := device + "\x00" + m.mount
		if seen[key] {
			c.warnDup.warn(c.log, "挂载表里有重复的 (device,mount)，已跳过后续条目（中心拒绝批内重复序列）",
				"mount", m.mount, "device", device)
			continue
		}

		st, err := c.statfs(m.mount)
		if err != nil {
			if !c.statfsWarned[m.mount] {
				c.statfsWarned[m.mount] = true
				c.log.Warn("statfs 失败，跳过该挂载点（网络盘挂住/权限不足都会这样）",
					"mount", m.mount, "err", err)
			}
			continue
		}
		delete(c.statfsWarned, m.mount)
		seen[key] = true

		row := model.Disk{
			Mount:  m.mount,
			Device: device,
			Total:  f64(float64(st.TotalBytes)),
			// ✅ Used = Total − FreeBytes（含 root 保留块，贴近 df 的语义）。
			Used: f64(nonNeg(float64(st.TotalBytes) - float64(st.FreeBytes))),
		}
		if st.TotalInode > 0 {
			sawInode = true
			row.InodeUsed = f64(clampPct(float64(st.TotalInode-st.FreeInode) / float64(st.TotalInode) * 100))
		}
		// TotalInode == 0（btrfs 就是这么报的）→ InodeUsed 留 nil：
		// 0/0 会得到 NaN，中心拒绝非有限数字，代价是整批 400。

		if hasDiskstats {
			if d, ok := c.ioDeltaFor(m, stats, devNoIndex, deltas, at); ok {
				row.ReadBps, row.WriteBps = d.readBps, d.writeBps
				row.ReadIOPS, row.WriteIOPS = d.readIOPS, d.writeIOPS
				row.LatencyMS = d.latencyMS
			}
		}
		rows = append(rows, row)
	}

	if !hasDiskstats {
		c.warnDiskstats.warn(c.log, "读不到 /proc/diskstats，本轮磁盘只有容量指标（无 IO/延迟）",
			"path", procPath(c.root, "diskstats"))
	}

	// 能力随真实采集结果更新（比惰性探测更可信）。
	c.capIO = hasDiskstats
	c.capInode = sawInode
	c.capProbed = true

	if len(rows) == 0 {
		// 全被过滤 / 全 statfs 失败：本轮没有新数据。⛔ 不写空数组冒充"这台机器没有磁盘"。
		return false, nil
	}
	if len(rows) > model.MaxDisks {
		c.warnTooMany.warn(c.log, "挂载点数量超过中心上限，已截断",
			"rows", len(rows), "limit", model.MaxDisks)
		rows = rows[:model.MaxDisks]
	}

	s.Metrics.Disk = rows
	return true, nil
}

// ioDeltaFor 取得某挂载点对应设备的本次 IO 结果。
//
// ⚠️ 差分**每设备每周期只做一次**（deltas 记忆化）：同一块盘可能挂载多次
//（bind mount、同一 fs 挂两个点），第二次递减会得到 Δ=0，
// 于是同一块盘在两条序列上一条正常、一条恒为 0 —— 面板上极难看出是采集侧的问题。
func (c *diskCollector) ioDeltaFor(
	m diskMount, stats map[string]diskIOStat, devNoIndex map[[2]uint64]diskIOStat,
	deltas map[string]diskIODelta, at time.Time,
) (diskIODelta, bool) {
	key, cur, ok := matchDiskStats(m, stats, devNoIndex)
	if !ok || !cur.usable() {
		return diskIODelta{}, false
	}
	if d, done := deltas[key]; done {
		return d, true
	}
	dev := c.ioDevice(key, cur)
	d := dev.update(cur, at)
	deltas[key] = d
	return d, true
}

// ioDevice 取（或建）某设备的差分器；按设备号匹配时复用按名字建的那个实例。
func (c *diskCollector) ioDevice(key string, cur diskIOStat) *diskIODevice {
	if dev, ok := c.io[key]; ok {
		return dev
	}
	dev := &diskIODevice{}
	c.io[key] = dev
	if cur.hasDevNo {
		c.devIO[[2]uint64{cur.major, cur.minor}] = dev
	}
	return dev
}

// matchDiskStats 把挂载点对应到 diskstats 里的一行。
//
// 匹配顺序：① 设备短名（/dev/nvme0n1p2 → nvme0n1p2）；
//
//	② mountinfo 里的 major:minor ↔ diskstats 的 (major,minor)。
//
// ② 不是锦上添花：LVM/RAID/device-mapper 的挂载源是 /dev/mapper/vg-lv，
// 而 diskstats 里的名字是 dm-0，只按名字匹配会让这些机器**永远没有磁盘 IO 数据**，
// 而面板上只表现为"IO 曲线是空的"，看不出是采集匹配的问题。
func matchDiskStats(m diskMount, stats map[string]diskIOStat, devNoIndex map[[2]uint64]diskIOStat) (string, diskIOStat, bool) {
	if m.device != "" {
		if s, ok := stats[m.device]; ok {
			return m.device, s, true
		}
	}
	if m.hasDevNo {
		if s, ok := devNoIndex[[2]uint64{m.major, m.minor}]; ok {
			return s.name, s, true
		}
	}
	return "", diskIOStat{}, false
}

// readMounts 读挂载表：优先 self/mountinfo（带设备号），退化到 mounts（老内核无 mountinfo）。
func (c *diskCollector) readMounts() ([]diskMount, error) {
	infoErr := error(nil)
	if content, err := readFileTrimmed(c.root, "self/mountinfo"); err == nil {
		if mounts := parseMountInfo(content); len(mounts) > 0 {
			return mounts, nil
		}
	} else {
		infoErr = err
	}

	content, err := readFileTrimmed(c.root, "mounts")
	if err != nil {
		if infoErr != nil {
			// 两条路径都失败：把 mountinfo 的错误一起带上（它才是"正常该有"的那份）。
			return nil, fmt.Errorf("self/mountinfo: %w; mounts: %w", infoErr, err)
		}
		return nil, err
	}
	return parseMountsFile(content), nil
}

// parseMountInfo 解析 `{root}/self/mountinfo`。
//
// 格式（proc(5)）：`mountID parentID major:minor root mountpoint options [optional…] - fstype source superopts`
//
// ⚠️ 用"找到独立的 `-` 字段"来切分，而不是 strings.Split(line, " - ")：
// 可选字段的**值**里可以含空格（如 `master:1`、带空格的 SELinux 上下文），
// 而 ` - ` 前后到底几个空格在不同内核/不同挂载选项下并不完全一致。
func parseMountInfo(content string) []diskMount {
	var out []diskMount
	for _, line := range splitLines(content) {
		fields := strings.Fields(line)
		sep := -1
		for i, f := range fields {
			if f == "-" {
				sep = i
				break
			}
		}
		// 左侧至少 6 个字段（含挂载点），右侧至少 2 个（fstype + source）。
		if sep < 5 || sep+2 >= len(fields) {
			continue
		}

		mount := unescapeMountField(fields[4])
		m := diskMount{
			mount:  mount,
			fsType: fields[sep+1],
			device: shortDeviceName(fields[sep+2]),
		}
		if maj, min, ok := parseDevNo(fields[2]); ok {
			m.major, m.minor, m.hasDevNo = maj, min, true
		}
		if m.mount == "" {
			continue
		}
		out = append(out, m)
	}
	return out
}

// parseMountsFile 解析 `{root}/mounts`（退化路径）。
//
// 格式：`source mountpoint fstype options dump pass`。⚠️ 没有设备号，
// 所以 LVM 这类设备在这条路径上按名字匹配不上，只能放弃 IO（有 mountinfo 时不会走到这里）。
func parseMountsFile(content string) []diskMount {
	var out []diskMount
	for _, line := range splitLines(content) {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		mount := unescapeMountField(fields[1])
		if mount == "" {
			continue
		}
		out = append(out, diskMount{
			mount:  mount,
			device: shortDeviceName(fields[0]),
			fsType: fields[2],
		})
	}
	return out
}

// parseDevNo 解析 `8:1` 形式的设备号。
func parseDevNo(s string) (uint64, uint64, bool) {
	i := strings.IndexByte(s, ':')
	if i <= 0 || i == len(s)-1 {
		return 0, 0, false
	}
	maj, ok := parseUintString(s[:i])
	if !ok {
		return 0, 0, false
	}
	min, ok := parseUintString(s[i+1:])
	if !ok {
		return 0, 0, false
	}
	return maj, min, true
}

// unescapeMountField 还原 mountinfo/mounts 里的八进制转义（空格 `\040`、制表 `\011`、
// 换行 `\012`、反斜杠 `\134`）。
//
// ⚠️ 必须还原：把 `\040` 原样交给 statfs 会得到一个"不存在"的路径 → 该挂载点永远采不到容量。
// 而这类挂载点（名字里带空格）恰恰常见于数据盘（`/data disk`），排查时看起来像"权限问题"。
func unescapeMountField(s string) string {
	if !strings.ContainsRune(s, '\\') {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+3 >= len(s) {
			b.WriteByte(s[i])
			continue
		}
		v := 0
		ok := true
		for j := 1; j <= 3; j++ {
			ch := s[i+j]
			if ch < '0' || ch > '7' {
				ok = false
				break
			}
			v = v*8 + int(ch-'0')
		}
		if !ok || v == 0 || v > 0xFF {
			b.WriteByte(s[i])
			continue
		}
		b.WriteByte(byte(v))
		i += 3
	}
	return b.String()
}

// shortDeviceName 把挂载源归一成 diskstats 里的设备短名。
//
//	/dev/nvme0n1p2      → nvme0n1p2
//	/dev/mapper/vg-lv   → vg-lv      （diskstats 里其实叫 dm-0，靠设备号兜底匹配）
//	/dev/disk/by-uuid/x → x
//	server:/export      → 原样保留（网络文件系统没有块设备；⛔ 不用 mount 冒充 device）
func shortDeviceName(source string) string {
	if source == "" || source == "none" {
		return ""
	}
	name := source
	if strings.HasPrefix(name, "/dev/") {
		name = strings.TrimPrefix(name, "/dev/")
		name = strings.TrimPrefix(name, "mapper/")
		if i := strings.LastIndexByte(name, '/'); i >= 0 {
			name = name[i+1:]
		}
	}
	return name
}

// readDiskStats 读 `{root}/diskstats`，返回按设备名的索引、按设备号的索引，以及是否读到。
func (c *diskCollector) readDiskStats() (map[string]diskIOStat, map[[2]uint64]diskIOStat, bool) {
	content, err := readFileTrimmed(c.root, "diskstats")
	if err != nil {
		return nil, nil, false
	}
	byName := map[string]diskIOStat{}
	byDevNo := map[[2]uint64]diskIOStat{}
	for _, s := range parseDiskStats(content) {
		byName[s.name] = s
		if s.hasDevNo {
			byDevNo[[2]uint64{s.major, s.minor}] = s
		}
	}
	return byName, byDevNo, len(byName) > 0
}

// parseDiskStats 解析 `{root}/diskstats`。
//
// 每行：`major minor name 数字字段…`。⛔ 只按位置取需要的列并逐个判存在，
// **不校验总列数**：11 列（2.6+）、14 列（4.18+ 带 discard）、17/18/20 列（5.5+ 带 flush）
// 都必须能解析，且同一份数据在不同内核上算出的速率必须完全一致。
func parseDiskStats(content string) []diskIOStat {
	var out []diskIOStat
	for _, line := range splitLines(content) {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		major, okMaj := atoiField(fields, 0)
		minor, okMin := atoiField(fields, 1)
		name := fields[2]
		if name == "" {
			continue
		}
		s := diskIOStat{name: name}
		if okMaj && okMin {
			s.major, s.minor, s.hasDevNo = major, minor, true
		}
		for _, f := range fields[3:] {
			v, ok := parseFloatStrict(f)
			if !ok {
				break // 数字段尾部出现非数字：后面不再当计数读（不猜）
			}
			s.nums = append(s.nums, v)
		}
		out = append(out, s)
	}
	return out
}

// checkDiskMetricName 预检该挂载点派生出的指标全名是否会超长/非法。
func checkDiskMetricName(device, mount string) error {
	// ⚠️ 维度组合必须与中心 metrics.service.js 的规则一致：
	// 中心是 `disk.device ? {device, mount} : {mount}`，所以 device 为空时**不能**带上这个键。
	labels := map[string]string{"mount": mount}
	if device != "" {
		labels["device"] = device
	}
	_, err := metric.Build(diskMetricBaseForCheck, labels)
	return err
}
