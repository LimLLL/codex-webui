/**
 * Plugin detail drawer showing description, metadata, linked skills/apps/MCPs,
 * and install/uninstall actions.
 */
import { Download, Trash2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { pluginsReadPluginOptions } from '@/generated/api/@tanstack/react-query.gen';

export interface PluginKey {
  marketplacePath: string;
  pluginName: string;
}

interface Props {
  pluginKey: PluginKey | null;
  onClose: () => void;
  onInstall: (marketplacePath: string, pluginName: string) => void;
  onUninstall: (pluginId: string) => void;
  mutating: boolean;
}

export function PluginDetailSheet({
  pluginKey,
  onClose,
  onInstall,
  onUninstall,
  mutating,
}: Props) {
  const { t } = useTranslation();

  const { data, isLoading } = useQuery({
    ...pluginsReadPluginOptions({
      query: {
        marketplacePath: pluginKey?.marketplacePath ?? '',
        pluginName: pluginKey?.pluginName ?? '',
      },
    }),
    enabled: pluginKey !== null,
  });

  const detail = data?.plugin ?? null;

  return (
    <Sheet open={pluginKey !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>
            {detail?.summary.interface?.displayName ?? detail?.summary.name ?? t('Plugin Detail')}
          </SheetTitle>
        </SheetHeader>

        {isLoading ? (
          <div className="space-y-3 pt-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : detail ? (
          <ScrollArea className="h-[calc(100vh-8rem)] pr-2">
            <div className="space-y-4 pb-6 pt-2">
              {/* Description */}
              {detail.description && (
                <p className="text-sm text-muted-foreground">{detail.description}</p>
              )}
              {detail.summary.interface?.longDescription && (
                <p className="text-sm text-muted-foreground">
                  {detail.summary.interface.longDescription}
                </p>
              )}

              {/* Metadata badges */}
              <div className="flex flex-wrap gap-2 text-xs">
                {detail.summary.interface?.developerName && (
                  <Badge variant="outline">{detail.summary.interface.developerName}</Badge>
                )}
                {detail.summary.interface?.category && (
                  <Badge variant="outline">{detail.summary.interface.category}</Badge>
                )}
                <Badge variant="secondary">{detail.marketplaceName}</Badge>
              </div>

              {/* Capabilities */}
              {detail.summary.interface?.capabilities &&
                detail.summary.interface.capabilities.length > 0 && (
                  <DetailSection title={t('Capabilities')}>
                    <div className="flex flex-wrap gap-1">
                      {detail.summary.interface.capabilities.map((cap) => (
                        <Badge key={cap} variant="outline" className="text-[10px]">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                  </DetailSection>
                )}

              {/* Linked skills */}
              {detail.skills.length > 0 && (
                <DetailSection title={`${t('Skills')} (${detail.skills.length})`}>
                  <div className="space-y-1">
                    {detail.skills.map((skill) => (
                      <div key={skill.path} className="rounded-md border border-border/50 px-2.5 py-1.5">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium">{skill.name}</span>
                          <Badge variant={skill.enabled ? 'secondary' : 'outline'} className="text-[10px]">
                            {skill.enabled ? t('Enabled') : t('Disabled')}
                          </Badge>
                        </div>
                        {skill.description && (
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{skill.description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </DetailSection>
              )}

              {/* Linked apps */}
              {detail.apps.length > 0 && (
                <DetailSection title={`${t('Apps')} (${detail.apps.length})`}>
                  <div className="space-y-1">
                    {detail.apps.map((app) => (
                      <div key={app.id} className="rounded-md border border-border/50 px-2.5 py-1.5 text-xs">
                        <span className="font-medium">{app.name}</span>
                        {app.description && (
                          <span className="ml-1 text-muted-foreground">— {app.description}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </DetailSection>
              )}

              {/* Linked MCP servers */}
              {detail.mcpServers.length > 0 && (
                <DetailSection title={`${t('MCP Servers')} (${detail.mcpServers.length})`}>
                  <div className="flex flex-wrap gap-1">
                    {detail.mcpServers.map((name) => (
                      <Badge key={name} variant="outline" className="text-[10px]">
                        {name}
                      </Badge>
                    ))}
                  </div>
                </DetailSection>
              )}

              {/* External links */}
              <DetailLinks iface={detail.summary.interface} />

              <Separator />

              {/* Install/Uninstall action */}
              <div className="flex justify-end">
                {detail.summary.installPolicy === 'INSTALLED_BY_DEFAULT' ? (
                  <Badge variant="secondary">{t('Built-in')}</Badge>
                ) : detail.summary.installed ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="gap-1.5"
                    disabled={mutating}
                    onClick={() => onUninstall(detail.summary.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('Uninstall')}
                  </Button>
                ) : detail.summary.installPolicy !== 'NOT_AVAILABLE' ? (
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={mutating}
                    onClick={() => onInstall(detail.marketplacePath, detail.summary.name)}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t('Install')}
                  </Button>
                ) : null}
              </div>
            </div>
          </ScrollArea>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('Plugin not found')}
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function DetailLinks({ iface }: { iface: { websiteUrl?: string | null; privacyPolicyUrl?: string | null; termsOfServiceUrl?: string | null } | null }) {
  const { t } = useTranslation();
  if (!iface?.websiteUrl && !iface?.privacyPolicyUrl && !iface?.termsOfServiceUrl) return null;

  const links = [
    { url: iface.websiteUrl, label: t('Website') },
    { url: iface.privacyPolicyUrl, label: t('Privacy Policy') },
    { url: iface.termsOfServiceUrl, label: t('Terms of Service') },
  ].filter((l) => l.url);

  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url!}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          {link.label}
        </a>
      ))}
    </div>
  );
}
