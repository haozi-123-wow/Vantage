/** 请求底座用到的通用类型（与 http.ts 分开放，避免 `export {}` 与类型混合） */
export type QueryValue = string | number | boolean | null | undefined | string[]
