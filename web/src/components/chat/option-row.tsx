/** Selectable popover row with an optional badge and description line. */
import { cn } from '@/lib/utils';

interface Props {
  /** Whether this row is the currently applied choice. */
  active: boolean;
  /** Short right-aligned marker, e.g. the catalog default. */
  badge?: string;
  /** Secondary line; omitted when the catalog supplies no copy. */
  description?: string | null;
  label: string;
  onSelect: () => void;
}

/** Renders one option in a composer selector popover. */
export function OptionRow({
  active,
  badge,
  description,
  label,
  onSelect,
}: Props) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full rounded-md px-2 py-1.5 text-left transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-sm">{label}</span>
        {badge && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {badge}
          </span>
        )}
      </span>
      {description && (
        <span
          className={cn(
            'mt-0.5 block text-xs leading-snug',
            active ? 'text-accent-foreground/70' : 'text-muted-foreground',
          )}
        >
          {description}
        </span>
      )}
    </button>
  );
}
