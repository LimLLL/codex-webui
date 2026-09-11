/** Catalog rendering regressions: honest read failures and accessible editing controls. */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  catalogFixture,
  deferred,
  documentText,
  entry,
  json,
} from './catalog.testing';
import { CatalogSettings } from './catalog-settings';
import {
  catalogReadDraftQueryKey,
  catalogStateQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';

vi.mock('@monaco-editor/react', async () => ({
  default: (await import('./catalog.testing')).TextEditor,
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

it('shows a failed state read without claiming there is no configured override', async () => {
  fixture.server.overrides.set('GET /api/codex/catalog', () =>
    json({ message: 'State storage unavailable' }, 503),
  );
  fixture.render(<CatalogSettings />);
  expect(await screen.findByText('State storage unavailable')).toBeVisible();
  expect(
    screen.queryByText('No user-level catalog override.'),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'Edit catalog JSON' }),
  );
  expect(screen.getByRole('textbox', { name: 'Raw JSON' })).toBeVisible();
});

it('keeps a failed draft read distinct from an absent draft', async () => {
  fixture.server.overrides.set('GET /api/codex/catalog/draft', () =>
    json({ message: 'Draft storage unavailable' }, 503),
  );
  fixture.render(<CatalogSettings />);
  expect(await screen.findByText('Draft storage unavailable')).toBeVisible();
  expect(screen.queryByText(/No draft yet/)).not.toBeInTheDocument();
});

it.each(['startupError', 'repairError'] as const)(
  'keeps restart and pending restoration reachable for %s',
  async (field) => {
    fixture.server.state = {
      ...fixture.server.state,
      ready: false,
      [field]: 'Repair diagnostic',
      configuredPointer: 'catalog-a.json',
      managed: true,
      activation: {
        before: 'catalog-b.json',
        after: 'catalog-a.json',
        outcome: 'pending',
      },
    };
    const user = userEvent.setup();
    fixture.render(<CatalogSettings />);
    expect(await screen.findByText('Repair diagnostic')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Restart Codex' }));
    await user.click(screen.getByRole('button', { name: 'Restore previous' }));
    await waitFor(() =>
      expect(fixture.server.writes).toContainEqual({
        method: 'POST',
        path: '/api/codex/catalog/restore',
        body: { expectedPointer: 'catalog-a.json' },
      }),
    );
    expect(
      fixture.server.writes.some(
        (write) => write.path === '/api/codex/catalog/restart',
      ),
    ).toBe(true);
  },
);

it('offers restart for a healthy unapplied pointer and withdraws stale restoration', async () => {
  fixture.server.state = {
    ...fixture.server.state,
    configuredPointer: 'catalog-a.json',
    pointerApplied: false,
    activation: { before: null, after: 'catalog-a.json', outcome: 'accepted' },
  };
  fixture.render(<CatalogSettings />);
  expect(
    await screen.findByRole('button', { name: 'Restart Codex' }),
  ).toBeEnabled();
  expect(
    screen.getByRole('button', { name: 'Restore previous' }),
  ).toBeEnabled();
  for (const state of [
    {
      ...fixture.server.state,
      activation: {
        before: null,
        after: 'catalog-a.json',
        outcome: 'reverted' as const,
      },
    },
    { ...fixture.server.state, configuredPointer: 'different.json' },
  ]) {
    fixture.server.state = state;
    await act(() =>
      fixture.queryClient.invalidateQueries({
        queryKey: catalogStateQueryKey(),
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Restore previous' }),
      ).not.toBeInTheDocument(),
    );
  }
});

it.each(['{broken', '{"models":[null]}'])(
  'preserves an unreadable draft and repairs it through JSON: %s',
  async (content) => {
    fixture.server.content = content;
    const user = userEvent.setup();
    fixture.render(<CatalogSettings />);
    await screen.findByText(/not a readable catalog/);
    expect(screen.getByRole('button', { name: 'Add model' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Edit catalog JSON' }));
    const raw = screen.getByRole('textbox', { name: 'Raw JSON' });
    expect(raw).toHaveValue(content);
    fireEvent.change(raw, { target: { value: documentText } });
    expect(await screen.findByText('Alpha')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add model' })).toBeEnabled();
    expect(
      screen.queryByText(/not a readable catalog/),
    ).not.toBeInTheDocument();
  },
);

it('round trips a renamed entry without losing unknown fields or creating a duplicate', async () => {
  const user = userEvent.setup();
  fixture.render(<CatalogSettings />);
  await user.click(await screen.findByRole('button', { name: 'Edit' }));
  await user.clear(screen.getByRole('textbox', { name: 'slug' }));
  await user.type(screen.getByRole('textbox', { name: 'slug' }), 'renamed');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await user.click(screen.getByRole('button', { name: 'Edit catalog JSON' }));
  const raw = screen.getByRole('textbox', {
    name: 'Raw JSON',
  }) as HTMLTextAreaElement;
  expect(JSON.parse(raw.value)).toEqual({
    models: [{ ...entry, slug: 'renamed' }],
    unknown_document: 'keep',
  });
  fireEvent.change(raw, {
    target: {
      value: JSON.stringify({
        models: [{ ...entry, slug: 'renamed', description: 'From raw' }],
        unknown_document: 'keep',
      }),
    },
  });
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('textbox', { name: 'description' })).toHaveValue(
    'From raw',
  );
});

it('retains intermediate field text, keeps the opening field types, and resets cancellation', async () => {
  const user = userEvent.setup();
  fixture.render(<CatalogSettings />);
  await user.click(await screen.findByRole('button', { name: 'Edit' }));
  const description = screen.getByRole('textbox', { name: 'description' });
  await user.clear(description);
  await user.type(description, 'Replacement');
  expect(description).toHaveValue('Replacement');
  await user.click(screen.getByRole('button', { name: /Show all/ }));
  const messages = screen.getByRole('textbox', { name: 'model_messages' });
  await user.clear(messages);
  await user.paste('{');
  expect(messages).toHaveValue('{');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await user.paste('"instructions_template":"new"}');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('textbox', { name: 'description' })).toHaveValue(
    entry.description,
  );
});

it('preserves dirty text across another browser save and a failed discard, then explicitly adopts fresh text', async () => {
  const user = userEvent.setup();
  fixture.render(<CatalogSettings />);
  await screen.findByText('Alpha');
  await user.click(screen.getByRole('button', { name: 'Edit catalog JSON' }));
  const raw = screen.getByRole('textbox', { name: 'Raw JSON' });
  const mine = `${documentText}\n`;
  fireEvent.change(raw, { target: { value: mine } });
  fixture.server.content = JSON.stringify({
    models: [{ ...entry, display_name: 'Remote' }],
  });
  await act(() =>
    fixture.queryClient.invalidateQueries({
      queryKey: catalogReadDraftQueryKey(),
    }),
  );
  const discard = await screen.findByRole('button', {
    name: /Discard my edits/,
  });
  expect(raw).toHaveValue(mine);
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(await screen.findByText('Draft changed elsewhere')).toBeVisible();
  expect(fixture.server.writes[0].body).toEqual({
    content: mine,
    expectedDraft: documentText,
  });
  fixture.server.overrides.set('GET /api/codex/catalog/draft', () =>
    json({ message: 'Discard read failed' }, 503),
  );
  await user.click(discard);
  expect(
    (await screen.findAllByText('Discard read failed')).length,
  ).toBeGreaterThan(0);
  expect(raw).toHaveValue(mine);
  fixture.server.overrides.delete('GET /api/codex/catalog/draft');
  await user.click(discard);
  await waitFor(() => expect(raw).toHaveValue(fixture.server.content));
  expect(await screen.findByText('Remote')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: /Discard my edits/ }),
  ).not.toBeInTheDocument();
});

it.each([false, true])(
  'adopts only the submitted text when a save responds (typing continued: %s)',
  async (continued) => {
    const user = userEvent.setup();
    const response = deferred<Response>();
    fixture.server.overrides.set(
      'PUT /api/codex/catalog/draft',
      () => response.promise,
    );
    fixture.render(<CatalogSettings />);
    await screen.findByText('Alpha');
    await user.click(screen.getByRole('button', { name: 'Edit catalog JSON' }));
    const raw = screen.getByRole('textbox', { name: 'Raw JSON' });
    const sent = `${documentText}\n`;
    const later = `${sent}\n`;
    const canonical = JSON.stringify(JSON.parse(documentText), null, 2);
    fireEvent.change(raw, { target: { value: sent } });
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fixture.server.writes).toHaveLength(1));
    if (continued) fireEvent.change(raw, { target: { value: later } });
    fixture.server.content = canonical;
    await act(async () =>
      response.resolve(json({ content: canonical, warnings: [] })),
    );
    await waitFor(() => expect(raw).toHaveValue(continued ? later : canonical));
    if (!continued)
      expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    if (continued) {
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Save draft' }),
        ).toBeEnabled(),
      );
      fixture.server.overrides.delete('PUT /api/codex/catalog/draft');
      await user.click(screen.getByRole('button', { name: 'Save draft' }));
      await waitFor(() =>
        expect(fixture.server.writes[1].body).toEqual({
          content: later,
          expectedDraft: canonical,
        }),
      );
    }
  },
);

