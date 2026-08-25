/**
 * Executes composer slash commands.
 *
 * Dispatch is an explicit switch rather than a generic executor: `/plan` writes
 * thread settings, `/compact` calls a semantic endpoint, and the rest open a
 * dialog that sends nothing until the user confirms. Keeping them distinct is
 * what lets each one carry its own preconditions and error handling.
 */
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  threadCommandsReadCollaborationModeOptions,
  threadCommandsReadCollaborationModeQueryKey,
  threadCommandsSetCollaborationModeMutation,
  threadsCompactThreadMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { getApiErrorMessage } from '@/lib/api-error';
import type { SlashCommandDef } from '@/lib/slash-commands';

/** Which slash dialog is currently open, if any. */
export type SlashDialog = 'goal' | 'review' | 'feedback' | null;

interface UseSlashDispatchParams {
  threadId: string | null;
  onError: (message: string) => void;
}

export function useSlashDispatch({
  threadId,
  onError,
}: UseSlashDispatchParams) {
  const [dialog, setDialog] = useState<SlashDialog>(null);
  const queryClient = useQueryClient();

  // Backend reports `observed: false` until app-server emits settings for this
  // thread, so the UI must be able to say "unknown" rather than assert Default.
  const { data: collaborationMode } = useQuery({
    ...threadCommandsReadCollaborationModeOptions({
      path: { threadId: threadId ?? '' },
    }),
    enabled: Boolean(threadId),
  });

  const setCollaborationMode = useMutation({
    ...threadCommandsSetCollaborationModeMutation(),
    onSuccess: (_res, vars) => {
      void queryClient.invalidateQueries({
        queryKey: threadCommandsReadCollaborationModeQueryKey({
          path: { threadId: vars.path.threadId },
        }),
      });
    },
    onError: (err) => onError(getApiErrorMessage(err)),
  });

  const compactThread = useMutation({
    ...threadsCompactThreadMutation(),
    onError: (err) => onError(getApiErrorMessage(err)),
  });

  const planActive = collaborationMode?.mode === 'plan';

  /**
   * Toggles plan mode.
   *
   * When the current mode is unknown the toggle sets Plan rather than guessing
   * that the thread is currently on Default, matching how `/plan` reads to a
   * user who cannot see a confirmed state.
   */
  const togglePlanMode = useCallback(() => {
    if (!threadId) return;
    setCollaborationMode.mutate({
      path: { threadId },
      body: { mode: planActive ? 'default' : 'plan' },
    });
  }, [threadId, planActive, setCollaborationMode]);

  const runCommand = useCallback(
    (command: SlashCommandDef) => {
      switch (command.name) {
        case 'plan':
          togglePlanMode();
          return;
        case 'compact':
          if (threadId) compactThread.mutate({ path: { threadId } });
          return;
        case 'goal':
        case 'review':
        case 'feedback':
          setDialog(command.name);
          return;
        default:
          // Unknown names never reach here — the palette only yields catalog
          // entries — but failing loudly beats silently swallowing a command.
          onError(`Unknown command: /${command.name}`);
      }
    },
    [togglePlanMode, threadId, compactThread, onError],
  );

  return {
    runCommand,
    dialog,
    setDialog,
    collaborationMode,
    planActive,
    togglePlanMode,
    planPending: setCollaborationMode.isPending,
    compactPending: compactThread.isPending,
  };
}
