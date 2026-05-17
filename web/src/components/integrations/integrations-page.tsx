/**
 * Integrations page shell with tab routing: Plugins / Apps / MCPs.
 * Accessible from sidebar nav; tab state stored in URL search param.
 */
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useTimelineStore } from '@/stores/timeline-store';
import { PluginsTab } from './plugins-tab';
import { AppsTab } from './apps-tab';
import { McpsTab } from './mcps-tab';

const TABS = ['plugins', 'apps', 'mcps'] as const;
type IntegrationTab = (typeof TABS)[number];

function tabLabel(tab: IntegrationTab): string {
  const labels: Record<IntegrationTab, string> = {
    plugins: 'Plugins',
    apps: 'Apps',
    mcps: 'MCP Servers',
  };
  return labels[tab];
}

export function IntegrationsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const threadId = useTimelineStore((s) => s.threadId);
  const tab = useRouterState({
    select: (state) =>
      ((state.location.search as { tab?: IntegrationTab }).tab ?? 'plugins'),
  });

  const navigateBack = () => {
    if (threadId) {
      void navigate({ to: '/t/$threadId', params: { threadId } });
    } else {
      void navigate({ to: '/' });
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={navigateBack}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-semibold">{t('Integrations')}</h1>
        </div>

        <div className="flex flex-wrap gap-2">
          {TABS.map((s) => (
            <Button
              key={s}
              variant={tab === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => void navigate({ to: '/integrations', search: { tab: s } })}
            >
              {t(tabLabel(s))}
            </Button>
          ))}
        </div>

        <Separator />

        {tab === 'plugins' && <PluginsTab />}
        {tab === 'apps' && <AppsTab />}
        {tab === 'mcps' && <McpsTab />}
      </div>
    </div>
  );
}
