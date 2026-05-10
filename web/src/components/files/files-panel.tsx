/**
 * Full-screen file browser panel (global view): tree sidebar + file viewer.
 * Root directory is managed by App.tsx.
 */
import { FileTree } from './file-tree';
import { FileViewer } from './file-viewer';
import { useFilesStore } from '@/stores/files-store';

export function FilesPanel() {
  const selectedFile = useFilesStore((s) => s.selectedFile);
  const rootDir = useFilesStore((s) => s.rootDir);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-56 shrink-0 flex-col border-r border-border bg-muted/20">
        <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
          Explorer
        </div>
        {rootDir && (
          <div className="truncate border-b border-border px-3 pb-1.5 text-xs text-muted-foreground/60">
            {rootDir}
          </div>
        )}
        <FileTree />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {selectedFile ? (
          <FileViewer />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a file to view
          </div>
        )}
      </div>
    </div>
  );
}
