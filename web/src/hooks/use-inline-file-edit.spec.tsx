/** Late mutation responses must not own a subsequently opened editor. */
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { useInlineFileEdit } from './use-inline-file-edit';
const api = vi.hoisted(() => ({ create: vi.fn(), rename: vi.fn() }));
vi.mock('@/generated/api/sdk.gen', async (original) => ({
  ...(await original<typeof import('@/generated/api/sdk.gen')>()),
  filesCreateDirectory: api.create,
  filesRenamePath: api.rename,
  filesReadTree: () => Promise.resolve({ data: [] }),
}));

/** Renders the hook the way both directory hosts do. */
function mountHook() {
  const client = new QueryClient();
  return renderHook(() => useInlineFileEdit(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/**
 * The editor holds the whole entry name and only *selects* the base, exactly as
 * Explorer does, so replacing the selection already leaves the extension in the
 * field. Submitting the field verbatim is therefore the complete new name — a
 * second copy appended behind it would rename `foo.ts` to `bar.ts.ts`.
 */
it('renames from the submitted field without re-appending the retained extension', async () => {
  api.rename.mockResolvedValue({
    data: { ok: true, oldPath: '/work/foo.ts', newPath: '/work/bar.ts' },
  });
  const { result } = mountHook();
  act(() =>
    result.current.start({
      kind: 'rename',
      parentPath: '/work',
      targetPath: '/work/foo.ts',
      initialValue: 'foo.ts',
      selectBaseName: true,
    }),
  );
  await act(async () => {
    await result.current.commit('bar.ts');
  });
  expect(api.rename).toHaveBeenCalledWith(
    expect.objectContaining({
      body: { path: '/work/foo.ts', newName: 'bar.ts' },
    }),
  );
});

it('settles an old creation without clearing a newer draft after cancellation', async () => {
  let resolve!: (value: unknown) => void;
  api.create.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const client = new QueryClient();
  const { result } = renderHook(() => useInlineFileEdit(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  act(() => result.current.start({ kind: 'newFolder', parentPath: '/work' }));
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.commit('old');
  });
  act(() => {
    result.current.cancel();
    result.current.start({ kind: 'newFolder', parentPath: '/other' });
  });
  await act(async () => {
    resolve({ data: { path: '/work/old', ok: true } });
    await pending;
  });
  expect(result.current.edit).toMatchObject({
    parentPath: '/other',
    pending: false,
    error: null,
  });
});
