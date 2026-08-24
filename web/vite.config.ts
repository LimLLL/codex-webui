import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const runtimeBasePathToken = '__CODEX_WEBUI_BASE_PATH__';

export default defineConfig({
  // Relative build assets let one image run at / or behind any proxy prefix.
  // The backend supplies the matching <base href> for each HTML request.
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'runtime-base-path-dev',
      apply: 'serve',
      transformIndexHtml(html) {
        return html.replaceAll(runtimeBasePathToken, '/');
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: true,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8172',
      '/socket.io': {
        target: 'http://localhost:8172',
        ws: true,
      },
    },
  },
});
