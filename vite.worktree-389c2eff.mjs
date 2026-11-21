import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  root: '/home/coder/.cpm/worktrees/task-389c2eff-498f-4cd4-80bd-a43088f989b7/client',
  cacheDir: '/tmp/vite-worktree-389c2eff-cache',
  optimizeDeps: { exclude: ['@huggingface/transformers', 'kokoro-js', 'onnxruntime-web'] },
  server: {
    port: 40021, host: '0.0.0.0', allowedHosts: true,
    proxy: { '/api': 'http://localhost:3000', '/auth': 'http://localhost:3000' },
  },
});
