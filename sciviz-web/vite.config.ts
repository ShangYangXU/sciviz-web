import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // 主包 752 kB（gzip 246 kB）是量过的正常值，不是缺陷：react-dom 205 + 自己的代码
    // 223 + yaml 96 + xyflow 129 + d3 约 60（见 docs/开发日志.md 2026-09-16 那条）。
    // Vite 默认的 500 kB 是给**公网网页**定的经验值，而这份前端由本地宿主在同机伺服
    // （127.0.0.1:8765），不经过网络；照搬那个数，只会让"双击图标"每次都刷一条不会
    // 兑现的警告 —— 而每次启动都有的警告会被学会忽略。
    // 调高不等于不看：真涨一截（例如 Pyodide 的 JS 被误打进主包，量级 +1MB）仍会报。
    chunkSizeWarningLimit: 900,
  },
})
