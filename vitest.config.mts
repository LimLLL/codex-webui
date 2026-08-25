/**
 * Vitest config for backend unit tests.
 *
 * NestJS resolves constructor dependencies by reading `design:paramtypes` metadata,
 * which TypeScript only emits under `emitDecoratorMetadata`. Neither esbuild nor Oxc
 * emits it, so SWC must be the sole transformer — hence `unplugin-swc` plus both
 * `esbuild: false` and `oxc: false`. Dropping either one silently strips the metadata
 * and every provider fails to resolve with an error naming a parameter index rather
 * than the real cause.
 */
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  esbuild: false,
  oxc: false,
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: [
        'src/main.ts',
        'src/**/*.module.ts',
        'src/**/*.spec.ts',
        'src/codex/codex-schema/**',
      ],
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});
