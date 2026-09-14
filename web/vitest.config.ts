/**
 * Vitest config for the web client.
 *
 * Merges the Vite build config so tests resolve the `@` alias and run through the
 * same React plugin the app is built with, instead of a second, drifting copy.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';
import { playwright } from '@vitest/browser-playwright';
import type { BrowserCommand } from 'vitest/node';

/** Sends native wheel input inside the test iframe rather than fabricating scroll measurements. */
const scrollTranscript: BrowserCommand<[delta: number]> = async (
  context,
  delta,
) => {
  const bounds = await context.iframe
    .locator('[data-transcript-scroller]')
    .boundingBox();
  if (!bounds) throw new Error('Transcript has no browser layout box');
  await context.page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await context.page.mouse.wheel(0, delta);
};

/** Holds a real pointer gesture so ResizeObserver changes can arrive before pointer release. */
const holdTranscriptPointer: BrowserCommand<[held: boolean]> = async (
  context,
  held,
) => {
  if (!held) {
    await context.page.mouse.up();
    return;
  }
  const bounds = await context.iframe
    .locator('[data-transcript-scroller]')
    .boundingBox();
  if (!bounds) throw new Error('Transcript has no browser layout box');
  await context.page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await context.page.mouse.down();
};

/** Exercises the real divider's pointer capture, preview, release and Escape path. */
const explorerDivider: BrowserCommand<
  [action: 'start' | 'move' | 'end' | 'cancel', delta?: number]
> = async (context, action, delta = 0) => {
  if (action === 'cancel') await context.page.keyboard.press('Escape');
  if (action === 'end' || action === 'cancel') {
    await context.page.mouse.up();
    return;
  }
  const bounds = await context.iframe.getByRole('separator').boundingBox();
  if (!bounds) throw new Error('Explorer divider has no browser layout box');
  await context.page.mouse.move(
    bounds.x + bounds.width / 2 + delta,
    bounds.y + bounds.height / 2,
  );
  if (action === 'start') await context.page.mouse.down();
};

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            globals: true,
            environment: 'jsdom',
            setupFiles: ['./src/test/setup.ts'],
            include: ['src/**/*.spec.{ts,tsx}'],
          },
        },
        {
          extends: true,
          test: {
            name: 'browser',
            include: ['src/**/*.browser.{ts,tsx}'],
            // Failure annotations copy screenshots too; keep those copies
            // under the same ignored and per-run-cleared directory.
            attachmentsDir: '.vitest-screenshots/attachments',
            browser: {
              enabled: true,
              headless: true,
              provider: playwright(),
              commands: {
                scrollTranscript,
                holdTranscriptPointer,
                explorerDivider,
              },
              // Failure screenshots default to a `__screenshots__` folder beside
              // each test file, which scatters build output through `src/` and
              // only ever grows: every failing case writes one per run, and
              // renaming a case orphans its file rather than replacing it.
              // Collected in one ignored directory that `test:browser` clears.
              screenshotDirectory: '.vitest-screenshots',
              instances: [{ browser: 'chromium' }, { browser: 'webkit' }],
            },
          },
        },
      ],
    },
  }),
);
