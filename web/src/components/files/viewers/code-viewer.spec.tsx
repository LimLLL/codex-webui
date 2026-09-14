/** Shared document ownership and per-view navigation, using a minimal Monaco model collaborator. */
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CodeViewer } from './code-viewer';
import { retainDocument, releaseDocument, reloadDocument, saveDocument, useDocumentStore } from '@/stores/document-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), reveal: vi.fn(), restored: vi.fn() }));
vi.mock('@/generated/api/sdk.gen', () => ({ filesReadFile: io.read, filesWriteFile: io.write }));
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
    editor: { createModel: (text: string, _language: unknown, uri: { path: string; toString: () => string }) => {
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
  useDocumentStore.setState({ documents: {} });
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
  io.read.mockResolvedValue({ data: { content: 'one\ntwo\nthree', mtime: 10 } });
  io.write.mockResolvedValue({ data: { mtime: 11 } });
});

/** Waits for the shared asynchronous document loader, not an arbitrary editor mount timer. */
async function load(path: string, view: string) {
  retainDocument(path, view);
  await waitFor(() => expect(useDocumentStore.getState().documents[path]?.model).not.toBeNull());
  return useDocumentStore.getState().documents[path]!;
}

it('shares one model across conversation and standalone views and retains a dirty draft after disposal', async () => {
  const first = await load('/shared.ts', 'conversation');
  const second = await load('/shared.ts', 'standalone');
  expect(second.model).toBe(first.model);
  first.model!.setValue('unsaved');
  releaseDocument('/shared.ts', 'conversation'); releaseDocument('/shared.ts', 'standalone');
  await Promise.resolve();
  expect(useDocumentStore.getState().documents['/shared.ts']).toMatchObject({ dirty: true, savedContent: 'one\ntwo\nthree', revision: 10 });
  expect((await load('/shared.ts', 'restored')).model!.getValue()).toBe('unsaved');
  expect(io.read).toHaveBeenCalledTimes(1);
});

it('does not replace a draft or advance its write precondition during a background read', async () => {
  const document = await load('/conflict.ts', 'view');
  document.model!.setValue('draft');
  io.read.mockResolvedValueOnce({ data: { content: 'external edit', mtime: 20 } });
  await reloadDocument('/conflict.ts');
  expect(document.model!.getValue()).toBe('draft');
  expect(useDocumentStore.getState().documents['/conflict.ts']).toMatchObject({ revision: 10, conflict: true, dirty: true });
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
  expect(useDocumentStore.getState().documents['/saving.ts']).toMatchObject({ savedContent: 'submitted', revision: 21, dirty: true, saving: false });
});

it('keeps the draft and baseline when saving fails', async () => {
  const document = await load('/failure.ts', 'view');
  document.model!.setValue('draft');
  io.write.mockRejectedValueOnce(new Error('write conflict'));
  expect(await saveDocument('/failure.ts')).toBe(false);
  expect(useDocumentStore.getState().documents['/failure.ts']).toMatchObject({ revision: 10, dirty: true, error: 'write conflict' });
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
