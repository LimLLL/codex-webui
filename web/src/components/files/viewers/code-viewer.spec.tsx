/** Shared document ownership and per-view navigation, using a minimal Monaco model collaborator. */
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CodeViewer } from './code-viewer';
import { getDocumentForPath, retainDocument, releaseDocument, reloadDocument, saveDocument, useDocumentStore } from '@/stores/document-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), create: vi.fn(), reveal: vi.fn(), restored: vi.fn() }));
vi.mock('@/generated/api/sdk.gen', () => ({ filesReadFile: io.read, filesWriteFile: io.write, filesCreateFile: io.create }));
vi.mock('@monaco-editor/react', async () => {
  const { useEffect } = await import('react');
  const models = new Map<string, ReturnType<typeof makeModel>>();
  function makeModel(text: string, uri: { path: string; toString: () => string }) {
    let value = text;
    const listeners = new Set<() => void>();
    return {
      uri, getValue: () => value, getLineCount: () => value.split('\n').length,
      setValue: (next: string) => { value = next; listeners.forEach((fn) => fn()); },
      onDidChangeContent: (fn: () => void) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
      dispose: () => models.delete(uri.toString()),
    };
  }
  const monaco = {
    Uri: { file: (path: string) => ({ path, toString: () => `file://${encodeURI(path)}` }) },
    languages: { getLanguages: () => [{ id: 'typescript', extensions: ['.ts'] }] },
    editor: { setModelLanguage: vi.fn(), createModel: (text: string, _language: unknown, uri: { path: string; toString: () => string }) => {
      const model = makeModel(text, uri); models.set(uri.toString(), model); return model;
    } },
  };
  function Editor({ path, onMount }: { path: string; onMount: (value: unknown) => void }) {
    useEffect(() => {
      const model = models.get(path);
      const subscription = () => ({ dispose: () => undefined });
      onMount({
        getModel: () => model, layout: () => undefined, restoreViewState: io.restored,
        saveViewState: () => null, onDidChangeCursorPosition: subscription,
        onDidScrollChange: subscription, onKeyDown: subscription,
        setPosition: () => undefined, revealLineInCenter: io.reveal,
      });
    }, [path, onMount]);
    return <div data-testid="editor" />;
  }
  return { default: Editor, loader: { init: async () => monaco } };
});

beforeEach(() => {
  vi.clearAllMocks();
  useDocumentStore.setState({ documents: {}, pathIndex: {} });
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
  io.read.mockResolvedValue({ data: { content: 'one\ntwo\nthree', mtime: 10 } });
  io.write.mockResolvedValue({ data: { mtime: 11 } });
});

/** Waits for the shared asynchronous document loader, not an arbitrary editor mount timer. */
async function load(path: string, view: string) {
  retainDocument(path, view);
  await waitFor(() => expect(getDocumentForPath(path)?.model).not.toBeNull());
  return getDocumentForPath(path)!;
}

it('shares one model across conversation and standalone views and retains a dirty draft after disposal', async () => {
  const first = await load('/shared.ts', 'conversation');
  const second = await load('/shared.ts', 'standalone');
  expect(second.model).toBe(first.model);
  first.model!.setValue('unsaved');
  releaseDocument('/shared.ts', 'conversation'); releaseDocument('/shared.ts', 'standalone');
  await Promise.resolve();
  expect(getDocumentForPath('/shared.ts')).toMatchObject({ dirty: true, savedContent: 'one\ntwo\nthree', revision: 10 });
  expect((await load('/shared.ts', 'restored')).model!.getValue()).toBe('unsaved');
  expect(io.read).toHaveBeenCalledTimes(1);
});

it('does not replace a draft or advance its write precondition during a background read', async () => {
  const document = await load('/conflict.ts', 'view');
  document.model!.setValue('draft');
  io.read.mockResolvedValueOnce({ data: { content: 'external edit', mtime: 20 } });
  await reloadDocument('/conflict.ts');
  expect(document.model!.getValue()).toBe('draft');
  expect(getDocumentForPath('/conflict.ts')).toMatchObject({ revision: 10, conflict: true, dirty: true });
  await saveDocument('/conflict.ts');
  expect(io.write).toHaveBeenCalledWith(expect.objectContaining({ body: { path: '/conflict.ts', content: 'draft', expectedMtime: 10 } }));
});

it('pairs the acknowledged revision with the submitted text, keeping newer edits dirty', async () => {
  const document = await load('/saving.ts', 'view');
  document.model!.setValue('submitted');
  let finish!: (value: unknown) => void;
  io.write.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const saving = saveDocument('/saving.ts');
  document.model!.setValue('typed during save');
  finish({ data: { mtime: 21 } });
  expect(await saving).toBe(true);
  expect(getDocumentForPath('/saving.ts')).toMatchObject({ savedContent: 'submitted', revision: 21, dirty: true, saving: false });
});

