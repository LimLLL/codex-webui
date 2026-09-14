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
  /** Expanded directory paths for tree state. */
  expandedDirs: Set<string>;
  setRootDir: (dir: string | null) => void;
  selectFile: (filePath: string | null) => void;
  toggleDirectory: (dirPath: string) => void;
  navigateUp: () => void;
}

export const useFilesStore = create<FilesState>((set, get) => ({
  rootDir: null,
  selectedFile: null,
  expandedDirs: new Set<string>(),

  setRootDir: (dir: string | null) => {
    if (dir === get().rootDir) return;
    set({
      rootDir: dir,
      selectedFile: null,
      expandedDirs: new Set<string>(),
    });
  },

  /** Selects the standalone browser's view; document and reveal ownership live outside the tree. */
  selectFile: (filePath) => set({ selectedFile: filePath }),

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
