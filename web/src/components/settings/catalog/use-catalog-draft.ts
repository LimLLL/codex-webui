/**
 * Draft state for the model catalog editor.
 *
 * The form and the raw JSON editor edit the same document, so both go through
 * this hook. It keeps the last content the server acknowledged separate from
 * the working copy: every write is an optimistic-concurrency operation that
 * must send the exact previous content, and a stale value silently clobbers a
 * change made from another browser.
 */
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  catalogApplyMutation,
  catalogBlockersOptions,
  catalogReadDraftOptions,
  catalogReadDraftQueryKey,
  catalogRestartMutation,
  catalogRestoreMutation,
  catalogSaveDraftMutation,
  catalogSeedMutation,
  catalogStateOptions,
  catalogStateQueryKey,
  catalogUseDefaultMutation,
  catalogValidateMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import type { CatalogDocumentDto, CatalogWarningDto } from '@/generated/api';

/** One catalog entry, kept as parsed JSON so unknown fields survive editing. */
export type CatalogEntry = Record<string, unknown> & { slug?: unknown };

export interface ParsedCatalog {
  models: CatalogEntry[];
}

/**
 * Parses a catalog document defensively.
 *
 * @param content - Raw JSON document, or null when no draft exists.
 * @returns Parsed models, or null when the document is absent or unparseable.
 */
export function parseCatalogDocument(
  content: string | null,
): ParsedCatalog | null {
  if (!content) return null;
  try {
    const value: unknown = JSON.parse(content);
    if (
      !value ||
      typeof value !== 'object' ||
      !Array.isArray((value as ParsedCatalog).models)
    )
      return null;
    // Entries have to be objects before anything reads a field off them. A
    // document can be valid JSON and still hold `null` or a bare string here;
    // the structured list is what withdraws, not the document.
    const models: unknown[] = (value as { models: unknown[] }).models;
    if (
      models.some(
        (entry) =>
          !entry || typeof entry !== 'object' || Array.isArray(entry),
      )
    )
      return null;
    return value as ParsedCatalog;
  } catch {
    return null;
  }
}

/** Reads a string field from an entry without assuming the upstream shape. */
export function entryText(entry: CatalogEntry, key: string): string {
  const value = entry[key];
  return typeof value === 'string' ? value : '';
}

/** Stable label for an entry, falling back to its slug. */
export function entryLabel(entry: CatalogEntry): string {
  return entryText(entry, 'display_name') || entryText(entry, 'slug');
}

/**
 * Decides whether a server draft may replace the local editing state.
 *
 * `committed` is the precondition sent with every write, so it may never move
 * ahead of the content `working` was derived from: a fresh precondition paired
 * with stale content is an overwrite the backend cannot detect. While the
 * working copy is dirty the local state stays put and the divergence surfaces
 * as the intended 409 instead.
 *
 * @param current - Local editing state.
 * @param serverContent - Content the draft query last returned.
 * @returns Replacement state, or null to keep the local state as it is.
 */
export function reconcileDraft(
  current: { seen: string | null | undefined; committed: string | null; working: string | null },
  serverContent: string | null,
): { seen: string | null; committed: string | null; working: string | null } | null {
  if (current.seen === serverContent) return null;
  if (current.working !== current.committed) return null;
  return { seen: serverContent, committed: serverContent, working: serverContent };
}

