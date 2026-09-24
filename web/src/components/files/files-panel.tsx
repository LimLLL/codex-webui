/**
 * Full-screen file browser panel (global view): tree sidebar + file viewer.
 * Desktop: inline tree sidebar (w-56) + viewer.
 * Mobile/Tablet: tree in Sheet overlay, viewer full-width with toggle button.
 */
import { useState } from 'react';
import { FolderTree } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { useDocumentStore } from '@/stores/document-store';
import { useFilesStore } from '@/stores/files-store';
import { FileTree } from './file-tree';
import { FileViewer } from './file-viewer';
import { fileViewId } from '@/stores/workspace-store';

/** Shared file tree header + tree component. */
function FileTreeSidebar({
  rootDir,
  onFileClick,
}: {
  rootDir: string | null;
  onFileClick?: (filePath: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="shrink-0 px-3 py-2 text-xs font-medium text-muted-foreground">
        {t('Explorer')}
      </div>
      {rootDir && (
        <div className="shrink-0 truncate border-b border-border px-3 pb-1.5 text-xs text-muted-foreground/60">
          {rootDir}
        </div>
      )}
      <FileTree onFileClick={onFileClick} />
    </>
  );
}

export function FilesPanel() {
  const { t } = useTranslation();
  const selectedFile = useFilesStore((s) => s.selectedFile);
  const documentId = useDocumentStore((state) =>
    selectedFile ? state.pathIndex[selectedFile] : undefined,
  );
  const rootDir = useFilesStore((s) => s.rootDir);
  const selectFile = useFilesStore((s) => s.selectFile);
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  const [treeSheetOpen, setTreeSheetOpen] = useState(false);

  // Mobile: select file and close the tree Sheet
  const handleMobileFileClick = (filePath: string) => {
    selectFile(filePath);
    setTreeSheetOpen(false);
  };

  const viewerContent = selectedFile ? (
    <FileViewer
      key={documentId ?? selectedFile}
      filePath={selectedFile}
      documentId={documentId}
      viewId={fileViewId('files', documentId ?? selectedFile)}
    />
  ) : (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {t('Select a file to view')}
    </div>
  );

  if (isDesktop) {
    return (
      <div className="flex min-h-0 flex-1">
        <div className="flex w-56 shrink-0 flex-col border-r border-border bg-muted/20">
          <FileTreeSidebar rootDir={rootDir} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">{viewerContent}</div>
      </div>
    );
  }

  // Mobile/Tablet: file tree in Sheet, viewer full-width
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5"
          onClick={() => setTreeSheetOpen(true)}
        >
          <FolderTree className="h-4 w-4" />
          {t('Explorer')}
        </Button>
        {rootDir && (
          <span className="truncate text-xs text-muted-foreground/60">
            {rootDir}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">{viewerContent}</div>

      <Sheet open={treeSheetOpen} onOpenChange={setTreeSheetOpen}>
        <SheetContent
          side="left"
          className="!w-[280px] p-0 sm:!max-w-[320px]"
          showCloseButton={false}
        >
          <SheetTitle className="sr-only">{t('File explorer')}</SheetTitle>
          <div className="flex h-full flex-col bg-muted/20">
            <FileTreeSidebar
              rootDir={rootDir}
              onFileClick={handleMobileFileClick}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
