import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Isolated worktree preview: vite on 40060, backend on 40061.
export default defineConfig({
  plugins: [react()],
  root: 'client',
  optimizeDeps: {
    exclude: ['@huggingface/transformers', 'kokoro-js', 'onnxruntime-web'],
  },
  server: {
    port: 40060,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:40061',
      '/auth': 'http://localhost:40061',
    },
  },
});
