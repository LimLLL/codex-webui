/**
 * Recursive file tree component with lazy-loading directories.
 * Includes breadcrumb navigation and delete support.
 */
import {
  ChevronRight,
  ChevronUp,
  File,
  Folder,
  FolderOpen,
  Loader2,
  Trash2,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFilesStore } from '@/stores/files-store';
import { cn } from '@/lib/utils';

interface FileTreeProps {
  /** Optional override for file click. If not provided, uses store's selectFile. */
  onFileClick?: (filePath: string) => void;
}

export function FileTree({ onFileClick }: FileTreeProps = {}) {
  const rootDir = useFilesStore((s) => s.rootDir);
  const tree = useFilesStore((s) => s.tree);
  const selectedFile = useFilesStore((s) => s.selectedFile);
  const navigateUp = useFilesStore((s) => s.navigateUp);

  if (!rootDir) {
    return (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
        No workspace directory
      </div>
    );
  }

  const dirName = rootDir.split('/').pop() || rootDir;

  return (
    <>
      {/* Breadcrumb */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <button
          type="button"
          onClick={() => void navigateUp()}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title="Go up"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <span className="truncate text-xs text-muted-foreground" title={rootDir}>
          {dirName}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="py-1">
          <DirectoryContents
            dirPath={rootDir}
            tree={tree}
            depth={0}
            selectedFile={selectedFile}
            onFileClick={onFileClick}
          />
        </div>
      </ScrollArea>
    </>
  );
}

interface DirectoryContentsProps {
  dirPath: string;
  tree: Map<string, { name: string; path: string; type: string; expanded?: boolean }[]>;
  depth: number;
  selectedFile: string | null;
  onFileClick?: (filePath: string) => void;
}

function DirectoryContents({ dirPath, tree, depth, selectedFile, onFileClick }: DirectoryContentsProps) {
  const toggleDirectory = useFilesStore((s) => s.toggleDirectory);
  const defaultSelectFile = useFilesStore((s) => s.selectFile);
  const deletePath = useFilesStore((s) => s.deletePath);
  const handleFileClick = onFileClick ?? ((p: string) => void defaultSelectFile(p));

  const children = tree.get(dirPath);
  if (!children) {
    return (
      <div
        className="flex items-center gap-1 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading...
      </div>
    );
  }

  return (
    <>
      {children.map((entry) => {
        if (entry.type === 'directory') {
          const isExpanded = entry.expanded ?? false;
          return (
            <div key={entry.path}>
              <TreeRow
                depth={depth}
                icon="directory"
                name={entry.name}
                expanded={isExpanded}
                selected={false}
                onClick={() => toggleDirectory(entry.path)}
                onDelete={() => void deletePath(entry.path)}
              />
              {isExpanded && (
                <DirectoryContents
                  dirPath={entry.path}
                  tree={tree}
                  depth={depth + 1}
                  selectedFile={selectedFile}
                  onFileClick={onFileClick}
                />
              )}
            </div>
          );
        }
        return (
          <TreeRow
            key={entry.path}
            depth={depth}
            icon="file"
            name={entry.name}
            selected={entry.path === selectedFile}
            onClick={() => handleFileClick(entry.path)}
            onDelete={() => void deletePath(entry.path)}
          />
        );
      })}
    </>
  );
}

interface TreeRowProps {
  depth: number;
  icon: 'file' | 'directory';
  name: string;
  expanded?: boolean;
  selected: boolean;
  onClick: () => void;
  onDelete: () => void;
}

function TreeRow({ depth, icon, name, expanded, selected, onClick, onDelete }: TreeRowProps) {
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-1 py-0.5 text-xs transition-colors hover:bg-accent/50',
        selected && 'bg-accent text-accent-foreground',
      )}
      style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: 4 }}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
      >
        {icon === 'directory' ? (
          <>
            <ChevronRight
              className={cn(
                'h-3 w-3 shrink-0 transition-transform',
                expanded && 'rotate-90',
              )}
            />
            {expanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-400" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
            )}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="min-w-0 truncate">{name}</span>
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/20 hover:text-destructive group-hover:opacity-100"
        title="Delete"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
