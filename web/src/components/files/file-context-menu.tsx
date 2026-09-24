/**
 * Right-click context menu for file tree entries.
 * Actions vary based on whether the target is a file or directory.
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  Download,
  FilePlus,
  FolderPlus,
  FolderUp,
  MessageSquarePlus,
  Move,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

export interface FileContextMenuActions {
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onRename?: () => void;
  onCopy?: () => void;
  onMove?: () => void;
  onDelete?: () => void;
  onRefresh?: () => void;
  onDownload?: () => void;
  onUploadFiles?: () => void;
  onUploadFolder?: () => void;
  onAttachToChat?: () => void;
}

interface FileContextMenuProps {
  type: 'file' | 'directory';
  actions: FileContextMenuActions;
  /** Called when context menu open state changes — for highlighting the target row. */
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Defers a chosen action until the menu has finished closing.
 *
 * Radix returns focus to the trigger on close. An action that mounts an inline
 * input must therefore run after that restoration is suppressed, or the row
 * steals focus back from the editor it just opened.
 *
 * @returns `select` to record the chosen action, and the `onCloseAutoFocus`
 *          handler that suppresses focus restoration and runs it.
 */
function useDeferredMenuAction(): {
  select: (action: (() => void) | undefined) => void;
  afterClose: (event: Event) => void;
} {
  const pendingAction = useRef<(() => void) | null>(null);
  return {
    select: (action) => {
      pendingAction.current = action ?? null;
    },
    afterClose: (event) => {
      const action = pendingAction.current;
      pendingAction.current = null;
      if (!action) return;
      event.preventDefault();
      requestAnimationFrame(action);
    },
  };
}

export function FileContextMenu({
  type,
  actions,
  onOpenChange,
  children,
}: FileContextMenuProps) {
  const { t } = useTranslation();
  const { select, afterClose } = useDeferredMenuAction();
  const isDir = type === 'directory';

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48" onCloseAutoFocus={afterClose}>
        {isDir && (actions.onNewFile || actions.onNewFolder) && (
          <>
            {actions.onNewFile && (
              <ContextMenuItem onSelect={() => select(actions.onNewFile)}>
                <FilePlus className="h-3.5 w-3.5" />
                {t('New File')}
              </ContextMenuItem>
            )}
            {actions.onNewFolder && (
              <ContextMenuItem onSelect={() => select(actions.onNewFolder)}>
                <FolderPlus className="h-3.5 w-3.5" />
                {t('New Folder')}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}
        {actions.onRename && (
          <ContextMenuItem onSelect={() => select(actions.onRename)}>
            <Pencil className="h-3.5 w-3.5" />
            {t('Rename')}
          </ContextMenuItem>
        )}
        {actions.onCopy && (
          <ContextMenuItem onSelect={() => select(actions.onCopy)}>
            <Copy className="h-3.5 w-3.5" />
            {t('Copy to...')}
          </ContextMenuItem>
        )}
        {actions.onMove && (
          <ContextMenuItem onSelect={() => select(actions.onMove)}>
            <Move className="h-3.5 w-3.5" />
            {t('Move to...')}
          </ContextMenuItem>
        )}
        {!isDir && actions.onDownload && (
          <ContextMenuItem onSelect={() => select(actions.onDownload)}>
            <Download className="h-3.5 w-3.5" />
            {t('Download')}
          </ContextMenuItem>
        )}
        {isDir && (actions.onUploadFiles || actions.onUploadFolder) && (
          <>
            <ContextMenuSeparator />
            {actions.onUploadFiles && (
              <ContextMenuItem onSelect={() => select(actions.onUploadFiles)}>
                <Upload className="h-3.5 w-3.5" />
                {t('Upload files here...')}
              </ContextMenuItem>
            )}
            {actions.onUploadFolder && (
              <ContextMenuItem onSelect={() => select(actions.onUploadFolder)}>
                <FolderUp className="h-3.5 w-3.5" />
                {t('Upload folder here...')}
              </ContextMenuItem>
            )}
          </>
        )}
        {actions.onAttachToChat && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => select(actions.onAttachToChat)}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
              {t('Attach to chat')}
            </ContextMenuItem>
          </>
        )}
        {actions.onRefresh && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => select(actions.onRefresh)}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('Refresh')}
            </ContextMenuItem>
          </>
        )}
        {actions.onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() => select(actions.onDelete)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('Delete')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Context menu for unused listing space, whose actions target the current directory. */
export function FileListingContextMenu({
  actions,
  children,
}: {
  actions: Pick<
    FileContextMenuActions,
    | 'onNewFile'
    | 'onNewFolder'
    | 'onUploadFiles'
    | 'onUploadFolder'
    | 'onRefresh'
  >;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { select, afterClose } = useDeferredMenuAction();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48" onCloseAutoFocus={afterClose}>
        {actions.onNewFile && (
          <ContextMenuItem onSelect={() => select(actions.onNewFile)}>
            <FilePlus className="h-3.5 w-3.5" />
            {t('New File')}
          </ContextMenuItem>
        )}
        {actions.onNewFolder && (
          <ContextMenuItem onSelect={() => select(actions.onNewFolder)}>
            <FolderPlus className="h-3.5 w-3.5" />
            {t('New Folder')}
          </ContextMenuItem>
        )}
        {(actions.onNewFile || actions.onNewFolder) && <ContextMenuSeparator />}
        {actions.onUploadFiles && (
          <ContextMenuItem onSelect={() => select(actions.onUploadFiles)}>
            <Upload className="h-3.5 w-3.5" />
            {t('Upload files here...')}
          </ContextMenuItem>
        )}
        {actions.onUploadFolder && (
          <ContextMenuItem onSelect={() => select(actions.onUploadFolder)}>
            <FolderUp className="h-3.5 w-3.5" />
            {t('Upload folder here...')}
          </ContextMenuItem>
        )}
        {actions.onRefresh && (
          <ContextMenuItem onSelect={() => select(actions.onRefresh)}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t('Refresh')}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
