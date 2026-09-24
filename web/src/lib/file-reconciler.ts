/** Application-level path repair shared by confirmed mutations and observed changes. */
import type { QueryClient } from '@tanstack/react-query';
import { filesGetMetadata } from '@/generated/api';
import {
  filesReadTreeQueryKey,
  filesReadFileQueryKey,
  filesGetMetadataQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { useFilesStore } from '@/stores/files-store';
import { getApiErrorCode } from '@/lib/api-error';
import { useWorkspaceStore } from '@/stores/workspace-store';
import {
  markDocumentsDeleted,
  reloadDocument,
  remapDocuments,
  useDocumentStore,
} from '@/stores/document-store';
import { acquireFileWatch } from './file-watch-leases';
import {
  filePathChanges,
  type FilePathChange,
  fileMutationEpoch,
  waitForFileMutations,
  emitFileChange,
  parentFilePath,
  pathIsWithin,
  subscribeFileChanges,
  type FileChange,
} from './file-change-events';

/** Invalidates sets of directory and file keys, never once per entry in a shared parent. */
function invalidatePaths(queryClient: QueryClient, paths: Set<string>): void {
  const directories = new Set(paths);
  for (const path of paths) directories.add(parentFilePath(path));
  for (const root of directories)
    void queryClient.invalidateQueries({
      queryKey: filesReadTreeQueryKey({ query: { root } }),
    });
  for (const path of paths) {
    void queryClient.invalidateQueries({
      queryKey: filesReadFileQueryKey({ query: { path } }),
    });
    void queryClient.invalidateQueries({
      queryKey: filesGetMetadataQueryKey({ query: { path } }),
    });
  }
}

/** Repairs every owner before refetching; source is diagnostic and never changes semantics. */
export function applyFileChange(
  queryClient: QueryClient,
  change: FileChange,
): void {
  const paths = new Set<string>();
  for (const fact of filePathChanges(change)) {
    if (fact.kind === 'rename') {
      useFilesStore.getState().remapPaths(fact.oldPath, fact.newPath);
      remapDocuments(fact.oldPath, fact.newPath);
      useWorkspaceStore.getState().syncDocumentPaths();
      paths.add(fact.oldPath);
      paths.add(fact.newPath);
    } else if (fact.kind === 'delete') {
      useFilesStore.getState().removePaths(fact.path);
      markDocumentsDeleted(fact.path);
      useWorkspaceStore.getState().syncDocumentPaths();
      paths.add(fact.path);
    } else {
      fact.paths.forEach((path) => paths.add(path));
    }
  }
  // Descendant query keys and documents must also refresh after a parent move.
  for (const document of Object.values(useDocumentStore.getState().documents)) {
    if (
      document.path &&
      [...paths].some((path) => pathIsWithin(document.path!, path))
    ) {
      paths.add(document.path);
      if (document.model) void reloadDocument(document.id);
    }
  }
  invalidatePaths(queryClient, paths);
}

/**
 * Mounted at authenticated application scope, independently of any file browser.
 * Document records include tab-owned buffers even when their editor is unmounted.
 * A live-path change releases the pinned old watch and acquires the new path.
 */
export function installFileReconciler(queryClient: QueryClient): () => void {
  const watches = new Map<string, () => void>();
  const sync = () => {
    useWorkspaceStore.getState().syncDocumentPaths();
    const desired = new Set(
      Object.values(useDocumentStore.getState().documents).flatMap((doc) =>
        doc.path ? [doc.path] : [],
      ),
    );
    for (const [path, release] of watches)
      if (!desired.has(path)) {
        release();
        watches.delete(path);
      }
    for (const path of desired)
      if (!watches.has(path)) watches.set(path, acquireFileWatch(path));
  };
  const unsubscribeChanges = subscribeFileChanges((change) =>
    applyFileChange(queryClient, change),
  );
  const unsubscribeDocuments = useDocumentStore.subscribe(sync);
  sync();
  return () => {
    unsubscribeChanges();
    unsubscribeDocuments();
    for (const release of watches.values()) release();
  };
}

/** Distinguishes a confirmed absence from transport, authentication or permission failures. */
async function inspect(
  path: string,
): Promise<'missing' | 'present' | 'unknown'> {
  try {
    await filesGetMetadata({ query: { path }, throwOnError: true });
    return 'present';
  } catch (error) {
    return getApiErrorCode(error) === 'files.path_not_found'
      ? 'missing'
      : 'unknown';
  }
}

let externalWork: Promise<void> = Promise.resolve();
/**
 * Serializes classifications so older reads cannot apply after newer changes.
 *
 * External observations are never promoted to a relocation. Measured on the
 * pinned CLI (`pnpm probe fs-watch-classification`): a rename and an unrelated
 * delete-plus-create in one watched directory emit the *same* two-path batch,
 * so "one path vanished, one appeared" is not evidence of a move — and the
 * order within the pair is not stable either. Guessing would retarget an open
 * buffer onto an unrelated file: the write precondition would usually reject
 * the eventual save, but the tab would already be claiming the wrong file, and
 * a clean document would load foreign content under its own identity.
 *
 * A vanished path therefore detaches its buffer, which keeps the text and undo
 * history and offers explicit recovery. Only this client's own mutations, whose
 * REST response names both ends authoritatively, produce a `rename`.
 *
 * The scope and reconnect-refresh flag the transport carries are deliberately
 * not parameters: a reconnect batch names the watched directory itself, and
 * invalidating that path already refreshes its listing and its parent.
 */
export function reconcileExternalPaths(paths: readonly string[]): Promise<void> {
  const changedPaths = [...new Set(paths)];
  const task = async () => {
    await waitForFileMutations();
    const epoch = fileMutationEpoch();
    const states = await Promise.all(changedPaths.map(inspect));
    await waitForFileMutations();
    if (epoch !== fileMutationEpoch()) {
      emitFileChange({
        source: 'external',
        kind: 'invalidate',
        paths: changedPaths,
      });
      return;
    }
    const changes: FilePathChange[] = changedPaths.flatMap((path, index) =>
      states[index] === 'missing'
        ? [{ source: 'external' as const, kind: 'delete' as const, path }]
        : [],
    );
    const remaining = changedPaths.filter(
      (_, index) => states[index] !== 'missing',
    );
    if (remaining.length)
      changes.push({
        source: 'external',
        kind: 'invalidate',
        paths: remaining,
      });
    if (changes.length === 1) emitFileChange(changes[0]);
    else if (changes.length)
      emitFileChange({ source: 'external', kind: 'batch', changes });
  };
  externalWork = externalWork.then(task, task);
  return externalWork;
}
