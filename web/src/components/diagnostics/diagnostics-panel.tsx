/** Diagnostics panel for browsing structured logs and exporting issue bundles. */
import { useMemo, useState } from 'react';
import { Download, RefreshCw, Copy } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { logsListLogsOptions } from '@/generated/api/@tanstack/react-query.gen';
import type {
  LogEntryDto,
  LogsExportResponseDto,
  LogsListLogsData,
} from '@/generated/api';
import { logsExportDiagnostics } from '@/generated/api';
import { copyTextToClipboard } from '@/lib/clipboard';
import { showSnackbar } from '@/stores/snackbar-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

type LogLevel = NonNullable<NonNullable<LogsListLogsData['query']>['level']>;

const LEVELS: Array<'' | LogLevel> = ['', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const PAGE_SIZE = 50;

/** Renders filters, log entries, and copy/download diagnostics actions. */
export function DiagnosticsPanel() {
  const { t } = useTranslation();
  const [level, setLevel] = useState<'' | LogLevel>('');
  const [source, setSource] = useState('');
  const [offset, setOffset] = useState(0);
  /** Bundle fetched for a copy the browser then refused; see handleCopyExport. */
  const [readyBundle, setReadyBundle] = useState<LogsExportResponseDto | null>(null);
  const [copyPending, setCopyPending] = useState(false);

  const query = useQuery(
    logsListLogsOptions({
      query: {
        level: (level || undefined) as LogLevel | undefined,
        source: source || undefined,
        offset,
        limit: PAGE_SIZE,
      },
    }),
  );

  const entries = query.data?.data ?? [];
  const total = query.data?.total ?? 0;
  const pageLabel = useMemo(() => {
    if (!query.data) return '0 / 0';
    const start = total === 0 ? 0 : offset + 1;
    const end = Math.min(offset + PAGE_SIZE, total);
    return `${start}-${end} / ${total}`;
  }, [offset, query.data, total]);

  const handleExport = async () => {
    const { data: bundle } = await logsExportDiagnostics({ throwOnError: true });
    downloadJson(bundle, `codex-webui-diagnostics-${bundle.exportedAt}.json`);
  };

  /**
   * Copies the diagnostic bundle, retaining it when the copy itself fails.
   *
   * Off HTTPS the clipboard write falls back to `execCommand`, which browsers
   * only honour while the originating click's user activation is still live —
   * and building the bundle spends real time (it reads the rotated log files
   * and shells out for the Codex version). Rather than pre-fetching on every
   * visit, the bundle earned by a failed attempt is kept so the next click can
   * copy from the click's own call stack, where the activation is guaranteed.
   *
   * A retained bundle is a snapshot, so it is surfaced on the button rather
   * than held invisibly, and Refresh discards it along with the logs on screen.
   * The button is disabled for the duration: two exports in flight can settle
   * out of order and let a failed older one reinstate itself over a newer one
   * that already copied.
   */
  const handleCopyExport = async () => {
    setCopyPending(true);
    try {
      let bundle = readyBundle;
      if (!bundle) {
        try {
          const { data } = await logsExportDiagnostics({ throwOnError: true });
          bundle = data;
        } catch {
          // The API client's error interceptor already reported this; a second
          // snackbar would only stack the same message on top of itself.
          return;
        }
      }

      try {
        await copyTextToClipboard(JSON.stringify(bundle, null, 2));
        setReadyBundle(null);
        showSnackbar(t('Copied!'), 'success');
      } catch {
        setReadyBundle(bundle);
        showSnackbar(t('Copy failed. Click again to copy.'), 'warning');
      }
    } finally {
      setCopyPending(false);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="mr-auto">
          <h2 className="text-sm font-semibold">{t('Diagnostics')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('Structured logs and sanitized issue bundle export.')}
          </p>
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('Level')}
          <select
            value={level}
            onChange={(event) => {
              setOffset(0);
              setLevel(event.target.value as '' | LogLevel);
            }}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          >
            {LEVELS.map((item) => (
              <option key={item || 'all'} value={item}>
                {item || t('All')}
              </option>
            ))}
          </select>
        </label>

        <Input
          value={source}
          onChange={(event) => {
            setOffset(0);
            setSource(event.target.value);
          }}
          placeholder={t('Filter source')}
          className="h-8 w-40"
        />

        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // Refreshing asks for current diagnostics, so a snapshot held over
            // from a refused copy would contradict what the panel now shows.
            setReadyBundle(null);
            void query.refetch();
          }}
          // Also locked during a copy: clearing here cannot undo a copy already
          // in flight, whose failure would reinstate the snapshot afterwards.
          disabled={query.isFetching || copyPending}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t('Refresh')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          // `aria-disabled` rather than `disabled`: a disabled button cannot
          // hold focus, and the fallback copy path hands focus back to whatever
          // held it — which would be <body> if this button had been disabled
          // out from under it, exactly when a refused copy asks for another
          // click. The handler guards the press instead.
          aria-disabled={copyPending}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (copyPending) return;
            void handleCopyExport();
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          {readyBundle ? t('Copy prepared export') : t('Copy export')}
        </Button>
        <Button size="sm" onClick={() => void handleExport()}>
          <Download className="h-3.5 w-3.5" />
          {t('Download export')}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="divide-y divide-border">
          {entries.map((entry, index) => (
            <LogEntryDtoRow key={`${entry.timestamp}-${index}`} entry={entry} />
          ))}

          {!query.isLoading && entries.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {t('No logs found')}
            </div>
          )}

          {query.isLoading && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {t('Loading...')}
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
        <span>{pageLabel}</span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            {t('Previous')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!query.data?.hasMore}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            {t('Next')}
          </Button>
        </div>
      </div>
    </section>
  );
}

function LogEntryDtoRow({ entry }: { entry: LogEntryDto }) {
  return (
    <article className="space-y-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={levelVariant(entry.level)}>{entry.level}</Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {entry.timestamp}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {entry.source}
        </span>
      </div>
      <p className="break-words text-foreground">{entry.message || '(no message)'}</p>
      <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs text-muted-foreground">
        {JSON.stringify(entry.fields, null, 2)}
      </pre>
    </article>
  );
}

function levelVariant(level: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (level === 'error' || level === 'fatal') return 'destructive';
  if (level === 'warn') return 'outline';
  if (level === 'info') return 'default';
  return 'secondary';
}

function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/[:.]/g, '-');
  link.click();
  URL.revokeObjectURL(url);
}
