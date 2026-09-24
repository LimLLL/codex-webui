/**
 * Shared editable documents with stable identity and path indexing.
 *
 * A filesystem path is mutable. The record id and Monaco model URI are not.
 * This keeps dirty buffers and undo history alive through directory moves and
 * prevents a newly recreated path from reusing an old model.
 */
import { create } from 'zustand';
import { loader, type Monaco } from '@monaco-editor/react';
import {
  filesReadFile,
  filesWriteFile,
  filesCreateFile,
} from '@/generated/api/sdk.gen';
import i18n from '@/i18n';
import { getApiErrorCode, getApiErrorMessage } from '@/lib/api-error';
import {
  emitFileChange,
  beginFileMutation,
  finishFileMutation,
  pathIsWithin,
  remapFilePath,
} from '@/lib/file-change-events';

export type TextModel = ReturnType<Monaco['editor']['createModel']>;
export type DocumentId = string;

export interface DocumentRecord {
  id: DocumentId;
  path: string | null;
  lastPath: string;
  model: TextModel | null;
  savedContent: string | null;
  revision: number | null;
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  error: string | null;
  conflict: boolean;
  detached: boolean;
  /** Rejects responses issued before a relocation or detachment. */
  locationVersion: number;
}

interface DocumentState {
  documents: Record<DocumentId, DocumentRecord>;
  pathIndex: Record<string, DocumentId>;
}

export const useDocumentStore = create<DocumentState>(() => ({
  documents: {},
  pathIndex: {},
}));

const readers = new Map<DocumentId, Promise<void>>();
const readAgain = new Set<DocumentId>();
const owners = new Map<DocumentId, Set<string>>();
const listeners = new Map<DocumentId, { dispose: () => void }>();
let nextDocumentId = 1;

/** Chooses language from the live path without ever replacing the model URI. */
async function updateLanguage(id: DocumentId): Promise<void> {
  const monaco: Monaco = await loader.init();
  const document = useDocumentStore.getState().documents[id];
  if (!document?.model) return;
  const name = (document.path ?? document.lastPath).split('/').pop() ?? '';
  const language = monaco.languages
    .getLanguages()
    .find(
      (entry: { id: string; filenames?: string[]; extensions?: string[] }) =>
        entry.filenames?.includes(name) ||
        entry.extensions?.some((extension) =>
          name.toLowerCase().endsWith(extension.toLowerCase()),
        ),
    );
  monaco.editor.setModelLanguage(document.model, language?.id ?? 'plaintext');
}

/** Resolves either a live path or a stable document id. */
export function resolveDocumentId(pathOrId: string): DocumentId | null {
  const state = useDocumentStore.getState();
  return state.documents[pathOrId]
    ? pathOrId
    : (state.pathIndex[pathOrId] ?? null);
}

/** Reads a live-path document without exposing the internal index to callers. */
export function getDocumentForPath(path: string): DocumentRecord | null {
  const id = useDocumentStore.getState().pathIndex[path];
  return id ? (useDocumentStore.getState().documents[id] ?? null) : null;
}

/** Updates an existing stable record; late async work cannot resurrect it. */
function updateDocument(id: DocumentId, patch: Partial<DocumentRecord>): void {
  useDocumentStore.setState((state) => {
    const current = state.documents[id];
    if (!current) return state;
    return {
      documents: { ...state.documents, [id]: { ...current, ...patch } },
    };
  });
}

/** Creates one record and indexes its current path. */
function createDocument(path: string): DocumentId {
  const id = `document:${nextDocumentId++}`;
  useDocumentStore.setState((state) => ({
    documents: {
      ...state.documents,
      [id]: {
        id,
        path,
        lastPath: path,
        model: null,
        savedContent: null,
        revision: null,
        dirty: false,
        saving: false,
        loading: false,
        error: null,
        conflict: false,
        detached: false,
        locationVersion: 0,
      },
    },
    pathIndex: { ...state.pathIndex, [path]: id },
  }));
  return id;
}

/** Returns the stable identity for a path without mounting an editor or reading it. */
export function ensureDocumentIdentity(path: string): DocumentId {
  const indexed = useDocumentStore.getState().pathIndex[path];
  if (indexed && useDocumentStore.getState().documents[indexed]?.path === path)
    return indexed;
  return createDocument(path);
}

/** Pins an open tab without starting a text read for binary viewers. */
export function pinDocument(id: DocumentId, ownerId: string): void {
  const views = owners.get(id) ?? new Set<string>();
  views.add(ownerId);
  owners.set(id, views);
}

/** Retains an already selected stable record for one mounted view. */
export function retainDocumentById(id: DocumentId, viewId: string): DocumentId {
  const views = owners.get(id) ?? new Set<string>();
  views.add(viewId);
  owners.set(id, views);
  const document = useDocumentStore.getState().documents[id];
  if (document && !document.model && !document.loading && !document.detached)
    void reloadDocument(id);
  return id;
}

