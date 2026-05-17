/** Single plugin card with status badge and install/uninstall action. */
import { Download, Package, Star, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { PluginSummaryDto } from '@/generated/api/types.gen';
import { cn } from '@/lib/utils';
import type { PluginKey } from './plugin-detail-sheet';

interface Props {
  plugin: PluginSummaryDto;
  marketplacePath: string;
  featured?: boolean;
  disabled?: boolean;
  onSelect: (key: PluginKey) => void;
  onInstall: () => void;
  onUninstall: () => void;
}

export function PluginCard({
  plugin,
  marketplacePath,
  featured,
  disabled,
  onSelect,
  onInstall,
  onUninstall,
}: Props) {
  const { t } = useTranslation();
  const displayName = plugin.interface?.displayName ?? plugin.name;
  const desc = plugin.interface?.shortDescription ?? null;

  return (
    <div
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border border-border/50 p-3 transition-colors hover:bg-accent/30',
      )}
      onClick={() => onSelect({ marketplacePath, pluginName: plugin.name })}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ')
          onSelect({ marketplacePath, pluginName: plugin.name });
      }}
    >
      {/* Icon placeholder */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Package className="h-5 w-5 text-muted-foreground" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{displayName}</span>
          {featured && <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />}
          {plugin.installed && (
            <Badge variant="secondary" className="text-[10px]">
              {plugin.installPolicy === 'INSTALLED_BY_DEFAULT' ? t('Built-in') : t('Installed')}
            </Badge>
          )}
        </div>
        {desc && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{desc}</p>}
        {plugin.interface?.developerName && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {plugin.interface.developerName}
          </p>
        )}
      </div>

      {/* Action button */}
      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
        <PluginAction
          plugin={plugin}
          disabled={!!disabled}
          onInstall={onInstall}
          onUninstall={onUninstall}
        />
      </div>
    </div>
  );
}

/** Install / Uninstall / Built-in / Unavailable button. */
function PluginAction({
  plugin,
  disabled,
  onInstall,
  onUninstall,
}: {
  plugin: PluginSummaryDto;
  disabled: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const { t } = useTranslation();

  if (plugin.installPolicy === 'NOT_AVAILABLE') {
    return (
      <Button size="sm" variant="ghost" disabled className="h-7 text-xs">
        {t('Unavailable')}
      </Button>
    );
  }
  if (plugin.installPolicy === 'INSTALLED_BY_DEFAULT') {
    return <Badge variant="outline" className="text-[10px]">{t('Built-in')}</Badge>;
  }
  if (plugin.installed) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
        disabled={disabled}
        onClick={onUninstall}
      >
        <Trash2 className="h-3 w-3" />
        {t('Uninstall')}
      </Button>
    );
  }
  return (
    <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={disabled} onClick={onInstall}>
      <Download className="h-3 w-3" />
      {t('Install')}
    </Button>
  );
}
