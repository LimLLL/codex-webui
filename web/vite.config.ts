import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const runtimeBasePathToken = '__CODEX_WEBUI_BASE_PATH__';

function normalizeDevBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '/' || trimmed === '.') return '/';
  const segments = trimmed.split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}/` : '/';
}

const devBasePath = normalizeDevBasePath(
  process.env.CODEX_WEBUI_BASE_PATH ?? process.env.WEBUI_BASE_PATH,
);

const devProxyPrefix =
  devBasePath === '/' ? '' : devBasePath.replace(/\/$/, '');
const stripDevBasePath = (requestPath: string) =>
  requestPath.slice(devProxyPrefix.length);

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
      config() {
        return devBasePath === '/' ? undefined : { base: devBasePath };
      },
      configureServer(server) {
        if (devBasePath === '/') return;
        const base = devBasePath;
        server.middlewares.use((req, _res, next) => {
          const url = req.url ?? '/';
          if (!url.startsWith(base)) {
            req.url = base + url.replace(/^\/+/, '');
          }
          next();
        });
      },
      transformIndexHtml(html) {
        return html.replaceAll(runtimeBasePathToken, devBasePath);
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
    host: '0.0.0.0',
    port: 5173,
    ...(devBasePath === '/' || process.env.CODEX_WEBUI_HMR === '1'
      ? {}
      : { hmr: false }),
    proxy: {
      [`${devProxyPrefix}/api`]: {
        target: 'http://localhost:8172',
        rewrite: stripDevBasePath,
      },
      [`${devProxyPrefix}/socket.io`]: {
        target: 'http://localhost:8172',
        ws: true,
        rewrite: stripDevBasePath,
      },
    },
  },
});
