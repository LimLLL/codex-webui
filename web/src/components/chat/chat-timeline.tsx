/**
 * Virtualized scrollable message timeline.
 * Uses TanStack Virtual for efficient rendering of long conversations.
 */
import { useMemo, useState } from 'react';
import { Bot, Lock } from 'lucide-react';
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
import {
  useCreateMessageBranch,
  useMessageVersions,
} from '@/hooks/use-message-branches';
import {
  adoptionBlockReason,
  buildDeleteRequestBody,
  pickSurvivingVersion,
  useBranchAdoptionStatus,
  useDeletePreview,
  useDeleteThread,
} from '@/hooks/use-thread-deletion';
import { useLoadOlderHistory } from '@/hooks/use-thread-open';
import { DeleteConversationDialog } from '@/components/branches/delete-conversation-dialog';
import { getApiErrorMessage } from '@/lib/api-error';
import { VirtualTranscript } from './virtual-transcript';
import {
  isPlanDisplayable,
  isTurnItemDisplayable,
} from '@/lib/turn-item-display';
import {
  useTimelineStore,
  type ThreadRuntimeState,
} from '@/stores/timeline-store';
import type { TimelineEntry } from '@/types/timeline';
import { TimelineEntryRow } from './timeline-entry-row';

/** Stable empty set, so "nothing is being deleted" is referentially constant. */
const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_TIMELINE: TimelineEntry[] = [];
const EMPTY_APPROVALS: ThreadRuntimeState['approvals'] = {};
const EMPTY_REQUESTS: ThreadRuntimeState['userInputRequests'] = {};

/** Joins entry keys into a comparable signature; cannot occur inside a key. */
const KEY_SEPARATOR = '\u0000';

/**
 * Derives a stable virtualizer key for every timeline entry.
 *
 * Index keys cannot survive `Load earlier messages`: prepending shifts every
 * existing entry by the page size, so cached row heights — and the end anchor
 * the virtualizer restores position from — would be attributed to the wrong
 * entries. Turn ids are the natural identity, but a user message has none until
 * `turn/started` arrives, and several system messages can share one turn. Both
 * are disambiguated by their ordinal within their own group, which prepending
 * cannot disturb: prepended history is always persisted turns, so it never
 * lands in the group an as-yet unidentified live entry is counted in.
 */
function deriveEntryKeys(timeline: TimelineEntry[]): string[] {
  const counts = new Map<string, number>();
  return timeline.map((entry) => {
    if (entry.kind === 'interaction') return `interaction:${entry.instanceId}`;
    const turnId = 'turnId' in entry ? entry.turnId : undefined;
    const group = `${entry.kind}:${turnId ?? 'pending'}`;
    const ordinal = counts.get(group) ?? 0;
    counts.set(group, ordinal + 1);
    return `${group}:${ordinal}`;
  });
}

/**
 * States that this conversation is held open for writing elsewhere.
 *
 * Only one process may hold a paginated conversation open for writing. Losing
 * that race leaves the history perfectly readable, so the conversation is shown
 * rather than refused — but silently showing a conversation that rejects every
 * message would read as the app being broken.
 */
function ReadOnlyBanner({ reason }: { reason: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 sm:px-4 lg:px-6 dark:text-amber-300">
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <p className="font-medium">
          {t('Read-only: this conversation is open in another client.')}
        </p>
        <p className="opacity-80">
          {reason ||
            t('Close it there, then reopen this conversation to continue it.')}
        </p>
      </div>
    </div>
  );
}

interface Props {
  conversationId: string;
  active?: boolean;
  ready?: boolean;
  onReady?: (measured: boolean) => void;
  onEditMessage?: (message: string) => void;
  /**
   * Space in px reserved at the end of the transcript for a composer floating
   * over it, including its covering padding and safe area.
   */
  bottomInset?: number;
  /**
   * Increments when the composer dispatches a send or steer. Following resumes
   * on the change, not on the value, so the route only has to count sends.
   */
  scrollToLatestSignal?: number;
}

