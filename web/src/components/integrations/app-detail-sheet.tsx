/** App detail drawer with per-app and per-tool approval configuration. */
import { ExternalLink, Power } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  appsListAppsQueryKey,
  appsReadAppsOptions,
  codexConfigReadConfigOptions,
  codexConfigUpdateConfigMutation,
  codexStatusGetStatusOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import type {
  AppInfoDto,
  ConfigEditDto,
  ConnectorMetadataDto,
} from '@/generated/api/types.gen';
import {
  ApprovalReviewerControl,
  ConfigBooleanOverrideControl,
  ConfigSelectOverrideControl,
  type OverrideSelectOption,
} from '@/components/codex-config/config-override-controls';
import {
  type AppToolApprovalModeValue,
  type ApprovalReviewerValue,
  type ConfigRecord,
  isEditableConfigSegment,
  isUserConfigOrigin,
} from '@/lib/codex-config';
import { getApiErrorMessage } from '@/lib/api-error';
import { showSnackbar } from '@/stores/snackbar-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { PolicySection, WarningBanner } from './app-detail-layout';
import { ToolSummaries } from './app-tool-policy-list';
import {
  queryHasId,
  resolveApprovalMode,
  resolveBoolean,
  resolveReviewer,
  useApprovalModeOptions,
  useReviewerOptions,
} from './app-config-helpers';

type ConfigKeyPath = ConfigEditDto['keyPath'];
type ConfigValue = ConfigEditDto['value'];

interface AppDetailSheetProps {
  /** App row selected from app/list, or null when the sheet is closed. */
  app: AppInfoDto | null;
  /** Closes the sheet. */
  onClose: () => void;
}

