import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const api = process.env.TC_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@tc/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) } },
  build: {
    // iPad 8th generation ships iPadOS 14+; Safari 15 is a safe baseline for the features used.
    target: ['safari15', 'es2020'],
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: { manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : undefined) },
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: api, ws: true, changeOrigin: false },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as never);
