import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: Vite-Server auf 5173, /api wird an das Backend (3001) geproxyt — inkl.
// SSE-Streaming (keine Pufferung). Prod: `vite build` -> dist, vom Hono-Server
// als statisches SPA ausgeliefert.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
