/**
 * Markdown renderer for agent messages.
 * Uses react-markdown + remark-gfm. Code blocks get Shiki syntax highlighting
 * (lazy-loaded on first completed code block, plain <code> fallback while loading).
 * File references — link destinations and qualifying inline-code tokens — open
 * in the session panel instead of navigating the browser to a dead URL.
 */
import { memo, useEffect, useMemo, useState, useCallback, type ComponentProps } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, FileText } from 'lucide-react';
import { showSnackbar } from '@/stores/snackbar-store';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { parseFileReference, type FileReference } from '@/lib/file-references';
import {
  remarkFileReferences,
  FILE_REFERENCE_PATH_ATTR,
  FILE_REFERENCE_LINE_ATTR,
} from '@/lib/remark-file-references';

type HighlighterType = Awaited<ReturnType<typeof import('shiki')['createHighlighter']>>;

let highlighterPromise: Promise<HighlighterType> | null = null;
let highlighterInstance: HighlighterType | null = null;

/** Lazily creates and caches a Shiki highlighter. */
function getHighlighter(): Promise<HighlighterType> {
  if (highlighterInstance) return Promise.resolve(highlighterInstance);
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(async ({ createHighlighter }) => {
      const hl = await createHighlighter({
        themes: ['github-dark', 'github-light'],
        langs: [
          'javascript', 'typescript', 'jsx', 'tsx', 'json', 'html', 'css',
          'python', 'rust', 'go', 'bash', 'shell', 'sql', 'yaml', 'toml',
          'markdown', 'diff', 'dockerfile',
        ],
      });
      highlighterInstance = hl;
      return hl;
    });
  }
  return highlighterPromise;
}

interface Props {
  content: string;
  /** When false (streaming), skip Shiki highlighting for performance. */
  completed: boolean;
  /**
   * Opens a file the message referred to. Omitted when the renderer is used
   * outside a conversation, where a relative path has nothing to resolve
   * against — references then stay inert rather than guessing a base.
   */
  onOpenFileReference?: (reference: FileReference) => void;
}

/** Local-looking destination: no scheme, not protocol-relative, not a fragment. */
function isLocalDestination(url: string): boolean {
  return (
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) && !url.startsWith('//') && !url.startsWith('#')
  );
}

/**
 * URL transform admitting the one file destination the default sanitizer eats.
 *
 * The stock transform blanks a destination whose first colon precedes any
 * slash, question mark or hash — which is exactly `README.md:42`, a bare
 * filename carrying a line suffix. Paths with a directory separator already
 * survive untouched. Rewriting only that form to an explicit relative path
 * keeps every other protection, including the rejection of unsafe schemes,
 * on the stock path.
 *
 * Restricted to link hrefs: applied blindly it also rewrote image sources, so
 * `![x](README.md:42)` would have issued an image request for a path the
 * renderer never intended to fetch.
 */
const agentUrlTransform: NonNullable<
  ComponentProps<typeof Markdown>['urlTransform']
> = (url, key, node) => {
  if (key !== 'href' || node.tagName !== 'a') return defaultUrlTransform(url);
  const reference = parseFileReference(url, 'link');
  if (reference && reference.line !== null && !url.includes('/') && /:\d+$/.test(url)) {
    return defaultUrlTransform(`./${url}`);
  }
  return defaultUrlTransform(url);
};

/** Stable plugin list; a fresh array each render would rebuild the tree. */
const REMARK_PLUGINS = [remarkGfm, remarkFileReferences()];

/** Clickable file reference, shared by link destinations and inline-code tokens. */
function FileReferenceMark({
  reference,
  onOpen,
  className,
  children,
}: {
  reference: FileReference;
  onOpen: (reference: FileReference) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const activate = () => onOpen(reference);
  const label =
    reference.line !== null ? `${reference.path}:${reference.line}` : reference.path;
  return (
    // A span rather than a button: these appear inside paragraphs, and the
    // human-message mention badge already established this shape.
    <span
      role="button"
      tabIndex={0}
      title={label}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1 rounded transition-colors',
        className,
      )}
    >
      <FileText className="inline h-3 w-3 shrink-0 opacity-70" />
      {children}
    </span>
  );
}

