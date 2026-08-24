import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

function normalizeBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

const publicBasePath = normalizeBasePath(process.env.WEBUI_BASE_PATH);
const proxyPrefix = publicBasePath === '/' ? '' : publicBasePath.slice(0, -1);

export default defineConfig({
  base: publicBasePath,
  plugins: [react(), tailwindcss()],
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
      [`${proxyPrefix}/api`]: {
        target: 'http://localhost:8172',
        rewrite: (requestPath) => requestPath.slice(proxyPrefix.length),
      },
      [`${proxyPrefix}/socket.io`]: {
        target: 'http://localhost:8172',
        ws: true,
        rewrite: (requestPath) => requestPath.slice(proxyPrefix.length),
      },
    },
  },
});
