/** Browser-session view descriptors. Documents and terminal processes have separate owners. */
import { create } from 'zustand';
import { useTerminalViewStore } from './terminal-view-store';
import {
  ensureDocumentIdentity,
  pinDocument,
  releaseDocument,
  useDocumentStore,
} from './document-store';
import type { OnMount } from '@monaco-editor/react';

export type EditorViewState = ReturnType<
  Parameters<OnMount>[0]['saveViewState']
>;
export type WorkspaceTab =
  | { id: string; kind: 'file'; path: string; documentId: string }
  | { id: string; kind: 'terminal'; terminalId: string };

export interface WorkspaceContext {
  tabs: WorkspaceTab[];
  activeId: string;
}

export interface FileViewState {
  editor: EditorViewState;
  reveal: { line: number; request: number } | null;
}

/** Shared immutable defaults keep Zustand selections stable before a context is opened. */
export const EMPTY_WORKSPACE: WorkspaceContext = {
  tabs: [],
  activeId: 'conversation',
};
export const EMPTY_FILE_VIEW: FileViewState = { editor: null, reveal: null };

interface WorkspaceState {
  contexts: Record<string, WorkspaceContext>;
  fileViews: Record<string, FileViewState>;
  openFile: (context: string, path: string, line?: number | null) => void;
  openTerminal: (context: string, terminalId: string) => void;
  adoptTerminal: (context: string, terminalId: string) => void;
  select: (context: string, id: string) => void;
  remove: (context: string, id: string) => void;
  forgetConversations: (threadIds: readonly string[]) => void;
  saveEditor: (viewId: string, editor: EditorViewState) => void;
  revealLine: (viewId: string, line: number | null) => void;
  consumeReveal: (viewId: string, request: number) => void;
  cancelReveal: (viewId: string) => void;
  syncDocumentPaths: () => void;
}

let revealSequence = 0;
let nextFileTabId = 1;

/** Identifies a file view independently of its shared document and transient line request. */
export function fileViewId(context: string, identity: string): string {
  return JSON.stringify([context, identity]);
}

