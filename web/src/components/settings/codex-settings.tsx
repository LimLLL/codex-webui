/**
 * Codex app-server config management tab.
 *
 * Two modes:
 * 1. Structured editor — curated fields with per-field controls
 * 2. Raw editor — Monaco-based config.toml editing for power users
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ApprovalReviewerControl,
  ConfigSelectOverrideControl,
  ConfigSourceBadge,
  type OverrideSelectOption,
} from '@/components/codex-config/config-override-controls';
import { RawConfigEditor } from './raw-config-editor';
import {
  catalogStateQueryKey,
  codexConfigReadConfigOptions,
  codexConfigUpdateConfigMutation,
  codexStatusGetStatusOptions,
  modelsListModelsOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import type {
  CatalogWarningDto,
  ConfigEditDto,
} from '@/generated/api/types.gen';
import { showSnackbar } from '@/stores/snackbar-store';
import {
  APPROVAL_REVIEWER_VALUES,
  type ApprovalReviewerValue,
  type ConfigRecord,
  configValueToString,
  formatConfigValue,
  isApprovalReviewerValue,
  isUserConfigOrigin,
  originLabel,
  resolveConfigValue,
} from '@/lib/codex-config';
import { ConfigFieldEditor } from './codex-settings-fields';
import {
  FIELD_DEFS,
  type FieldDef,
  GROUP_ORDER,
  stringToConfigValue,
} from './codex-settings-defs';

// ---------------------------------------------------------------------------
// Security read-only fields
// ---------------------------------------------------------------------------

const SECURITY_READONLY_KEYS = ['sandbox_workspace_write'] as const;

const SECURITY_FIELD_LABELS: Record<
  (typeof SECURITY_READONLY_KEYS)[number],
  string
> = {
  sandbox_workspace_write: 'Sandbox Workspace Write',
};

/**
 * Global defaults for conversations started from now on.
 *
 * These are editable here and nowhere else. The chat badge changes ONE
 * conversation, which is a different thing — writing the global keys was
 * measured not to reach a thread that is already loaded. Both controls existing
 * is the point; for a while the badge pointed here for the default while this
 * page pointed back at the badge, leaving no way to change it outside the raw
 * TOML editor.
 *
 * The approval list is exactly the pinned config schema's: `untrusted` was
 * retired from it and makes the app-server refuse to start, `on-failure` no
 * longer exists, and the granular object form has no place in a two-choice
 * picker. Offering a value the server rejects would break every future
 * conversation from a settings page.
 */
const APPROVAL_POLICY_VALUES = ['on-request', 'never'] as const;
type ApprovalPolicyValue = (typeof APPROVAL_POLICY_VALUES)[number];
const isApprovalPolicyValue = (value: unknown): value is ApprovalPolicyValue =>
  typeof value === 'string' && (APPROVAL_POLICY_VALUES as readonly string[]).includes(value);

