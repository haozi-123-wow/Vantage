// disk_test.go —— 磁盘采集器：mountinfo 解析（转义/LVM/重复挂载）、diskstats 多列宽、
// 双采样 IO（注入时钟 + 注入 statfs）、过滤规则、降级。
package collector

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"vantage-agent/internal/model"
)

// statfs 夹具：按挂载点登记容量与 inode。docker overlay 故意**不登记**（模拟 statfs 挂住）。
func diskStatfsStub() StatFSSource {
	return statfsStub(map[string]StatFSResult{
		"/":               {TotalBytes: 100 << 30, FreeBytes: 40 << 30, AvailBytes: 36 << 30, TotalInode: 10_000_000, FreeInode: 2_500_000},
		"/data":           {TotalBytes: 200 << 30, FreeBytes: 50 << 30, AvailBytes: 45 << 30, TotalInode: 5_000_000, FreeInode: 4_000_000},
		"/run":            {TotalBytes: 1 << 30, FreeBytes: 1 << 30, AvailBytes: 1 << 30, TotalInode: 0, FreeInode: 0}, // btrfs 式：inode 恒 0
		"/srv/vgdata":     {TotalBytes: 50 << 30, FreeBytes: 10 << 30, AvailBytes: 9 << 30, TotalInode: 1_000_000, FreeInode: 900_000},
		"/srv/bind":       {TotalBytes: 100 << 30, FreeBytes: 40 << 30, AvailBytes: 36 << 30, TotalInode: 10_000_000, FreeInode: 2_500_000},
		"/mnt/with space": {TotalBytes: 20 << 30, FreeBytes: 5 << 30, AvailBytes: 4 << 30, TotalInode: 100_000, FreeInode: 90_000},
		"/mnt/legacy":     {TotalBytes: 30 << 30, FreeBytes: 15 << 30, AvailBytes: 14 << 30, TotalInode: 2_000_000, FreeInode: 1_500_000},
	})
}

// 第二个 /proc/diskstats 采样：sda1/dm-0/nvme0n1p2/sdd1 计数前进；sdc1 保持 6 列（不可用）。
const diskstatsSecondSample = `   8       1 sda1 160 0 8000 110 260 0 16000 220 0 330 200
 259       2 nvme0n1p2 40 0 6100 30 60 0 12200 50 0 80 30 0 0 0 0 7 0 3 12 5
 253       0 dm-0 560 0 14000 180 760 0 18000 380 0 560 500
   8      49 sdd1 50 0 1400 38 30 0 1100 35 0 73 20
   8      33 sdc1 100 2000 50 400 500 6000
   7       0 loop0 1 0 2 0 1 0 2 0 0 0 0
`