/** Code block with optional Shiki highlighting and copy button. */
function CodeBlock({
  className,
  children,
  completed,
}: {
  className?: string;
  children: string;
  completed: boolean;
}) {
  const { t } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const lang = className?.replace('language-', '') ?? '';

  useEffect(() => {
    if (!completed || !lang) return;
    let cancelled = false;

    void getHighlighter().then((hl) => {
      if (cancelled) return;
      try {
        const loadedLangs = hl.getLoadedLanguages();
        if (!loadedLangs.includes(lang as never)) return;
        const result = hl.codeToHtml(children, {
          lang,
          themes: { dark: 'github-dark', light: 'github-light' },
          defaultColor: 'dark',
        });
        setHtml(result);
      } catch {
        // Language not supported — stay with plain rendering
      }
    });

    return () => { cancelled = true; };
  }, [children, lang, completed]);

  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showSnackbar(t('Copy failed'), 'error');
    }
  }, [children, t]);

  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-border/50 bg-[#0d1117]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1">
        <span className="text-xs text-gray-400">{lang || t('Code')}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-gray-400 opacity-0 transition-opacity hover:text-gray-100 group-hover:opacity-100"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t('Copied!') : t('Copy')}
        </button>
      </div>
      {html ? (
        <div
          className="overflow-auto p-3 text-sm leading-relaxed [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="m-0 overflow-auto p-3 text-sm leading-relaxed text-gray-300">
          <code>{children}</code>
        </pre>
      )}
    </div>
  );
}

/** Maps markdown elements to Tailwind-styled components. */
const components = (
  completed: boolean,
  onOpenFileReference?: (reference: FileReference) => void,
): ComponentProps<typeof Markdown>['components'] => ({
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-xl font-bold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="text-sm">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-muted-foreground/30 pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => {
    // A destination naming a workspace file opens in the session panel. Left as
    // an anchor it would resolve against the app URL and 404, which is the
    // defect this renderer is being corrected for.
    const reference = href ? parseFileReference(href, 'link') : null;
    if (reference && onOpenFileReference) {
      return (
        <FileReferenceMark
          reference={reference}
          onOpen={onOpenFileReference}
          className="px-0.5 text-blue-400 underline decoration-blue-400/30 hover:decoration-blue-400"
        >
          {children}
        </FileReferenceMark>
      );
    }
    // A local destination we could not parse, or could not open, stays inert.
    // Falling through to an anchor would navigate the browser to a path the
    // static server has nothing at — the original defect, reintroduced for
    // exactly the destinations the parser declined to vouch for.
    if (!href || isLocalDestination(href)) {
      return <span>{children}</span>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 underline decoration-blue-400/30 hover:decoration-blue-400"
      >
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className="my-2 overflow-auto">
      <table className="min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
  th: ({ children }) => <th className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">{children}</th>,
  td: ({ children }) => <td className="border-t border-border/50 px-3 py-1.5 text-sm">{children}</td>,
  hr: () => <hr className="my-4 border-border/50" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
  code: ({ node, className, children, ...rest }) => {
    void node;
    const isBlock = className?.startsWith('language-') || String(children).includes('\n');
    if (isBlock) {
      return (
        <CodeBlock className={className} completed={completed}>
          {String(children).replace(/\n$/, '')}
        </CodeBlock>
      );
    }

    // The remark pass tagged this node if its whole token parsed as a file
    // reference, having already skipped fenced blocks and tokens nested in a
    // link. Untagged tokens keep rendering as ordinary code.
    const attributes = rest as Record<string, unknown>;
    const referencePath = attributes[FILE_REFERENCE_PATH_ATTR];
    // Inferred references wait for the message to finish. Mid-stream, an
    // unterminated link can present its code-formatted label as a standalone
    // token, so activating it would open the label's path and then silently
    // change target once the real destination arrives. Explicit links are
    // already complete when markdown recognises them, so they need no wait.
    if (completed && typeof referencePath === 'string' && onOpenFileReference) {
      const rawLine = attributes[FILE_REFERENCE_LINE_ATTR];
      const parsedLine = typeof rawLine === 'string' ? Number(rawLine) : NaN;
      return (
        <FileReferenceMark
          reference={{
            path: referencePath,
            line: Number.isInteger(parsedLine) ? parsedLine : null,
          }}
          onOpen={onOpenFileReference}
          className="bg-muted/60 px-1.5 py-0.5 font-mono text-[0.85em] hover:bg-muted"
        >
          {children}
        </FileReferenceMark>
      );
    }

    return (
      <code
        className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[0.85em]"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
});

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  completed,
  onOpenFileReference,
}: Props) {
  const markdownComponents = useMemo(
    () => components(completed, onOpenFileReference),
    [completed, onOpenFileReference],
  );

  return (
    <div className={cn('text-sm leading-relaxed', 'wrap-break-word')}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        components={markdownComponents}
        urlTransform={agentUrlTransform}
      >
        {content}
      </Markdown>
    </div>
  );
});
