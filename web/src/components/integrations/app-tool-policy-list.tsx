/** Tool policy controls for one app detail sheet. */
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  ConfigBooleanOverrideControl,
  ConfigSelectOverrideControl,
  type OverrideSelectOption,
} from '@/components/codex-config/config-override-controls';
import type {
  AppToolSummaryDto,
  ConfigEditDto,
} from '@/generated/api/types.gen';
import type { AppToolApprovalModeValue, ConfigRecord } from '@/lib/codex-config';
import { isEditableConfigSegment, isUserConfigOrigin } from '@/lib/codex-config';
import { PolicySection, WarningBanner } from './app-detail-layout';
import { resolveApprovalMode, resolveBoolean } from './app-config-helpers';

type ConfigKeyPath = ConfigEditDto['keyPath'];
type ConfigValue = ConfigEditDto['value'];

interface ToolSummariesProps {
  /** App id used to build curated config paths. */
  appId: string;
  /** Display-only tool summaries returned by app/read. */
  tools: AppToolSummaryDto[] | null;
  /** Redacted config/read config object. */
  config: ConfigRecord | undefined;
  /** Redacted config/read origin metadata. */
  origins: ConfigRecord | undefined;
  /** Whether the app id itself is accepted by curated config paths. */
  idEditable: boolean;
  /** Disables controls while writes are pending. */
  saving: boolean;
  /** Tool approval-mode choices. */
  approvalModeOptions: readonly OverrideSelectOption<AppToolApprovalModeValue>[];
  /** Writes one curated leaf key. */
  onWrite: (keyPath: ConfigKeyPath, value: ConfigValue) => void;
}

/** Renders display-only tool metadata with editable per-tool override controls. */
export function ToolSummaries({
  appId,
  tools,
  config,
  origins,
  idEditable,
  saving,
  approvalModeOptions,
  onWrite,
}: ToolSummariesProps) {
  const { t } = useTranslation();

  if (tools === null) {
    return (
      <PolicySection title={t('Tools')}>
        <p className="text-sm text-muted-foreground">
          {t('Tool summaries are not available for this app.')}
        </p>
      </PolicySection>
    );
  }

  if (tools.length === 0) {
    return (
      <PolicySection title={t('Tools')}>
        <p className="text-sm text-muted-foreground">{t('No tools reported')}</p>
      </PolicySection>
    );
  }

  return (
    <PolicySection title={`${t('Tools')} (${tools.length})`}>
      <div className="space-y-3">
        {tools.map((tool) => (
          <ToolPolicyRow
            key={tool.name}
            appId={appId}
            tool={tool}
            config={config}
            origins={origins}
            editable={idEditable && isEditableConfigSegment(tool.name)}
            saving={saving}
            approvalModeOptions={approvalModeOptions}
            onWrite={onWrite}
          />
        ))}
      </div>
    </PolicySection>
  );
}

interface ToolPolicyRowProps {
  /** App id used to build curated config paths. */
  appId: string;
  /** Display-only tool summary returned by app/read. */
  tool: AppToolSummaryDto;
  /** Redacted config/read config object. */
  config: ConfigRecord | undefined;
  /** Redacted config/read origin metadata. */
  origins: ConfigRecord | undefined;
  /** Whether this app/tool id pair can be written through curated config. */
  editable: boolean;
  /** Disables controls while writes are pending. */
  saving: boolean;
  /** Tool approval-mode choices. */
  approvalModeOptions: readonly OverrideSelectOption<AppToolApprovalModeValue>[];
  /** Writes one curated leaf key. */
  onWrite: (keyPath: ConfigKeyPath, value: ConfigValue) => void;
}

function ToolPolicyRow({
  appId,
  tool,
  config,
  origins,
  editable,
  saving,
  approvalModeOptions,
  onWrite,
}: ToolPolicyRowProps) {
  const { t } = useTranslation();
  const toolBase = `apps.${appId}.tools.${tool.name}`;
  const enabled = resolveBoolean(config, origins, [
    `${toolBase}.enabled`,
    `apps.${appId}.default_tools_enabled`,
  ], true);
  const approvalMode = resolveApprovalMode(config, origins, [
    `${toolBase}.approval_mode`,
    `apps.${appId}.default_tools_approval_mode`,
    'apps._default.default_tools_approval_mode',
  ]);

  return (
    <div className="space-y-3 rounded-lg border border-border/50 px-3 py-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{tool.title ?? tool.name}</span>
          <code className="text-[11px] text-muted-foreground">{tool.name}</code>
          <Badge
            variant={tool.isEnabled ? 'secondary' : 'outline'}
            className="text-[10px]"
          >
            {tool.isEnabled ? t('runtime enabled') : t('runtime disabled')}
          </Badge>
          {tool.isReadOnly && (
            <Badge variant="outline" className="text-[10px]">
              {t('read-only')}
            </Badge>
          )}
        </div>
        {tool.description && (
          <p className="text-xs text-muted-foreground">{tool.description}</p>
        )}
        {tool.disabledReason && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {tool.disabledReason}
          </p>
        )}
      </div>

      {editable ? (
        <div className="space-y-2">
          <ConfigBooleanOverrideControl
            label={t('Tool enabled')}
            effectiveValue={enabled.value}
            source={enabled.source}
            overridden={isUserConfigOrigin(origins, `${toolBase}.enabled`)}
            saving={saving}
            onCommit={(value) => onWrite(`${toolBase}.enabled`, value)}
          />
          <ConfigSelectOverrideControl
            label={t('Tool approval')}
            effectiveValue={approvalMode.value}
            source={approvalMode.source}
            overridden={isUserConfigOrigin(origins, `${toolBase}.approval_mode`)}
            saving={saving}
            options={approvalModeOptions}
            onCommit={(value) => onWrite(`${toolBase}.approval_mode`, value)}
          />
        </div>
      ) : (
        <WarningBanner
          message={t(
            'This tool name cannot be edited through the curated config path.',
          )}
        />
      )}
    </div>
  );
}
