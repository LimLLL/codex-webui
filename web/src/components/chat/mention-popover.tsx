/**
 * Popover triggered by @ in ChatInput for file/directory search.
 * Pure display component — filtering and query are managed by useChatMention hook.
 */
import { useEffect, useRef } from 'react';
import { File, Folder, Loader2, Paperclip } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { unescapeMentionPath } from '@/lib/mention-utils';
import { cn } from '@/lib/utils';

export interface MentionResult {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

interface Props {
  open: boolean;
  /** Breadcrumb path segments (relative, e.g. "src/components"). */
  browseRelative: string;
  /** Pre-filtered mention results from the parent hook. */
  filtered: MentionResult[];
  /** Whether the directory listing is still loading. */
  isLoading: boolean;
  selectedIndex: number;
  /** Called when a file is selected (or directory is pinned). */
  onSelect: (result: MentionResult) => void;
  /** Called when user navigates into a directory (click or Enter on dir). */
  onNavigate: (dirPath: string) => void;
  /** Called when user clicks a breadcrumb segment to go back to that level. */
  onNavigateUp: (relativePath: string) => void;
}

export function MentionPopover({ open, browseRelative, filtered, isLoading, selectedIndex, onSelect, onNavigate, onNavigateUp }: Props) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!open) return null;

  const pathSegments = browseRelative ? browseRelative.split('/') : [];

  return (
    <div className="absolute bottom-full z-50 mb-1 w-72 rounded-lg border border-border bg-popover shadow-lg">
      {/* Clickable breadcrumb for navigation */}
      <div className="flex items-center gap-0.5 border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={() => onNavigateUp('')}
          className="rounded px-0.5 hover:bg-accent hover:text-foreground"
        >
          /
        </button>
        {pathSegments.map((seg, i) => {
          const segPath = pathSegments.slice(0, i + 1).join('/');
          return (
            <span key={i} className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => onNavigateUp(segPath)}
                className="rounded px-0.5 hover:bg-accent hover:text-foreground"
              >
                {unescapeMentionPath(seg)}
              </button>
              {i < pathSegments.length - 1 && <span className="opacity-40">/</span>}
            </span>
          );
        })}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('Loading...')}
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground">
          {t('No matching files')}
        </div>
      ) : (
        <div ref={listRef} className="max-h-52 overflow-y-auto py-1">
          {filtered.map((entry, i) => (
            <div
              key={entry.path}
              className={cn(
                'group flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors',
                i === selectedIndex ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50',
              )}
            >
              {entry.type === 'directory' ? (
                <>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => onNavigate(entry.path)}
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{entry.name}</span>
                  </button>
                  <button
                    type="button"
                    title={t('Attach to chat')}
                    onClick={() => onSelect(entry)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
                  >
                    <Paperclip className="h-3 w-3" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => onSelect(entry)}
                >
                  <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{entry.name}</span>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
