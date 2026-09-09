/**
 * Regression tests for the code viewer's write precondition and line navigation.
 *
 * Both are failure modes that are invisible until they cost something: a save
 * built from mismatched content and modification time silently overwrites
 * someone else's work, and a jump that fires against the wrong file quietly
 * moves the user somewhere they did not ask to go.
 *
 * Deliberately driven through a real query client with deferred responses
 * rather than a mocked hook returning chosen booleans — the defects these pin
 * all live in the timing between two independent requests, which a booleans
 * mock cannot express.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ReadResult {
  content: string;
  size: number;
  mtime: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Reads queued by the test, consumed in order by the mocked query. */
let pendingReads: Array<Deferred<ReadResult>> = [];
const writeSpy = vi.fn();

function queueRead(): Deferred<ReadResult> {
  const next = deferred<ReadResult>();
  pendingReads.push(next);
  return next;
}

vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  filesReadFileOptions: ({ query }: { query: { path: string } }) => ({
    queryKey: ['files', 'read', query.path],
    queryFn: () => {
      const next = pendingReads.shift();
      if (!next) throw new Error('no read queued');
      return next.promise;
    },
  }),
  filesReadFileQueryKey: ({ query }: { query: { path: string } }) => [
    'files',
    'read',
    query.path,
  ],
  filesWriteFileMutation: () => ({
    mutationFn: (variables: unknown) => {
      writeSpy(variables);
      return Promise.resolve({ mtime: 999 });
    },
  }),
}));

const revealLineInCenter = vi.fn();
const setPosition = vi.fn();
let editorValue = '';
let modelLineCount = 100;

/**
 * Stands in for the Monaco wrapper.
 *
 * Reproduces the two behaviours the viewer actually depends on: the model URI
 * is parsed from the `path` prop, and mounting is asynchronous rather than
 * synchronous with render.
 */
