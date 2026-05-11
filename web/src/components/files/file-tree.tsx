/**
 * Recursive file tree component with lazy-loading directories.
 * Uses TanStack Query for data, Zustand for UI state.
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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  filesReadTreeOptions,
  filesDeletePathMutation,
  filesReadTreeQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { useFilesStore } from '@/stores/files-store';
import { cn } from '@/lib/utils';

interface FileTreeProps {
  /** Optional override for file click. If not provided, uses store's selectFile. */
  onFileClick?: (filePath: string) => void;
}

export function FileTree({ onFileClick }: FileTreeProps = {}) {
  const { t } = useTranslation();
  const rootDir = useFilesStore((s) => s.rootDir);
  const selectedFile = useFilesStore((s) => s.selectedFile);
  const navigateUp = useFilesStore((s) => s.navigateUp);

  if (!rootDir) {
    return (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
        {t('No workspace directory')}
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
          onClick={() => navigateUp()}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title={t('Go up')}
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
  depth: number;
  selectedFile: string | null;
  onFileClick?: (filePath: string) => void;
}

function DirectoryContents({ dirPath, depth, selectedFile, onFileClick }: DirectoryContentsProps) {
  const { t } = useTranslation();
  const toggleDirectory = useFilesStore((s) => s.toggleDirectory);
  const defaultSelectFile = useFilesStore((s) => s.selectFile);
  const expandedDirs = useFilesStore((s) => s.expandedDirs);
  const queryClient = useQueryClient();
  const handleFileClick = onFileClick ?? ((p: string) => defaultSelectFile(p));

  const { data: children, isLoading } = useQuery({
    ...filesReadTreeOptions({ query: { root: dirPath } }),
  });

  const deletePath = useMutation({
    ...filesDeletePathMutation(),
    onSuccess: (_res, variables) => {
      const deletedPath = variables.query!.path;
      void queryClient.invalidateQueries({ queryKey: filesReadTreeQueryKey({ query: { root: dirPath } }) });
      if (selectedFile === deletedPath || selectedFile?.startsWith(`${deletedPath}/`)) {
        defaultSelectFile(null);
      }
    },
  });

  if (isLoading) {
    return (
      <div
        className="flex items-center gap-1 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('Loading...')}
      </div>
    );
  }

  if (!children) return null;

  return (
    <>
      {children.map((entry) => {
        if (entry.type === 'directory') {
          const isExpanded = expandedDirs.has(entry.path);
          return (
            <div key={entry.path}>
              <TreeRow
                depth={depth}
                icon="directory"
                name={entry.name}
                expanded={isExpanded}
                selected={false}
                onClick={() => toggleDirectory(entry.path)}
                onDelete={() => deletePath.mutate({ query: { path: entry.path } })}
              />
              {isExpanded && (
                <DirectoryContents
                  dirPath={entry.path}
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
            onDelete={() => deletePath.mutate({ query: { path: entry.path } })}
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
  const { t } = useTranslation();
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
        title={t('Delete')}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
