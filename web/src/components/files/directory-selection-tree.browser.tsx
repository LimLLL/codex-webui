/** Real Radix portals, focus restoration and inline row geometry inside a modal. */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { DirectorySelectionTree } from './directory-selection-tree';
import '@/index.css';
import '@/i18n';

const api = vi.hoisted(() => ({
  entries: [] as Array<{ path: string; name: string; type: 'directory' }>,
  create: vi.fn(),
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    connected: false,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  }),
}));
vi.mock('@/generated/api/sdk.gen', async (original) => ({
  ...(await original<typeof import('@/generated/api/sdk.gen')>()),
  filesGetRoots: () =>
    Promise.resolve({ data: { roots: ['/workspace'], homeDir: '/workspace' } }),
  filesReadTree: () => Promise.resolve({ data: [...api.entries] }),
  filesCreateDirectory: api.create,
}));

export function Picker() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <QueryClientProvider client={client}>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Pick directory</DialogTitle>
          <DirectorySelectionTree
            selectedPath={selected}
            onSelectedPathChange={setSelected}
          />
        </DialogContent>
      </Dialog>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  api.entries = [];
  api.create.mockReset();
  api.create.mockImplementation(({ body }: { body: { path: string } }) => {
    api.entries.push({
      path: body.path,
      name: body.path.split('/').pop()!,
      type: 'directory',
    });
    return Promise.resolve({ data: { ok: true, path: body.path } });
  });
});
afterEach(cleanup);

test('moves focus from a body-portalled menu into an indented editor and Escape leaves its dialog open', async () => {
  render(<Picker />);
  await page.getByText('workspace', { exact: true }).click({ button: 'right' });
  await expect
    .element(page.getByRole('menuitem', { name: 'Rename', exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'File or directory name' });
  await expect.element(input).toHaveFocus();
  const field = input.element().getBoundingClientRect();
  const root = page
    .getByText('workspace', { exact: true })
    .element()
    .closest('[role="button"]')!
    .getBoundingClientRect();
  expect(field.width).toBeGreaterThan(0);
  expect(field.left).toBeGreaterThan(root.left);
  await userEvent.keyboard('{Escape}');
  await expect
    .element(page.getByRole('dialog', { name: 'Pick directory' }))
    .toBeVisible();
  await expect.element(input).not.toBeInTheDocument();
});

test('creates inside the selected directory without a nested name-entry dialog', async () => {
  render(<Picker />);
  await page.getByText('workspace', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'File or directory name' });
  await input.fill('project');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => api.create.mock.calls.length).toBe(1);
  expect(api.create.mock.calls[0][0]).toMatchObject({
    body: { path: '/workspace/project' },
  });
  await expect
    .element(page.getByText('project', { exact: true }))
    .toBeVisible();
});