vi.mock('@monaco-editor/react', async () => {
  const { useEffect } = await import('react');
  function EditorStub({
    path,
    value,
    onMount,
  }: {
    path: string;
    value: string;
    onMount: (editor: unknown) => void;
  }) {
    editorValue = value;
    // Mount lands after the commit, as the real wrapper's async loader does.
    useEffect(() => {
      const url = new URL(path);
      onMount({
        getModel: () => ({
          uri: {
            scheme: url.protocol.replace(':', ''),
            authority: url.host,
            query: url.search.replace('?', ''),
            fragment: url.hash.replace('#', ''),
            path: decodeURIComponent(url.pathname),
          },
          getLineCount: () => modelLineCount,
        }),
        getValue: () => editorValue,
        setPosition,
        revealLineInCenter,
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);
    return <div data-testid="editor" data-path={path} />;
  }
  return { default: EditorStub };
});

const { CodeViewer } = await import('./code-viewer');
const { useFilesStore } = await import('@/stores/files-store');

const FILE = '/work/project/app.ts';

let queryClient: QueryClient;

/** The save control, which is the visible expression of the write precondition. */
function saveButton(): HTMLButtonElement {
  return screen.getByTitle(/Save/) as HTMLButtonElement;
}

function renderViewer(filePath = FILE) {
  queryClient = new QueryClient({
    // Retries would only add nondeterministic delay between a rejection and
    // the state under test.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<CodeViewer filePath={filePath} />, { wrapper });
}

beforeEach(() => {
  pendingReads = [];
  writeSpy.mockClear();
  revealLineInCenter.mockClear();
  setPosition.mockClear();
  editorValue = '';
  modelLineCount = 100;
  useFilesStore.setState({ selectedFile: FILE, pendingLine: null });
});

afterEach(() => {
  queryClient?.clear();
});

/**
 * Settles a queued read and lets the resulting effects run.
 *
 * Flushed through a macrotask rather than a single microtask: the query state
 * update, the re-render and the editor's mount effect are separate turns, and
 * stopping short leaves the viewer still showing its loading branch.
 */
async function resolveRead(
  target: Deferred<ReadResult>,
  result: Partial<ReadResult> = {},
) {
  await act(async () => {
    target.resolve({ content: 'BODY', size: 4, mtime: 1000, ...result });
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

describe('CodeViewer write precondition', () => {
  it('saves with the modification time that arrived with the content', async () => {
    // The precondition has to describe the buffer being overwritten. Taken
    // from a separate metadata request it can refresh on its own and vouch for
    // a revision the editor never held.
    const first = queueRead();
    renderViewer();
    await resolveRead(first, { mtime: 4242 });

    const user = userEvent.setup();
    await user.click(await screen.findByTitle(/Save/));

    await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    expect(writeSpy.mock.calls[0][0]).toMatchObject({
      body: { path: FILE, content: 'BODY', expectedMtime: 4242 },
    });
  });

  it('refuses to save while a refresh is outstanding', async () => {
    const first = queueRead();
    renderViewer();
    await resolveRead(first);

    // A refresh in flight means the buffer on screen may already be behind the
    // file; writing it back would resolve the conflict check against content
    // nobody has seen.
    queueRead();
    await act(async () => {
      // Not awaited: this refetch is deliberately left in flight.
      void queryClient.invalidateQueries({ queryKey: ['files', 'read', FILE] });
      await Promise.resolve();
    });

    await waitFor(() => expect(saveButton()).toBeDisabled());
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('keeps the editor and its buffer when a refresh fails', async () => {
    const first = queueRead();
    renderViewer();
    await resolveRead(first);

    const failing = queueRead();
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: ['files', 'read', FILE] });
      failing.reject(new Error('network'));
      await Promise.resolve();
    });

    // Unmounting here would dispose the model and take unsaved edits with it.
    await waitFor(() => expect(saveButton()).toBeDisabled());
    expect(screen.getByTestId('editor')).toBeInTheDocument();
  });

  it('shows an error instead of an empty editor when the first read fails', async () => {
    const first = queueRead();
    renderViewer();
    await act(async () => {
      first.reject(new Error('permission denied'));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByTestId('editor')).toBeNull());
    expect(screen.getByText('Could not open this file')).toBeInTheDocument();
  });
});

describe('CodeViewer line navigation', () => {
  it('reveals a pending line once and consumes it', async () => {
    useFilesStore.setState({ selectedFile: FILE, pendingLine: 42 });
    const first = queueRead();
    renderViewer();
    await resolveRead(first);

    await waitFor(() => expect(revealLineInCenter).toHaveBeenCalledWith(42));
    expect(useFilesStore.getState().pendingLine).toBeNull();

    // A later refresh must not drag the user back to it.
    revealLineInCenter.mockClear();
    const refresh = queueRead();
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: ['files', 'read', FILE] });
      await Promise.resolve();
    });
    await resolveRead(refresh);
    expect(revealLineInCenter).not.toHaveBeenCalled();
  });

  it('clamps a line past the end of the file', async () => {
    modelLineCount = 10;
    useFilesStore.setState({ selectedFile: FILE, pendingLine: 500 });
    const first = queueRead();
    renderViewer();
    await resolveRead(first);

    await waitFor(() => expect(revealLineInCenter).toHaveBeenCalledWith(10));
  });

  it('does not navigate for a file that is no longer selected', async () => {
    useFilesStore.setState({
      selectedFile: '/work/project/other.ts',
      pendingLine: 42,
    });
    const first = queueRead();
    renderViewer();
    await resolveRead(first);

    await waitFor(() =>
      expect(screen.getByTestId('editor')).toBeInTheDocument(),
    );
    expect(revealLineInCenter).not.toHaveBeenCalled();
    // The request belongs to the other file and must survive for it.
    expect(useFilesStore.getState().pendingLine).toBe(42);
  });
});