/** Retains a model for one mounted view and starts one shared read. */
export function retainDocument(path: string, viewId: string): DocumentId {
  return retainDocumentById(ensureDocumentIdentity(path), viewId);
}

/** Releases an editor owner; dirty or saving models survive unmount. */
export function releaseDocument(idOrPath: string, viewId: string): void {
  const id = resolveDocumentId(idOrPath);
  if (!id) return;
  owners.get(id)?.delete(viewId);
  collectIfUnowned(id);
}

/** Preserves the Strict Mode remount guard from the original implementation. */
function collectIfUnowned(id: DocumentId): void {
  queueMicrotask(() => {
    const document = useDocumentStore.getState().documents[id];
    if (
      !document ||
      owners.get(id)?.size ||
      document.dirty ||
      document.saving ||
      document.loading
    )
      return;
    listeners.get(id)?.dispose();
    listeners.delete(id);
    document.model?.dispose();
    owners.delete(id);
    readers.delete(id);
    useDocumentStore.setState((state) => {
      const documents = { ...state.documents };
      const pathIndex = { ...state.pathIndex };
      delete documents[id];
      if (document.path) delete pathIndex[document.path];
      return { documents, pathIndex };
    });
  });
}

/** Reads a live document without replacing a dirty buffer or advancing its revision. */
export function reloadDocument(pathOrId: string): Promise<void> {
  const id = resolveDocumentId(pathOrId);
  if (!id) return Promise.resolve();
  const pending = readers.get(id);
  if (pending) {
    readAgain.add(id);
    return pending;
  }
  const initial = useDocumentStore.getState().documents[id];
  if (!initial?.path || initial.detached) return Promise.resolve();
  const readPath = initial.path;
  const version = initial.locationVersion;
  updateDocument(id, { loading: true, error: null });
  const task = (async () => {
    try {
      const [monaco, { data }] = await Promise.all([
        loader.init(),
        filesReadFile({ query: { path: readPath }, throwOnError: true }),
      ]);
      const current = useDocumentStore.getState().documents[id];
      if (!current || current.locationVersion !== version || current.detached)
        return;
      // A read started while saving may arrive after the save acknowledgement.
      // It cannot roll a newer acknowledged baseline back to its older snapshot.
      if (
        current.revision !== initial.revision ||
        current.savedContent !== initial.savedContent
      )
        return;
      if (current.dirty || current.saving) {
        updateDocument(id, {
          loading: false,
          conflict: data.mtime !== current.revision,
        });
        return;
      }
      const model =
        current.model ??
        monaco.editor.createModel(
          data.content,
          undefined,
          monaco.Uri.file(
            `/__codex_documents__/${id}/${readPath.split('/').pop() ?? 'file'}`,
          ),
        );
      listeners.get(id)?.dispose();
      if (model.getValue() !== data.content) model.setValue(data.content);
      updateDocument(id, {
        model,
        savedContent: data.content,
        revision: data.mtime,
        dirty: false,
        loading: false,
        error: null,
        conflict: false,
      });
      void updateLanguage(id);
      listeners.set(
        id,
        model.onDidChangeContent(() => {
          const latest = useDocumentStore.getState().documents[id];
          if (latest)
            updateDocument(id, {
              dirty: model.getValue() !== latest.savedContent,
            });
        }),
      );
    } catch (error) {
      if (
        useDocumentStore.getState().documents[id]?.locationVersion === version
      )
        updateDocument(id, { error: getApiErrorMessage(error) });
    } finally {
      readers.delete(id);
      updateDocument(id, { loading: false });
      const latest = useDocumentStore.getState().documents[id];
      const again = readAgain.delete(id) || latest?.locationVersion !== version;
      if (again && latest?.path && !latest.detached) void reloadDocument(id);
      collectIfUnowned(id);
    }
  })();
  readers.set(id, task);
  return task;
}

/** Saves the current buffer through the record's current live path. */
export async function saveDocument(pathOrId: string): Promise<boolean> {
  const id = resolveDocumentId(pathOrId);
  const current = id ? useDocumentStore.getState().documents[id] : undefined;
  if (
    !id ||
    !current?.model ||
    !current.path ||
    current.detached ||
    current.revision === null ||
    current.saving ||
    current.loading
  )
    return false;
  const path = current.path;
  const content = current.model.getValue();
  updateDocument(id, { saving: true, error: null });
  beginFileMutation();
  try {
    const { data } = await filesWriteFile({
      body: { path, content, expectedMtime: current.revision },
      throwOnError: true,
    });
    const latest = useDocumentStore.getState().documents[id];
    if (
      latest?.model === current.model &&
      latest.locationVersion === current.locationVersion
    )
      updateDocument(id, {
        savedContent: content,
        revision: data.mtime,
        saving: false,
        dirty: current.model.getValue() !== content,
        conflict: false,
      });
    return latest?.locationVersion === current.locationVersion;
  } catch (error) {
    if (
      useDocumentStore.getState().documents[id]?.locationVersion ===
      current.locationVersion
    )
      updateDocument(id, {
        error: getApiErrorMessage(error),
        // Only a rejected write precondition means the file moved under us. A
        // network or permission failure leaves the baseline valid, and claiming
        // otherwise would offer to reconcile against a disk state never read.
        conflict:
          getApiErrorCode(error) === 'files.modified_since_read'
            ? true
            : current.conflict,
      });
    return false;
  } finally {
    finishFileMutation();
    updateDocument(id, { saving: false });
    collectIfUnowned(id);
  }
}

