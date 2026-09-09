/**
 * MCPs tab: full MCP server list with status, auth, reload, and OAuth login.
 */
import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  mcpServersListServersQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import {
  mcpServersListServers,
  mcpServersReloadAll,
  mcpServersStartOauthLogin,
} from '@/generated/api/sdk.gen';
import type { McpServerStatus, McpServerStartupState } from '@/types/mcp';
import { useMcpStore, type McpServerRuntimeStatus } from '@/stores/mcp-store';
import { cn } from '@/lib/utils';
import { showSnackbar } from '@/stores/snackbar-store';
import { getApiErrorMessage } from '@/lib/api-error';
import { copyTextToClipboard } from '@/lib/clipboard';

export function McpsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const runtimeStatuses = useMcpStore((s) => s.statuses);

  const serversQuery = useQuery({
    queryKey: mcpServersListServersQueryKey(),
    queryFn: async () => {
      const { data } = await mcpServersListServers({
        query: { detail: 'toolsAndAuthOnly' },
        throwOnError: true,
      });
      return data;
    },
    staleTime: 30_000,
  });

  const reloadMutation = useMutation({
    mutationFn: () => mcpServersReloadAll({ throwOnError: true }),
    onSuccess: () => {
      showSnackbar(t('MCP servers reloading'), 'success');
      void queryClient.invalidateQueries({ queryKey: mcpServersListServersQueryKey() });
    },
    onError: (err) => showSnackbar(getApiErrorMessage(err), 'error'),
  });

  // Build merged rows from inventory + runtime status
  const rows = buildRows(
    (serversQuery.data?.data ?? []) as unknown as McpServerStatus[],
    runtimeStatuses,
  );

  if (serversQuery.isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (serversQuery.isError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        {t('Failed to load MCP servers')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with reload */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {t('{{ready}}/{{total}} ready', {
            ready: rows.filter((r) => r.status === 'ready').length,
            total: rows.length,
          })}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={reloadMutation.isPending}
          onClick={() => reloadMutation.mutate()}
        >
          {reloadMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('Reload All')}
        </Button>
      </div>

      {/* Server list */}
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t('No MCP servers reported')}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <McpServerRow key={row.name} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface McpRow {
  name: string;
  status: McpServerStartupState;
  error: string | null;
  authStatus?: McpServerStatus['authStatus'];
  toolCount?: number;
}

function McpServerRow({ row }: { row: McpRow }) {
  const { t } = useTranslation();
  const [loggingIn, setLoggingIn] = useState(false);
  /** Authorization URL the popup blocker kept us from opening; see below. */
  const [blockedAuthUrl, setBlockedAuthUrl] = useState<string | null>(null);

  const StatusIcon =
    row.status === 'failed' ? AlertCircle :
    row.status === 'starting' ? Loader2 :
    CheckCircle2;

  const needsLogin = row.authStatus === 'notLoggedIn';

  // The row is keyed by server name and outlives any one login attempt, so a
  // retained URL has to be released when authentication actually succeeds.
  // Otherwise a later logout re-reveals the stale link, which points at a flow
  // nobody started. Copying or opening the link proves nothing on its own —
  // only the server reporting itself logged in does.
  //
  // Adjusted during render rather than in an effect: the release is derived
  // from a prop transition, and an effect would paint the stale link once
  // before clearing it.
  const [loginWasNeeded, setLoginWasNeeded] = useState(needsLogin);
  if (loginWasNeeded !== needsLogin) {
    setLoginWasNeeded(needsLogin);
    if (!needsLogin) setBlockedAuthUrl(null);
  }

  const handleOauthLogin = async () => {
    setLoggingIn(true);
    setBlockedAuthUrl(null);
    // Open blank tab synchronously to avoid popup blocker
    const loginTab = window.open('about:blank', '_blank');

    try {
      const { data } = await mcpServersStartOauthLogin({
        body: { name: row.name },
        throwOnError: true,
      });
      if (data?.authorizationUrl && loginTab) {
        // Prevent opened page from accessing window.opener (security)
        loginTab.opener = null;
        loginTab.location.href = data.authorizationUrl;
      } else if (data?.authorizationUrl) {
        // Popup blocked. Surface the URL for the user to act on rather than
        // copying it here: off HTTPS the clipboard falls back to a command
        // that needs the click's user activation, which the request above may
        // already have spent — and a copy that failed used to discard the URL
        // outright, leaving Login as the only recourse and failing the same
        // way again. A link the user activates needs no clipboard at all.
        setBlockedAuthUrl(data.authorizationUrl);
        showSnackbar(t('Popup blocked. Use the authorization link below.'), 'warning');
      }
    } catch (err) {
      loginTab?.close();
      showSnackbar(getApiErrorMessage(err), 'error');
    } finally {
      setLoggingIn(false);
    }
  };

  /** Copies the retained URL from the user's own click, where activation holds. */
  const handleCopyAuthUrl = async () => {
    if (!blockedAuthUrl) return;
    try {
      await copyTextToClipboard(blockedAuthUrl);
      showSnackbar(t('Copied!'), 'success');
    } catch {
      showSnackbar(t('Copy failed'), 'error');
    }
  };

  return (
    <div className="rounded-lg border border-border/50 p-3">
      <div className="flex items-center gap-2">
        <StatusIcon
          className={cn(
            'h-4 w-4 shrink-0',
            row.status === 'failed' && 'text-destructive',
            row.status === 'ready' && 'text-green-500',
            row.status === 'starting' && 'animate-spin text-blue-500',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
        <Badge variant={row.status === 'failed' ? 'destructive' : 'secondary'} className="text-[10px]">
          {t(row.status)}
        </Badge>
      </div>

      {/* Details row */}
      <div className="mt-1.5 flex items-center gap-3 pl-6 text-xs text-muted-foreground">
        {row.authStatus && <span>{t('auth')}: {t(row.authStatus)}</span>}
        {row.toolCount !== undefined && <span>{t('tools')}: {row.toolCount}</span>}
      </div>

      {/* Error */}
      {row.error && (
        <p className="mt-1 pl-6 text-xs text-destructive">{row.error}</p>
      )}

      {/* OAuth login action */}
      {needsLogin && (
        <div className="mt-2 pl-6">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            disabled={loggingIn}
            onClick={handleOauthLogin}
          >
            {loggingIn ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogIn className="h-3 w-3" />}
            {t('Login')}
          </Button>

          {blockedAuthUrl && (
            <div className="mt-2 space-y-1.5 rounded-md border border-border/50 bg-muted/40 p-2">
              <p className="text-xs text-muted-foreground">
                {t('Your browser blocked the login tab. Open the authorization page yourself:')}
              </p>
              <p className="break-all font-mono text-[11px] text-foreground">{blockedAuthUrl}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" asChild>
                  <a href={blockedAuthUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3 w-3" />
                    {t('Open authorization page')}
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-xs"
                  onClick={() => void handleCopyAuthUrl()}
                >
                  <Copy className="h-3 w-3" />
                  {t('Copy link')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRows(
  servers: McpServerStatus[],
  runtimeStatuses: Record<string, McpServerRuntimeStatus>,
): McpRow[] {
  const rows = new Map<string, McpRow>();
  for (const server of servers) {
    const runtime = runtimeStatuses[server.name];
    rows.set(server.name, {
      name: server.name,
      status: runtime?.status ?? 'ready',
      error: runtime?.error ?? null,
      authStatus: server.authStatus,
      toolCount: Object.keys(server.tools ?? {}).length,
    });
  }
  for (const runtime of Object.values(runtimeStatuses)) {
    if (!rows.has(runtime.name)) {
      rows.set(runtime.name, {
        name: runtime.name,
        status: runtime.status,
        error: runtime.error,
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