// 全链路：mountinfo 解析 + 容量 + 双采样 IO + 延迟 + 去重 + 转义 + 设备号匹配。
func TestDiskTwoSampleCapacityAndIO(t *testing.T) {
	root := copyFixtures(t)
	cfg := testConfig()
	c := newDiskCollector(cfg, root, diskStatfsStub()).(*diskCollector)
	clk := newFakeClock()
	c.now = clk.now
	ctx := context.Background()

	var s Snapshot
	produced, err := c.Collect(ctx, &s) // 首轮：容量 + IO nil（无上一份样本）
	if err != nil || !produced {
		t.Fatalf("首轮应产出容量（got %v, err=%v）", produced, err)
	}
	first := diskByMount(s.Metrics.Disk)
	if len(s.Metrics.Disk) != 7 {
		t.Fatalf("应有 7 个挂载点（/data 重复去重、docker statfs 失败跳过），got %d：%v",
			len(s.Metrics.Disk), diskMounts(s.Metrics.Disk))
	}
	// Used = Total − FreeBytes（含 root 保留块，贴近 df），不是 Total − Avail。
	if *first["/"].Used != (100<<30)-(40<<30) {
		t.Fatalf("/ used = %v", *first["/"].Used)
	}
	// inode 百分比：(10M−2.5M)/10M×100 = 75。
	if *first["/"].InodeUsed != 75 {
		t.Fatalf("/ inode_used_pct = %v，期望 75", *first["/"].InodeUsed)
	}
	// btrfs 式 TotalInode=0 → 留 nil（0/0 是 NaN，中心拒绝非有限数字）。
	if first["/run"].InodeUsed != nil {
		t.Fatalf("/run inode_used_pct 应为 nil，got %v", *first["/run"].InodeUsed)
	}
	// mountinfo 的 \040 转义必须还原，否则 statfs 永远打不到这个挂载点。
	if _, ok := first["/mnt/with space"]; !ok {
		t.Fatalf(`"/mnt/with\040space" 应还原为 "/mnt/with space" 并采到容量：%v`, diskMounts(s.Metrics.Disk))
	}
	// 6 列的 sdc1（老内核/被裁剪输出）：容量照常，IO 留 nil。
	if first["/mnt/legacy"].ReadBps != nil {
		t.Fatalf("6 列 diskstats 不得产出 IO（列语义不可用），got %v", *first["/mnt/legacy"].ReadBps)
	}

	// 第二轮：计数前进 + 时钟前进 30s。
	overwrite(t, root, "diskstats", diskstatsSecondSample)
	clk.advance(30 * time.Second)
	s = Snapshot{}
	produced, err = c.Collect(ctx, &s)
	if err != nil || !produced {
		t.Fatalf("第二轮应产出（got %v, err=%v）", produced, err)
	}
	second := diskByMount(s.Metrics.Disk)
	sd := second["/"]
	// read_bps = Δsectors×512 ÷ 真实 30s = 6000×512/30 = 102400（分母若拿配置周期 60s 会小一半）。
	if sd.ReadBps == nil || *sd.ReadBps != 102400 {
		t.Fatalf("/ read_bps = %v，期望 102400", sd.ReadBps)
	}
	if sd.WriteBps == nil || *sd.WriteBps != 204800 {
		t.Fatalf("/ write_bps = %v，期望 204800（Δ12000×512÷30）", sd.WriteBps)
	}
	if sd.ReadIOPS == nil || *sd.ReadIOPS != 2 || sd.WriteIOPS == nil || *sd.WriteIOPS != 2 {
		t.Fatalf("/ iops = %v / %v，期望 2 / 2", sd.ReadIOPS, sd.WriteIOPS)
	}
	// 平均延迟 = Δ(msR+msW) ÷ Δ完成次数 = (60+120)/(60+60) = 1.5ms。
	if sd.LatencyMS == nil || !almostEqual(*sd.LatencyMS, 1.5) {
		t.Fatalf("/ latency_ms = %v，期望 1.5", sd.LatencyMS)
	}
	// 同一设备挂载多次（/ 与 /srv/bind 都是 sda1）：IO 差分每设备每周期只算一次，
	// 两条序列必须拿到**同一份**结果（第二次递减会是恒 0）。
	if b := second["/srv/bind"].ReadBps; b == nil || *b != 102400 {
		t.Fatalf("/srv/bind read_bps = %v，期望与 / 相同的 102400", b)
	}
	// LVM：mountinfo 源是 /dev/mapper/vg-data，diskstats 里叫 dm-0 —— 靠设备号 253:0 匹配。
	vg := second["/srv/vgdata"]
	if vg.ReadBps == nil || *vg.ReadBps != 102400 {
		t.Fatalf("/srv/vgdata read_bps = %v，期望经设备号匹配 dm-0 得 102400", vg.ReadBps)
	}
	if vg.Device != "vg-data" {
		t.Fatalf("/srv/vgdata device = %q（短名），期望 vg-data", vg.Device)
	}
	// /data 的 nvme0n1p2 计数前进 Δ30 次读 → 1 IOPS。
	if d := second["/data"]; d.ReadIOPS == nil || *d.ReadIOPS != 1 {
		t.Fatalf("/data read_iops = %v，期望 1", d.ReadIOPS)
	}
}