const SANDBOX_MODE_VALUES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
type SandboxModeValue = (typeof SANDBOX_MODE_VALUES)[number];
const isSandboxModeValue = (value: unknown): value is SandboxModeValue =>
  typeof value === 'string' && (SANDBOX_MODE_VALUES as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CodexSettings() {
  const { t, i18n } = useTranslation();
  const isNonEnglish = !i18n.language.startsWith('en');
  const queryClient = useQueryClient();

  // ---- Queries ----
  const configQuery = useQuery(codexConfigReadConfigOptions());

  const config = configQuery.data?.config as ConfigRecord | undefined;
  const origins = configQuery.data?.origins as ConfigRecord | undefined;

  // ---- Drafts: same pattern as useCategorySettings ----
  // draftOverrides stores user edits; base values come from config via useMemo.
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>(
    {},
  );

  const baseDrafts = useMemo(() => {
    if (!config) return {};
    const base: Record<string, string> = {};
    for (const def of FIELD_DEFS) {
      base[def.key] = configValueToString(config[def.key]);
    }
    return base;
  }, [config]);

  const drafts = useMemo(
    () => ({ ...baseDrafts, ...draftOverrides }),
    [baseDrafts, draftOverrides],
  );

  const dirtyKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, value] of Object.entries(draftOverrides)) {
      if (value !== baseDrafts[key]) keys.add(key);
    }
    return keys;
  }, [draftOverrides, baseDrafts]);

  const handleDraftChange = useCallback((key: string, value: string) => {
    setDraftOverrides((prev) => ({ ...prev, [key]: value }));
  }, []);

  // ---- Mutations ----
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: codexConfigReadConfigOptions().queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: codexStatusGetStatusOptions().queryKey,
    });
    // A raw edit can move model_catalog_json, so the catalog panel's notion of
    // configured vs running is stale the moment config.toml is written.
    void queryClient.invalidateQueries({ queryKey: catalogStateQueryKey() });
  }, [queryClient]);

  const [saveWarnings, setSaveWarnings] = useState<CatalogWarningDto[]>([]);

  const updateMutation = useMutation({
    ...codexConfigUpdateConfigMutation(),
    onSuccess: (data, variables) => {
      // Optimistically update the query cache with the returned config
      queryClient.setQueryData(codexConfigReadConfigOptions().queryKey, data);
      // Held separately from the query: warnings are produced by the write, and
      // the invalidation below refetches a read that does not carry them. This
      // is where "the configured model is not in the catalog" surfaces at all.
      setSaveWarnings(data.warnings ?? []);
      invalidate();
      showSnackbar(t('Config saved'), 'success');
      // Only clear drafts for saved keys, preserve other pending edits
      const savedKeys = new Set(variables.body.edits.map((e) => e.keyPath));
      setDraftOverrides((prev) => {
        const next = { ...prev };
        for (const key of savedKeys) delete next[key];
        return next;
      });
    },
    onError: (err) => {
      showSnackbar(
        t('Failed to save config: {{msg}}', { msg: String(err) }),
        'error',
      );
    },
  });

  const handleSaveField = useCallback(
    (key: ConfigEditDto['keyPath']) => {
      const raw = drafts[key] ?? '';
      const result = stringToConfigValue(key, raw);
      if ('error' in result) {
        showSnackbar(t(result.error), 'error');
        return;
      }
      updateMutation.mutate({
        body: { edits: [{ keyPath: key, value: result.value }] },
      });
    },
    [drafts, t, updateMutation],
  );

  const handleClearField = useCallback(
    (key: ConfigEditDto['keyPath']) => {
      updateMutation.mutate({
        body: { edits: [{ keyPath: key, value: null }] },
      });
    },
    [updateMutation],
  );

  // ---- Profile options (dynamic from config.profiles) ----
  const profileOptions = useMemo(() => {
    const activeProfile = configValueToString(config?.profile);
    const profiles = config?.profiles;
    const options: string[] = [];
    if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
      options.push(...Object.keys(profiles));
    }
    // Ensure the current active profile appears even if not in profiles map
    if (activeProfile && !options.includes(activeProfile)) {
      options.push(activeProfile);
    }
    return options;
  }, [config]);

  // ---- Service tier options (dynamic from the model catalog) ----
  // Tier ids are advertised per model and opaque to the app-server, so this
  // cannot be a static list. It previously hardcoded `fast` / `flex`, which the
  // real catalog does not use — the gpt-5.6 family returns `priority` and
  // `ultrafast` — so the control could only ever write invalid values. The
  // config key is global, hence the union across models rather than one model's
  // set. Any tier already written to config is kept so an existing value is
  // never silently dropped from the list.
  const { data: modelsData } = useQuery({
    ...modelsListModelsOptions(),
    staleTime: 60_000,
  });
  const serviceTierOptions = useMemo(() => {
    const options: string[] = [];
    for (const model of modelsData?.data ?? []) {
      for (const tier of model.serviceTiers) {
        if (!options.includes(tier.id)) options.push(tier.id);
      }
    }
    const current = configValueToString(config?.['service_tier']);
    if (current && !options.includes(current)) options.push(current);
    return options;
  }, [modelsData, config]);

  const reviewerOptions = useMemo<
    readonly OverrideSelectOption<ApprovalReviewerValue>[]
  >(
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

  const topLevelReviewer = useMemo(
    () =>
      resolveConfigValue(
        config,
        origins,
        ['approvals_reviewer'],
        'user',
        isApprovalReviewerValue,
      ),
    [config, origins],
  );

  // Read from the same curated config the rest of this page uses, so the
  // control shows what the server actually resolved rather than what this tab
  // last wrote.
  const globalApprovalPolicy = useMemo(
    () =>
      resolveConfigValue(
        config,
        origins,
        ['approval_policy'],
        'on-request' as ApprovalPolicyValue,
        isApprovalPolicyValue,
      ),
    [config, origins],
  );

  const globalSandboxMode = useMemo(
    () =>
      resolveConfigValue(
        config,
        origins,
        ['sandbox_mode'],
        'read-only' as SandboxModeValue,
        isSandboxModeValue,
      ),
    [config, origins],
  );

  // ---- Group fields ----
  const groupedFields = useMemo(() => {
    const map = new Map<string, FieldDef[]>();
    for (const group of GROUP_ORDER) {
      map.set(group, []);
    }
    for (const def of FIELD_DEFS) {
      const list = map.get(def.group) ?? [];
      list.push(def);
      map.set(def.group, list);
    }
    return map;
  }, []);

  // The structured editor is what withdraws on a failed or pending read; the raw
  // editor keeps ONE position in the tree across every state. Returning early
  // per state would remount it, and a remount discards the unsaved TOML the user
  // came here to write — which is most likely exactly when the read is failing.
  const unavailable = configQuery.isLoading ? (
    <div className="rounded-lg border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
      {t('Loading...')}
    </div>
  ) : (
    <div className="rounded-lg border border-destructive/30 bg-card/50 px-4 py-3 text-sm text-destructive">
      {t('Failed to load Codex config')}
    </div>
  );

  return (
    <section className="space-y-6">
      {!config || configQuery.isError || configQuery.isLoading ? (
        unavailable
      ) : (
        <>
          <div className="space-y-1">
            <h2 className="text-sm font-medium text-muted-foreground">
              {t('Codex Configuration')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t(
                'Manage Codex app-server settings. Changes are saved to user config.toml and hot-reloaded.',
              )}
            </p>
          </div>

          {saveWarnings.length > 0 && (
            <ul className="space-y-1 text-xs text-amber-500">
              {saveWarnings.map((warning, index) => (
                <li key={index}>
                  {warning.model ? `${warning.model}: ` : ''}
                  {warning.message}
                </li>
              ))}
            </ul>
          )}

          {/* Structured field groups */}
          {GROUP_ORDER.map((group) => {
            const fields = groupedFields.get(group);
            if (!fields?.length) return null;
            // Hide Profile group when no profiles are defined
            if (group === 'Profile' && profileOptions.length === 0) return null;
            return (
              <div key={group} className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">
                  {t(group)}
                </h3>
                {fields.map((def) => (
                  <ConfigFieldEditor
                    key={def.key}
                    def={def}
                    draft={drafts[def.key] ?? ''}
                    dirty={dirtyKeys.has(def.key)}
                    origin={originLabel(origins, def.key)}
                    overridden={isUserConfigOrigin(origins, def.key)}
                    saving={updateMutation.isPending}
                    profileOptions={
                      def.key === 'profile' ? profileOptions : undefined
                    }
                    serviceTierOptions={
                      def.key === 'service_tier'
                        ? serviceTierOptions
                        : undefined
                    }
                    onDraftChange={handleDraftChange}
                    onSave={handleSaveField}
                    onClear={handleClearField}
                  />
                ))}
              </div>
            );
          })}

          {/* Security read-only */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              {t('Security')}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                'Defaults for new conversations. Changing them does not affect a conversation already open — use its security badge for that.',
              )}
            </p>
            <ConfigSelectOverrideControl
              label={t('Approval Policy')}
              description={t('When Codex asks before running a command.')}
              effectiveValue={globalApprovalPolicy.value}
              source={globalApprovalPolicy.source}
              overridden={isUserConfigOrigin(origins, 'approval_policy')}
              saving={updateMutation.isPending}
              options={APPROVAL_POLICY_VALUES.map((value) => ({
                value,
                label: t(value),
              }))}
              onCommit={(value) =>
                updateMutation.mutate({
                  body: { edits: [{ keyPath: 'approval_policy', value }] },
                })
              }
            />
            <ConfigSelectOverrideControl
              label={t('Sandbox Mode')}
              description={t('What a command may reach by default.')}
              effectiveValue={globalSandboxMode.value}
              source={globalSandboxMode.source}
              overridden={isUserConfigOrigin(origins, 'sandbox_mode')}
              saving={updateMutation.isPending}
              options={SANDBOX_MODE_VALUES.map((value) => ({
                value,
                label: t(value),
              }))}
              onCommit={(value) =>
                updateMutation.mutate({
                  body: { edits: [{ keyPath: 'sandbox_mode', value }] },
                })
              }
            />
            <ApprovalReviewerControl
              label={t('Approvals Reviewer')}
              description={t('Default reviewer for approval requests.')}
              effectiveValue={topLevelReviewer.value}
              source={topLevelReviewer.source}
              overridden={isUserConfigOrigin(origins, 'approvals_reviewer')}
              saving={updateMutation.isPending}
              options={reviewerOptions}
              onCommit={(value) =>
                updateMutation.mutate({
                  body: {
                    edits: [{ keyPath: 'approvals_reviewer', value }],
                  },
                })
              }
            />
            {SECURITY_READONLY_KEYS.map((key) => (
              <div
                key={key}
                className="space-y-1 overflow-hidden rounded-lg border border-border bg-card/50 px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {t(SECURITY_FIELD_LABELS[key])}
                  </span>
                  {isNonEnglish && (
                    <code className="text-xs text-muted-foreground">{key}</code>
                  )}
                  <ConfigSourceBadge source={originLabel(origins, key)} />
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  {formatConfigValue(config[key])}
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      <RawConfigEditor onSaved={invalidate} />
    </section>
  );
}
