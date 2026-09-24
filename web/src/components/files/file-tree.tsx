/** Flat Explorer-style browser with drag/drop, context menus, and inline edits. */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Folder, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DragDropProvider } from '@dnd-kit/react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { filesReadTreeOptions } from '@/generated/api/@tanstack/react-query.gen';
import { useFilesStore } from '@/stores/files-store';
import { useFileOperations } from '@/hooks/use-file-operations';
import {
  useInlineFileEdit,
  type InlineFileEdit,
} from '@/hooks/use-inline-file-edit';
import { showSnackbar } from '@/stores/snackbar-store';
import { useFileWatch } from '@/hooks/use-file-watch';
import { FileListingContextMenu } from './file-context-menu';
import { FileBrowserEntry } from './file-browser-entry';
import { FileToolbar } from './file-toolbar';
import { DeleteConfirmDialog, FilePathDialog } from './file-dialogs';
import { DirectorySelectionTree } from './directory-selection-tree';
import { InlineEntryEditor } from './inline-entry-editor';

type EntryType = 'file' | 'directory';
type InlineEdit = InlineFileEdit;
interface NavigationEdit {
  targetPath: string;
  kind: 'newFile' | 'newFolder';
  previousRoot: string;
  previousSelection: string | null;
}
interface DialogState {
  type: 'copy' | 'move' | 'delete' | null;
  entryPath: string;
  entryName: string;
  entryType: EntryType;
}
const CLOSED: DialogState = {
  type: null,
  entryPath: '',
  entryName: '',
  entryType: 'file',
};

interface FileTreeProps {
  onFileClick?: (filePath: string) => void;
}

