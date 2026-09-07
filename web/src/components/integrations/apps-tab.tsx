/**
 * Apps tab: paginated list with enable/disable toggle and external install links.
 */
import { useState } from 'react';
import { ExternalLink, Loader2, Power, SlidersHorizontal } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  appsListAppsOptions,
  appsListAppsQueryKey,
  codexConfigReadConfigOptions,
  codexStatusGetStatusOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import { codexConfigUpdateConfig } from '@/generated/api/sdk.gen';
import type { AppInfoDto } from '@/generated/api/types.gen';
import { showSnackbar } from '@/stores/snackbar-store';
import { getApiErrorMessage } from '@/lib/api-error';
import { queryHasId } from '@/lib/query-invalidation';
import { AppDefaultsSheet } from './app-defaults-sheet';
import { AppDetailSheet } from './app-detail-sheet';

export function AppsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [selectedApp, setSelectedApp] = useState<AppInfoDto | null>(null);
  const [defaultsOpen, setDefaultsOpen] = useState(false);

  const { data, isLoading, isError, isFetching } = useQuery({
    ...appsListAppsOptions({
      query: { cursor: cursor ?? undefined },
    }),
    staleTime: 30_000,
  });

  const apps = data?.data ?? [];
  const nextCursor = data?.nextCursor ?? null;

  const invalidateAppsConfig = () => {
    void queryClient.invalidateQueries({ queryKey: appsListAppsQueryKey() });
    void queryClient.invalidateQueries({
      queryKey: codexConfigReadConfigOptions().queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: codexStatusGetStatusOptions().queryKey,
    });
    void queryClient.invalidateQueries({
      predicate: (query) => queryHasId(query, 'appsReadApps'),
    });
  };

  const goNext = () => {
    if (!nextCursor) return;
    setCursorStack((stack) => [...stack, cursor]);
    setCursor(nextCursor);
  };
  const goPrevious = () => {
    setCursorStack((stack) => {
      const next = stack.slice(0, -1);
      setCursor(stack.at(-1) ?? null);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        {t('Failed to load apps')}
      </div>
    );
  }

  // App defaults are configured independently of the list, so the entry point
  // and its sheet stay mounted even when no apps are available.
  const isEmpty = apps.length === 0 && cursorStack.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => setDefaultsOpen(true)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('Defaults')}
        </Button>
      </div>

      {isEmpty ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t('No apps available')}
        </p>
      ) : (
        <div className="space-y-2">
          {apps.map((app) => (
            <AppRow
              key={app.id}
              app={app}
              onToggled={invalidateAppsConfig}
              onOpenDetails={() => setSelectedApp(app)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {(cursorStack.length > 0 || nextCursor) && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={isFetching || cursorStack.length === 0} onClick={goPrevious}>
            {t('Previous')}
          </Button>
          <Button size="sm" variant="outline" disabled={isFetching || !nextCursor} onClick={goNext}>
            {t('Next')}
          </Button>
        </div>
      )}

      <AppDetailSheet
        app={selectedApp}
        onClose={() => setSelectedApp(null)}
      />
      <AppDefaultsSheet
        open={defaultsOpen}
        onClose={() => setDefaultsOpen(false)}
      />
    </div>
  );
}

/** Single app row with logo, toggle, and install link. */
function AppRow({
  app,
  onToggled,
  onOpenDetails,
}: {
  app: AppInfoDto;
  onToggled: () => void;
  onOpenDetails: () => void;
}) {
  const { t } = useTranslation();
  const [toggling, setToggling] = useState(false);

  const developer =
    app.branding?.developer ?? app.appMetadata?.developer ?? null;
  const category = app.branding?.category ?? null;

  const handleToggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await codexConfigUpdateConfig({
        body: {
          edits: [{ keyPath: `apps.${app.id}.enabled`, value: enabled }],
        },
        throwOnError: true,
      });
      showSnackbar(
        enabled ? t('App enabled') : t('App disabled'),
        'success',
      );
      onToggled();
    } catch (err) {
      showSnackbar(getApiErrorMessage(err), 'error');
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
      {/* Logo or placeholder */}
      {app.logoUrl ? (
        <img
          src={app.logoUrl}
          alt={app.name}
          className="h-10 w-10 shrink-0 rounded-lg object-contain"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Power className="h-5 w-5 text-muted-foreground" />
        </div>
      )}

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{app.name}</span>
          {!app.isAccessible && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {t('not available')}
            </Badge>
          )}
          {category && (
            <Badge variant="outline" className="text-[10px]">{category}</Badge>
          )}
        </div>
        {app.description && (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{app.description}</p>
        )}
        {developer && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">{developer}</p>
        )}
        {app.pluginDisplayNames.length > 0 && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {t('via')} {app.pluginDisplayNames.join(', ')}
          </p>
        )}
      </div>

      {/* Install link */}
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 text-xs"
        onClick={onOpenDetails}
      >
        <SlidersHorizontal className="h-3 w-3" />
        {t('Manage')}
      </Button>

      {app.installUrl && (
        <Button asChild size="sm" variant="ghost" className="h-7 gap-1 text-xs">
          <a href={app.installUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3 w-3" />
            {t('Install')}
          </a>
        </Button>
      )}

      {/* Enable/Disable toggle */}
      <div className="flex items-center gap-2">
        {toggling && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Switch
          checked={app.isEnabled}
          disabled={toggling || !app.isAccessible}
          onCheckedChange={handleToggle}
        />
      </div>
    </div>
  );
}
