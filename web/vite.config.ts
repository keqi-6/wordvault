import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时把 /api 代理到本地后端；生产由后端直接托管 dist。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Windows 上某些编辑器的原子写入会在源码目录留下临时目录，
    // 它们被 fs.watch 监听到会抛 EBUSY 把 dev server 打崩，这里直接忽略。
    watch: {
      ignored: ['**/*.tmpdir', '**/*.tmpdir/**', '**/.*.tmpdir/**', '**/*~', '**/*.swp'],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
