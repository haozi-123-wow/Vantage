<script setup lang="ts">
/**
 * 主机列表（docs/frontend.md §4.3，需登录）。
 *
 * 硬约束：
 * - 顶栏计数**必须**来自 `GET /api/v1/summary`（⛔ 不要数列表条数：`limit` 一截断就是错的）；
 * - 列含当前 IP / 漂移角标 / Flapping 角标 / 活动告警数；「当前值」随 `/ws/live` 增量更新；
 * - 行内操作**只有进入详情**，⛔ 不存在重启/改配置/下发类操作（设计 §2.1）；
 * - `next_cursor` 本期恒为 `null`（状态类接口没有 keyset 的自然键，docs/api.md §1.2 ③）——
 *   按"有值才翻页"处理，⛔ 不自己造页码。
 */
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { AppError } from '@/api/http'
import { hostsApi, type HostListItem } from '@/api/private'
import AsyncState from '@/components/AsyncState.vue'
import HostTable from '@/components/HostTable.vue'
import SummaryBar from '@/components/SummaryBar.vue'
import { errorText } from '@/i18n'
import { useRealtimeStore } from '@/store/realtime'
import type { PanelSummary, RealtimeHost } from '@/types/domain'

const { t } = useI18n()
const router = useRouter()
const realtime = useRealtimeStore()

/** 轮询兜底间隔；WS 正常时"当前值"列由增量即时更新 */
const POLL_MS = 15_000
/** 状态类列表没有真游标，一次取满（服务端上限 200，超出会夹取并告警） */
const LIMIT = 200

const filters = reactive<{ status: '' | 'online' | 'offline' | 'disabled'; tag: string; q: string }>({
  status: '',
  tag: '',
  q: '',
})

const items = ref<HostListItem[]>([])
const summary = ref<PanelSummary | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

let timer: number | undefined

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const [list, nextSummary] = await Promise.all([
      hostsApi.list({
        status: filters.status === '' ? undefined : filters.status,
        // ⛔ 空串按"未提供"处理（服务端同样如此），这里顺手省掉无意义的参数
        tag: filters.tag.trim() === '' ? undefined : filters.tag.trim(),
        q: filters.q.trim() === '' ? undefined : filters.q.trim(),
        limit: LIMIT,
      }),
      hostsApi.summary(),
    ])
    items.value = list.items
    summary.value = nextSummary
  } catch (err) {
    error.value = err instanceof AppError ? errorText(err.code, err.message) : errorText(undefined)
  } finally {
    loading.value = false
  }
}

function openDetail(id: string): void {
  void router.push({ name: 'host-detail', params: { id } })
}

function resetFilters(): void {
  filters.status = ''
  filters.tag = ''
  filters.q = ''
  void load()
}

onMounted(() => {
  // 登录后全站单连接：列表页订 `/ws/live`，详情页复用同一条连接、只改订阅
  realtime.connect('live')
  void load()
  timer = window.setInterval(() => void load(), POLL_MS)
})

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
})

/**
 * `/ws/live` 的 `snapshot.hosts[]` 与列表页 items **同形**（docs/api.md §5.2），
 * 故这里按内部 `id` 就地合并"当前值"列；筛选条件不会被 WS 绕过（只更新已在本页的行）。
 */
watch(
  () => realtime.hostList,
  (list) => {
    if (realtime.channel !== 'live' || list.length === 0) return
    const live = new Map<string, HostListItem>()
    for (const entry of list) {
      const id = (entry as RealtimeHost).id
      if (typeof id === 'string') live.set(id, entry as HostListItem)
    }
    if (live.size === 0) return
    items.value = items.value.map((row) => {
      const next = live.get(row.id)
      return next ? { ...row, ...next } : row
    })
  },
)
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('view.hostList.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.hostList.hint') }}</p>

    <SummaryBar :summary="summary" :loading="loading" />

    <div class="host-list__filters">
      <ElSelect v-model="filters.status" class="host-list__status" size="small" @change="load">
        <ElOption :label="t('hostFilter.allStatus')" value="" />
        <ElOption :label="t('status.online')" value="online" />
        <ElOption :label="t('status.offline')" value="offline" />
        <ElOption :label="t('status.disabled')" value="disabled" />
      </ElSelect>

      <ElInput
        v-model="filters.tag"
        class="host-list__tag"
        size="small"
        clearable
        :placeholder="t('hostFilter.tag')"
        @keyup.enter="load"
      />

      <ElInput
        v-model="filters.q"
        class="host-list__q"
        size="small"
        clearable
        :placeholder="t('hostFilter.name')"
        @keyup.enter="load"
      />

      <ElButton size="small" type="primary" :loading="loading" @click="load">{{ t('hostFilter.apply') }}</ElButton>
      <ElButton size="small" @click="resetFilters">{{ t('hostFilter.reset') }}</ElButton>

      <span class="host-list__spacer" />
      <span class="host-list__count vc-num">{{ t('hostFilter.count', { count: items.length }) }}</span>
    </div>

    <AsyncState
      :loading="loading && items.length === 0"
      :error="error"
      :empty="!loading && items.length === 0"
      @retry="load"
    >
      <HostTable :items="items" :loading="loading" @select="openDetail" />
    </AsyncState>

    <p class="host-list__note">{{ t('hostFilter.sortNote') }}</p>
  </section>
</template>

<style scoped>
.host-list__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 14px 0 10px;
}

.host-list__status {
  width: 130px;
}

.host-list__tag {
  width: 150px;
}

.host-list__q {
  width: 200px;
}

.host-list__spacer {
  flex: 1;
}

.host-list__count {
  color: var(--vc-text-2);
  font-size: 12px;
}

.host-list__note {
  margin: 10px 0 0;
  color: var(--vc-text-2);
  font-size: 12px;
}
</style>