/** Cancels navigation intent without discarding the editor's ordinary reading state. */
function clearActiveReveal(state: WorkspaceState, context: string) {
  const current = state.contexts[context];
  const tab = current?.tabs.find((entry) => entry.id === current.activeId);
  if (tab?.kind !== 'file') return state.fileViews;
  const id = fileViewId(context, tab.id);
  return {
    ...state.fileViews,
    [id]: { ...(state.fileViews[id] ?? EMPTY_FILE_VIEW), reveal: null },
  };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  contexts: {},
  fileViews: {},
  /** Adds a discovered terminal without changing tab selection or file reveal intent. */
  adoptTerminal: (context, terminalId) =>
    set((state) => {
      const current = state.contexts[context] ?? EMPTY_WORKSPACE;
      const id = `terminal:${terminalId}`;
      if (current.tabs.some((tab) => tab.id === id)) return state;
      return {
        contexts: {
          ...state.contexts,
          [context]: {
            ...current,
            tabs: [...current.tabs, { id, kind: 'terminal', terminalId }],
          },
        },
      };
    }),
  openFile: (context, path, line = null) =>
    set((state) => {
      const current = state.contexts[context] ?? EMPTY_WORKSPACE;
      const existing = current.tabs.find(
        (tab): tab is Extract<WorkspaceTab, { kind: 'file' }> =>
          tab.kind === 'file' &&
          tab.path === path &&
          useDocumentStore.getState().pathIndex[path] === tab.documentId,
      );
      const documentId = existing?.documentId ?? ensureDocumentIdentity(path);
      const id = existing?.id ?? `file:${nextFileTabId++}`;
      pinDocument(documentId, `tab:${context}:${id}`);
      const viewId = fileViewId(context, id);
      return {
        contexts: {
          ...state.contexts,
          [context]: {
            tabs: existing
              ? current.tabs
              : [...current.tabs, { id, kind: 'file', path, documentId }],
            activeId: id,
          },
        },
        fileViews: {
          ...clearActiveReveal(state, context),
          [viewId]: {
            ...(state.fileViews[viewId] ?? EMPTY_FILE_VIEW),
            reveal: line === null ? null : { line, request: ++revealSequence },
          },
        },
      };
    }),
  openTerminal: (context, terminalId) =>
    set((state) => {
      const current = state.contexts[context] ?? EMPTY_WORKSPACE;
      const id = `terminal:${terminalId}`;
      return {
        contexts: {
          ...state.contexts,
          [context]: {
            tabs: current.tabs.some((tab) => tab.id === id)
              ? current.tabs
              : [...current.tabs, { id, kind: 'terminal', terminalId }],
            activeId: id,
          },
        },
        fileViews: clearActiveReveal(state, context),
      };
    }),
  select: (context, id) =>
    set((state) => {
      const current = state.contexts[context] ?? EMPTY_WORKSPACE;
      if (current.activeId === id) return state;
      if (id !== 'conversation' && !current.tabs.some((tab) => tab.id === id))
        return state;
      return {
        contexts: {
          ...state.contexts,
          [context]: { ...current, activeId: id },
        },
        fileViews: clearActiveReveal(state, context),
      };
    }),
  remove: (context, id) =>
    set((state) => {
      const current = state.contexts[context] ?? EMPTY_WORKSPACE;
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return state;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      const fileViews = {
        ...(current.activeId === id
          ? clearActiveReveal(state, context)
          : state.fileViews),
      };
      const removed = current.tabs[index];
      if (removed.kind === 'file') {
        delete fileViews[fileViewId(context, removed.id)];
        releaseDocument(removed.documentId, `tab:${context}:${removed.id}`);
      }
      return {
        contexts: {
          ...state.contexts,
          [context]: {
            tabs,
            activeId:
              current.activeId === id
                ? (tabs[Math.max(0, index - 1)]?.id ?? 'conversation')
                : current.activeId,
          },
        },
        fileViews,
      };
    }),
  forgetConversations: (threadIds) =>
    set((state) => {
      const contexts = { ...state.contexts };
      const fileViews = { ...state.fileViews };
      for (const threadId of threadIds) {
        const context = `thread:${threadId}`;
        for (const tab of contexts[context]?.tabs ?? []) {
          if (tab.kind === 'file') {
            delete fileViews[fileViewId(context, tab.id)];
            releaseDocument(tab.documentId, `tab:${context}:${tab.id}`);
          }
        }
        useTerminalViewStore.getState().releaseContext(context);
        delete contexts[context];
      }
      return { contexts, fileViews };
    }),
  saveEditor: (viewId, editor) =>
    set((state) => ({
      fileViews: {
        ...state.fileViews,
        [viewId]: { ...(state.fileViews[viewId] ?? EMPTY_FILE_VIEW), editor },
      },
    })),
  revealLine: (viewId, line) =>
    set((state) => ({
      fileViews: {
        ...state.fileViews,
        [viewId]: {
          ...(state.fileViews[viewId] ?? EMPTY_FILE_VIEW),
          reveal: line === null ? null : { line, request: ++revealSequence },
        },
      },
    })),
  consumeReveal: (viewId, request) =>
    set((state) => {
      const current = state.fileViews[viewId];
      if (current?.reveal?.request !== request) return state;
      return {
        fileViews: {
          ...state.fileViews,
          [viewId]: { ...current, reveal: null },
        },
      };
    }),
  cancelReveal: (viewId) =>
    set((state) => {
      const current = state.fileViews[viewId];
      if (!current?.reveal) return state;
      return {
        fileViews: {
          ...state.fileViews,
          [viewId]: { ...current, reveal: null },
        },
      };
    }),
  /** Applies document relocation and closes deleted clean views without touching dirty buffers. */
  syncDocumentPaths: () => {
    const documents = useDocumentStore.getState().documents;
    for (const [context, workspace] of Object.entries(get().contexts)) {
      for (const tab of workspace.tabs) {
        if (tab.kind !== 'file') continue;
        const document = documents[tab.documentId];
        if (document?.detached && !document.dirty && !document.saving)
          get().remove(context, tab.id);
      }
    }
    set((state) => {
      let changed = false;
      const contexts = Object.fromEntries(
        Object.entries(state.contexts).map(([key, context]) => {
          const tabs = context.tabs.map((tab) => {
            if (tab.kind !== 'file') return tab;
            const document =
              useDocumentStore.getState().documents[tab.documentId];
            if (!document?.path || document.path === tab.path) return tab;
            changed = true;
            return { ...tab, path: document.path };
          });
          return [key, { ...context, tabs }];
        }),
      );
      const fileViews = { ...state.fileViews };
      for (const viewId of Object.keys(fileViews)) {
        if (!viewId.startsWith('["files",')) continue;
        const [, documentId] = JSON.parse(viewId) as [string, string];
        if (documentId.startsWith('document:') && !documents[documentId]) {
          delete fileViews[viewId];
          changed = true;
        }
      }
      return changed ? { contexts, fileViews } : state;
    });
  },
}));
