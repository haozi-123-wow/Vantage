<script setup lang="ts">
/**
 * 免登录总览（docs/frontend.md §4.1，M1 交付物）。
 *
 * 硬约束（⛔ 都不是风格问题）：
 * - 只调 `/api/public/*` 与订阅 `/ws/public`；标识一律用 `public_slug`，
 *   主机名只用服务端下发的那一个（显示名优先，缺失回退 `name`，§3.1 D-名）；
 * - ⛔ 不得出现 IP、内网网段、设备真实名（服务端已泛化成「磁盘 1/网卡 1」）、
 *   历史曲线、进程 Top，以及**任何管理入口**；
 * - 点击主机**就地展开当前快照**，⛔ 不设公开详情路由（F2）；
 * - 实时：订阅 `/ws/public`（服务端只推 `status`）；**断线即退化为轮询**并明确提示（§4.1）；
 * - `public_view.enabled=false` 时所有公开接口 404 → 显示「公开视图已关闭，请登录」，
 *   ⛔ 不把它当成"没有主机"（不泄露"存在但被关闭"，docs/api.md §3.2）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { getHostNow, getHosts, getProbes, getSummary, isPublicViewDisabled } from '@/api/public'
import { AppError } from '@/api/http'
import AsyncState from '@/components/AsyncState.vue'
import HostCard from '@/components/HostCard.vue'
import ProbeOverview from '@/components/ProbeOverview.vue'
import SummaryBar from '@/components/SummaryBar.vue'
import { errorText } from '@/i18n'
import { useRealtimeStore } from '@/store/realtime'
import type { PublicHost, PublicHostNow, PublicProbe, PublicSummary } from '@/types/domain'

const { t } = useI18n()
const realtime = useRealtimeStore()

/** 退化轮询间隔（docs/frontend.md §4.1 建议 15–30s） */
const POLL_MS = 20_000

const summary = ref<PublicSummary | null>(null)
const hosts = ref<PublicHost[]>([])
const probes = ref<PublicProbe[]>([])
const probesTruncated = ref(false)

const loading = ref(false)
const error = ref<string | null>(null)
/** 公开视图整体被关闭（`/api/public/*` 一律 404） */
const viewDisabled = ref(false)

/** 就地展开：同一时刻只展开一台（公开页是"看一眼状态"，不是多标签对比） */
const expandedSlug = ref<string | null>(null)
const details = ref<Record<string, PublicHostNow | null>>({})
const detailLoading = ref(false)

let timer: number | undefined

function toErrorText(err: unknown): string {
  if (err instanceof AppError) return errorText(err.code, err.message)
  return errorText(undefined, err instanceof Error ? err.message : undefined)
}

async function loadAll(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const [nextSummary, nextHosts, nextProbes] = await Promise.all([getSummary(), getHosts(), getProbes()])
    summary.value = nextSummary
    hosts.value = nextHosts.items
    probes.value = nextProbes.items
    probesTruncated.value = nextProbes.truncated
    viewDisabled.value = false
  } catch (err) {
    if (isPublicViewDisabled(err)) {
      // 总开关关闭：⛔ 不显示任何旧数据（那会让人以为视图还开着）
      viewDisabled.value = true
      summary.value = null
      hosts.value = []
      probes.value = []
      probesTruncated.value = false
      error.value = null
    } else {
      error.value = toErrorText(err)
    }
  } finally {
    loading.value = false
  }
}

/** 探活不随 `status` 增量变化，实时连接正常时单独刷新它即可 */
async function loadProbes(): Promise<void> {
  try {
    const next = await getProbes()
    probes.value = next.items
    probesTruncated.value = next.truncated
  } catch {
    // 单次探活刷新失败不打断页面：下一轮还会再试（⛔ 不把已有内容清空）
  }
}

