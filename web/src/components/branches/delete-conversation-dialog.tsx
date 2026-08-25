/** Confirmation for the cascading conversation delete. */
import { lazy, Suspense, useMemo } from 'react';
import {
  AlertTriangle,
  Archive,
  CircleHelp,
  Loader2,
  ShieldQuestion,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { useIsMobile } from '@/hooks/use-breakpoint';
import {
  flattenForList,
  layoutBranchGraph,
} from '@/lib/branch-graph-layout';
import { cn } from '@/lib/utils';
import type { ThreadDeletePreviewDto } from '@/generated/api/types.gen';
import type { BranchGraphItem } from './branch-graph';

// React Flow is a large dependency used only by the two graph surfaces, both of
// which live behind a dialog. Loading it lazily keeps it out of the entry chunk.
const BranchGraphPreview = lazy(() =>
  import('./branch-graph').then((module) => ({
    default: module.BranchGraphPreview,
  })),
);

interface Props {
  open: boolean;
  /** Null while the preview is still loading. */
  preview: ThreadDeletePreviewDto | null;
  loading: boolean;
  errorMessage: string | null;
  pending: boolean;
  currentThreadId: string | null;
  onConfirm: (preview: ThreadDeletePreviewDto) => void;
  onClose: () => void;
}

/**
 * Shows exactly what a delete will destroy, then takes consent for that set.
 *
 * The indented list is authoritative and is the only affordance on narrow
 * screens; the graph beside it explains structure that indentation alone
 * conveys poorly. Both are built from the server's plan rather than from local
 * topology, so what is displayed is what the server will act on.
 */
export function DeleteConversationDialog({
  open,
  preview,
  loading,
  errorMessage,
  pending,
  currentThreadId,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  const items = useMemo<BranchGraphItem[]>(() => {
    if (!preview) return [];
    return preview.threads.map((thread) => ({
      threadId: thread.threadId,
      parentThreadId: thread.parentThreadId ?? null,
      data: {
        label: thread.name?.trim() || thread.preview?.trim() || thread.threadId.slice(0, 8),
        isTarget: thread.threadId === preview.targetThreadId,
        isCurrent: thread.threadId === currentThreadId,
        isDoomed: true,
        running: thread.active,
        pendingApprovalCount: thread.pendingApprovalCount,
        archived: thread.archived,
        // `server` means the planner learned of this thread from app-server's
        // `forkedFromId` alone: no local edge, therefore no recorded fork point.
        external: thread.source === 'server',
        boundaryUnknown: thread.source === 'server',
        createdAt: thread.createdAt ?? null,
        clickable: false,
      },
    }));
  }, [preview, currentThreadId]);

  const listed = useMemo(
    () => flattenForList(layoutBranchGraph(items)),
    [items],
  );

  const runningCount = preview?.runningThreadIds.length ?? 0;
  const approvalCount = preview?.pendingApprovals.length ?? 0;
  const blocked = Boolean(preview && !preview.canDelete);
  const canConfirm = Boolean(preview) && !blocked && !pending && !loading;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <AlertDialogContent className="max-w-3xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('Delete this conversation and everything branched from it?')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              'This cannot be undone. Files already written to the workspace are not reverted.',
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('Working out what would be deleted…')}
          </div>
        )}

        {errorMessage && !loading && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </p>
        )}

        {preview && !loading && (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              {t('{{count}} conversation(s) will be permanently deleted:', {
                count: preview.threadIds.length,
              })}
            </p>

            <div
              className={cn(
                'grid gap-3',
                !isMobile && items.length > 1 && 'grid-cols-[minmax(0,1fr)_320px]',
              )}
            >
              <ScrollArea className="max-h-64 rounded-md border">
                <ul className="p-2">
                  {listed.map((entry) => {
                    const thread = preview.threads.find(
                      (item) => item.threadId === entry.node.threadId,
                    );
                    return (
                      <li
                        key={entry.node.threadId}
                        className="flex items-start gap-1.5 py-1 text-sm"
                        style={{ paddingLeft: `${entry.depth * 16}px` }}
                      >
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-destructive line-through decoration-destructive/50">
                            {entry.node.data.label}
                          </span>
                          <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            {thread?.active && (
                              <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                {t('Running — will be interrupted')}
                              </span>
                            )}
                            {(thread?.pendingApprovalCount ?? 0) > 0 && (
                              <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                                <ShieldQuestion className="h-3 w-3" />
                                {t('Approval request will be cancelled')}
                              </span>
                            )}
                            {thread?.archived && (
                              <span className="flex items-center gap-0.5">
                                <Archive className="h-3 w-3" />
                                {t('Archived')}
                              </span>
                            )}
                            {thread?.source === 'server' && (
                              <span className="flex items-center gap-0.5">
                                <CircleHelp className="h-3 w-3" />
                                {t('External branch (fork point unknown)')}
                              </span>
                            )}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>

              {!isMobile && items.length > 1 && (
                <Suspense
                  fallback={<div className="h-64 rounded-md border" />}
                >
                  <BranchGraphPreview
                    items={items}
                    className="h-64 rounded-md border"
                  />
                </Suspense>
              )}
            </div>

            {(runningCount > 0 || approvalCount > 0) && (
              <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {runningCount > 0 &&
                    t('{{count}} running reply will be interrupted.', {
                      count: runningCount,
                    })}{' '}
                  {approvalCount > 0 &&
                    t('{{count}} pending approval request will be cancelled.', {
                      count: approvalCount,
                    })}
                </span>
              </p>
            )}

            {blocked && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <p className="font-medium">
                  {t('Deletion is blocked for this branch tree:')}
                </p>
                <ul className="mt-1 list-disc pl-4">
                  {preview.blockers.map((blocker, index) => (
                    <li key={`${blocker.code}-${index}`}>{blocker.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => preview && onConfirm(preview)}
          >
            {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('Delete permanently')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
