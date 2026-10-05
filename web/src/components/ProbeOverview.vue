<script setup lang="ts">
/**
 * 探活当前概览（公开页，`GET /api/public/probes`）。
 *
 * ⛔ 公开侧只展示服务端**脱敏后**的 `target_host`（域名 / 公网 IP / 哨兵文案「内网地址」/ null），
 *    ⛔ 不回显原始 target、不带路径与端口（docs/api.md §3.2）。
 * ⚠️ 条数被服务端上限截断时 `truncated: true`——必须提示"仅显示前 N 条"，⛔ 不静默丢数据。
 */
import { useI18n } from 'vue-i18n'

import type { PublicProbe } from '@/types/domain'
import { formatLocalWithOffset } from '@/utils/time'
import { formatMs } from '@/utils/units'

defineProps<{
  probes: PublicProbe[]
  truncated?: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <div class="probe-overview">
    <p v-if="truncated" class="probe-overview__truncated">
      {{ t('probe.truncated', { count: probes.length }) }}
    </p>

    <ElTable :data="probes" size="small" class="probe-overview__table">
      <ElTableColumn :label="t('probe.name')" min-width="140">
        <template #default="{ row }">
          <span>{{ row.name }}</span>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('probe.host')" min-width="140">
        <template #default="{ row }">
          <span>{{ row.host_name ?? '—' }}</span>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('probe.target')" min-width="160">
        <template #default="{ row }">
          <!-- ⛔ 只渲染服务端脱敏后的值；解析不出来时是 null → `—` -->
          <span class="vc-num">{{ row.target_host ?? '—' }}</span>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('probe.type')" width="90" prop="type" />

      <ElTableColumn :label="t('probe.result')" width="90">
        <template #default="{ row }">
          <ElTag size="small" disable-transitions :type="row.up ? 'success' : 'danger'">
            {{ row.up ? t('probe.up') : t('probe.down') }}
          </ElTag>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('probe.latency')" width="110">
        <template #default="{ row }">
          <span class="vc-num">{{ formatMs(row.latency_ms) }}</span>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('probe.checkedAt')" min-width="170">
        <template #default="{ row }">
          <span class="vc-num">{{ row.checked_at ? formatLocalWithOffset(row.checked_at, { seconds: true }) : '—' }}</span>
        </template>
      </ElTableColumn>
    </ElTable>
  </div>
</template>

<style scoped>
.probe-overview__table {
  width: 100%;
}

.probe-overview__truncated {
  margin: 0 0 8px;
  color: var(--vc-warn);
  font-size: 12px;
}
</style>
