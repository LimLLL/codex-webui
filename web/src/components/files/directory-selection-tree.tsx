/** Shared lazy directory selector used by workspace and copy/move dialogs. */
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  filesGetRootsOptions,
  filesReadTreeOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import {
  useInlineFileEdit,
  type InlineFileEdit,
} from '@/hooks/use-inline-file-edit';
import { useFileWatch } from '@/hooks/use-file-watch';
import { cn } from '@/lib/utils';
import {
  filePathChanges,
  pathIsWithin,
  remapFilePath,
  subscribeFileChanges,
} from '@/lib/file-change-events';
import { FileContextMenu } from './file-context-menu';
import { InlineEntryEditor } from './inline-entry-editor';

type EditState = InlineFileEdit;

export interface DirectorySelectionTreeProps {
  selectedPath: string | null;
  onSelectedPathChange: (path: string | null) => void;
  className?: string;
  showSelectedPath?: boolean;
}

/** Owns expansion and lazy queries while the caller owns semantic selection. */
export function DirectorySelectionTree({
  selectedPath,
  onSelectedPathChange,
  className,
  showSelectedPath = false,
}: DirectorySelectionTreeProps) {
  const { t } = useTranslation();
  const inline = useInlineFileEdit(onSelectedPathChange);
  const { edit, ops } = inline;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const rootsQuery = useQuery(filesGetRootsOptions());
  const rootPaths = useMemo(
    () => new Set(rootsQuery.data?.roots ?? []),
    [rootsQuery.data],
  );
  const roots = rootsQuery.data
    ? (Array.from(
        new Set([rootsQuery.data.homeDir, ...rootsQuery.data.roots]),
      ).filter(Boolean) as string[])
    : [];

  const toggle = (path: string) => {
    const collapsing = expanded.has(path);
    if (
      collapsing &&
      edit &&
      (pathIsWithin(edit.parentPath, path) ||
        (edit.targetPath ? pathIsWithin(edit.targetPath, path) : false))
    )
      inline.cancel();
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  useEffect(
    () =>
      subscribeFileChanges((batch) => {
        for (const change of filePathChanges(batch)) {
          if (change.kind === 'rename') {
            if (selectedPath)
              onSelectedPathChange(
                remapFilePath(selectedPath, change.oldPath, change.newPath) ??
                  selectedPath,
              );
            setExpanded(
              (current) =>
                new Set(
                  [...current].map(
                    (path) =>
                      remapFilePath(path, change.oldPath, change.newPath) ??
                      path,
                  ),
                ),
            );
          } else if (change.kind === 'delete') {
            if (selectedPath && pathIsWithin(selectedPath, change.path))
              onSelectedPathChange(null);
            setExpanded(
              (current) =>
                new Set(
                  [...current].filter(
                    (path) => !pathIsWithin(path, change.path),
                  ),
                ),
            );
          }
        }
      }),
    [selectedPath, onSelectedPathChange],
  );

  const startCreate = (parentPath: string) => {
    setExpanded((current) => new Set(current).add(parentPath));
    inline.start({ kind: 'newFolder', parentPath });
  };
  const startRename = (path: string, name: string) =>
    inline.start({
      kind: 'rename',
      parentPath: path.slice(0, path.lastIndexOf('/')) || '/',
      targetPath: path,
      initialValue: name,
    });
  const commitEdit = (value: string) => {
    void inline.commit(value);
  };

  return (
    <>
      <ScrollArea className={cn('h-64 rounded-md border', className)}>
        <div className="py-1">
          {rootsQuery.isLoading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('Loading...')}
            </div>
          ) : rootsQuery.isError || roots.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {t('Cannot load directories')}
            </div>
          ) : (
            roots.map((root) => (
              <DirectoryNode
                key={root}
                path={root}
                name={root.split('/').pop() || root}
                depth={0}
                selectedPath={selectedPath}
                expanded={expanded}
                rootPaths={rootPaths}
                edit={edit}
                onSelect={onSelectedPathChange}
                onToggle={toggle}
                onCreate={startCreate}
                onRename={startRename}
                onDelete={setDeleteTarget}
                onRefresh={(path) => ops.refresh(path, 'directory')}
                onCommit={commitEdit}
                onCancel={inline.cancel}
              />
            ))
          )}
        </div>
      </ScrollArea>
      {showSelectedPath && selectedPath && (
        <div className="truncate rounded bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground">
          {selectedPath}
        </div>
      )}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Are you sure you want to delete the directory "{{name}}" and all its contents?',
                { name: deleteTarget?.name },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteTarget) return;
                ops.deletePath.mutate(
                  { query: { path: deleteTarget.path, recursive: true } },
                  { onSettled: () => setDeleteTarget(null) },
                );
              }}
            >
              {t('Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface DirectoryNodeProps {
  path: string;
  name: string;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  rootPaths: Set<string>;
  edit: EditState | null;
  onSelect: (path: string | null) => void;
  onToggle: (path: string) => void;
  onCreate: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (target: { path: string; name: string }) => void;
  onRefresh: (path: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/** Renders one selectable directory and leases children only while expanded and mounted. */
function DirectoryNode({ path, name, depth, ...childProps }: DirectoryNodeProps) {
  // `path`/`name`/`depth` are deliberately destructured away rather than kept in
  // a spreadable bag: forwarding them into a child row would override the entry
  // being rendered with this row's own identity, and a node whose path equals its
  // parent's re-expands forever. JSX spread performs no excess-property check, so
  // the Omit in DirectoryChildrenProps cannot catch that on its own.
  const {
    selectedPath,
    expanded,
    rootPaths,
    edit,
    onSelect,
    onToggle,
    onCreate,
    onRename,
    onDelete,
    onRefresh,
    onCommit,
    onCancel,
  } = childProps;
  const isExpanded = expanded.has(path);
  const isEditing = edit?.kind === 'rename' && edit.targetPath === path;
  useFileWatch(path, isExpanded);
  const actions = {
    onNewFolder: () => onCreate(path),
    onRename: rootPaths.has(path) ? undefined : () => onRename(path, name),
    onDelete: rootPaths.has(path) ? undefined : () => onDelete({ path, name }),
    onRefresh: () => onRefresh(path),
  };
  return (
    <div>
      <FileContextMenu type="directory" actions={actions}>
        <div
          className={cn(
            'flex items-center gap-1 py-1 text-xs hover:bg-accent/50',
            selectedPath === path && 'bg-primary/10 text-primary',
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          role="button"
          tabIndex={0}
          aria-pressed={selectedPath === path}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(path);
            }
          }}
          onClick={() => onSelect(path)}
          onDoubleClick={() => onToggle(path)}
        >
          <button
            type="button"
            className="shrink-0 p-0.5"
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${name}`}
            aria-expanded={isExpanded}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(path);
            }}
          >
            <ChevronRight
              className={cn(
                'h-3 w-3 transition-transform',
                isExpanded && 'rotate-90',
              )}
            />
          </button>
          {isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          )}
          {isEditing ? (
            <InlineEntryEditor
              key={edit.id}
              initialValue={edit.initialValue}
              pending={edit.pending}
              error={edit.error}
              onCommit={onCommit}
              onCancel={onCancel}
            />
          ) : (
            <span className="min-w-0 truncate">{name}</span>
          )}
        </div>
      </FileContextMenu>
      {isExpanded && (
        <DirectoryChildren
          {...childProps}
          parentPath={path}
          depth={depth + 1}
        />
      )}
    </div>
  );
}

/** Lazily lists child directories, placing pending creation inside its true parent. */
function DirectoryChildren({
  parentPath,
  depth,
  ...props
}: Omit<DirectoryNodeProps, 'path' | 'name' | 'depth'> & {
  parentPath: string;
  depth: number;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    ...filesReadTreeOptions({ query: { root: parentPath } }),
  });
  if (query.isLoading)
    return (
      <div
        className="flex items-center gap-1 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('Loading...')}
      </div>
    );
  if (query.isError)
    return (
      <div
        className="py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {t('Cannot load directories')}
      </div>
    );
  const dirs = (query.data ?? []).filter((entry) => entry.type === 'directory');
  const createEdit =
    props.edit?.kind === 'newFolder' && props.edit.parentPath === parentPath;
  return (
    <>
      {createEdit && (
        <div
          className="flex items-center gap-1 py-1 text-xs"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <InlineEntryEditor
            key={props.edit?.id}
            pending={props.edit?.pending}
            error={props.edit?.error}
            onCommit={props.onCommit}
            onCancel={props.onCancel}
          />
        </div>
      )}
      {dirs.map((entry) => (
        // Identity last: the entry being rendered must win over anything the
        // inherited bag happens to carry.
        <DirectoryNode
          key={entry.path}
          {...props}
          path={entry.path}
          name={entry.name}
          depth={depth}
        />
      ))}
      {dirs.length === 0 && !createEdit && (
        <div
          className="py-1 text-xs italic text-muted-foreground"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {t('No subdirectories')}
        </div>
      )}
    </>
  );
}
