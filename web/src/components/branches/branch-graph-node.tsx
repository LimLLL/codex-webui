/** Shared node body for both branch-graph surfaces. */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Archive,
  CircleHelp,
  Loader2,
  ShieldQuestion,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { BRANCH_NODE_HEIGHT, BRANCH_NODE_WIDTH } from '@/lib/branch-graph-layout';

/**
 * Everything the node body renders; assembled by whichever surface owns it.
 *
 * Deliberately free of an index signature. React Flow wants node data to be
 * indexable, but `Omit`-ing a field from an indexable type erases its named
 * members, so the index signature is added only at the React Flow boundary.
 */
export interface BranchGraphNodeData {
  threadId: string;
  label: string;
  /**
   * Marks the node a cascading delete was launched from.
   *
   * Only meaningful where the rest of the set follows from this one — i.e. the
   * delete confirmation. In a browse graph every node is equally "the one you
   * opened it from", so the badge would say nothing.
   */
  isTarget: boolean;
  /** Set for the thread currently open, so the graph doubles as a "you are here". */
  isCurrent: boolean;
  /** Marks the whole subtree a pending delete would remove. */
  isDoomed: boolean;
  running: boolean;
  pendingApprovalCount: number;
  archived: boolean;
  /**
   * True when this branch was not created by this client.
   *
   * Deliberately separate from {@link boundaryUnknown}: adopting a fork off disk
   * reconstructs its divergence point precisely, so "we did not make this" and
   * "we do not know where this split" are different claims. Conflating them made
   * the graph report a known fork point as unknown.
   */
  external: boolean;
  /**
   * True when the fork point was never recorded anywhere we can read, so the
   * node's vertical placement is approximate and its edge is drawn dashed.
   */
  boundaryUnknown: boolean;
  /** Unix seconds; null when app-server no longer knows the thread. */
  createdAt: number | null;
  /** Purely cosmetic: the click itself is handled by React Flow's `onNodeClick`. */
  clickable: boolean;
}

/** Compact absolute timestamp; branch trees are read by "which came first". */
function formatCreatedAt(seconds: number | null): string | null {
  if (!seconds) return null;
  return new Date(seconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * One conversation in the branch graph.
 *
 * Doomed nodes are marked three ways — colour, a strikethrough label, and an
 * icon — because colour alone fails both low-contrast dark themes and colour
 * vision deficiency, and this styling is what tells a user what is about to be
 * destroyed.
 */
export function BranchGraphNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const node = data as unknown as BranchGraphNodeData;
  const createdAt = formatCreatedAt(node.createdAt);

  return (
    <div
      style={{ width: BRANCH_NODE_WIDTH, height: BRANCH_NODE_HEIGHT }}
      className={cn(
        'flex flex-col justify-between rounded-lg border px-3 py-2 text-left transition-colors',
        node.isDoomed
          ? 'border-destructive/60 bg-destructive/10'
          : 'border-border bg-card',
        node.isCurrent && !node.isDoomed && 'border-primary ring-1 ring-primary/40',
        node.clickable && 'cursor-pointer hover:border-primary/60',
      )}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />

      <div className="flex items-start gap-1.5">
        {node.isDoomed && (
          <Trash2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        )}
        <span
          className={cn(
            'line-clamp-2 text-xs leading-snug',
            node.isDoomed
              ? 'text-destructive line-through decoration-destructive/60'
              : 'text-foreground',
          )}
        >
          {node.label}
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {createdAt && (
          <span className="tabular-nums" title={createdAt}>
            {createdAt}
          </span>
        )}
        {node.isTarget && (
          <span className="rounded bg-destructive/20 px-1 py-px text-destructive">
            {t('Selected for deletion')}
          </span>
        )}
        {node.isCurrent && (
          <span className="rounded bg-primary/15 px-1 py-px text-primary">
            {t('Open')}
          </span>
        )}
        {node.running && (
          <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('Running')}
          </span>
        )}
        {node.pendingApprovalCount > 0 && (
          <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
            <ShieldQuestion className="h-3 w-3" />
            {node.pendingApprovalCount}
          </span>
        )}
        {node.archived && (
          <span className="flex items-center gap-0.5">
            <Archive className="h-3 w-3" />
            {t('Archived')}
          </span>
        )}
        {/* One marker, not two: a branch with an unrecorded fork point is
            always external as well, and stacking both badges says nothing
            extra. The stronger claim wins. */}
        {(node.boundaryUnknown || node.external) && (
          <span
            className="flex items-center gap-0.5"
            title={
              node.boundaryUnknown
                ? t('Fork point unknown: this branch was not created here.')
                : t(
                    'Created outside this client; its fork point was reconstructed from disk.',
                  )
            }
          >
            <CircleHelp className="h-3 w-3" />
            {node.boundaryUnknown ? t('Fork point unknown') : t('External')}
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}
