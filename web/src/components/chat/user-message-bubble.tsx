/**
 * User message bubble with markdown rendering, clickable @mentions, and image badges.
 * Uses react-markdown + remark-gfm + custom remark-mentions plugin.
 */
import { useMemo, type ComponentProps } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, ImageIcon } from 'lucide-react';
import { remarkMentions } from '@/lib/remark-mentions';
import { normalizeMessageMentions } from '@/lib/mention-utils';

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

/** Allow `mention:` scheme through react-markdown's URL sanitizer. */
function userUrlTransform(url: string): string {
  if (url.startsWith('mention:')) return url;
  return defaultUrlTransform(url);
}

/**
 * Markdown component overrides for user message bubbles.
 *
 * Tints are expressed against `foreground`/`border` rather than fixed white or
 * black: the bubble sits on a neutral surface that inverts between themes, and
 * hard-coded white worked only while the bubble was a saturated blue block.
 *
 * Links with `mention:` scheme render as clickable file badges;
 * regular links open in a new tab.
 */
const userComponents: ComponentProps<typeof Markdown>['components'] = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="text-sm">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => {
    // Mention links → clickable file badge
    if (href?.startsWith('mention:')) {
      const absolutePath = href.slice('mention:'.length);
      return (
        <span
          role="button"
          tabIndex={0}
          onClick={() => openFileInPanel(absolutePath)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openFileInPanel(absolutePath);
            }
          }}
          className="inline-flex cursor-pointer items-center gap-1 rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[0.85em] transition-colors hover:bg-foreground/20"
        >
          <FileText className="inline h-3 w-3 opacity-70" />
          {children}
        </span>
      );
    }
    // Regular links
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
        {children}
      </a>
    );
  },
  code: ({ className, children, ...rest }) => {
    const isBlock = className?.startsWith('language-') || String(children).includes('\n');
    if (isBlock) {
      return (
        <pre className="my-2 overflow-auto rounded bg-foreground/[0.07] p-3 text-sm leading-relaxed">
          <code>{children}</code>
        </pre>
      );
    }
    return (
      <code className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[0.85em]" {...rest}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  hr: () => <hr className="my-3 border-border" />,
};

export function UserMessageBubble({ content, threadCwd, images }: Props) {
  // Normalize absolute @mentions to relative before rendering
  const normalizedContent = useMemo(
    () => normalizeMessageMentions(content, threadCwd),
    [content, threadCwd],
  );

  // Memoize remark plugins array (stable reference prevents re-renders)
  const remarkPlugins = useMemo(
    () => [remarkGfm, remarkMentions(threadCwd)],
    [threadCwd],
  );

  // Filter out direct URLs — only server paths are openable
  const imageFiles = images?.filter((src) => !/^(https?|data|blob):/.test(src));

  return (
    <div className="text-sm leading-relaxed [overflow-wrap:break-word]">
      <Markdown remarkPlugins={remarkPlugins} components={userComponents} urlTransform={userUrlTransform}>
        {normalizedContent}
      </Markdown>

      {imageFiles && imageFiles.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {imageFiles.map((src, i) => (
            <span
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => openFileInPanel(src)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openFileInPanel(src);
                }
              }}
              className="inline-flex cursor-pointer items-center gap-1 rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[0.85em] transition-colors hover:bg-foreground/20"
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