/** App detail surface for scoped app/tool config edits. */
export function AppDetailSheet({ app, onClose }: AppDetailSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const threadId = useTimelineStore((s) => s.threadId);
  const appId = app?.id ?? '__closed__';

  const detailQuery = useQuery({
    ...appsReadAppsOptions({
      query: {
        appIds: [appId],
        includeTools: true,
        threadId: threadId ?? undefined,
      },
    }),
    enabled: app !== null,
  });

  const configQuery = useQuery({
    ...codexConfigReadConfigOptions(),
    enabled: app !== null,
  });

  const updateMutation = useMutation({
    ...codexConfigUpdateConfigMutation(),
    onSuccess: (data) => {
      queryClient.setQueryData(codexConfigReadConfigOptions().queryKey, data);
      void queryClient.invalidateQueries({
        queryKey: codexConfigReadConfigOptions().queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: codexStatusGetStatusOptions().queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: appsListAppsQueryKey(),
      });
      void queryClient.invalidateQueries({
        predicate: (query) => queryHasId(query, 'appsReadApps'),
      });
      showSnackbar(t('Config saved'), 'success');
    },
    onError: (error) => showSnackbar(getApiErrorMessage(error), 'error'),
  });

  const metadata = detailQuery.data?.apps[0] ?? null;
  const missing = detailQuery.data?.missingAppIds.includes(appId) ?? false;
  const config = configQuery.data?.config as ConfigRecord | undefined;
  const origins = configQuery.data?.origins as ConfigRecord | undefined;
  const idEditable = app ? isEditableConfigSegment(app.id) : false;
  const configReady = !configQuery.isError && config !== undefined;

  const reviewerOptions = useReviewerOptions();
  const approvalModeOptions = useApprovalModeOptions();

  const writeConfig = (keyPath: ConfigKeyPath, value: ConfigValue) => {
    updateMutation.mutate({
      body: { edits: [{ keyPath, value }] },
    });
  };

  return (
    <Sheet open={app !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{metadata?.name ?? app?.name ?? t('App Detail')}</SheetTitle>
          <SheetDescription>
            {metadata?.description ?? app?.description ?? app?.id ?? ''}
          </SheetDescription>
        </SheetHeader>

        {!app ? null : detailQuery.isLoading || configQuery.isLoading ? (
          <div className="space-y-3 px-4 pt-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : (
          <ScrollArea className="h-[calc(100vh-8rem)] px-4 pr-2">
            <div className="space-y-5 pb-6 pt-2">
              <AppIdentity app={app} metadata={metadata} />

              {missing && (
                <WarningBanner
                  message={t('App metadata is unavailable for this account.')}
                />
              )}
              {detailQuery.isError && (
                <WarningBanner message={t('Failed to load app metadata.')} />
              )}
              {configQuery.isError && (
                <WarningBanner message={t('Failed to load Codex config.')} />
              )}
              {!idEditable && (
                <WarningBanner
                  message={t(
                    'This app id cannot be edited through the curated config path.',
                  )}
                />
              )}

              {idEditable && configReady && (
                <AppPolicyControls
                  app={app}
                  config={config}
                  origins={origins}
                  saving={updateMutation.isPending}
                  reviewerOptions={reviewerOptions}
                  approvalModeOptions={approvalModeOptions}
                  onWrite={writeConfig}
                />
              )}

              <Separator />

              <ToolSummaries
                appId={app.id}
                tools={metadata?.toolSummaries ?? null}
                config={config}
                origins={origins}
                idEditable={idEditable && configReady}
                saving={updateMutation.isPending}
                approvalModeOptions={approvalModeOptions}
                onWrite={writeConfig}
              />
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}

interface AppPolicyControlsProps {
  /** App row from app/list. */
  app: AppInfoDto;
  /** Redacted config/read config object. */
  config: ConfigRecord | undefined;
  /** Redacted config/read origin metadata. */
  origins: ConfigRecord | undefined;
  /** Disables controls while writes are pending. */
  saving: boolean;
  /** Reviewer select choices. */
  reviewerOptions: readonly OverrideSelectOption<ApprovalReviewerValue>[];
  /** Tool approval-mode choices. */
  approvalModeOptions: readonly OverrideSelectOption<AppToolApprovalModeValue>[];
  /** Writes one curated leaf key. */
  onWrite: (keyPath: ConfigKeyPath, value: ConfigValue) => void;
}

function AppPolicyControls({
  app,
  config,
  origins,
  saving,
  reviewerOptions,
  approvalModeOptions,
  onWrite,
}: AppPolicyControlsProps) {
  const { t } = useTranslation();
  const appBase = `apps.${app.id}`;
  const enabled = resolveBoolean(config, origins, [
    `${appBase}.enabled`,
    'apps._default.enabled',
  ], app.isEnabled);
  // Built-in defaults are `true` for both: the app-server fills them in that way
  // when `[apps._default]` omits them. Falling back to `false` would show these
  // tools as blocked while the server actually permits them.
  const destructive = resolveBoolean(config, origins, [
    `${appBase}.destructive_enabled`,
    'apps._default.destructive_enabled',
  ], true);
  const openWorld = resolveBoolean(config, origins, [
    `${appBase}.open_world_enabled`,
    'apps._default.open_world_enabled',
  ], true);
  const defaultToolsEnabled = resolveBoolean(config, origins, [
    `${appBase}.default_tools_enabled`,
  ], true);
  const defaultToolApproval = resolveApprovalMode(config, origins, [
    `${appBase}.default_tools_approval_mode`,
    'apps._default.default_tools_approval_mode',
  ]);
  const reviewer = resolveReviewer(config, origins, [
    `${appBase}.approvals_reviewer`,
    'apps._default.approvals_reviewer',
    'approvals_reviewer',
  ]);

  return (
    <PolicySection title={t('App Settings')}>
      <ConfigBooleanOverrideControl
        label={t('App enabled')}
        description={t('Controls whether this app is available to Codex.')}
        effectiveValue={enabled.value}
        source={enabled.source}
        overridden={isUserConfigOrigin(origins, `${appBase}.enabled`)}
        saving={saving}
        onCommit={(value) => onWrite(`${appBase}.enabled`, value)}
      />
      <ConfigBooleanOverrideControl
        label={t('Destructive tools')}
        description={t('Allows app tools that can make destructive changes.')}
        effectiveValue={destructive.value}
        source={destructive.source}
        overridden={isUserConfigOrigin(origins, `${appBase}.destructive_enabled`)}
        saving={saving}
        onCommit={(value) => onWrite(`${appBase}.destructive_enabled`, value)}
      />
      <ConfigBooleanOverrideControl
        label={t('Open-world tools')}
        description={t('Allows app tools that can act outside bounded data.')}
        effectiveValue={openWorld.value}
        source={openWorld.source}
        overridden={isUserConfigOrigin(origins, `${appBase}.open_world_enabled`)}
        saving={saving}
        onCommit={(value) => onWrite(`${appBase}.open_world_enabled`, value)}
      />
      <ConfigBooleanOverrideControl
        label={t('Default tool enablement')}
        description={t('Default enablement for tools without a tool override.')}
        effectiveValue={defaultToolsEnabled.value}
        source={defaultToolsEnabled.source}
        overridden={isUserConfigOrigin(origins, `${appBase}.default_tools_enabled`)}
        saving={saving}
        onCommit={(value) => onWrite(`${appBase}.default_tools_enabled`, value)}
      />
      <ConfigSelectOverrideControl
        label={t('Default tool approval')}
        description={t('Approval mode for tools without a tool override.')}
        effectiveValue={defaultToolApproval.value}
        source={defaultToolApproval.source}
        overridden={isUserConfigOrigin(origins, `${appBase}.default_tools_approval_mode`)}
        saving={saving}
        options={approvalModeOptions}
        onCommit={(value) =>
          onWrite(`${appBase}.default_tools_approval_mode`, value)
        }
      />
      <ApprovalReviewerControl
        label={t('App approval reviewer')}
        description={t('Reviewer used for this app after inheritance is applied.')}
        effectiveValue={reviewer.value}
        source={reviewer.source}
        overridden={isUserConfigOrigin(origins, `${appBase}.approvals_reviewer`)}
        saving={saving}
        options={reviewerOptions}
        onCommit={(value) => onWrite(`${appBase}.approvals_reviewer`, value)}
      />
    </PolicySection>
  );
}

function AppIdentity({
  app,
  metadata,
}: {
  app: AppInfoDto;
  metadata: ConnectorMetadataDto | null;
}) {
  const { t } = useTranslation();
  const logoUrl = metadata?.iconUrl ?? app.logoUrl;
  const installUrl = metadata?.installUrl ?? app.installUrl;
  const plugins = metadata?.pluginDisplayNames ?? app.pluginDisplayNames;

  return (
    <div className="flex items-start gap-3">
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={metadata?.name ?? app.name}
          className="h-12 w-12 shrink-0 rounded-lg object-contain"
        />
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Power className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-xs text-muted-foreground">{app.id}</code>
          {!app.isAccessible && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {t('not available')}
            </Badge>
          )}
        </div>
        {plugins.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('via')} {plugins.join(', ')}
          </p>
        )}
        {installUrl && (
          <Button asChild size="sm" variant="outline" className="mt-1 h-7 gap-1 text-xs">
            <a href={installUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" />
              {t('Install')}
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
