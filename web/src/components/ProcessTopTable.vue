<script setup lang="ts">
/**
 * 进程 Top 快照（详情页，`GET /api/v1/hosts/{id}/processes`）。
 *
 * ⚠️ 三态必须能区分（docs/api.md §4.2）：
 * - `at` / `total` / `top` **同时为 null** = 该时刻**没有采集到**（从未上报 / 超出 30 天保留期）；
 * - `total: 0, top: []` = 那一刻**确实没有进程**。
 *   ⛔ 两者渲染成同一句"暂无数据"就是把"采集缺失"和"确实为空"混为一谈。
 * ⚠️ `at` 语义是「该时刻**之前**最近的一条」（采样是周期性的，严格相等等于永远查不到）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { HostProcessSnapshot } from '@/api/private'
import { formatLocalWithOffset } from '@/utils/time'
import { formatInt } from '@/utils/format'
import { formatBytes, formatPct } from '@/utils/units'

const props = defineProps<{
  data: HostProcessSnapshot | null
  loading?: boolean
}>()

const { t } = useI18n()

/** 整条快照缺失（三态同时为 null） */
const missing = computed(() => {
  const data = props.data
  return !data || (data.at === null && data.total === null && data.top === null)
})

const rows = computed(() => props.data?.top ?? [])

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '—'
}

function numOf(row: Record<string, unknown>, key: string): number | null {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
</script>

<template>
  <div class="process-top">
    <ElAlert
      v-if="missing && !loading"
      type="info"
      :closable="false"
      :title="t('process.missing')"
      :description="t('process.missingHint')"
    />

    <template v-else-if="data">
      <p class="process-top__meta vc-num">
        {{ t('process.total', { count: data.total === null ? '—' : formatInt(data.total) }) }}
        <span v-if="data.at" class="process-top__sub">
          {{ t('process.sampledAt', { time: formatLocalWithOffset(data.at, { seconds: true }) }) }}
        </span>
      </p>

      <ElEmpty v-if="rows.length === 0" :description="t('process.empty')" :image-size="40" />

      <ElTable v-else :data="rows" size="small" class="process-top__table">
        <ElTableColumn :label="t('process.pid')" width="90">
          <template #default="{ row }">
            <span class="vc-num">{{ str(row, 'pid') }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn :label="t('process.name')" min-width="180">
          <template #default="{ row }">
            <!-- 进程名视为不可信文本：默认插值转义，⛔ 不用 v-html -->
            <span>{{ str(row, 'name') }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn :label="t('process.cpu')" width="110">
          <template #default="{ row }">
            <span class="vc-num">{{ formatPct(numOf(row, 'cpu')) }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn :label="t('process.mem')" width="130">
          <template #default="{ row }">
            <!-- `mem` 在契约里是 bytes（内存占用），按字节格式化 -->
            <span class="vc-num">{{ formatBytes(numOf(row, 'mem')) }}</span>
          </template>
        </ElTableColumn>
      </ElTable>
    </template>

    <ElSkeleton v-else :rows="3" animated />
  </div>
</template>

<style scoped>
.process-top__meta {
  margin: 0 0 8px;
  font-size: 13px;
}

.process-top__sub {
  margin-left: 8px;
  color: var(--vc-text-2);
  font-size: 12px;
}

.process-top__table {
  width: 100%;
}
</style>