it('does not reshape a new-entry form when its saved template changes elsewhere', async () => {
  const user = userEvent.setup();
  fixture.render(<CatalogSettings />);
  await screen.findByText('Alpha');
  await user.click(screen.getByRole('button', { name: 'Add model' }));
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Inherit from' }),
    'alpha',
  );
  await user.type(screen.getByRole('textbox', { name: 'slug' }), 'my-model');
  await user.click(screen.getByRole('button', { name: /Show all/ }));
  fixture.server.content = JSON.stringify({
    models: [
      {
        ...entry,
        remote_new_field: 'new',
        display_name: 'Remote template',
        description: 'Remote changed',
      },
    ],
  });
  await act(() =>
    fixture.queryClient.invalidateQueries({
      queryKey: catalogReadDraftQueryKey(),
    }),
  );
  await screen.findByRole('option', { name: 'Remote template' });
  expect(screen.getByRole('textbox', { name: 'slug' })).toHaveValue('my-model');
  expect(screen.getByRole('textbox', { name: 'description' })).toHaveValue(
    entry.description,
  );
  expect(
    screen.queryByRole('textbox', { name: 'remote_new_field' }),
  ).not.toBeInTheDocument();
});

it('reports a removed entry instead of appending its abandoned edit', async () => {
  const user = userEvent.setup();
  fixture.render(<CatalogSettings />);
  await user.click(await screen.findByRole('button', { name: 'Edit' }));
  fixture.server.content = '{"models":[]}';
  await act(() =>
    fixture.queryClient.invalidateQueries({
      queryKey: catalogReadDraftQueryKey(),
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText(/no longer in the draft/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Edit catalog JSON' }));
  expect(screen.getByRole('textbox', { name: 'Raw JSON' })).toHaveValue(
    '{"models":[]}',
  );
});

it('exposes the template and every editor type through associated labels', async () => {
  const user = userEvent.setup();
  fixture.render(<CatalogSettings />);
  await screen.findByText('Alpha');
  await user.click(screen.getByRole('button', { name: 'Add model' }));
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Inherit from' }),
    'alpha',
  );
  expect(screen.getByRole('textbox', { name: 'slug' })).toBeVisible();
  expect(
    screen.getByRole('spinbutton', { name: 'context_window' }),
  ).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'visibility' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: /Show all/ }));
  expect(
    screen.getByRole('switch', { name: 'supported_in_api' }),
  ).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'model_messages' })).toBeVisible();
});
