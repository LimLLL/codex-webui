/**
 * Zustand store for file browser state.
 * Manages file tree navigation and open file content.
 * Root directory comes from the active thread's cwd.
 */
import { create } from 'zustand';
import { api, type FileEntry } from '../api';

interface TreeNode extends FileEntry {
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
}

interface FilesState {
  /** Current root directory (from thread cwd). */
  rootDir: string | null;
  /** Tree nodes keyed by directory path. */
  tree: Map<string, TreeNode[]>;
  /** Currently selected file path. */
  selectedFile: string | null;
  /** Content of the currently open file. */
  fileContent: string | null;
  /** Mtime of currently open file (for conflict detection). */
  fileMtime: number | null;
  /** Whether the file panel is visible. */
  panelOpen: boolean;
  /** Whether file content is being loaded. */
  loadingFile: boolean;

  /** Sets root directory and loads its contents. */
  setRootDir: (dir: string | null) => Promise<void>;
  loadDirectory: (dirPath: string) => Promise<void>;
  toggleDirectory: (dirPath: string) => void;
  selectFile: (filePath: string) => Promise<void>;
  saveFile: (content: string) => Promise<void>;
  deletePath: (targetPath: string) => Promise<void>;
  navigateUp: () => Promise<void>;
  setPanelOpen: (open: boolean) => void;
}

export const useFilesStore = create<FilesState>((set, get) => ({
  rootDir: null,
  tree: new Map(),
  selectedFile: null,
  fileContent: null,
  fileMtime: null,
  panelOpen: false,
  loadingFile: false,

  setRootDir: async (dir: string | null) => {
    if (dir === get().rootDir) return;
    set({ rootDir: dir, tree: new Map(), selectedFile: null, fileContent: null });
    if (dir) {
      // Register cwd as workspace root so backend allows access
      await api.addWorkspaceRoot(dir);
      await get().loadDirectory(dir);
    }
  },

  loadDirectory: async (dirPath: string) => {
    try {
      const entries = await api.getFileTree(dirPath);
      const nodes: TreeNode[] = entries.map((e) => ({
        ...e,
        expanded: false,
        loading: false,
      }));
      set((s) => {
        const next = new Map(s.tree);
        next.set(dirPath, nodes);
        return { tree: next };
      });
    } catch {
      /* silently fail */
    }
  },

  toggleDirectory: (dirPath: string) => {
    const { tree, loadDirectory } = get();
    const parent = findParentOf(tree, dirPath);
    if (!parent) return;

    const node = parent.find((n) => n.path === dirPath);
    if (!node || node.type !== 'directory') return;

    if (!node.expanded && !tree.has(dirPath)) {
      void loadDirectory(dirPath);
    }

    set((s) => {
      const nextTree = new Map(s.tree);
      for (const [key, nodes] of nextTree) {
        const idx = nodes.findIndex((n) => n.path === dirPath);
        if (idx >= 0) {
          const updated = [...nodes];
          updated[idx] = { ...updated[idx], expanded: !updated[idx].expanded };
          nextTree.set(key, updated);
          break;
        }
      }
      return { tree: nextTree };
    });
  },

  selectFile: async (filePath: string) => {
    set({ selectedFile: filePath, loadingFile: true, panelOpen: true });
    try {
      const res = await api.readFile(filePath);
      set({ fileContent: res.content, fileMtime: null, loadingFile: false });
      const meta = await api.getFileMetadata(filePath);
      set({ fileMtime: meta.mtime });
    } catch {
      set({ fileContent: null, loadingFile: false });
    }
  },

  saveFile: async (content: string) => {
    const { selectedFile, fileMtime } = get();
    if (!selectedFile) return;
    try {
      const res = await api.writeFile(
        selectedFile,
        content,
        fileMtime ?? undefined,
      );
      set({ fileMtime: res.mtime, fileContent: content });
    } catch (err) {
      console.error('Save failed:', err);
    }
  },

  deletePath: async (targetPath: string) => {
    try {
      await api.deleteFile(targetPath);
      // Reload the parent directory
      const parent = targetPath.substring(0, targetPath.lastIndexOf('/'));
      if (parent) {
        await get().loadDirectory(parent);
      }
      // Clear selection if deleted file was selected
      if (get().selectedFile === targetPath) {
        set({ selectedFile: null, fileContent: null });
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  },

  navigateUp: async () => {
    const { rootDir } = get();
    if (!rootDir || rootDir === '/') return;
    const parent = rootDir.substring(0, rootDir.lastIndexOf('/')) || '/';
    await get().setRootDir(parent);
  },

  setPanelOpen: (open: boolean) => set({ panelOpen: open }),
}));

/** Finds the parent node list that contains a node with the given path. */
function findParentOf(
  tree: Map<string, TreeNode[]>,
  targetPath: string,
): TreeNode[] | null {
  for (const nodes of tree.values()) {
    if (nodes.some((n) => n.path === targetPath)) return nodes;
  }
  return null;
}
