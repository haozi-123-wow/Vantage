/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 开发期 vite 代理目标（仅 dev server 使用，见 vite.config.ts） */
  readonly VITE_DEV_API_TARGET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
