import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 接真实后端时：复制 .env.example 为 .env，设置 VITE_USE_MOCK=false 和 VITE_API_BASE
// base: './' 让产物可在任意路径（含本地 file://）下运行
export default defineConfig({
  base: './',
  build: {
    // 本环境 Node 的 trash 包装会让 Vite 清空 dist 失败，改为手动清理
    emptyOutDir: false
  },
  plugins: [
    vue(),
    // 把 JS/CSS 全部内联进单个 index.html，避免 ESM/HMR 在预览沙箱里加载失败
    viteSingleFile()
  ],
  server: {
    port: 5173,
    proxy: {
      // 开发态需要同时代理数据面与控制面：
      // 此前只代理 /v1，导致 dev 下所有 /__gw/* 控制接口 404
      //（模型列表、账号管理、API Key、局域网信息全部取不到）。
      '/v1': {
        target: process.env.VITE_API_BASE || 'http://127.0.0.1:8765',
        changeOrigin: true
      },
      '/__gw': {
        target: process.env.VITE_GW_BASE || 'http://127.0.0.1:4173',
        changeOrigin: true
      },
      '/health': {
        target: process.env.VITE_GW_BASE || 'http://127.0.0.1:4173',
        changeOrigin: true
      }
    }
  }
})
