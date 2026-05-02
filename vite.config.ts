import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const pegTarget = {
  target: 'https://server.p2peg.app',
  changeOrigin: true,
  secure: true,
} as const
const pegProxy = {
  '/peg-api': { ...pegTarget, rewrite: (path: string) => path.replace(/^\/peg-api/, '') },
  /** 与连字符路径等价；避免误用下划线时开发环境 404 */
  '/peg_api': { ...pegTarget, rewrite: (path: string) => path.replace(/^\/peg_api/, '') },
} as const

const noStore = { 'Cache-Control': 'no-store' } as const

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    minify: 'terser',
  },
  server: {
    proxy: pegProxy,
    /** 减少开发时误用旧 HMR 缓存、误以为界面未更新 */
    headers: noStore,
  },
  preview: {
    proxy: pegProxy,
    headers: noStore,
  },
})
