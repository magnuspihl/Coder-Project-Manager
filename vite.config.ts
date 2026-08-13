import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  optimizeDeps: {
    exclude: ['@huggingface/transformers', 'kokoro-js', 'onnxruntime-web'],
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      // Defaults to the main checkout's backend. A worktree preview runs its own
      // backend on another port and points here with CPM_PROXY_TARGET, so it
      // never proxies into (or writes through to) the live instance.
      '/api': process.env.CPM_PROXY_TARGET || 'http://localhost:3000',
      '/auth': process.env.CPM_PROXY_TARGET || 'http://localhost:3000',
    },
  },
});
