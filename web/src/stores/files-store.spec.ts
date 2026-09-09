/**
 * Tests pinning the transient line target's lifetime.
 *
 * The hazard this guards is not a wrong jump but a *late* one: a target that
 * outlives the request that raised it gets applied to whichever file the user
 * opens next, which reads as the viewer moving on its own.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useFilesStore } from './files-store';

const initial = useFilesStore.getState();

beforeEach(() => {
  useFilesStore.setState({
    rootDir: null,
    selectedFile: null,
    panelOpen: false,
    expandedDirs: new Set<string>(),
    pendingLine: null,
  });
});

describe('files-store line target', () => {
  it('carries a line supplied with the selection', () => {
    initial.selectFile('/work/app.ts', 42);

    expect(useFilesStore.getState().pendingLine).toBe(42);
  });

  it('clears a standing target when a selection supplies no line', () => {
    // A file-tree click or a plain mention means "show me this file", not
    // "show me where the previous request pointed".
    initial.selectFile('/work/app.ts', 42);
    initial.selectFile('/work/other.ts');

    expect(useFilesStore.getState().pendingLine).toBeNull();
  });

  it('clears the target when the selection is dropped', () => {
    initial.selectFile('/work/app.ts', 42);
    initial.selectFile(null);

    expect(useFilesStore.getState().pendingLine).toBeNull();
  });

  it('clears the target when the root directory changes', () => {
    // The selection is gone with the root, so the target has nothing left to
    // apply to and would only wait for the next file opened.
    initial.selectFile('/work/app.ts', 42);
    initial.setRootDir('/elsewhere');

    expect(useFilesStore.getState().pendingLine).toBeNull();
  });

  it('consumes the target explicitly', () => {
    initial.selectFile('/work/app.ts', 42);
    initial.clearPendingLine();

    expect(useFilesStore.getState().pendingLine).toBeNull();
    // Consuming the jump must not close the file it was for.
    expect(useFilesStore.getState().selectedFile).toBe('/work/app.ts');
  });

  it('reinstates a target when the same file is requested again', () => {
    // Re-clicking the same reference is a new navigation request, not a no-op.
    initial.selectFile('/work/app.ts', 42);
    initial.clearPendingLine();
    initial.selectFile('/work/app.ts', 42);

    expect(useFilesStore.getState().pendingLine).toBe(42);
  });
});
