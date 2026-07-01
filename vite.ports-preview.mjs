import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  root: 'client',
  cacheDir: '/tmp/vite-preview-ports-cache',
  optimizeDeps: { exclude: ['@huggingface/transformers', 'kokoro-js', 'onnxruntime-web'] },
  server: {
    port: 40010, host: '0.0.0.0', allowedHosts: true,
    proxy: { '/api': 'http://localhost:3000', '/auth': 'http://localhost:3000' },
  },
});
