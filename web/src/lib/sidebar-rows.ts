/**
 * Selects the sidebar's row index from the query results, by the view on screen.
 *
 * This lives outside the component because the rule it enforces is not obvious
 * and was already violated once: the home and detail projections replace one
 * another in the tree, so their queries are gated — but a gated TanStack Query
 * keeps its last data. Reading all three caches at once therefore mixes rows the
 * user is looking at with rows left over from a view they navigated away from.
 */
import type { ThreadDto, ThreadOverviewRowDto } from '@/generated/api/types.gen';

/** The three sidebar projections, each holding whatever its query last returned. */
export interface SidebarRowsByView {
  /** Unarchived home rows. */
  active: readonly ThreadOverviewRowDto[];
  /** Archived home rows, a short preview list. */
  archived: readonly ThreadOverviewRowDto[];
  /** One page of a workspace or archive detail view. */
  detail: readonly ThreadOverviewRowDto[];
}

/** Everything the sidebar derives from the rows it is currently displaying. */
export interface SidebarRowSelection {
  /** Rows belonging to the view on screen, in render order. */
  displayedRows: readonly ThreadOverviewRowDto[];
  /** Displayed rows indexed by the conversation each one stands for. */
  rowByThreadId: ReadonlyMap<string, ThreadOverviewRowDto>;
  /** Hidden branch member → the displayed conversation representing it. */
  displayThreadIdByMember: ReadonlyMap<string, string>;
  /**
   * Conversations a "leave this one" action may land on.
   *
   * Narrower than {@link displayedRows}: the home view displays an archived
   * preview, but archiving a conversation must not land the user on another
   * archived one.
   */
  visibleThreads: readonly ThreadDto[];
}

/**
 * Derives the displayed row set and its indexes for one sidebar view.
 *
 * @param rows - The three projections' last known data, gated or not
 * @param isHomeView - Whether the overview is rendering rather than a detail page
 * @returns The rows on screen plus the lookups built strictly from them
 */
export function selectSidebarRows(
  rows: SidebarRowsByView,
  isHomeView: boolean,
): SidebarRowSelection {
  // Only the views actually on screen may contribute. Indexing a gated view's
  // retained cache lets a stale detail page overwrite a freshly fetched home row
  // for the same conversation, carrying a stale `openThreadId` and stale
  // membership — the two fields that decide what clicking that row does.
  const displayedRows = isHomeView
    ? [...rows.active, ...rows.archived]
    : rows.detail;

  const rowByThreadId = new Map<string, ThreadOverviewRowDto>();
  for (const row of displayedRows) rowByThreadId.set(row.thread.id, row);

  // Every hidden member maps to the row that stands for it, so a deep link to a
  // branch still lights up the row the user can see.
  const displayThreadIdByMember = new Map<string, string>();
  for (const row of rowByThreadId.values()) {
    for (const memberId of row.memberThreadIds) {
      displayThreadIdByMember.set(memberId, row.thread.id);
    }
  }

  const visibleThreads = (isHomeView ? rows.active : rows.detail).map(
    (row) => row.thread,
  );

  return {
    displayedRows,
    rowByThreadId,
    displayThreadIdByMember,
    visibleThreads,
  };
}
