<script setup lang="ts">
/**
 * 设置（docs/frontend.md §4.6，M4 交付物；仅 `admin`，2FA 受限态例外）。
 *
 * 骨架阶段：仅路由与页面占位。实现时的硬约束：
 * - Agent 管理：创建/轮换的 key 与 secret **仅显示一次**，并给出三种安装命令形态与安全提示；手动轮换
 *   必须弹窗强提示 + 主机名二次确认；
 * - 轮换提醒阈值取后端下发的 `rotate_policy.days`（⛔ 前端不硬编码，默认 90 天）；
 * - 系统设置项**统一渲染后端白名单项**（⛔ 前端不硬编码 key 列表与默认值）；
 * - 用户管理最小集：列表 + 分配 role + 启用/禁用 + 重置该用户 2FA（⛔ 本期不做改密/删除 UI）；
 * - ⛔ 不在 URL、日志、埋点、控制台打印 key/secret/Cookie；一次性展示页刷新后即消失（不缓存）。
 */
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('view.settings.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.settings.hint') }}</p>
    <ElAlert
      type="info"
      :closable="false"
      :title="t('common.skeletonNotice')"
      :description="t('common.specPointer')"
    />
  </section>
</template>
