<script setup lang="ts">
/**
 * 设置（**管理类**；docs/frontend.md §4.6，M4 交付物；`meta.role = 'admin'`）。
 *
 * ⚠️ 自助类区块（二次验证、我的会话、SSO 绑定状态）**不在本页**，它们在我的账号页 `/account`
 *    （`Account.vue`）。原因：本页仅 `admin` 可达，而服务端对自助类不设 admin 门槛 ——
 *    塞在这里会让普通用户（`role=user`）在完整态下永远无法自助开启 2FA。
 *    2026-10-03 Owner 拍板按「方案 A」拆分（见 docs/frontend.md §3 路由表与 §4.6）。
 *
 * 本页待实现区块（硬约束照抄 docs/frontend.md §4.6，实现时逐条对照）：
 * - Agent 管理：创建 / **手动轮换** / 禁用 / 吊销；创建与轮换的 key 与 secret **仅显示一次**，并给出
 *   一键安装命令与两种更安全形式 + 安全提示；手动轮换必须弹窗强提示 + 主机名二次确认；
 * - 轮换提醒：阈值取后端下发的 `rotate_policy.days`（⛔ 前端不硬编码，默认 90 天）；
 * - 面板账号：用户列表 + 分配 `role` + 启用/禁用 + 重置该用户 2FA（⛔ 本期不做改密/删除用户 UI）；
 * - 系统设置项：统一渲染后端下发的**白名单项**（⛔ 前端不硬编码 key 列表与默认值），保存走 `PATCH`；
 * - 公开视图总开关（需醒目状态 + 一键关闭 + 二次确认）与审计日志入口。
 * - ⛔ 不在 URL、日志、埋点、控制台打印 key/secret/Cookie；一次性展示页刷新后即消失（不缓存）。
 */
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <section class="vc-page">
    <h1 class="vc-page__title">{{ t('view.settings.title') }}</h1>
    <p class="vc-page__hint">{{ t('view.settings.hint') }}</p>

    <p class="settings__link">
      <RouterLink :to="{ name: 'account' }">{{ t('view.settings.accountLink') }}</RouterLink>
    </p>

    <ElAlert
      class="settings__todo"
      type="info"
      :closable="false"
      :title="t('common.skeletonNotice')"
      :description="t('common.specPointer')"
    />
  </section>
</template>

<style scoped>
.settings__link {
  margin: 0 0 16px;
  font-size: 13px;
}

.settings__todo {
  max-width: 560px;
}
</style>
