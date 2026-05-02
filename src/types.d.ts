interface ImportMetaEnv {
  /** Peg2Peg 根 URL，无尾斜杠，与 Vercel 上 PEG_UPSTREAM 应指向同一服务 */
  readonly VITE_PEG_API_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  ethereum?: unknown
}
