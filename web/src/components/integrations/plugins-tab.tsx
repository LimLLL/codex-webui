/**
 * Plugins tab: marketplace browser with search, featured strip, install/uninstall.
 */
import { useMemo, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw, Search, Star, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  pluginsListPluginsOptions,
  pluginsListPluginsQueryKey,
  pluginsInstallPluginMutation,
  pluginsUninstallPluginMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { appsListAppsQueryKey, mcpServersListServersQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import type { PluginSummaryDto, PluginMarketplaceEntryDto } from '@/generated/api/types.gen';
import { showSnackbar } from '@/stores/snackbar-store';
import { PluginCard } from './plugin-card';
import { PluginDetailSheet, type PluginKey } from './plugin-detail-sheet';

export function PluginsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedPlugin, setSelectedPlugin] = useState<PluginKey | null>(null);

  // --- Data ---
  const { data, isLoading, isError } = useQuery({
    ...pluginsListPluginsOptions(),
    staleTime: 60_000,
  });

  const marketplaces = useMemo(() => data?.marketplaces ?? [], [data]);
  const loadErrors = data?.marketplaceLoadErrors ?? [];
  const remoteSyncError = data?.remoteSyncError ?? null;
  const featuredIds = useMemo(() => new Set(data?.featuredPluginIds ?? []), [data]);

  // Flatten all plugins for search/featured
  const allPlugins = useMemo(() => {
    const result: Array<{ plugin: PluginSummaryDto; marketplace: PluginMarketplaceEntryDto }> = [];
    for (const mp of marketplaces) {
      for (const p of mp.plugins) result.push({ plugin: p, marketplace: mp });
    }
    return result;
  }, [marketplaces]);

  const filtered = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    return allPlugins.filter(
      ({ plugin }) =>
        plugin.name.toLowerCase().includes(q) ||
        plugin.interface?.displayName?.toLowerCase().includes(q) ||
        plugin.interface?.shortDescription?.toLowerCase().includes(q),
    );
  }, [search, allPlugins]);

  const featured = useMemo(
    () => allPlugins.filter(({ plugin }) => featuredIds.has(plugin.id)),
    [allPlugins, featuredIds],
  );
  const installed = useMemo(
    () => allPlugins.filter(({ plugin }) => plugin.installed),
    [allPlugins],
  );

  // --- Mutations ---
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: pluginsListPluginsQueryKey() });
    void queryClient.invalidateQueries({ predicate: (q) => queryHasId(q, 'pluginsReadPlugin') });
    void queryClient.invalidateQueries({ queryKey: appsListAppsQueryKey() });
    void queryClient.invalidateQueries({ predicate: (q) => queryHasId(q, 'skillsListSkills') });
    void queryClient.invalidateQueries({ queryKey: mcpServersListServersQueryKey() });
  };

  const installMutation = useMutation({
    ...pluginsInstallPluginMutation(),
    onSuccess: (res) => {
      invalidateAll();
      const needsAuth = res.appsNeedingAuth?.length ?? 0;
      showSnackbar(
        needsAuth > 0
          ? t('Plugin installed. {{count}} app(s) need authentication.', { count: needsAuth })
          : t('Plugin installed'),
        'success',
      );
    },
    onError: (err) => showSnackbar(String(err.message), 'error'),
  });

  const uninstallMutation = useMutation({
    ...pluginsUninstallPluginMutation(),
    onSuccess: () => {
      invalidateAll();
      showSnackbar(t('Plugin uninstalled'), 'success');
    },
    onError: (err) => showSnackbar(String(err.message), 'error'),
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const { pluginsListPlugins } = await import('@/generated/api/sdk.gen');
      const { data } = await pluginsListPlugins({
        query: { forceRemoteSync: true },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pluginsListPluginsQueryKey() });
      showSnackbar(t('Marketplace refreshed'), 'success');
    },
    onError: (err) => showSnackbar(String(err.message), 'error'),
  });

  const mutating = installMutation.isPending || uninstallMutation.isPending;

  const makeCardProps = (plugin: PluginSummaryDto, mp: PluginMarketplaceEntryDto) => ({
    plugin,
    marketplacePath: mp.path,
    featured: featuredIds.has(plugin.id),
    disabled: mutating,
    onSelect: setSelectedPlugin,
    onInstall: () =>
      installMutation.mutate({ body: { marketplacePath: mp.path, pluginName: plugin.name } }),
    onUninstall: () => uninstallMutation.mutate({ body: { pluginId: plugin.id } }),
  });

  // --- Loading / Error ---
  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (isError) {
    return <ErrorBanner message={t('Failed to load plugins')} />;
  }

  return (
    <div className="space-y-6">
      {/* Search + Refresh */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('Search plugins...')}
            className="pl-9"
          />
          {search && (
            <Button variant="ghost" size="icon" className="absolute right-1 top-1 h-7 w-7" onClick={() => setSearch('')}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={refreshMutation.isPending} onClick={() => refreshMutation.mutate()}>
          {refreshMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t('Refresh')}
        </Button>
      </div>

      {/* Error banners */}
      {remoteSyncError && <ErrorBanner message={t('Remote sync failed: {{msg}}', { msg: remoteSyncError })} />}
      {loadErrors.map((err) => (
        <ErrorBanner key={err.marketplacePath} message={`${err.marketplacePath}: ${err.message}`} />
      ))}

      {/* Search results */}
      {filtered !== null ? (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('{{count}} result(s)', { count: filtered.length })}
          </h3>
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('No matching plugins')}</p>
          ) : (
            filtered.map(({ plugin, marketplace }) => (
              <PluginCard key={`${marketplace.path}::${plugin.name}`} {...makeCardProps(plugin, marketplace)} />
            ))
          )}
        </div>
      ) : (
        <>
          {/* Featured */}
          {featured.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Star className="h-3 w-3" /> {t('Featured')}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {featured.map(({ plugin, marketplace }) => (
                  <PluginCard key={`${marketplace.path}::${plugin.name}`} {...makeCardProps(plugin, marketplace)} />
                ))}
              </div>
            </section>
          )}

          {/* Installed */}
          {installed.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                {t('Installed')} ({installed.length})
              </h3>
              <div className="space-y-2">
                {installed.map(({ plugin, marketplace }) => (
                  <PluginCard key={`${marketplace.path}::${plugin.name}`} {...makeCardProps(plugin, marketplace)} />
                ))}
              </div>
            </section>
          )}

          {/* Marketplace groups (uninstalled only) */}
          {marketplaces.map((mp) => {
            const uninstalled = mp.plugins.filter((p) => !p.installed);
            if (uninstalled.length === 0) return null;
            return (
              <section key={mp.path}>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                  {mp.interface?.displayName ?? mp.name}
                </h3>
                <div className="space-y-2">
                  {uninstalled.map((plugin) => (
                    <PluginCard key={`${mp.path}::${plugin.name}`} {...makeCardProps(plugin, mp)} />
                  ))}
                </div>
              </section>
            );
          })}

          {allPlugins.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('No plugins available')}</p>
          )}
        </>
      )}

      <PluginDetailSheet
        pluginKey={selectedPlugin}
        onClose={() => setSelectedPlugin(null)}
        onInstall={(mp, name) => installMutation.mutate({ body: { marketplacePath: mp, pluginName: name } })}
        onUninstall={(id) => uninstallMutation.mutate({ body: { pluginId: id } })}
        mutating={mutating}
      />
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/** Matches generated TanStack Query keys whose first element has `{ _id: id }`. */
function queryHasId(query: { queryKey: readonly unknown[] }, id: string): boolean {
  const first = query.queryKey[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    '_id' in first &&
    (first as { _id?: unknown })._id === id
  );
}
