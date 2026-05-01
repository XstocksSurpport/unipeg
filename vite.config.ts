import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const pegProxy = {
  '/peg-api': {
    target: 'https://server.peg2peg.app',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/peg-api/, ''),
  },
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
