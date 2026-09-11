/**
 * Renders a proposed set of file changes.
 *
 * Shared because the same change set reaches the user through two different
 * doors and must look the same behind both: inside the `fileChange` item for a
 * conversation being watched, and inside the standalone approval card for one
 * that is not. The second door exists because the pending item is measurably
 * absent from history while its approval is outstanding, so a client without
 * the item stream is given the changes with the request instead.
 */
import { useTranslation } from 'react-i18next';
import type { FileChangeEntry } from '@/types/timeline';
import { cn } from '@/lib/utils';
import { GitDiffPanel } from './git-diff-panel';

/** Plain diff rendering, used while a change is still being streamed. */
function RawDiff({ diff }: { diff: string }) {
  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto p-3 font-mono text-xs leading-relaxed',
        'scrollbar-thin scrollbar-track-transparent scrollbar-thumb-muted-foreground/20',
      )}
    >
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={cn(
            line.startsWith('+') && !line.startsWith('+++')
              ? 'bg-green-500/10 text-green-400'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'bg-red-500/10 text-red-400'
                : line.startsWith('@@')
                  ? 'text-blue-400'
                  : 'text-muted-foreground',
          )}
        >
          {line}
        </div>
      ))}
    </pre>
  );
}

interface Props {
  changes: readonly FileChangeEntry[];
  /**
   * Whether the change set is final.
   *
   * Only a settled diff goes through the syntax-highlighting viewer: it parses
   * the patch, and a half-streamed hunk is not one.
   */
  settled: boolean;
  /** Shows each file's path even for a single-file set. */
  alwaysLabelPaths?: boolean;
}

/**
 * Lists every proposed file with its diff.
 *
 * Every entry is drawn, never just the first — one approval was measured
 * covering two files, and a renderer that shows one of them is asking the user
 * to approve a write they cannot see.
 */
export function FileChangeSet({ changes, settled, alwaysLabelPaths }: Props) {
  const { t } = useTranslation();
  const showPaths = alwaysLabelPaths || changes.length > 1;

  return (
    <>
      {changes.map((change, index) => (
        <div key={`${index}:${change.path}`} className="border-t border-border">
          {showPaths && (
            <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-xs text-muted-foreground">
              <span className="min-w-0 truncate">{change.path}</span>
              {/* A rename's destination exists only inside the kind union, so
                  omitting it would show the move as an edit in place. */}
              {change.movePath && (
                <span className="shrink-0 truncate text-blue-400">
                  → {change.movePath}
                </span>
              )}
              {change.changeKind && change.changeKind !== 'update' && (
                <span className="shrink-0 uppercase">{change.changeKind}</span>
              )}
            </div>
          )}
          {change.diff ? (
            settled ? (
              <GitDiffPanel
                diff={change.diff}
                filePath={change.path}
                showToolbar={false}
                maxHeightClassName="max-h-64"
              />
            ) : (
              <RawDiff diff={change.diff} />
            )
          ) : (
            // A change with no diff is still a change. Saying so beats an empty
            // row that reads as though the file were untouched.
            <p className="px-3 py-1.5 text-xs text-muted-foreground">
              {t('No diff provided for this file.')}
            </p>
          )}
        </div>
      ))}
    </>
  );
}
