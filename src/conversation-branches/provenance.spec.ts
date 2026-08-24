import { selectProvenanceRows, type ThreadProvenance } from './provenance';

interface Row {
  threadId: string;
  turnId: string;
  value: string;
}

describe('selectProvenanceRows', () => {
  const branch: ThreadProvenance = {
    threadIds: ['root', 'child'],
    inheritedTurnIds: new Set(['turn-0']),
  };

  it('admits ancestor rows only for inherited turns', () => {
    const rows: Row[] = [
      { threadId: 'root', turnId: 'turn-0', value: 'inherited' },
      // Produced by the parent after the fork point — not part of this history.
      { threadId: 'root', turnId: 'turn-1', value: 'post-fork' },
      { threadId: 'child', turnId: 'turn-1b', value: 'own' },
    ];

    expect(selectProvenanceRows(branch, rows).map((row) => row.value)).toEqual([
      'inherited',
      'own',
    ]);
  });

  it('prefers the nearest thread when a turn id appears twice', () => {
    const rows: Row[] = [
      { threadId: 'root', turnId: 'turn-0', value: 'ancestor' },
      { threadId: 'child', turnId: 'turn-0', value: 'descendant' },
    ];

    expect(selectProvenanceRows(branch, rows).map((row) => row.value)).toEqual([
      'descendant',
    ]);
  });

  it('applies no turn restriction to untracked threads', () => {
    const untracked: ThreadProvenance = {
      threadIds: ['lonely'],
      inheritedTurnIds: null,
    };
    const rows: Row[] = [
      { threadId: 'lonely', turnId: 'turn-0', value: 'a' },
      { threadId: 'lonely', turnId: 'turn-1', value: 'b' },
    ];

    expect(selectProvenanceRows(untracked, rows)).toHaveLength(2);
  });

  it('drops rows from threads outside the provenance chain', () => {
    const rows: Row[] = [
      { threadId: 'stranger', turnId: 'turn-0', value: 'unrelated' },
    ];

    expect(selectProvenanceRows(branch, rows)).toEqual([]);
  });
});
