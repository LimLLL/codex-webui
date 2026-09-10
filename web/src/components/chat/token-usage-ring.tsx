/**
 * Circular progress ring showing context window usage.
 * Placed left of the Send button in ChatInput.
 * Desktop: hover reveals popover. Mobile: tap reveals popover.
 */
import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useIsMobile } from '@/hooks/use-breakpoint';
import { useTimelineStore } from '@/stores/timeline-store';
import { getContextRatio, formatTokens } from '@/lib/token-usage';

const SIZE = 24;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Returns a Tailwind-ish color based on usage ratio.
 *
 * @param ratio - 0–1 representing context window fill
 */
function ringColor(ratio: number): string {
  if (ratio >= 0.9) return '#ef4444'; // red-500
  if (ratio >= 0.7) return '#f59e0b'; // amber-500
  return '#22c55e'; // green-500
}

/**
 * Popover wrapper: desktop opens on hover, mobile opens on tap.
 */
function HoverPopover({
  children,
  detail,
}: {
  children: React.ReactNode;
  detail: React.ReactNode;
}) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }, [cancelClose]);

  // Mobile: default click behavior via Radix
  if (mobile) {
    return (
      <Popover>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent side="top" className="w-auto p-3">
          {detail}
        </PopoverContent>
      </Popover>
    );
  }

  // Desktop: hover-controlled popover
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        onMouseEnter={() => { cancelClose(); setOpen(true); }}
        onMouseLeave={scheduleClose}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-auto p-3"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        {detail}
      </PopoverContent>
    </Popover>
  );
}

export function TokenUsageRing() {
  const { t } = useTranslation();
  const usage = useTimelineStore((s) => s.latestTokenUsage);

  if (!usage) return null;

  const ratio = getContextRatio(usage);
  // No context window info → show compact token count only
  if (ratio === null) {
    return (
      <HoverPopover detail={<TokenBreakdown usage={usage} t={t} />}>
        <span className="cursor-default text-[10px] tabular-nums text-muted-foreground">
          {formatTokens(usage.total.totalTokens)}
        </span>
      </HoverPopover>
    );
  }

  const offset = CIRCUMFERENCE * (1 - ratio);
  const color = ringColor(ratio);
  const pct = Math.round(ratio * 100);

  return (
    <HoverPopover detail={<TokenBreakdown usage={usage} t={t} />}>
      <div className="relative flex cursor-default items-center justify-center" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} className="-rotate-90">
          {/* Background track */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            className="text-muted/30"
          />
          {/* Progress arc */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className="transition-all duration-300"
          />
        </svg>
        <span className="absolute text-[8px] font-medium tabular-nums text-muted-foreground">
          {pct}
        </span>
      </div>
    </HoverPopover>
  );
}

/** Tooltip content with detailed token breakdown. */
function TokenBreakdown({
  usage,
  t,
}: {
  usage: import('@/types/codex-notifications').ThreadTokenUsage;
  t: (key: string) => string;
}) {
  const { last, total, modelContextWindow } = usage;
  const hasWindow = modelContextWindow != null && modelContextWindow > 0;
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">{t('Context Usage')}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
        <span className="text-muted-foreground">{t('Context')}</span>
        <span>{formatTokens(last.inputTokens)}</span>
        {hasWindow && (
          <>
            <span className="text-muted-foreground">{t('Window')}</span>
            <span>{formatTokens(modelContextWindow)}</span>
          </>
        )}
        <span className="mt-1 text-muted-foreground">{t('Thread Total')}</span>
        <span className="mt-1 font-medium">{formatTokens(total.totalTokens)}</span>
      </div>
      {/*
        The window is whatever app-server reports, and it routinely differs from
        `model_context_window` in config.toml: Codex clamps that setting to the
        model's `max_context_window` and then reserves headroom. Saying so here
        is cheaper than letting every user rediscover it. The auto-compaction
        threshold is deliberately not shown — the protocol does not expose it,
        and re-deriving it client-side would silently drift from upstream.
      */}
      {hasWindow && (
        <p className="max-w-[15rem] pt-1 text-[10px] leading-snug text-muted-foreground">
          {t(
            'Effective window reported by Codex. It can be smaller than model_context_window in config.toml, which is capped by the model.',
          )}
        </p>
      )}
    </div>
  );
}
