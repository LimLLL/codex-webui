/** Diff arithmetic shared by the file-change item and the approval card. */
import type { FileChangeEntry } from '@/types/timeline';

/**
 * Counts diff lines of one polarity, excluding the file headers.
 *
 * @param diff - Unified diff text, possibly empty
 * @param prefix - `+` or `-`
 * @param header - The three-character header (`+++` / `---`) to exclude
 */
function countLines(diff: string, prefix: string, header: string): number {
  if (!diff) return 0;
  return diff
    .split('\n')
    .filter((line) => line.startsWith(prefix) && !line.startsWith(header))
    .length;
}

/**
 * Additions and deletions across an entire change set.
 *
 * Summed over every file rather than the first, so a header cannot understate
 * how much a patch touches — which matters most on the one surface where the
 * number is what a user decides from.
 *
 * @param changes - Every proposed file in the set
 */
export function summarizeChangeSet(changes: readonly FileChangeEntry[]): {
  additions: number;
  deletions: number;
  hasDiff: boolean;
} {
  let additions = 0;
  let deletions = 0;
  let hasDiff = false;
  for (const change of changes) {
    additions += countLines(change.diff, '+', '+++');
    deletions += countLines(change.diff, '-', '---');
    if (change.diff) hasDiff = true;
  }
  return { additions, deletions, hasDiff };
}
