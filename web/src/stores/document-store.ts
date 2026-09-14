/** Shared editable documents: editor disposal never discards an unsaved working model. */
import { create } from 'zustand';
import { loader, type Monaco } from '@monaco-editor/react';
import { filesReadFile, filesWriteFile } from '@/generated/api/sdk.gen';
import { getApiErrorMessage } from '@/lib/api-error';

export type TextModel = ReturnType<Monaco['editor']['createModel']>;

export interface DocumentRecord {
  path: string;
  model: TextModel | null;
  savedContent: string | null;
  revision: number | null;
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  error: string | null;
  conflict: boolean;
}

interface DocumentState {
  documents: Record<string, DocumentRecord>;
}

export const useDocumentStore = create<DocumentState>(() => ({
  documents: {},
}));
const readers = new Map<string, Promise<void>>();
const owners = new Map<string, Set<string>>();
const listeners = new Map<string, { dispose: () => void }>();

/** Updates only an existing document; a late request cannot resurrect a disposed record. */
function updateDocument(path: string, patch: Partial<DocumentRecord>): void {
  useDocumentStore.setState((state) => {
    const current = state.documents[path];
    if (
      current &&
      Object.entries(patch).every(
        ([key, value]) => current[key as keyof DocumentRecord] === value,
      )
    )
      return state;
    return current
      ? { documents: { ...state.documents, [path]: { ...current, ...patch } } }
      : state;
  });
}

/** Retains a model for a mounted view and loads it once across simultaneous readers. */
export function retainDocument(path: string, viewId: string): void {
  const views = owners.get(path) ?? new Set<string>();
  views.add(viewId);
  owners.set(path, views);
  if (!useDocumentStore.getState().documents[path]) {
    useDocumentStore.setState((state) => ({
      documents: {
        ...state.documents,
        [path]: {
          path,
          model: null,
          savedContent: null,
          revision: null,
          dirty: false,
          saving: false,
          loading: false,
          error: null,
          conflict: false,
        },
      },
    }));
    void reloadDocument(path);
  }
}

/** Releases an editor owner; dirty or saving models survive, including their undo history. */
export function releaseDocument(path: string, viewId: string): void {
  owners.get(path)?.delete(viewId);
  collectIfUnowned(path);
}

/**
 * Disposes a document once nothing references it and nothing is unsaved.
 *
 * Also runs after an async read or write settles: those hold the record alive
 * past the release of their last editor, and without a second pass the model
 * and its change listener would outlive every view of the file.
 */
function collectIfUnowned(path: string): void {
  // React Strict Mode reattaches effects in the same task. Do not dispose a
  // model that its replacement editor is about to acquire.
  queueMicrotask(() => {
    const document = useDocumentStore.getState().documents[path];
    if (
      !document ||
      owners.get(path)?.size ||
      document.dirty ||
      document.saving ||
      document.loading
    )
      return;
    listeners.get(path)?.dispose();
    listeners.delete(path);
    document.model?.dispose();
    owners.delete(path);
    useDocumentStore.setState((state) => {
      const documents = { ...state.documents };
      delete documents[path];
      return { documents };
    });
  });
}

/** Reads server content without replacing a dirty buffer or advancing its write precondition. */
export function reloadDocument(path: string): Promise<void> {
  const pending = readers.get(path);
  if (pending) return pending;
  updateDocument(path, { loading: true, error: null });
  const task = (async () => {
    try {
      const [monaco, { data }] = await Promise.all([
        loader.init(),
        filesReadFile({ query: { path }, throwOnError: true }),
      ]);
      const current = useDocumentStore.getState().documents[path];
      if (!current) return;
      if (current.dirty || current.saving) {
        updateDocument(path, {
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
          monaco.Uri.file(path),
        );
      // Detach our change listener while installing a confirmed server baseline.
      listeners.get(path)?.dispose();
      if (model.getValue() !== data.content) model.setValue(data.content);
      updateDocument(path, {
        model,
        savedContent: data.content,
        revision: data.mtime,
        dirty: false,
        loading: false,
        error: null,
        conflict: false,
      });
      listeners.set(
        path,
        model.onDidChangeContent(() => {
          const baseline = useDocumentStore.getState().documents[path];
          if (baseline)
            updateDocument(path, {
              dirty: model.getValue() !== baseline.savedContent,
            });
        }),
      );
    } catch (error) {
      updateDocument(path, {
        loading: false,
        error: getApiErrorMessage(error),
      });
    } finally {
      readers.delete(path);
      collectIfUnowned(path);
    }
  })();
  readers.set(path, task);
  return task;
}

/** Saves the captured buffer; edits made during the request remain dirty after acknowledgement. */
export async function saveDocument(path: string): Promise<boolean> {
  const current = useDocumentStore.getState().documents[path];
  if (
    !current?.model ||
    current.revision === null ||
    current.saving ||
    current.loading
  )
    return false;
  const content = current.model.getValue();
  updateDocument(path, { saving: true, error: null });
  try {
    const { data } = await filesWriteFile({
      body: {
        path,
        content,
        expectedMtime: current.revision,
      },
      throwOnError: true,
    });
    const latest = useDocumentStore.getState().documents[path];
    if (latest?.model === current.model)
      updateDocument(path, {
        savedContent: content,
        revision: data.mtime,
        saving: false,
        dirty: current.model.getValue() !== content,
        conflict: false,
      });
    return true;
  } catch (error) {
    updateDocument(path, { saving: false, error: getApiErrorMessage(error) });
    return false;
  } finally {
    collectIfUnowned(path);
  }
}

/** Explicitly discards a working copy; ordinary unmount and navigation never call this. */
export function discardDocument(path: string): void {
  const current = useDocumentStore.getState().documents[path];
  if (!current?.model || current.saving || current.savedContent === null)
    return;
  current.model.setValue(current.savedContent);
  updateDocument(path, { dirty: false, conflict: false, error: null });
  collectIfUnowned(path);
}
