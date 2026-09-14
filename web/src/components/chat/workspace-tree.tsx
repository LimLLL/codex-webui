/** Right-hand explorer with a divider preview: dragging never reflows the transcript. */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2 } from 'lucide-react';
import { FileTree } from '@/components/files/file-tree';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useFilesStore } from '@/stores/files-store';
import { useLayoutStore } from '@/stores/layout-store';
import { filesAddRoot } from '@/generated/api';

interface Props {
  cwd: string | null;
  desktop: boolean;
  mobileOpen: boolean;
  onMobileClose: () => void;
  onFile: (path: string) => void;
}

/** Adapts only explorer presentation; the conversation and tab content keep their tree positions. */
export function WorkspaceTree({
  cwd,
  desktop,
  mobileOpen,
  onMobileClose,
  onFile,
}: Props) {
  const { t } = useTranslation();
  const currentRoot = useFilesStore((s) => s.rootDir);
  const [adoptedCwd, setAdoptedCwd] = useState<string | null>(null);
  const collapsed = useLayoutStore((s) => s.workspaceTreeCollapsed);
  const width = useLayoutStore((s) => s.workspaceTreeWidth);
  const setCollapsed = useLayoutStore((s) => s.setWorkspaceTreeCollapsed);
  // This component shares the conversation's keyed lifetime. Adoption is
  // separate from navigation: browsing may move rootDir anywhere afterwards.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const adopt = () => {
      if (cancelled) return;
      useFilesStore.getState().setRootDir(cwd);
      setAdoptedCwd(cwd);
    };
    void filesAddRoot({
      body: { root: cwd },
      throwOnError: true,
      meta: { silent: true },
    }).then(adopt, adopt);
    // Rejection still adopts the requested directory so FileTree can display
    // its read error. A superseded request cannot replace the next root.
    return () => {
      cancelled = true;
    };
  }, [cwd]);
  const contents = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b px-3 text-xs font-medium">
        <span className="flex-1">{t('Explorer')}</span>
        <button
          type="button"
          aria-label={t('Close explorer')}
          onClick={() => (desktop ? setCollapsed(true) : onMobileClose())}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* Never compare the browsed root to cwd: entering folders and going up
          both change it. The adoption receipt prevents showing a prior
          conversation's tree while this one's metadata/request is pending. */}
      {cwd && adoptedCwd === cwd && currentRoot ? (
        <FileTree
          onFileClick={(path) => {
            onFile(path);
            onMobileClose();
          }}
        />
      ) : (
        <div
          role="status"
          className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('Loading...')}
        </div>
      )}
    </div>
  );
  if (!desktop)
    return (
      <Sheet
        open={mobileOpen}
        onOpenChange={(open) => !open && onMobileClose()}
      >
        <SheetContent
          side="right"
          className="!w-[min(85vw,360px)] p-0"
          showCloseButton={false}
        >
          <SheetTitle className="sr-only">{t('Explorer')}</SheetTitle>
          {contents}
        </SheetContent>
      </Sheet>
    );
  if (collapsed) return null;
  return (
    <aside
      className="relative flex min-h-0 shrink-0 flex-col border-l bg-background"
      style={{ width, maxWidth: '45%' }}
    >
      <ExplorerDivider />
      {contents}
    </aside>
  );
}

/** Withdrawing the desktop rail disposes its gesture and preview without committing a preference. */
function ExplorerDivider() {
  const { t } = useTranslation();
  const setWidth = useLayoutStore((s) => s.setWorkspaceTreeWidth);
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{ start: number; width: number } | null>(null);
  /** Preview and commit obey the same CSS max-width constraint. */
  const constrainedWidth = (separator: HTMLElement, proposed: number) => {
    const available =
      separator.parentElement!.parentElement!.getBoundingClientRect().width;
    return Math.min(600, available * 0.45, Math.max(180, proposed));
  };
  return (
    <>
      <div
        role="separator"
        aria-label={t('Explorer width')}
        aria-orientation="vertical"
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none"
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const actual =
              event.currentTarget.parentElement!.getBoundingClientRect().width;
            setWidth(
              constrainedWidth(
                event.currentTarget,
                actual + (event.key === 'ArrowLeft' ? 16 : -16),
              ),
            );
          }
          if (event.key === 'Escape') {
            drag.current = null;
            setPreview(null);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.focus();
          setPreview(null);
          drag.current = {
            start: event.clientX,
            width:
              event.currentTarget.parentElement!.getBoundingClientRect().width,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setPreview(
              constrainedWidth(
                event.currentTarget,
                drag.current.width + drag.current.start - event.clientX,
              ),
            );
        }}
        onPointerUp={(event) => {
          if (drag.current && event.clientX !== drag.current.start)
            setWidth(
              constrainedWidth(
                event.currentTarget,
                drag.current.width + drag.current.start - event.clientX,
              ),
            );
          drag.current = null;
          setPreview(null);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setPreview(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setPreview(null);
        }}
      />
      {preview !== null && (
        <div
          className="pointer-events-none absolute inset-y-0 z-40 w-0.5 bg-primary"
          style={{ right: preview }}
        />
      )}
    </>
  );
}