/** Owns flat navigation and delegates layout-independent edits and entry actions. */
export function FileTree({ onFileClick }: FileTreeProps = {}) {
  const { t } = useTranslation();
  const rootDir = useFilesStore((s) => s.rootDir);
  const setRootDir = useFilesStore((s) => s.setRootDir);
  const selectedFile = useFilesStore((s) => s.selectedFile);
  const selectFile = useFilesStore((s) => s.selectFile);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadFolderInputRef = useRef<HTMLInputElement>(null);
  const inline = useInlineFileEdit();
  const { edit, ops, cancel } = inline;
  const setEdit = (
    request: Omit<InlineEdit, 'id' | 'pending' | 'error'> | null,
  ) => (request ? inline.start(request) : inline.cancel());
  const [dialog, setDialog] = useState<DialogState>(CLOSED);
  const [navigationEdit, setNavigationEdit] = useState<NavigationEdit | null>(
    null,
  );
  useEffect(
    () =>
      useFilesStore.subscribe((next, previous) => {
        if (next.rootDir === previous.rootDir) return;
        cancel();
        setNavigationEdit((pending) =>
          pending?.targetPath === next.rootDir ? pending : null,
        );
      }),
    [cancel],
  );

  const openDialog = (
    type: DialogState['type'],
    entryPath: string,
    entryName: string,
    entryType: EntryType,
  ) => setDialog({ type, entryPath, entryName, entryType });
  const closeDialog = () => setDialog(CLOSED);

  const startRowCreate = (
    targetPath: string,
    kind: 'newFile' | 'newFolder',
  ) => {
    if (!rootDir) return;
    inline.cancel();
    setNavigationEdit({
      targetPath,
      kind,
      previousRoot: rootDir,
      previousSelection: selectedFile,
    });
    setRootDir(targetPath);
  };

  const startBackgroundCreate = (kind: 'newFile' | 'newFolder') => {
    if (rootDir) setEdit({ kind, parentPath: rootDir });
  };

  const commitEdit = (value: string) => {
    void inline.commit(value);
  };
  const navigate = (path: string) => {
    inline.cancel();
    setNavigationEdit(null);
    setRootDir(path);
  };

  const handleUpload = (files: FileList, destinationPath: string) => {
    const formData = new FormData();
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const relativePath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
        file.name;
      formData.append('files', file, relativePath);
    }
    ops.uploadFiles.mutate({ destinationPath, formData });
  };

  const handleDragEnd = useCallback(
    (event: {
      canceled: boolean;
      operation: {
        source: { data?: Record<string, unknown> } | null;
        target: { data?: Record<string, unknown> } | null;
      };
    }) => {
      if (event.canceled) return;
      const { source, target } = event.operation;
      const sourcePath = source?.data?.path as string | undefined;
      const targetDir = target?.data?.path as string | undefined;
      if (
        !sourcePath ||
        !targetDir ||
        sourcePath === targetDir ||
        targetDir.startsWith(`${sourcePath}/`)
      )
        return;
      if (sourcePath.slice(0, sourcePath.lastIndexOf('/')) === targetDir)
        return;
      const name = sourcePath.split('/').pop() ?? '';
      ops.movePath.mutate({
        body: { sourcePath, destinationPath: `${targetDir}/${name}` },
      });
    },
    [ops],
  );

  if (!rootDir)
    return (
      <div className="space-y-2 px-3 py-4 text-xs">
        <p>{t('No workspace directory')}</p>
        <DirectorySelectionTree
          selectedPath={null}
          onSelectedPathChange={setRootDir}
        />
      </div>
    );
  const handleClick = onFileClick ?? ((path: string) => selectFile(path));

  return (
    <>
      <FileToolbar onUpload={handleUpload} />
      <FileListingContextMenu
        actions={{
          onNewFile: () => startBackgroundCreate('newFile'),
          onNewFolder: () => startBackgroundCreate('newFolder'),
          onUploadFiles: () => uploadInputRef.current?.click(),
          onUploadFolder: () => uploadFolderInputRef.current?.click(),
          onRefresh: () => ops.refresh(rootDir, 'directory'),
        }}
      >
        <ScrollArea
          className="min-h-0 flex-1"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files'))
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            handleUpload(event.dataTransfer.files, rootDir);
          }}
        >
          <DragDropProvider onDragEnd={handleDragEnd}>
            <FlatDirectory
              dirPath={rootDir}
              selectedFile={selectedFile}
              onFileClick={handleClick}
              onDirClick={navigate}
              openDialog={openDialog}
              ops={ops}
              onUpload={handleUpload}
              edit={edit?.parentPath === rootDir ? edit : null}
              setEdit={setEdit}
              commitEdit={commitEdit}
              navigationEdit={navigationEdit}
              onNavigationReady={(kind) => {
                setNavigationEdit(null);
                setEdit({ kind, parentPath: rootDir });
              }}
              onNavigationFailed={() => {
                if (navigationEdit && rootDir === navigationEdit.targetPath) {
                  setRootDir(navigationEdit.previousRoot);
                  selectFile(navigationEdit.previousSelection);
                }
                setNavigationEdit(null);
                inline.cancel();
                showSnackbar(t('Cannot load directories'), 'error');
              }}
              onRowCreate={startRowCreate}
            />
          </DragDropProvider>
        </ScrollArea>
      </FileListingContextMenu>
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length)
            handleUpload(event.target.files, rootDir);
          event.target.value = '';
        }}
      />
      <input
        ref={uploadFolderInputRef}
        type="file"
        multiple
        className="hidden"
        {...{ webkitdirectory: '', directory: '' }}
        onChange={(event) => {
          if (event.target.files?.length)
            handleUpload(event.target.files, rootDir);
          event.target.value = '';
        }}
      />

      <FilePathDialog
        open={dialog.type === 'copy'}
        onOpenChange={(open) => !open && closeDialog()}
        title={t('Copy to...')}
        description={t('Select destination directory')}
        onConfirm={(dest) =>
          ops.copyPath.mutate({
            body: {
              sourcePath: dialog.entryPath,
              destinationPath: `${dest}/${dialog.entryName}`,
            },
          })
        }
      />
      <FilePathDialog
        open={dialog.type === 'move'}
        onOpenChange={(open) => !open && closeDialog()}
        title={t('Move to...')}
        description={t('Select destination directory')}
        onConfirm={(dest) =>
          ops.movePath.mutate({
            body: {
              sourcePath: dialog.entryPath,
              destinationPath: `${dest}/${dialog.entryName}`,
            },
          })
        }
      />
      <DeleteConfirmDialog
        open={dialog.type === 'delete'}
        onOpenChange={(open) => !open && closeDialog()}
        entryName={dialog.entryName}
        isDirectory={dialog.entryType === 'directory'}
        onConfirm={(recursive) => {
          ops.deletePath.mutate({
            query: {
              path: dialog.entryPath,
              recursive: recursive || undefined,
            },
          });
          closeDialog();
        }}
      />
    </>
  );
}

