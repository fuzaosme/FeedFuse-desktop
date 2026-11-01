import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const DEV_SERVER_PORT = 9559;
const DEV_TOKEN = process.env.FEEDFUSE_TOKEN ?? 'dev-local-token';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    // 端口被占时让 Vite 自动顺延（5174…），比整条 dev 会话直接退出友好；
    // 实际使用的地址由 dev-local.mjs 从 Vite 输出里解析后高亮打印。
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${DEV_SERVER_PORT}`,
        changeOrigin: false,
        headers: { 'x-feedfuse-token': DEV_TOKEN },
        // 图片代理是 <img> 直接请求的，没法带头，这里统一补上也无副作用。
      },
    },
  },
});
