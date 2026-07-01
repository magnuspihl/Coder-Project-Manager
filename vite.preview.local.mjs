import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Worktree preview. Client on 40030, proxying API/auth to the isolated
// backend on 40031 (throwaway seeded DB — never the live one).
export default defineConfig({
  plugins: [react()],
  root: 'client',
  cacheDir: '/tmp/vite-preview-9b12-cache',
  optimizeDeps: {
    exclude: ['@huggingface/transformers', 'kokoro-js', 'onnxruntime-web'],
  },
  server: {
    port: 40030,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:40031',
      '/auth': 'http://localhost:40031',
    },
  },
});
