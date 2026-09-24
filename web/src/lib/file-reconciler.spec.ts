/** Reconciliation uses component-prefix matches and set-based invalidations. */
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { applyFileChange, reconcileExternalPaths } from './file-reconciler';
import { subscribeFileChanges } from './file-change-events';
import { useFilesStore } from '@/stores/files-store';
import { useDocumentStore } from '@/stores/document-store';
const metadata = vi.hoisted(() => vi.fn());
vi.mock('@/generated/api', async (original) => ({
  ...(await original<typeof import('@/generated/api')>()),
  filesGetMetadata: metadata,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useDocumentStore.setState({ documents: {}, pathIndex: {} });
  useFilesStore.setState({
    rootDir: '/work/a/sub',
    selectedFile: '/work/ab/file.ts',
  });
});

it('repairs the browser directory but leaves a string-prefix sibling alone', () => {
  applyFileChange(new QueryClient(), {
    source: 'local',
    kind: 'rename',
    oldPath: '/work/a',
    newPath: '/work/b',
  });
  expect(useFilesStore.getState()).toMatchObject({
    rootDir: '/work/b/sub',
    selectedFile: '/work/ab/file.ts',
  });
});

it('invalidates a shared parent once for a 50-path batch', () => {
  const client = new QueryClient();
  const invalidations = vi.spyOn(client, 'invalidateQueries');
  applyFileChange(client, {
    source: 'external',
    kind: 'invalidate',
    paths: Array.from({ length: 50 }, (_, i) => `/work/${i}.txt`),
  });
  const keys = invalidations.mock.calls.map(([filters]) =>
    JSON.stringify(filters?.queryKey),
  );
  expect(keys.length).toBe(new Set(keys).size);
  expect(
    keys.filter(
      (key) => key.includes('filesReadTree') && key.includes('"root":"/work"'),
    ),
  ).toHaveLength(1);
});

it('never treats permission or network errors as deletion', async () => {
  metadata.mockRejectedValue({ errorCode: 'auth.invalid_token' });
  const events = vi.fn();
  const unsubscribe = subscribeFileChanges(events);
  await reconcileExternalPaths(['/work/file.ts']);
  unsubscribe();
  expect(events).toHaveBeenCalledExactlyOnceWith({
    source: 'external',
    kind: 'invalidate',
    paths: ['/work/file.ts'],
  });
});

/**
 * `pnpm probe fs-watch-classification` measured a rename and an unrelated
 * delete-plus-create emitting an identical two-path batch, so this shape must
 * never be promoted to a relocation — the vanished path detaches instead.
 */
it('refuses to read a relocation out of a vanished-plus-appeared pair', async () => {
  metadata.mockImplementation(({ query }: { query: { path: string } }) =>
    query.path === '/work/old.ts'
      ? Promise.reject({ errorCode: 'files.path_not_found' })
      : Promise.resolve({
          data: { type: query.path === '/work' ? 'directory' : 'file' },
        }),
  );
  const events = vi.fn();
  const unsubscribe = subscribeFileChanges(events);
  await reconcileExternalPaths(['/work/new.ts', '/work/old.ts']);
  unsubscribe();
  expect(events).toHaveBeenCalledExactlyOnceWith({
    source: 'external',
    kind: 'batch',
    changes: [
      { source: 'external', kind: 'delete', path: '/work/old.ts' },
      { source: 'external', kind: 'invalidate', paths: ['/work/new.ts'] },
    ],
  });
  expect(events).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'rename' }),
  );
});

it('waits for local rename acknowledgement before inspecting an old pinned file path', async () => {
  const { beginFileMutation, finishFileMutation } =
    await import('./file-change-events');
  const events = vi.fn();
  const unsubscribe = subscribeFileChanges(events);
  metadata.mockRejectedValue({ errorCode: 'files.path_not_found' });
  beginFileMutation();
  const pending = reconcileExternalPaths(['/old.ts']);
  await Promise.resolve();
  expect(metadata).not.toHaveBeenCalled();
  finishFileMutation();
  await pending;
  unsubscribe();
  expect(events).toHaveBeenCalledWith({
    source: 'external',
    kind: 'delete',
    path: '/old.ts',
  });
});

it('invalidates a common directory once for a native batch of 50 deletions', async () => {
  metadata.mockRejectedValue({ errorCode: 'files.path_not_found' });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const unsubscribe = subscribeFileChanges((change) =>
    applyFileChange(client, change),
  );
  await reconcileExternalPaths(
    Array.from({ length: 50 }, (_, i) => `/work/${i}.txt`),
  );
  unsubscribe();
  const keys = invalidate.mock.calls.map(([filters]) =>
    JSON.stringify(filters?.queryKey),
  );
  expect(keys.length).toBe(new Set(keys).size);
  expect(
    keys.filter(
      (key) => key.includes('filesReadTree') && key.includes('"root":"/work"'),
    ),
  ).toHaveLength(1);
});
