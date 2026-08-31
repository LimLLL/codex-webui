/**
 * Renders turn lifecycle markers that carry no content of their own:
 * context compaction and the inline review mode brackets.
 *
 * These are deliberately hairline dividers rather than cards — they punctuate
 * the transcript instead of contributing to it, and a card would read as
 * another agent action.
 */
import { Loader2, ScanSearch, ScanText, Shrink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnItem } from '@/types/timeline';

interface Props {
  item: Extract<
    TurnItem,
    {
      type:
        | 'contextCompaction'
        | 'enteredReviewMode'
        | 'exitedReviewMode';
    }
  >;
}

export function TurnMarkerItem({ item }: Props) {
  const { t } = useTranslation();

  const { icon: Icon, label } = describeMarker(item, t);
  if (!label) return null;

  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border/60" />
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        {item.completed ? (
          <Icon className="h-3 w-3" />
        ) : (
          <Loader2 className="h-3 w-3 animate-spin" />
        )}
        {label}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

/**
 * Maps a marker item to its icon and label.
 *
 * @param item - The marker turn item being rendered
 * @param t - i18n translate function from the calling component
 * @returns Icon component plus a display label, or an empty label to skip render
 */
function describeMarker(
  item: Props['item'],
  t: (key: string) => string,
): { icon: typeof Shrink; label: string } {
  switch (item.type) {
    case 'contextCompaction':
      return {
        icon: Shrink,
        label: item.completed
          ? t('Context compacted')
          : t('Compacting context...'),
      };
    case 'enteredReviewMode':
      // `content` is the review subject, e.g. "current changes". It is absent
      // for custom-instruction reviews, so the label has to stand alone.
      return {
        icon: ScanSearch,
        label: item.content
          ? `${t('Reviewing')}: ${item.content}`
          : t('Review started'),
      };
    case 'exitedReviewMode':
      return { icon: ScanText, label: t('Review finished') };
  }
}
