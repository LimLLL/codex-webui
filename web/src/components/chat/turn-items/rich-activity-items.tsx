/** Renderers for sub-agent, search, image, sleep, and future activity items. */
import {
  Bot,
  Clock3,
  Eye,
  ImageIcon,
  Loader2,
  Search,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnItem, WebSearchAction } from '@/types/timeline';

function LifecycleIcon({ completed }: { completed: boolean }) {
  return completed ? (
    <span className="h-1.5 w-1.5 rounded-full bg-current" />
  ) : (
    <Loader2 className="h-3 w-3 animate-spin" />
  );
}

function ActivityMarker({
  icon: Icon,
  completed,
  children,
}: {
  icon: typeof Bot;
  completed: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border/60" />
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 wrap-break-word">{children}</span>
        <LifecycleIcon completed={completed} />
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

/** Renders lifecycle activity attributed to a child thread. */
export function SubAgentActivityItem({
  item,
}: {
  item: Extract<TurnItem, { type: 'subAgentActivity' }>;
}) {
  const { t } = useTranslation();
  const labels = {
    started: t('Sub-agent started'),
    interacted: t('Sub-agent interacted'),
    interrupted: t('Sub-agent interrupted'),
    completed: t('Sub-agent completed'),
  } as const;
  const identity = item.agentPath || item.agentThreadId;
  return (
    <ActivityMarker icon={Bot} completed={item.completed}>
      {labels[item.activityKind]}
      {identity && ` · ${identity}`}
    </ActivityMarker>
  );
}

function describeSearchAction(action: WebSearchAction | null): string | null {
  if (!action) return null;
  switch (action.type) {
    case 'search':
      return action.queries.length > 0
        ? action.queries.join(', ')
        : action.query;
    case 'openPage':
      return action.url;
    case 'findInPage':
      return [action.pattern, action.url].filter(Boolean).join(' · ');
    case 'other':
      return null;
  }
}

/** Renders understood web-search metadata while ignoring opaque result fields. */
export function WebSearchItem({
  item,
}: {
  item: Extract<TurnItem, { type: 'webSearch' }>;
}) {
  const { t } = useTranslation();
  const action = describeSearchAction(item.action);
  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <Search className="h-3.5 w-3.5" />
        <span className="font-medium">{t('Web search')}</span>
        {!item.completed && <Loader2 className="h-3 w-3 animate-spin" />}
        {item.resultCount !== null && (
          <span className="ml-auto">
            {t('{{count}} results', { count: item.resultCount })}
          </span>
        )}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-foreground/80 wrap-break-word">
        {item.query}
      </p>
      {action && <p className="mt-1 font-mono text-[10px] wrap-break-word">{action}</p>}
      {item.resultPreviews.length > 0 && (
        <div className="mt-2 space-y-1.5 border-t border-border/30 pt-2">
          {item.resultPreviews.map((result, index) => (
            <div key={`${result.url ?? result.title ?? 'result'}:${index}`}>
              {result.title && <p className="font-medium text-foreground/80">{result.title}</p>}
              {result.url && <p className="font-mono text-[10px] wrap-break-word">{result.url}</p>}
              {result.snippet && <p className="mt-0.5 line-clamp-3">{result.snippet}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shows that the agent inspected an image path without making it clickable. */
export function ImageViewItem({
  item,
}: {
  item: Extract<TurnItem, { type: 'imageView' }>;
}) {
  const { t } = useTranslation();
  return (
    <ActivityMarker icon={Eye} completed={item.completed}>
      {t('Viewed image')}
      {item.path && ` · ${item.path}`}
    </ActivityMarker>
  );
}

/** Renders an interruptible waiting interval as a compact lifecycle marker. */
export function SleepItem({
  item,
}: {
  item: Extract<TurnItem, { type: 'sleep' }>;
}) {
  const { t } = useTranslation();
  const duration = item.durationMs >= 1000
    ? `${(item.durationMs / 1000).toFixed(1)} s`
    : `${item.durationMs} ms`;
  return (
    <ActivityMarker icon={Clock3} completed={item.completed}>
      {item.completed ? t('Waited') : t('Waiting')}
      {` · ${duration}`}
    </ActivityMarker>
  );
}

/** Renders a generated-image preview and its durable display metadata. */
export function ImageGenerationItem({
  item,
}: {
  item: Extract<TurnItem, { type: 'imageGeneration' }>;
}) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/30 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <Sparkles className="h-3.5 w-3.5" />
        <span className="font-medium">{t('Image generation')}</span>
        <span className="ml-auto">{item.status}</span>
        {!item.completed && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      <div className="space-y-2 border-t border-border/30 px-3 py-2">
        {item.revisedPrompt && (
          <p className="whitespace-pre-wrap text-foreground/80 wrap-break-word">
            {item.revisedPrompt}
          </p>
        )}
        {item.previewUrl && (
          <img
            src={item.previewUrl}
            alt={item.revisedPrompt ?? t('Generated image')}
            className="max-h-96 rounded-md object-contain"
          />
        )}
        {item.hasUnpreviewableResult && (
          <p className="flex items-center gap-1.5">
            <ImageIcon className="h-3.5 w-3.5" />
            {t('Generated image cannot be previewed safely.')}
          </p>
        )}
        {item.savedPath && (
          <p className="font-mono text-[10px] wrap-break-word">{item.savedPath}</p>
        )}
        {item.transparentBackground !== null && (
          <p>
            {item.transparentBackground
              ? t('Transparent background')
              : t('Opaque background')}
          </p>
        )}
        {item.failure && (
          <p className="text-destructive">
            {item.failure.type}
            {item.failure.limitId && ` · ${item.failure.limitId}`}
          </p>
        )}
      </div>
    </div>
  );
}

/** Renders only type and lifecycle for a future, unmodelled protocol item. */
export function UnknownActivityItem({
  item,
}: {
  item: Extract<TurnItem, { type: 'unknownActivity' }>;
}) {
  const { t } = useTranslation();
  return (
    <ActivityMarker icon={ImageIcon} completed={item.completed}>
      {t('Unsupported activity')}: {item.protocolType}
    </ActivityMarker>
  );
}
