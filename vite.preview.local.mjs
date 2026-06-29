import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Worktree preview for the per-workspace rate-limits change.
// Client on 40000, proxying API/auth to the isolated backend on 40001.
export default defineConfig({
  plugins: [react()],
  root: 'client',
  cacheDir: '/tmp/vite-preview-9b12-cache',
  optimizeDeps: {
    exclude: ['@huggingface/transformers', 'kokoro-js', 'onnxruntime-web'],
  },
  server: {
    port: 40000,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:40001',
      '/auth': 'http://localhost:40001',
    },
  },
});
