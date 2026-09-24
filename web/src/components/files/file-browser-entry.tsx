/** One flat-browser entry: dragging, file-drop upload, contextual actions and rename. */
import { useCallback, useRef, useState } from 'react';
import { ChevronRight, File, Folder } from 'lucide-react';
import { useDraggable, useDroppable } from '@dnd-kit/react';
import { Feedback } from '@dnd-kit/dom';
import type { useFileOperations } from '@/hooks/use-file-operations';
import type { InlineFileEdit as InlineEdit } from '@/hooks/use-inline-file-edit';
import { cn } from '@/lib/utils';
import { InlineEntryEditor } from './inline-entry-editor';
import { FileContextMenu } from './file-context-menu';
type EntryType = 'file' | 'directory';

interface FileBrowserEntryProps {
  icon: EntryType;
  name: string;
  path: string;
  selected: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  openDialog: (
    type: 'copy' | 'move' | 'delete' | null,
    path: string,
    name: string,
    typeOfEntry: EntryType,
  ) => void;
  ops: ReturnType<typeof useFileOperations>;
  onUpload: (files: FileList, destinationPath: string) => void;
  edit: InlineEdit | null;
  setEdit: (edit: Omit<InlineEdit, 'id' | 'pending' | 'error'> | null) => void;
  commitEdit: (value: string) => void;
  onNavigateCreate: (kind: 'newFile' | 'newFolder') => void;
}

/** Keeps dnd-kit on the outer div and native upload/menu/keyboard interaction on the entry. */
export function FileBrowserEntry({
  icon,
  name,
  path: entryPath,
  selected,
  onClick,
  onDoubleClick,
  openDialog,
  ops,
  onUpload,
  edit,
  setEdit,
  commitEdit,
  onNavigateCreate,
}: FileBrowserEntryProps) {
  const isDir = icon === 'directory';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { ref: dragRef, isDragging } = useDraggable({
    id: `drag-${entryPath}`,
    data: { path: entryPath, name, type: icon },
    plugins: [Feedback.configure({ feedback: 'clone' })],
  });
  const { ref: dropRef, isDropTarget } = useDroppable({
    id: `drop-${entryPath}`,
    disabled: !isDir,
    data: { path: entryPath },
  });
  const mergedRef = useCallback(
    (element: HTMLDivElement | null) => {
      dragRef(element);
      if (isDir) dropRef(element);
    },
    [dragRef, dropRef, isDir],
  );
  const rowEditing = edit?.kind === 'rename' && edit.targetPath === entryPath;
  const actions = {
    onNewFile: isDir ? () => onNavigateCreate('newFile') : undefined,
    onNewFolder: isDir ? () => onNavigateCreate('newFolder') : undefined,
    onRename: () =>
      setEdit({
        kind: 'rename',
        parentPath: entryPath.slice(0, entryPath.lastIndexOf('/')) || '/',
        targetPath: entryPath,
        initialValue: name,
        selectBaseName: !isDir,
      }),
    onCopy: () => openDialog('copy', entryPath, name, icon),
    onMove: () => openDialog('move', entryPath, name, icon),
    onDelete: () => openDialog('delete', entryPath, name, icon),
    onRefresh: () => ops.refresh(entryPath, icon),
    onDownload: !isDir ? () => void ops.downloadFile(entryPath) : undefined,
    onUploadFiles: isDir ? () => fileInputRef.current?.click() : undefined,
    onUploadFolder: isDir ? () => folderInputRef.current?.click() : undefined,
    onAttachToChat: () =>
      window.dispatchEvent(
        new CustomEvent('codex-webui:attach-file', {
          detail: { name, path: entryPath },
        }),
      ),
  };
  const handleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) onUpload(event.target.files, entryPath);
    event.target.value = '';
  };
  return (
    <div
      ref={mergedRef}
      onDragOver={(event) => {
        if (isDir && event.dataTransfer.types.includes('Files'))
          event.preventDefault();
      }}
      onDrop={(event) => {
        if (!isDir || !event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        onUpload(event.dataTransfer.files, entryPath);
      }}
      className={cn(
        'flex w-full items-center gap-1.5 px-3 py-1 text-xs transition-colors hover:bg-accent/50',
        selected && 'bg-accent text-accent-foreground',
        isMenuOpen && !selected && 'bg-accent/60',
        isDropTarget && isDir && 'bg-primary/15 ring-1 ring-primary/40',
        isDragging && 'opacity-40',
      )}
    >
      <FileContextMenu
        type={icon}
        actions={actions}
        onOpenChange={setIsMenuOpen}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (onDoubleClick) onDoubleClick();
              else onClick();
            }
          }}
          className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 text-left"
        >
          {isDir ? (
            <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          ) : (
            <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {rowEditing ? (
            <InlineEntryEditor
              key={edit.id}
              initialValue={edit.initialValue}
              selectBaseName={edit.selectBaseName}
              pending={edit.pending}
              error={edit.error}
              onCommit={commitEdit}
              onCancel={() => setEdit(null)}
            />
          ) : (
            <span className="min-w-0 truncate">{name}</span>
          )}
          {isDir && (
            <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/50" />
          )}
        </div>
      </FileContextMenu>
      {isDir && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleUpload}
          />
          <input
            ref={folderInputRef}
            type="file"
            {...{ webkitdirectory: '', directory: '' }}
            multiple
            className="hidden"
            onChange={handleUpload}
          />
        </>
      )}
    </div>
  );
}
