/** The raw repair editor must survive structured config failure and restart invalidation. */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexSettings } from './codex-settings';
import { CatalogSettings } from './catalog/catalog-settings';
import { catalogFixture, deferred, json } from './catalog/catalog.testing';
import { codexConfigReadConfigQueryKey } from '@/generated/api/@tanstack/react-query.gen';

vi.mock('@monaco-editor/react', async () => ({
  default: (await import('./catalog/catalog.testing')).TextEditor,
}));
vi.mock('@/stores/theme-store', () => ({
  useThemeStore: (select: (state: { dark: boolean }) => unknown) =>
    select({ dark: false }),
}));

let fixture: ReturnType<typeof catalogFixture>;
beforeEach(() => {
  fixture = catalogFixture();
});
afterEach(() => {
  fixture.dispose();
});

it('preserves unsaved TOML through loading, failure and success, then exposes the required restart', async () => {
  const user = userEvent.setup();
  const config = deferred<Response>();
  const baseline = 'model = "example"\n';
  fixture.server.overrides.set('GET /api/codex/config', () => config.promise);
  fixture.server.overrides.set('GET /api/models', () =>
    json({ data: [], nextCursor: null }),
  );
  fixture.server.overrides.set('GET /api/codex/config/raw', () =>
    json({ content: baseline, filePath: 'config.toml' }),
  );
  fixture.server.overrides.set('PUT /api/codex/config/raw', () => {
    fixture.server.state = {
      ...fixture.server.state,
      configuredPointer: 'catalog-a.json',
      pointerApplied: false,
    };
    return json({ restartRequired: true, reloaded: false, warnings: [] });
  });
  fixture.render(
    <>
      <CodexSettings />
      <CatalogSettings />
    </>,
  );
  await user.click(screen.getByRole('button', { name: 'Edit config.toml' }));
  const raw = await screen.findByRole('textbox', { name: 'Raw TOML' });
  await waitFor(() => expect(raw).toHaveValue(baseline));
  const edited = 'model = "edited"\n';
  fireEvent.change(raw, { target: { value: edited } });
  await act(async () => config.resolve(json({ message: 'Broken TOML' }, 503)));
  expect(await screen.findByText('Failed to load Codex config')).toBeVisible();
  expect(raw).toHaveValue(edited);
  fixture.server.overrides.set('GET /api/codex/config', () =>
    json({ config: {}, origins: {} }),
  );
  await act(() =>
    fixture.queryClient.invalidateQueries({
      queryKey: codexConfigReadConfigQueryKey(),
    }),
  );
  expect(await screen.findByText('Codex Configuration')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Raw TOML' })).toHaveValue(edited);
  await user.click(screen.getByRole('button', { name: 'Save & Reload' }));
  await waitFor(() =>
    expect(fixture.server.writes).toContainEqual({
      method: 'PUT',
      path: '/api/codex/config/raw',
      body: { content: edited, expectedContent: baseline },
    }),
  );
  expect(
    await screen.findByRole('button', { name: 'Restart Codex' }),
  ).toBeEnabled();
  expect(screen.getByRole('textbox', { name: 'Raw TOML' })).toHaveValue(edited);
});
