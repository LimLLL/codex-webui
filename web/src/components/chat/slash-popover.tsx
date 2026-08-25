/**
 * Palette triggered by `/` at the start of the composer draft.
 * Pure display component — filtering and selection live in useSlashCommands.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SlashAvailability, SlashCommandDef } from '@/lib/slash-commands';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  /** Pre-filtered commands from the parent hook, in catalog order. */
  filtered: SlashCommandDef[];
  selectedIndex: number;
  /** Drives the per-row disabled state and its explanation. */
  availability: SlashAvailability;
  onSelect: (command: SlashCommandDef) => void;
}

export function SlashPopover({
  open,
  filtered,
  selectedIndex,
  availability,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard selection visible as it moves past the fold.
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIndex] as
      | HTMLElement
      | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!open) return null;

  return (
    <div className="absolute bottom-full z-50 mb-1 w-[calc(100vw-2rem)] max-w-96 rounded-lg border border-border bg-popover shadow-lg sm:w-96">
      <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {t('No matching commands')}
          </div>
        )}
        {filtered.map((command, index) => {
          const blockedReason = command.unavailableReason(availability);
          const disabled = blockedReason !== null;
          return (
            <button
              key={command.name}
              type="button"
              disabled={disabled}
              // Mouse down instead of click: the textarea blurs on click and
              // would close the palette before the handler runs.
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(command);
              }}
              className={cn(
                'flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm',
                index === selectedIndex && !disabled && 'bg-accent',
                disabled
                  ? 'cursor-not-allowed opacity-50'
                  : 'hover:bg-accent/60',
              )}
            >
              <span className="font-mono text-xs font-medium">
                /{command.name}
              </span>
              <span className="flex-1 truncate text-xs text-muted-foreground">
                {disabled ? t(blockedReason) : t(command.description)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
