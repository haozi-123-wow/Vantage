import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { defineConfig } from 'vitest/config'

/**
 * 开发期只代理本机中心服务（`server/` 默认监听 127.0.0.1:8787，见 server/src/config/index.js）。
 * ⛔ 不引入任何外部 CDN / 外链资源；生产由反代把 `/api` 与 `/ws` 转给中心服务。
 *
 * ⚠️ `/ws` 的握手会带上浏览器的 `Origin`（如 http://localhost:5173），中心的 Origin 白名单
 *    必须包含该值，否则 WS 会被拒（docs/api.md §5.1）。
 */
const API_TARGET = process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [
    vue(),
    // 按需引入（docs/frontend.md §2 依赖边界）：⛔ 不允许全量 `import ElementPlus`
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia'],
      resolvers: [ElementPlusResolver()],
      dts: 'src/auto-imports.d.ts',
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: 'src/components.d.ts',
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, changeOrigin: true, ws: true },
      // 健康检查不在 /api 命名空间下（server/src/app.js），单独代理便于联调自查
      '/healthz': { target: API_TARGET, changeOrigin: true },
      '/readyz': { target: API_TARGET, changeOrigin: true },
    },
  },
  test: {
    // 单测目前全是纯逻辑（store / utils / api 断言），不需要 DOM：
    // 组件测试落地时再按文件加 `// @vitest-environment jsdom` 并补 jsdom + @vue/test-utils。
    environment: 'node',
    // 沙箱内子进程管道可能被拒（spawn EPERM，见根 README §3.1），故用 worker 线程而非 fork
    pool: 'threads',
    include: ['tests/**/*.spec.ts'],
    // 复用上一次的转码结果，重复跑测试不必重新 transform 全部模块
    fsModuleCache: true,
  },
})
