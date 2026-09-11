/** One ingestion/notification decision for live delivery and pending reads. */
import type { QueryClient } from '@tanstack/react-query';
import type { ThreadOverviewResponseDto } from '@/generated/api';
import { threadsListOverviewQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import { showSnackbar, useSnackbarStore } from '@/stores/snackbar-store';
import type { ApprovalRequest, UserInputRequest } from '@/types/approval';
import {
  pendingRequestKey,
  samePendingRequest,
  type PendingRequestIdentity,
} from './pending-request-identity';
import i18n from '@/i18n';

/** Retires visible and queued prompts for this exact interaction. */
export function dismissAttention(
  threadId: string,
  request: PendingRequestIdentity,
): void {
  const key = JSON.stringify([threadId, pendingRequestKey(request)]);
  const snackbars = useSnackbarStore.getState();
  for (const item of [...snackbars.visible, ...snackbars.queue]) {
    if (item.action?.attentionKey === key) snackbars.dismiss(item.id);
  }
}

/** Adds a genuinely new pending card and prompts only its background consumer. */
export function ingestAttention(
  request: ApprovalRequest | UserInputRequest,
  queryClient?: QueryClient,
): void {
  const store = useTimelineStore.getState();
  const runtime = store.getThreadRuntime(request.threadId);
  const held =
    runtime?.approvals[String(request.requestId)] ??
    runtime?.userInputRequests[String(request.requestId)];
  if (held && samePendingRequest(held, request)) return;
  if (held) dismissAttention(request.threadId, held);
  if (request.kind === 'userInput')
    store.addUserInputRequestForThread(request.threadId, request);
  else store.addApprovalForThread(request.threadId, request);
  const updated = store.getThreadRuntime(request.threadId);
  const inserted =
    updated?.approvals[String(request.requestId)] ??
    updated?.userInputRequests[String(request.requestId)];
  if (
    inserted?.status !== 'pending' ||
    (store.threadId === request.threadId &&
      store.subscribedThreadIds.has(request.threadId))
  )
    return;

  // The overview is paged and collapses branches, so a title is best effort.
  let title = runtime?.threadTitle;
  for (const [, page] of queryClient?.getQueriesData<ThreadOverviewResponseDto>(
    {
      queryKey: threadsListOverviewQueryKey(),
    },
  ) ?? []) {
    const row = page?.data.find(
      (entry) => entry.thread.id === request.threadId,
    );
    title ??= row?.thread.name ?? row?.thread.preview;
  }
  showSnackbar(
    i18n.t(
      request.kind === 'userInput'
        ? 'Input needed in {{thread}}'
        : 'Approval needed in {{thread}}',
      {
        thread: title ?? store.getThreadTitle(request.threadId),
      },
    ),
    'warning',
    0,
    {
      attentionKey: JSON.stringify([
        request.threadId,
        pendingRequestKey(request),
      ]),
      label: i18n.t('Open thread'),
      onClick: () =>
        window.dispatchEvent(
          new CustomEvent('codex-webui:jump-thread', {
            detail: { threadId: request.threadId },
          }),
        ),
    },
  );
}
