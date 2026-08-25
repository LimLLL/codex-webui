/**
 * Vitest config for the web client.
 *
 * Merges the Vite build config so tests resolve the `@` alias and run through the
 * same React plugin the app is built with, instead of a second, drifting copy.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.spec.{ts,tsx}'],
    },
  }),
);