export function useCatalogDraft() {
  const queryClient = useQueryClient();
  const state = useQuery(catalogStateOptions());
  const draft = useQuery(catalogReadDraftOptions());
  const blockers = useQuery({
    ...catalogBlockersOptions(),
    // Blockers are a point-in-time observation; a stale one would offer to
    // restart while a turn is running.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  /** Content the server last confirmed, used as the write precondition. */
  const [committed, setCommitted] = useState<string | null>(null);
  /** Working copy shown by the form and the raw editor. */
  const [working, setWorking] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<CatalogWarningDto[]>([]);
  const [seen, setSeen] = useState<string | null | undefined>(undefined);

  // Adjusted during render rather than in an effect: an effect would render
  // once with the stale draft first.
  if (draft.data !== undefined) {
    const next = reconcileDraft({ seen, committed, working }, draft.data.content);
    if (next) {
      setSeen(next.seen);
      setCommitted(next.committed);
      setWorking(next.working);
    }
  }

  const refreshAll = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: catalogStateQueryKey() }),
      queryClient.invalidateQueries({ queryKey: catalogReadDraftQueryKey() }),
      blockers.refetch(),
    ]);
  }, [blockers, queryClient]);

  /**
   * Throws away local edits and adopts the server draft.
   *
   * Refusing to overwrite a concurrent change is only half a design: without an
   * explicit way out, a stale baseline makes every subsequent save and seed fail
   * the precondition forever with no control that resolves it.
   */
  const discardLocalEdits = useCallback(async () => {
    // staleTime 0 forces a real read. The app's default keeps drafts fresh for
    // 30s, so the cached copy here would be the very content the user is trying
    // to escape, and the button would appear to do nothing.
    const fresh = await queryClient.fetchQuery({
      ...catalogReadDraftOptions(),
      staleTime: 0,
    });
    setSeen(fresh.content);
    setCommitted(fresh.content);
    setWorking(fresh.content);
    setWarnings(fresh.warnings);
  }, [queryClient]);

  /**
   * Records a write's own result as the cached draft.
   *
   * Without this the cache still holds the pre-save content, and reconciliation
   * — now clean, because the write advanced both baselines — immediately adopts
   * it and rolls the editor back to what was just replaced.
   */
  const adoptWriteResult = useCallback(
    (result: CatalogDocumentDto) => {
      queryClient.setQueryData(catalogReadDraftQueryKey(), result);
      setCommitted(result.content);
      setSeen(result.content);
      setWarnings(result.warnings);
    },
    [queryClient],
  );

  const save = useMutation({
    ...catalogSaveDraftMutation(),
    onSuccess: (result, variables) => {
      adoptWriteResult(result);
      // Typing continues while the request is in flight; only the text that was
      // actually sent gets replaced, so those keystrokes are not thrown away.
      const sent = variables.body?.content;
      setWorking((current) => (current === sent ? result.content : current));
      void refreshAll();
    },
  });
  const seed = useMutation({
    ...catalogSeedMutation(),
    onSuccess: (result) => {
      adoptWriteResult(result);
      setWorking(result.content);
      void refreshAll();
    },
  });
  const validate = useMutation({
    ...catalogValidateMutation(),
    onSuccess: (result) => setWarnings(result.warnings),
  });
  // These three can change the pointer, the activation record or the startup
  // diagnostic even when they fail, so state is refreshed on settle, not on
  // success — a failed activation is exactly when the panel is most stale.
  const apply = useMutation({
    ...catalogApplyMutation(),
    onSuccess: (result) => setWarnings(result.warnings),
    onSettled: () => void refreshAll(),
  });
  const useDefault = useMutation({
    ...catalogUseDefaultMutation(),
    onSettled: () => void refreshAll(),
  });
  const restore = useMutation({
    ...catalogRestoreMutation(),
    onSettled: () => void refreshAll(),
  });
  // Retrying startup after the config file was repaired by hand; the backend
  // still runs its own activity check before touching a live child.
  const restart = useMutation({
    ...catalogRestartMutation(),
    onSettled: () => void refreshAll(),
  });

  const parsed = parseCatalogDocument(working);
  return {
    state,
    blockers,
    committed,
    working,
    setWorking,
    parsed,
    warnings,
    dirty: working !== committed,
    save,
    seed,
    validate,
    apply,
    useDefault,
    restore,
    restart,
    refreshAll,
    discardLocalEdits,
    /**
     * A write is outstanding, so discarding now would race it: the older
     * response would land afterwards and move the baseline back under the
     * adopted content, recreating the conflict it just resolved.
     */
    writing: save.isPending || seed.isPending,
    /** Server draft differs from the baseline this edit was derived from. */
    stale: draft.data !== undefined && draft.data.content !== committed,
  };
}
