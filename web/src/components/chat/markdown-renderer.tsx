/**
 * Markdown renderer for agent messages.
 * Uses react-markdown + remark-gfm. Code blocks get Shiki syntax highlighting
 * (lazy-loaded on first completed code block, plain <code> fallback while loading).
 */
import { memo, useEffect, useState, useCallback, type ComponentProps } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';
import { showSnackbar } from '@/stores/snackbar-store';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

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
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showSnackbar(t('Copy failed'), 'error');
    }
  }, [children, t]);

  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-border/50 bg-[#0d1117]">
      <div className="flex items-center justify-between border-b border-border/30 px-3 py-1">
        <span className="text-xs text-muted-foreground">{lang || t('Code')}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
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
        <pre className="m-0 overflow-auto p-3 text-sm leading-relaxed text-muted-foreground">
          <code>{children}</code>
        </pre>
      )}
    </div>
  );
}

/** Maps markdown elements to Tailwind-styled components. */
const components = (completed: boolean): ComponentProps<typeof Markdown>['components'] => ({
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
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 underline decoration-blue-400/30 hover:decoration-blue-400"
    >
      {children}
    </a>
  ),
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
  code: ({ className, children, ...rest }) => {
    const isBlock = className?.startsWith('language-') || String(children).includes('\n');
    if (isBlock) {
      return (
        <CodeBlock className={className} completed={completed}>
          {String(children).replace(/\n$/, '')}
        </CodeBlock>
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

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, completed }: Props) {
  return (
    <div className={cn('text-sm leading-relaxed', 'wrap-break-word')}>
      <Markdown remarkPlugins={[remarkGfm]} components={components(completed)}>
        {content}
      </Markdown>
    </div>
  );
});
