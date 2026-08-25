import { useState } from 'react';
import { Activity, Check, Edit3, EllipsisVertical, Globe, Menu, Moon, Network, PanelLeftOpen, Settings, Sun, X } from 'lucide-react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  threadsListThreadsQueryKey,
  threadsSetThreadNameMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { useConnectionStore } from '@/stores/connection-store';
import { useLayoutStore } from '@/stores/layout-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { useMessageVersions } from '@/hooks/use-message-branches';
import { BranchGraphDialog } from '@/components/branches/branch-graph-dialog';
import { AccountRateLimitBadge } from './account-rate-limit-badge';
import { McpStatusBadge } from './mcp-status-badge';

/** Mobile overflow menu — closes after each action. */
function MobileOverflowMenu({
  onDiagnostics,
  onToggleLanguage,
  onToggleDark,
  dark,
  languageLabel,
  t,
}: {
  onDiagnostics: () => void;
  onToggleLanguage: () => void;
  onToggleDark: () => void;
  dark: boolean;
  languageLabel: string;
  t: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => { fn(); setOpen(false); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" className="h-9 w-9" aria-label={t('More actions')}>
          <EllipsisVertical className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-48 p-1">
        <button type="button" onClick={() => act(onDiagnostics)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
          <Activity className="h-4 w-4" /> {t('Diagnostics')}
        </button>
        <button type="button" onClick={() => act(onToggleLanguage)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
          <Globe className="h-4 w-4" /> {languageLabel}
        </button>
        <button type="button" onClick={() => act(onToggleDark)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {dark ? t('Light mode') : t('Dark mode')}
        </button>
      </PopoverContent>
    </Popover>
  );
}

interface Props {
  dark: boolean;
  onToggleDark: () => void;
  onToggleDiagnostics: () => void;
}

export function ChatHeader({ dark, onToggleDark, onToggleDiagnostics }: Props) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const connected = useConnectionStore((s) => s.connected);
  const threadId = useTimelineStore((s) => s.threadId);
  const threadTitle = useTimelineStore((s) => s.threadTitle);
  const threadMode = useTimelineStore((s) => s.threadMode);
  const setThreadTitle = useTimelineStore((s) => s.setThreadTitle);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [graphOpen, setGraphOpen] = useState(false);
  const queryClient = useQueryClient();

  // The graph is only meaningful once this conversation has more than one
  // version, so the entry point appears with the branches rather than always.
  const { isTracked } = useMessageVersions(threadId);

  // ── Responsive ──────────────────────────────────────────────────────
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  const toggleSidebarOpen = useLayoutStore((s) => s.toggleSidebarOpen);
  const desktopSidebarCollapsed = useLayoutStore((s) => s.desktopSidebarCollapsed);
  const toggleDesktopSidebarCollapsed = useLayoutStore((s) => s.toggleDesktopSidebarCollapsed);

  const isDiagnostics = useRouterState({
    select: (s) => s.location.pathname.startsWith('/diagnostics'),
  });

  const renameThread = useMutation({
    ...threadsSetThreadNameMutation(),
    onSuccess: (_res, variables) => {
      setThreadTitle(variables.body.name.trim());
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: threadsListThreadsQueryKey() });
    },
  });

  const toggleLanguage = () => {
    const next = i18n.language.startsWith('zh') ? 'en' : 'zh-CN';
    void i18n.changeLanguage(next);
  };

  const startEditing = () => {
    setDraftName(threadTitle ?? '');
    setEditing(true);
  };

  const saveName = () => {
    if (!threadId) return;
    const name = draftName.trim();
    if (!name) return;
    renameThread.mutate({ path: { threadId }, body: { name } });
  };

  const handleDiagnosticsToggle = () => {
    if (isDiagnostics) {
      if (threadId) {
        void navigate({ to: '/t/$threadId', params: { threadId } });
      } else {
        void navigate({ to: '/' });
      }
    } else {
      onToggleDiagnostics();
    }
  };

  return (
    <>
      <header className="glass-4 sticky top-0 z-10 flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3 lg:px-6">
        {/* Hamburger (mobile/tablet) or expand toggle (desktop collapsed) */}
        {!isDesktop ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 shrink-0 lg:hidden"
            onClick={toggleSidebarOpen}
            aria-label={t('Open navigation')}
          >
            <Menu className="h-5 w-5" />
          </Button>
        ) : desktopSidebarCollapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                onClick={toggleDesktopSidebarCollapsed}
                aria-label={t('Expand sidebar')}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Expand sidebar')}</TooltipContent>
          </Tooltip>
        ) : null}

        <div className="min-w-0 flex-1">
          {threadId ? (
            <div className="flex min-w-0 items-center gap-2">
              {editing ? (
                <>
                  <Input
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveName();
                      if (event.key === 'Escape') setEditing(false);
                    }}
                    className="h-8 max-w-sm"
                    autoFocus
                  />
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={saveName} disabled={!draftName.trim()}>
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="truncate text-left text-lg font-semibold tracking-tight hover:underline"
                    onClick={startEditing}
                    title={threadTitle ?? threadId}
                  >
                    {threadTitle || threadId.slice(0, 8)}
                  </button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={startEditing} title={t('Rename')}>
                    <Edit3 className="h-3.5 w-3.5" />
                  </Button>
                  {isTracked && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setGraphOpen(true)}
                          aria-label={t('Branch graph')}
                        >
                          <Network className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('Branch graph')}</TooltipContent>
                    </Tooltip>
                  )}
                  {threadMode === 'readOnly' && (
                    <Badge variant="secondary" className="text-xs">
                      {t('Archived read-only')}
                    </Badge>
                  )}
                </>
              )}
            </div>
          ) : (
            <h1 className="text-lg font-semibold tracking-tight">Codex WebUI</h1>
          )}
        </div>
        {/* Always visible badges */}
        <McpStatusBadge mode="header" />
        <span className="hidden sm:inline-flex"><AccountRateLimitBadge /></span>
        <Badge
          variant={connected ? 'default' : 'secondary'}
          className="text-xs transition-colors duration-300"
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full sm:mr-1.5 ${
              connected
                ? 'animate-pulse bg-green-400'
                : 'bg-muted-foreground'
            }`}
          />
          <span className="hidden sm:inline">
            {connected ? t('Connected') : t('Disconnected')}
          </span>
        </Badge>

        {/* Desktop: inline action buttons */}
        {isDesktop ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleDiagnosticsToggle}>
                  <Activity className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('Diagnostics')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void navigate({ to: '/settings' })}>
                  <Settings className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('Settings')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={toggleLanguage}>
                  <Globe className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{i18n.language.startsWith('zh') ? 'English' : '简体中文'}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onToggleDark}>
                  {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{dark ? t('Light mode') : t('Dark mode')}</TooltipContent>
            </Tooltip>
          </>
        ) : (
          /* Mobile/Tablet: overflow menu popover */
          <MobileOverflowMenu
            onDiagnostics={handleDiagnosticsToggle}
            onToggleLanguage={toggleLanguage}
            onToggleDark={onToggleDark}
            dark={dark}
            languageLabel={i18n.language.startsWith('zh') ? 'English' : '简体中文'}
            t={t}
          />
        )}
      </header>
      <Separator />
      <BranchGraphDialog
        threadId={graphOpen ? threadId : null}
        onClose={() => setGraphOpen(false)}
      />
    </>
  );
}
