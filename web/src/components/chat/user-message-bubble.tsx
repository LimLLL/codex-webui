/** User message bubble with clickable @mention badges and image badges. */
import { useMemo } from 'react';
import { FileText, ImageIcon } from 'lucide-react';
import { normalizeMessageMentions, splitMentionSegments } from '@/lib/mention-utils';

interface Props {
  content: string;
  threadCwd: string | null;
  images?: string[];
}

/** Dispatches a custom event to open a file in the session panel. */
function openFileInPanel(absolutePath: string): void {
  window.dispatchEvent(
    new CustomEvent('codex-webui:open-file', { detail: { path: absolutePath } }),
  );
}

export function UserMessageBubble({ content, threadCwd, images }: Props) {
  const segments = useMemo(() => {
    const normalized = normalizeMessageMentions(content, threadCwd);
    return splitMentionSegments(normalized);
  }, [content, threadCwd]);

  /** Resolves a mention display value (e.g. `@src/app.ts`) back to absolute path. */
  const resolveAbsolutePath = (mentionValue: string): string | null => {
    const mentionPath = mentionValue.startsWith('@')
      ? mentionValue.slice(1)
      : mentionValue;
    if (!mentionPath) return null;
    if (mentionPath.startsWith('/')) return mentionPath;
    if (!threadCwd) return null;
    return `${threadCwd}/${mentionPath}`;
  };

  // Filter out direct URLs — only server paths are openable
  const imageFiles = images?.filter((src) => !/^(https?|data|blob):/.test(src));

  return (
    <div className="text-sm leading-relaxed">
      <div>
        {segments.map((seg, i) =>
          seg.type === 'mention' ? (
            <span
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => {
                const absPath = resolveAbsolutePath(seg.value);
                if (absPath) openFileInPanel(absPath);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const absPath = resolveAbsolutePath(seg.value);
                  if (absPath) openFileInPanel(absPath);
                }
              }}
              className="inline-flex cursor-pointer items-center gap-1 rounded bg-white/15 px-1.5 py-0.5 font-mono text-[0.85em] transition-colors hover:bg-white/25"
            >
              <FileText className="inline h-3 w-3 opacity-70" />
              {seg.value}
            </span>
          ) : (
            <span key={i}>{seg.value}</span>
          ),
        )}
      </div>

      {imageFiles && imageFiles.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {imageFiles.map((src, i) => (
            <span
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => openFileInPanel(src)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') openFileInPanel(src);
              }}
              className="inline-flex cursor-pointer items-center gap-1 rounded bg-white/15 px-1.5 py-0.5 font-mono text-[0.85em] transition-colors hover:bg-white/25"
            >
              <ImageIcon className="inline h-3 w-3 opacity-70" />
              {src.split('/').pop() ?? src}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