it('keeps the draft and baseline when saving fails', async () => {
  const document = await load('/failure.ts', 'view');
  document.model!.setValue('draft');
  io.write.mockRejectedValueOnce(new Error('write conflict'));
  expect(await saveDocument('/failure.ts')).toBe(false);
  expect(getDocumentForPath('/failure.ts')).toMatchObject({ revision: 10, dirty: true, conflict: false, error: 'write conflict' });
});

it('applies only the active view reveal and consumes it after the intended model mounts', async () => {
  useWorkspaceStore.getState().revealLine('first', 2);
  useWorkspaceStore.getState().revealLine('other', 3);
  const view = render(<CodeViewer filePath="/lines.ts" viewId="first" active={false} />);
  await screen.findByTestId('editor');
  expect(io.reveal).not.toHaveBeenCalled();
  view.rerender(<CodeViewer filePath="/lines.ts" viewId="first" active />);
  await waitFor(() => expect(io.reveal).toHaveBeenCalledWith(2));
  expect(useWorkspaceStore.getState().fileViews.first.reveal).toBeNull();
  expect(useWorkspaceStore.getState().fileViews.other.reveal?.line).toBe(3);
  await act(async () => useWorkspaceStore.getState().revealLine('first', 99));
  await waitFor(() => expect(io.reveal).toHaveBeenLastCalledWith(3));
});

it('retargets a subtree without replacing models, and gives a vacated path a fresh buffer', async () => {
  const { remapDocuments } = await import('@/stores/document-store');
  const old = await load('/work/a/note.ts', 'first');
  const unrelated = await load('/work/ab/note.ts', 'other');
  old.model!.setValue('draft');
  const uri = old.model!.uri.toString();
  remapDocuments('/work/a', '/work/b');
  expect(getDocumentForPath('/work/b/note.ts')).toMatchObject({ id: old.id, model: old.model, dirty: true });
  expect(getDocumentForPath('/work/ab/note.ts')?.id).toBe(unrelated.id);
  expect(old.model!.uri.toString()).toBe(uri);
  io.read.mockResolvedValueOnce({ data: { content: 'new file at old path', mtime: 30 } });
  const replacement = await load('/work/a/note.ts', 'replacement');
  expect(replacement.id).not.toBe(old.id);
  expect(replacement.model!.uri.toString()).not.toBe(uri);
  expect(replacement.model!.getValue()).toBe('new file at old path');
  await saveDocument(old.id);
  expect(io.write).toHaveBeenLastCalledWith(expect.objectContaining({ body: { path: '/work/b/note.ts', content: 'draft', expectedMtime: 10 } }));
});

it('refuses detached save/reload and recovers into the same document with Save As', async () => {
  const { markDocumentsDeleted, saveDocumentAs } = await import('@/stores/document-store');
  useWorkspaceStore.getState().openFile('thread:a', '/work/note.ts');
  const tab = useWorkspaceStore.getState().contexts['thread:a'].tabs[0];
  const original = await load('/work/note.ts', 'editor');
  original.model!.setValue('unsaved work');
  markDocumentsDeleted('/work');
  expect(useDocumentStore.getState().documents[original.id]).toMatchObject({ path: null, detached: true, dirty: true });
  expect(await saveDocument(original.id)).toBe(false);
  await reloadDocument(original.id);
  expect(io.write).not.toHaveBeenCalled();
  expect(io.read).toHaveBeenCalledTimes(1);
  io.create.mockResolvedValueOnce({ data: { path: '/safe/recovered.ts', mtime: 40 } });
  expect(await saveDocumentAs(original.id, '/safe/recovered.ts')).toBe(true);
  useWorkspaceStore.getState().syncDocumentPaths();
  const recovered = useDocumentStore.getState().documents[original.id];
  expect(recovered).toMatchObject({ model: original.model, path: '/safe/recovered.ts', detached: false, dirty: false, revision: 40 });
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs[0]).toMatchObject({ id: tab.id, path: '/safe/recovered.ts', documentId: original.id });
});

it('retains clean identities while a tab is open, even when its editor unmounts', async () => {
  useWorkspaceStore.getState().openFile('thread:a', '/clean.ts');
  const original = await load('/clean.ts', 'editor');
  releaseDocument(original.id, 'editor');
  await Promise.resolve();
  expect(useDocumentStore.getState().documents[original.id]?.model).toBe(original.model);
  const tab = useWorkspaceStore.getState().contexts['thread:a'].tabs[0];
  useWorkspaceStore.getState().remove('thread:a', tab.id);
  await Promise.resolve();
  expect(useDocumentStore.getState().documents[original.id]).toBeUndefined();
});

it('rejects a save response from before relocation without getting stuck saving', async () => {
  const { remapDocuments } = await import('@/stores/document-store');
  const original = await load('/old.ts', 'view');
  original.model!.setValue('draft');
  let finish!: (value: unknown) => void;
  io.write.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const saving = saveDocument(original.id);
  remapDocuments('/old.ts', '/new.ts');
  finish({ data: { mtime: 99 } });
  expect(await saving).toBe(false);
  expect(getDocumentForPath('/new.ts')).toMatchObject({ revision: 10, dirty: true, saving: false });
});
