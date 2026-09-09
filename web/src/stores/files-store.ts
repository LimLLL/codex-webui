/**
 * Zustand store for file browser UI state only.
 * REST data (tree, content, metadata) is managed by TanStack Query.
 */
import { create } from 'zustand';

interface FilesState {
  /** Current root directory (from thread cwd or home). */
  rootDir: string | null;
  /** Currently selected file path. */
  selectedFile: string | null;
  /** Whether the file panel is visible. */
  panelOpen: boolean;
  /** Expanded directory paths for tree state. */
  expandedDirs: Set<string>;
  /**
   * One-based line to reveal once the selected file loads, or null.
   *
   * Transient rather than a property of the open tab: it expresses "go there
   * now", so it is consumed on arrival. Left standing, a later plain open of
   * the same file would jump somewhere the user never asked for.
   */
  pendingLine: number | null;

  setRootDir: (dir: string | null) => void;
  selectFile: (filePath: string | null, line?: number | null) => void;
  clearPendingLine: () => void;
  setPanelOpen: (open: boolean) => void;
  toggleDirectory: (dirPath: string) => void;
  navigateUp: () => void;
}

export const useFilesStore = create<FilesState>((set, get) => ({
  rootDir: null,
  selectedFile: null,
  panelOpen: false,
  expandedDirs: new Set<string>(),
  pendingLine: null,

  setRootDir: (dir: string | null) => {
    if (dir === get().rootDir) return;
    set({
      rootDir: dir,
      selectedFile: null,
      expandedDirs: new Set<string>(),
      // The selection is gone, so a line target for it would only wait to be
      // applied to whichever file is opened next.
      pendingLine: null,
    });
  },

  /**
   * Selects a file, optionally targeting a line.
   *
   * Callers that pass no line clear any standing target rather than inheriting
   * one: a file-tree click or a plain mention means "show me this file", not
   * "show me where the previous request pointed".
   *
   * @param filePath - Absolute path to display, or null to clear the selection
   * @param line - One-based line to reveal once loaded
   */
  selectFile: (filePath: string | null, line: number | null = null) => {
    set({
      selectedFile: filePath,
      panelOpen: filePath !== null,
      pendingLine: filePath === null ? null : line,
    });
  },

  clearPendingLine: () => set({ pendingLine: null }),

  setPanelOpen: (open: boolean) => set({ panelOpen: open }),

  toggleDirectory: (dirPath: string) => {
    set((s) => {
      const next = new Set(s.expandedDirs);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return { expandedDirs: next };
    });
  },

  navigateUp: () => {
    const { rootDir } = get();
    if (!rootDir || rootDir === '/') return;
    const parent = rootDir.substring(0, rootDir.lastIndexOf('/')) || '/';
    get().setRootDir(parent);
  },
}));