/** Saves a detached buffer as a new file while retaining its document identity. */
export async function saveDocumentAs(
  pathOrId: string,
  newPath: string,
  overwrite = false,
): Promise<boolean> {
  const id = resolveDocumentId(pathOrId);
  const current = id ? useDocumentStore.getState().documents[id] : undefined;
  if (!id || !current?.model || current.saving || current.loading) return false;
  const indexed = useDocumentStore.getState().pathIndex[newPath];
  if (indexed && indexed !== id) {
    updateDocument(id, {
      error: i18n.t(
        'Close the other document at this destination before saving.',
      ),
    });
    return false;
  }
  const content = current.model.getValue();
  updateDocument(id, { saving: true, error: null });
  beginFileMutation();
  try {
    const { data } = await filesCreateFile({
      body: { path: newPath, content, overwrite },
      throwOnError: true,
    });
    useDocumentStore.setState((state) => {
      const latest = state.documents[id];
      if (
        !latest ||
        latest.locationVersion !== current.locationVersion ||
        latest.model !== current.model
      )
        return state;
      const pathIndex = { ...state.pathIndex };
      if (latest.path) delete pathIndex[latest.path];
      pathIndex[data.path] = id;
      return {
        pathIndex,
        documents: {
          ...state.documents,
          [id]: {
            ...latest,
            path: data.path,
            lastPath: data.path,
            detached: false,
            conflict: false,
            locationVersion: latest.locationVersion + 1,
            saving: false,
            savedContent: content,
            revision: data.mtime,
            dirty: latest.model?.getValue() !== content,
            error: null,
          },
        },
      };
    });
    void updateLanguage(id);
    emitFileChange({ source: 'local', kind: 'invalidate', paths: [data.path] });
    return useDocumentStore.getState().documents[id]?.path === data.path;
  } catch (error) {
    updateDocument(id, { saving: false, error: getApiErrorMessage(error) });
    return false;
  } finally {
    finishFileMutation();
    updateDocument(id, { saving: false });
    collectIfUnowned(id);
  }
}

/** Retains an unsaved model while refusing ordinary filesystem writes. */
export function markDocumentsDeleted(deletedPath: string): void {
  const state = useDocumentStore.getState();
  for (const document of Object.values(state.documents)) {
    if (!document.path || !pathIsWithin(document.path, deletedPath)) continue;
    useDocumentStore.setState((current) => {
      const latest = current.documents[document.id];
      if (!latest) return current;
      const pathIndex = { ...current.pathIndex };
      delete pathIndex[document.path!];
      return {
        pathIndex,
        documents: {
          ...current.documents,
          [document.id]: {
            ...latest,
            path: null,
            lastPath: document.path!,
            detached: true,
            locationVersion: latest.locationVersion + 1,
            error: i18n.t('File was deleted or moved outside this client.'),
          },
        },
      };
    });
  }
}

/** Retargets every live document below a renamed directory or file. */
export function remapDocuments(oldPath: string, newPath: string): void {
  useDocumentStore.setState((state) => {
    const documents = { ...state.documents };
    const pathIndex = { ...state.pathIndex };
    for (const document of Object.values(state.documents)) {
      if (!document.path) continue;
      const nextPath = remapFilePath(document.path, oldPath, newPath);
      if (!nextPath || nextPath === document.path) continue;
      const collision = pathIndex[nextPath];
      if (collision && collision !== document.id) {
        const replaced = documents[collision];
        if (replaced)
          documents[collision] = {
            ...replaced,
            path: null,
            detached: true,
            locationVersion: replaced.locationVersion + 1,
            error: i18n.t('File was replaced by a moved document.'),
          };
      }
      delete pathIndex[document.path];
      pathIndex[nextPath] = document.id;
      documents[document.id] = {
        ...document,
        path: nextPath,
        lastPath: nextPath,
        locationVersion: document.locationVersion + 1,
      };
    }
    return { documents, pathIndex };
  });
  for (const document of Object.values(useDocumentStore.getState().documents))
    if (document.path && pathIsWithin(document.path, newPath) && document.model)
      void updateLanguage(document.id);
}

/** Explicitly discards a working copy; ordinary unmount never calls this. */
export function discardDocument(pathOrId: string): void {
  const id = resolveDocumentId(pathOrId);
  const current = id ? useDocumentStore.getState().documents[id] : undefined;
  if (!id || !current?.model || current.saving || current.savedContent === null)
    return;
  current.model.setValue(current.savedContent);
  updateDocument(id, { dirty: false, conflict: false, error: null });
  collectIfUnowned(id);
}
