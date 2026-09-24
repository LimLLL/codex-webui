/** One inline edit transaction shared by nested and flat directory hosts. */
import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { filesReadTreeOptions } from '@/generated/api/@tanstack/react-query.gen';
import i18n from '@/i18n';
import { getApiErrorMessage } from '@/lib/api-error';
import { useFileOperations } from './use-file-operations';

export interface InlineFileEdit {
  id: number;
  kind: 'newFile' | 'newFolder' | 'rename';
  parentPath: string;
  targetPath?: string;
  initialValue?: string;
  selectBaseName?: boolean;
  pending: boolean;
  error: string | null;
}
type EditRequest = Omit<InlineFileEdit, 'id' | 'pending' | 'error'>;

/**
 * Cancelling hides the draft but never cancels an already-sent filesystem write.
 * Mutation promises still publish reconciliation after a host unmounts. Each
 * completion can settle only its own editor identity, not a newer edit row.
 */
export function useInlineFileEdit(onCreated?: (path: string) => void) {
  const ops = useFileOperations();
  const queryClient = useQueryClient();
  const [edit, setEdit] = useState<InlineFileEdit | null>(null);
  const current = useRef<InlineFileEdit | null>(null);
  const sequence = useRef(0);
  const start = (request: EditRequest) => {
    const next = {
      ...request,
      id: ++sequence.current,
      pending: false,
      error: null,
    };
    current.current = next;
    setEdit(next);
  };
  const cancel = useCallback(() => {
    current.current = null;
    setEdit(null);
  }, []);
  const commit = async (name: string) => {
    const origin = current.current;
    if (!origin || origin.pending) return;
    const settle = (patch: Partial<InlineFileEdit>) => {
      if (current.current?.id !== origin.id) return;
      current.current = { ...current.current, ...patch };
      setEdit(current.current);
    };
    if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
      settle({ error: i18n.t('Enter a name without path separators.') });
      return;
    }
    settle({ pending: true, error: null });
    let createdPath: string | null = null;
    try {
      if (origin.kind === 'rename') {
        // The submitted field is already the complete name: `selectBaseName`
        // only moves the selection, so replacing it leaves the extension in
        // place. Re-appending a retained extension here yields `bar.ts.ts`.
        await ops.renamePath.mutateAsync({
          body: { path: origin.targetPath!, newName: name },
        });
      } else {
        const body = {
          path: `${origin.parentPath.replace(/\/$/, '')}/${name}`,
        };
        const result =
          origin.kind === 'newFile'
            ? await ops.createFile.mutateAsync({ body })
            : await ops.createDirectory.mutateAsync({ body });
        createdPath = result.path;
      }
    } catch (error) {
      settle({ pending: false, error: getApiErrorMessage(error) });
      return;
    }
    // Keep the successful create row until the authoritative listing arrives.
    // A failed refresh must not present a successful write as retryable.
    await queryClient
      .fetchQuery({
        ...filesReadTreeOptions({ query: { root: origin.parentPath } }),
        staleTime: 0,
      })
      .catch(() => undefined);
    if (current.current?.id !== origin.id) return;
    cancel();
    if (createdPath) onCreated?.(createdPath);
  };
  return { edit, start, cancel, commit, ops };
}
