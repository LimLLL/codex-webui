/** Helpers for app integration config controls. */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { OverrideSelectOption } from '@/components/codex-config/config-override-controls';
import {
  APP_TOOL_APPROVAL_MODE_VALUES,
  APPROVAL_REVIEWER_VALUES,
  type AppToolApprovalModeValue,
  type ApprovalReviewerValue,
  type ConfigRecord,
  isAppToolApprovalModeValue,
  isApprovalReviewerValue,
  isBooleanValue,
  resolveConfigValue,
} from '@/lib/codex-config';

/** Builds localized approval reviewer picker options. */
export function useReviewerOptions(): readonly OverrideSelectOption<ApprovalReviewerValue>[] {
  const { t } = useTranslation();
  return useMemo(
    () =>
      APPROVAL_REVIEWER_VALUES.map((value) => ({
        value,
        label:
          value === 'user'
            ? t('User')
            : value === 'auto_review'
              ? t('Automatic review')
              : t('Guardian subagent'),
      })),
    [t],
  );
}

/** Builds localized app tool approval-mode picker options. */
export function useApprovalModeOptions(): readonly OverrideSelectOption<AppToolApprovalModeValue>[] {
  const { t } = useTranslation();
  return useMemo(
    () =>
      APP_TOOL_APPROVAL_MODE_VALUES.map((value) => ({
        value,
        label:
          value === 'auto'
            ? t('Auto')
            : value === 'prompt'
              ? t('Prompt')
              : value === 'writes'
                ? t('Writes')
                : t('Approve'),
      })),
    [t],
  );
}

/** Resolves a boolean app config value through its inheritance chain. */
export function resolveBoolean(
  config: ConfigRecord | undefined,
  origins: ConfigRecord | undefined,
  keyPaths: readonly string[],
  fallback: boolean,
) {
  return resolveConfigValue(config, origins, keyPaths, fallback, isBooleanValue);
}

/** Resolves an app approval reviewer through app default and top-level config. */
export function resolveReviewer(
  config: ConfigRecord | undefined,
  origins: ConfigRecord | undefined,
  keyPaths: readonly string[],
) {
  return resolveConfigValue(
    config,
    origins,
    keyPaths,
    'user',
    isApprovalReviewerValue,
  );
}

/** Resolves an app tool approval mode through app and app-default config. */
export function resolveApprovalMode(
  config: ConfigRecord | undefined,
  origins: ConfigRecord | undefined,
  keyPaths: readonly string[],
) {
  return resolveConfigValue(
    config,
    origins,
    keyPaths,
    'auto',
    isAppToolApprovalModeValue,
  );
}

export { queryHasId } from '@/lib/query-invalidation';