func diskByMount(rows []model.Disk) map[string]model.Disk {
	out := map[string]model.Disk{}
	for _, d := range rows {
		out[d.Mount] = d
	}
	return out
}

func diskMounts(rows []model.Disk) []string {
	out := make([]string, 0, len(rows))
	for _, d := range rows {
		out = append(out, d.Mount)
	}
	return out
}

// 过滤：exclude_fs 命中 tmpfs；include_mounts 白名单优先。
func TestDiskFilters(t *testing.T) {
	root := copyFixtures(t)
	clk := newFakeClock()

	cfg := testConfig()
	cfg.Filters.Disk.ExcludeFS = []string{"tmpfs"}
	c := newDiskCollector(cfg, root, diskStatfsStub()).(*diskCollector)
	c.now = clk.now
	var s Snapshot
	produced, _ := c.Collect(context.Background(), &s)
	if !produced {
		t.Fatal("应产出")
	}
	for _, d := range s.Metrics.Disk {
		if d.Mount == "/run" {
			t.Fatal("/run（tmpfs）应被 exclude_fs 过滤")
		}
	}

	cfg2 := testConfig()
	cfg2.Filters.Disk.IncludeMounts = []string{"/data"}
	c2 := newDiskCollector(cfg2, root, diskStatfsStub()).(*diskCollector)
	c2.now = clk.now
	var s2 Snapshot
	produced, _ = c2.Collect(context.Background(), &s2)
	if !produced || len(s2.Metrics.Disk) != 1 || s2.Metrics.Disk[0].Mount != "/data" {
		t.Fatalf("include_mounts 白名单应只留 /data，got %v", diskMounts(s2.Metrics.Disk))
	}
}

// 降级：mountinfo 与 mounts 都读不到 → produced=false。
func TestDiskMissingMountTablesDegrades(t *testing.T) {
	root := copyFixtures(t)
	removeFixture(t, root, "self/mountinfo")
	c := newDiskCollector(testConfig(), root, diskStatfsStub()).(*diskCollector)
	clk := newFakeClock()
	c.now = clk.now
	var s Snapshot
	produced, err := c.Collect(context.Background(), &s)
	if err != nil || produced {
		t.Fatalf("无挂载表应 produced=false（got %v, err=%v）", produced, err)
	}
}

// parseMountInfo / shortDeviceName / unescape 的关键行为。
func TestParseMountInfoDetails(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("testdata", "proc", "self", "mountinfo"))
	if err != nil {
		t.Fatalf("读 mountinfo 夹具失败：%v", err)
	}
	mounts := parseMountInfo(string(b))
	byMount := map[string]diskMount{}
	for _, m := range mounts {
		byMount[m.mount] = m
	}
	if _, ok := byMount["/mnt/with space"]; !ok {
		t.Fatalf(`\040 应还原为空格：得到 %v`, diskMountNames(mounts))
	}
	if m := byMount["/srv/vgdata"]; m.device != "vg-data" || !m.hasDevNo || m.major != 253 || m.minor != 0 {
		t.Fatalf("mapper 源应取短名并带设备号：%+v", m)
	}
	if m := byMount["/run"]; m.fsType != "tmpfs" {
		t.Fatalf("fstype 解析错误：%+v", m)
	}
	// 短名归一：/dev/nvme0n1p2 → nvme0n1p2；mapper/ 前缀剥掉。
	if m := byMount["/data"]; m.device != "nvme0n1p2" {
		t.Fatalf("/data device = %q，期望 nvme0n1p2", m.device)
	}
}

func diskMountNames(ms []diskMount) []string {
	out := make([]string, 0, len(ms))
	for _, m := range ms {
		out = append(out, m.mount)
	}
	return out
}