async function toggleHost(host: PublicHost): Promise<void> {
  if (expandedSlug.value === host.slug) {
    expandedSlug.value = null
    return
  }
  expandedSlug.value = host.slug
  if (details.value[host.slug]) return

  detailLoading.value = true
  try {
    const detail = await getHostNow(host.slug)
    details.value = { ...details.value, [host.slug]: detail }
  } catch (err) {
    // 404 的三种含义不可区分（不存在 / 已被人工禁用 / 公开视图被关闭，docs/api.md §3.2）
    if (isPublicViewDisabled(err)) viewDisabled.value = true
    else details.value = { ...details.value, [host.slug]: null }
  } finally {
    detailLoading.value = false
  }
}

/** 实时连接未建立/已断开 → 退化为轮询（断线必须明确提示，⛔ 不静默假装还实时的） */
const degraded = computed(() => realtime.status !== 'open')

onMounted(() => {
  // 公开页只订 `/ws/public`（⛔ 绝不触发 `/ws/live` 的 Cookie 握手）
  realtime.connect('public')
  void loadAll()
  timer = window.setInterval(() => {
    if (degraded.value) void loadAll()
    else void loadProbes()
  }, POLL_MS)
})

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
  // ⛔ 不断开连接：全站单连接复用，换页只换订阅（docs/frontend.md §10）
})

/**
 * WS `snapshot.hosts[]` **就是** `GET /api/public/hosts` 的 items（同形状），
 * 公开 `status` delta 也是同一形状的脱敏条目 —— 所以这里可以直接整表镜像。
 */
watch(
  () => realtime.hostList,
  (list) => {
    if (realtime.channel !== 'public' || list.length === 0) return
    hosts.value = list as PublicHost[]
    viewDisabled.value = false
  },
)

watch(
  () => realtime.summary,
  (next) => {
    if (!next || realtime.channel !== 'public') return
    summary.value = {
      total: next.total,
      online: next.online,
      offline: next.offline,
      disabled: next.disabled ?? summary.value?.disabled ?? 0,
      alerts: next.alerts,
      // WS 快照不带 `updated_at`；保留 REST 那一次的时间，避免显示成"刚刚"
      updated_at: summary.value?.updated_at ?? new Date().toISOString(),
    }
  },
)
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('view.publicStatus.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.publicStatus.hint') }}</p>

    <ElAlert
      v-if="viewDisabled"
      type="warning"
      :closable="false"
      show-icon
      :title="t('publicStatus.disabledTitle')"
      :description="t('publicStatus.disabledHint')"
    >
      <RouterLink :to="{ name: 'login' }">{{ t('nav.login') }}</RouterLink>
    </ElAlert>

    <template v-else>
      <SummaryBar :summary="summary" :loading="loading" />

      <ElAlert
        v-if="degraded"
        class="public-status__degraded"
        type="warning"
        :closable="false"
        show-icon
        :title="t('realtime.degraded')"
        :description="t('publicStatus.pollingFallback', { seconds: POLL_MS / 1000 })"
      />

      <AsyncState
        :loading="loading && hosts.length === 0"
        :error="error"
        :empty="!loading && hosts.length === 0"
        @retry="loadAll"
      >
        <div class="public-status__grid">
          <HostCard
            v-for="host in hosts"
            :key="host.slug"
            :host="host"
            :detail="details[host.slug] ?? null"
            :expanded="expandedSlug === host.slug"
            :loading="detailLoading && expandedSlug === host.slug"
            @toggle="toggleHost(host)"
          />
        </div>
      </AsyncState>

      <h2 class="public-status__section">{{ t('publicStatus.probesTitle') }}</h2>
      <ProbeOverview :probes="probes" :truncated="probesTruncated" />
    </template>
  </section>
</template>

<style scoped>
.public-status__degraded {
  margin: 10px 0;
}

.public-status__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.public-status__section {
  margin: 22px 0 8px;
  font-size: 15px;
}

@media (max-width: 767px) {
  .public-status__grid {
    grid-template-columns: 1fr;
  }
}
</style>
