/** View identities and lifecycle remain independent from documents and shared terminal processes. */
import { beforeEach, expect, it } from 'vitest';
import { fileViewId, useWorkspaceStore } from './workspace-store';
import { useTerminalViewStore } from './terminal-view-store';

beforeEach(() => {
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
  useTerminalViewStore.setState({ retained: {}, target: null });
});

it('opens one tab per document, with independent navigation requests in each conversation', () => {
  const store = useWorkspaceStore.getState();
  store.openFile('thread:a', '/shared.ts', 3);
  const first =
    useWorkspaceStore.getState().fileViews[fileViewId('thread:a', '/shared.ts')]
      .reveal!;
  store.openFile('thread:a', '/shared.ts', 9);
  store.openFile('thread:b', '/shared.ts', 20);
  const state = useWorkspaceStore.getState();
  expect(state.contexts['thread:a'].tabs).toHaveLength(1);
  expect(
    state.fileViews[fileViewId('thread:a', '/shared.ts')].reveal,
  ).toMatchObject({ line: 9 });
  expect(
    state.fileViews[fileViewId('thread:b', '/shared.ts')].reveal,
  ).toMatchObject({ line: 20 });
  store.consumeReveal(fileViewId('thread:a', '/shared.ts'), first.request);
  expect(
    useWorkspaceStore.getState().fileViews[fileViewId('thread:a', '/shared.ts')]
      .reveal?.line,
  ).toBe(9);
});

it('cancels navigation when leaving a view, but not when closing an unrelated tab', () => {
  const store = useWorkspaceStore.getState();
  store.openFile('thread:a', '/first.ts');
  store.openFile('thread:a', '/second.ts', 12);
  store.remove('thread:a', 'file:/first.ts');
  expect(
    useWorkspaceStore.getState().fileViews[fileViewId('thread:a', '/second.ts')]
      .reveal?.line,
  ).toBe(12);
  store.select('thread:a', 'conversation');
  expect(
    useWorkspaceStore.getState().fileViews[fileViewId('thread:a', '/second.ts')]
      .reveal,
  ).toBeNull();
});

it('keeps tab sets across selection and removes only conversations actually deleted', () => {
  const store = useWorkspaceStore.getState();
  store.openFile('thread:a', '/a.ts');
  store.openFile('thread:b', '/b.ts');
  store.openTerminal('thread:a', 'terminal-a');
  useTerminalViewStore.getState().retain('terminal-a', 'thread:a');
  useTerminalViewStore.getState().retain('terminal-b', 'thread:b');
  store.forgetConversations(['a']);
  expect(useWorkspaceStore.getState().contexts['thread:a']).toBeUndefined();
  expect(useWorkspaceStore.getState().contexts['thread:b'].activeId).toBe(
    'file:/b.ts',
  );
  expect(useTerminalViewStore.getState().retained).toEqual({
    'terminal-b': 'thread:b',
  });
});

it('falls back to the pinned conversation after its final closable tab is removed', () => {
  const store = useWorkspaceStore.getState();
  store.openFile('thread:a', '/a.ts');
  store.remove('thread:a', 'file:/a.ts');
  expect(useWorkspaceStore.getState().contexts['thread:a']).toEqual({
    tabs: [],
    activeId: 'conversation',
  });
});
