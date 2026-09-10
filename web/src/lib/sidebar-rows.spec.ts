/**
 * Pins which sidebar projections may contribute rows.
 *
 * The defect these cover shipped once: home and detail queries are gated on the
 * view being rendered, but a gated TanStack Query retains its last data, so
 * indexing every projection let rows from a view the user had left win over the
 * view they were looking at.
 */
import { describe, it, expect } from 'vitest';
import type { ThreadDto, ThreadOverviewRowDto } from '@/generated/api/types.gen';
import { selectSidebarRows } from './sidebar-rows';

/** Builds a complete thread so a schema change breaks this file loudly. */
function thread(id: string): ThreadDto {
  return {
    id,
    forkedFromId: null,
    preview: `preview ${id}`,
    ephemeral: false,
    modelProvider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    status: { type: 'idle' },
    path: null,
    cwd: '/workspace',
    cliVersion: '0.153.2',
    source: 'appServer',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

/** Builds a row, defaulting the branch fields the sidebar actually reads. */
function row(
  id: string,
  overrides: Partial<ThreadOverviewRowDto> = {},
): ThreadOverviewRowDto {
  return {
    thread: thread(id),
    treeRootThreadId: id,
    openThreadId: id,
    memberThreadIds: [id],
    hiddenThreadIds: [],
    hasBranchDescendants: false,
    latestActivityAt: 1_700_000_000,
    running: false,
    waitingOnApproval: false,
    waitingOnUserInput: false,
    pendingApprovalCount: 0,
    ...overrides,
  };
}

describe('selectSidebarRows', () => {
  it('ignores a gated detail cache while the home view is rendering', () => {
    // Same conversation in both projections. The detail copy is what a
    // disabled query kept from the page the user navigated away from, and it
    // points at a branch member that is no longer the one to open.
    const fresh = row('t1', { openThreadId: 't1-latest', memberThreadIds: ['t1', 't1-latest'] });
    const retained = row('t1', { openThreadId: 't1-stale', memberThreadIds: ['t1', 't1-stale'] });

    const selection = selectSidebarRows(
      { active: [fresh], archived: [], detail: [retained] },
      true,
    );

    expect(selection.rowByThreadId.get('t1')?.openThreadId).toBe('t1-latest');
    // Membership decides which conversation a deep link highlights, so a stale
    // member must not resolve to a displayed row at all.
    expect(selection.displayThreadIdByMember.get('t1-latest')).toBe('t1');
    expect(selection.displayThreadIdByMember.has('t1-stale')).toBe(false);
  });

  it('ignores gated home caches while a detail view is rendering', () => {
    const retained = row('t1', { openThreadId: 't1-stale' });
    const fresh = row('t1', { openThreadId: 't1-latest' });

    const selection = selectSidebarRows(
      { active: [retained], archived: [], detail: [fresh] },
      false,
    );

    expect(selection.rowByThreadId.get('t1')?.openThreadId).toBe('t1-latest');
    expect(selection.displayedRows).toHaveLength(1);
  });

  it('indexes the archived preview on the home view', () => {
    const selection = selectSidebarRows(
      { active: [row('t1')], archived: [row('t2')], detail: [] },
      true,
    );

    expect([...selection.rowByThreadId.keys()]).toEqual(['t1', 't2']);
  });

  it('excludes archived rows from the conversations an archive action lands on', () => {
    // Archiving the open conversation has to land somewhere; landing on another
    // archived conversation would immediately leave the list being displayed.
    const selection = selectSidebarRows(
      { active: [row('t1')], archived: [row('t2')], detail: [] },
      true,
    );

    expect(selection.visibleThreads.map((t) => t.id)).toEqual(['t1']);
  });

  it('lands on the open page of conversations while a detail view is rendering', () => {
    // The home list is both the wrong neighbour and possibly empty: the view is
    // persisted, so a reload straight into a workspace never runs the home queries.
    const selection = selectSidebarRows(
      { active: [], archived: [], detail: [row('t9')] },
      false,
    );

    expect(selection.visibleThreads.map((t) => t.id)).toEqual(['t9']);
  });
});