interface FlatDirectoryProps {
  dirPath: string;
  selectedFile: string | null;
  onFileClick: (path: string) => void;
  onDirClick: (path: string) => void;
  openDialog: (
    type: DialogState['type'],
    path: string,
    name: string,
    entryType: EntryType,
  ) => void;
  ops: ReturnType<typeof useFileOperations>;
  onUpload: (files: FileList, destinationPath: string) => void;
  edit: InlineEdit | null;
  setEdit: (edit: Omit<InlineEdit, 'id' | 'pending' | 'error'> | null) => void;
  commitEdit: (value: string) => void;
  navigationEdit: NavigationEdit | null;
  onNavigationReady: (kind: 'newFile' | 'newFolder') => void;
  onNavigationFailed: () => void;
  onRowCreate: (targetPath: string, kind: 'newFile' | 'newFolder') => void;
}

/** Gates navigation-created rows on a successful directory read and leases the visible scope. */
function FlatDirectory(props: FlatDirectoryProps) {
  const { t } = useTranslation();
  const query = useQuery({
    ...filesReadTreeOptions({ query: { root: props.dirPath } }),
  });
  useFileWatch(props.dirPath);
  const mountedNavigation = props.navigationEdit?.targetPath === props.dirPath;
  const navigationKind = props.navigationEdit?.kind;
  // The callbacks are rebuilt by the parent on every render, so depending on
  // them would run this effect continuously. Reading the latest pair through a
  // ref keeps the dependency list to the query facts that actually decide the
  // outcome, without ever invoking a stale closure.
  const navigationHandlers = useRef({
    ready: props.onNavigationReady,
    failed: props.onNavigationFailed,
  });
  // Refreshed in its own effect rather than during render, and declared first so
  // the outcome effect below always reads the pair from the render it belongs to.
  useEffect(() => {
    navigationHandlers.current = {
      ready: props.onNavigationReady,
      failed: props.onNavigationFailed,
    };
  });
  const { isError, isFetching, data } = query;
  useEffect(() => {
    if (!mountedNavigation || !navigationKind) return;
    if (isError) navigationHandlers.current.failed();
    else if (!isFetching && data) navigationHandlers.current.ready(navigationKind);
  }, [mountedNavigation, navigationKind, isError, isFetching, data]);

  // The pending create row renders in every listing state. Creating does not
  // depend on reading: a directory that failed to list can still accept a new
  // entry, and the editor carries its own pending and error state, so hiding it
  // behind a successful read would make the menu action silently do nothing.
  const createRow = props.edit &&
    (props.edit.kind === 'newFile' || props.edit.kind === 'newFolder') &&
    props.edit.parentPath === props.dirPath && (
      <div className="flex items-center gap-1 px-3 py-1 text-xs">
        <Folder className="h-3.5 w-3.5 text-blue-400" />
        <InlineEntryEditor
          key={props.edit.id}
          initialValue={props.edit.initialValue}
          pending={props.edit.pending}
          error={props.edit.error}
          onCommit={props.commitEdit}
          onCancel={() => props.setEdit(null)}
        />
      </div>
    );

  return (
    <div className="py-1">
      {query.isLoading && (
        <div className="flex items-center gap-1 px-3 py-4 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('Loading...')}
        </div>
      )}
      {isError && (
        <div className="px-3 py-8 text-center text-xs text-destructive">
          {t('Cannot load directories')}
        </div>
      )}
      {data?.map((entry) => (
        <FileBrowserEntry
          key={entry.path}
          icon={entry.type === 'directory' ? 'directory' : 'file'}
          name={entry.name}
          path={entry.path}
          selected={entry.path === props.selectedFile}
          onClick={() => entry.type === 'file' && props.onFileClick(entry.path)}
          onDoubleClick={
            entry.type === 'directory'
              ? () => props.onDirClick(entry.path)
              : undefined
          }
          openDialog={props.openDialog}
          ops={props.ops}
          onUpload={props.onUpload}
          edit={props.edit}
          setEdit={props.setEdit}
          commitEdit={props.commitEdit}
          onNavigateCreate={(kind) => props.onRowCreate(entry.path, kind)}
        />
      ))}
      {createRow}
      {!query.isLoading && !isError && !data?.length && !props.edit && (
        <div className="px-3 py-8 text-center text-xs italic text-muted-foreground">
          {t('Empty directory')}
        </div>
      )}
    </div>
  );
}
