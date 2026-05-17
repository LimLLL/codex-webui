/**
 * Apps tab: paginated list with enable/disable toggle and external install links.
 */
import { useState } from 'react';
import { ExternalLink, Loader2, Power } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  appsListAppsOptions,
  appsListAppsQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { codexConfigUpdateConfig } from '@/generated/api/sdk.gen';
import type { AppInfoDto } from '@/generated/api/types.gen';
import { showSnackbar } from '@/stores/snackbar-store';

export function AppsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);

  const { data, isLoading, isError, isFetching } = useQuery({
    ...appsListAppsOptions({
      query: { cursor: cursor ?? undefined },
    }),
    staleTime: 30_000,
  });

  const apps = data?.data ?? [];
  const nextCursor = data?.nextCursor ?? null;

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

  if (apps.length === 0 && cursorStack.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t('No apps available')}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {apps.map((app) => (
          <AppRow
            key={app.id}
            app={app}
            onToggled={() => void queryClient.invalidateQueries({ queryKey: appsListAppsQueryKey() })}
          />
        ))}
      </div>

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
    </div>
  );
}

/** Single app row with logo, toggle, and install link. */
function AppRow({ app, onToggled }: { app: AppInfoDto; onToggled: () => void }) {
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
      showSnackbar(String((err as Error).message), 'error');
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