export function ChatTimeline({
  conversationId,
  onEditMessage,
  active = true,
  ready = true,
  onReady,
  bottomInset = 0,
  scrollToLatestSignal = 0,
}: Props) {
  'use no memo'; // TanStack Virtual is incompatible with React Compiler memoization
  const { t } = useTranslation();
  const runtime = useTimelineStore((s) => s.threadsById[conversationId]);
  const retainedTimeline = runtime?.timeline ?? EMPTY_TIMELINE;
  const activeTurnId = runtime?.activeTurnId ?? null;
  const approvals = runtime?.approvals ?? EMPTY_APPROVALS;
  const requests = runtime?.userInputRequests ?? EMPTY_REQUESTS;
  const timeline = useMemo(
    () =>
      retainedTimeline.filter(
        (entry) =>
          entry.kind !== 'turn' ||
          entry.turnId === activeTurnId ||
          entry.items.some(isTurnItemDisplayable) ||
          isPlanDisplayable(entry.plan) ||
          Boolean(entry.diff) ||
          Object.values(approvals).some(
            (request) => request.turnId === entry.turnId,
          ) ||
          Object.values(requests).some(
            (request) => request.turnId === entry.turnId,
          ),
      ),
    [retainedTimeline, activeTurnId, approvals, requests],
  );
  const threadId = conversationId;
  const threadCwd = runtime?.threadCwd ?? null;
  const threadMode = runtime?.threadMode ?? 'live';
  const busy = Boolean(runtime?.turnStartPending || runtime?.activeTurnId);
  const historyCursor = runtime?.historyCursor ?? null;
  const historyLoading = runtime?.historyLoading ?? false;
  const readOnlyReason = runtime?.readOnlyReason ?? null;
  const deletedRemotely = runtime?.deletedRemotely ?? false;
  const loadOlderHistory = useLoadOlderHistory(threadId);
  const [editTarget, setEditTarget] = useState<{
    turnId: string;
    content: string;
  } | null>(null);

  const { versionsByTurnId } = useMessageVersions(threadId);
  const adoptionStatus = useBranchAdoptionStatus();
  const deleteBlockedReason = adoptionBlockReason(adoptionStatus.data, t);
  // The sibling ordering is captured when the dialog opens rather than looked
  // up on confirm: the group is about to change underneath us, and the whole
  // point is to land on the neighbour the switcher was showing at that moment.
  const [deleteTarget, setDeleteTarget] = useState<{
    threadId: string;
    siblingThreadIds: string[];
  } | null>(null);
  const deletePreview = useDeletePreview(deleteTarget?.threadId ?? null);
  const deleteVersion = useDeleteThread({
    onFinished: () => setDeleteTarget(null),
    resolveSurvivor: (doomed) =>
      deleteTarget
        ? pickSurvivingVersion(
            deleteTarget.threadId,
            deleteTarget.siblingThreadIds,
            doomed,
          )
        : null,
  });
  const createBranch = useCreateMessageBranch((text) => {
    setEditTarget(null);
    if (text) onEditMessage?.(text);
  });

  // The confirmed cascade, for as long as the request is in flight. Taken from
  // the mutation's own variables rather than tracked separately so it can never
  // disagree with what was actually sent. The dialog closes and the route moves
  // to the surviving sibling the moment the request is issued, so without this
  // the switcher on that sibling is the only thing on screen — and it was
  // showing the pre-delete count, fully interactive, for the whole round trip.
  const deletingThreadIds = useMemo<ReadonlySet<string>>(
    () =>
      deleteVersion.isPending
        ? new Set(deleteVersion.variables?.body?.expectedThreadIds ?? [])
        : EMPTY_THREAD_IDS,
    [deleteVersion.isPending, deleteVersion.variables],
  );

  // A turn cannot be branched while the conversation is busy, and the newest
  // user message has no turn id until `turn/started` arrives.
  const canBranch =
    threadMode === 'live' &&
    readOnlyReason === null &&
    !deletedRemotely &&
    !busy &&
    !createBranch.isPending;

  const keySignature = useMemo(
    () => deriveEntryKeys(timeline).join(KEY_SEPARATOR),
    [timeline],
  );
  const entryKeys = useMemo(
    () => (keySignature ? keySignature.split(KEY_SEPARATOR) : []),
    [keySignature],
  );

  return (
    <>
      {readOnlyReason !== null && <ReadOnlyBanner reason={readOnlyReason} />}
      <div className="relative min-h-0 flex-1">
        <VirtualTranscript
          threadId={threadId ?? 'empty'}
          keys={entryKeys}
          active={active}
          ready={ready}
          bottomInset={bottomInset}
          scrollSignal={scrollToLatestSignal}
          onReady={onReady}
          hasOlder={historyCursor !== null}
          historyLoading={historyLoading}
          loadOlder={() => void loadOlderHistory()}
          historyHeader={
            historyCursor !== null ? (
              <button
                type="button"
                disabled={historyLoading}
                className="rounded-full border px-3 py-1 text-xs"
                onClick={() => void loadOlderHistory()}
              >
                {t(
                  historyLoading
                    ? 'Loading earlier messages…'
                    : 'Load earlier messages',
                )}
              </button>
            ) : undefined
          }
          renderRow={(index) => (
            <TimelineEntryRow
              entry={timeline[index]}
              threadCwd={threadCwd}
              threadId={threadId}
              canBranch={canBranch}
              versionsByTurnId={versionsByTurnId}
              deleteBlockedReason={deleteBlockedReason}
              deletingThreadIds={deletingThreadIds}
              onDeleteVersion={(threadId, siblingThreadIds) =>
                setDeleteTarget({ threadId, siblingThreadIds })
              }
              onEdit={setEditTarget}
              t={t}
            />
          )}
        />
        {ready && timeline.length === 0 && (
          <div
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-sm text-muted-foreground"
            style={{ paddingBottom: bottomInset }}
          >
            <Bot className="mb-4 h-10 w-10 opacity-30" />
            {t('Send a message to start the conversation.')}
          </div>
        )}
      </div>

      <AlertDialog
        open={active && editTarget !== null}
        onOpenChange={(open) => !open && setEditTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Edit this message?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'This creates a new version of the message. The current conversation is kept as a sibling version you can switch back to. File changes will NOT be reverted.',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={createBranch.isPending}
              onClick={() => {
                if (!threadId || !editTarget) return;
                createBranch.mutate({
                  path: { threadId },
                  body: {
                    editedTurnId: editTarget.turnId,
                    previewText: editTarget.content,
                  },
                });
              }}
            >
              {t('Confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeleteConversationDialog
        open={active && deleteTarget !== null}
        preview={deletePreview.data ?? null}
        loading={deletePreview.isLoading}
        errorMessage={
          deletePreview.error ? getApiErrorMessage(deletePreview.error) : null
        }
        pending={deleteVersion.isPending}
        currentThreadId={threadId}
        onConfirm={(preview) =>
          deleteVersion.mutate({
            path: { threadId: preview.targetThreadId },
            body: buildDeleteRequestBody(preview),
          })
        }
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
