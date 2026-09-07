/**
 * Codex app-server config management tab.
 *
 * Two modes:
 * 1. Structured editor — curated fields with per-field controls
 * 2. Raw editor — Monaco-based config.toml editing for power users
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  ApprovalReviewerControl,
  ConfigSourceBadge,
  type OverrideSelectOption,
} from '@/components/codex-config/config-override-controls';
import { useThemeStore } from '@/stores/theme-store';
import {
  codexConfigReadConfigOptions,
  codexConfigReadRawConfigOptions,
  codexConfigUpdateConfigMutation,
  codexConfigUpdateRawConfigMutation,
  codexStatusGetStatusOptions,
  modelsListModelsOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import type { ConfigEditDto } from '@/generated/api/types.gen';
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

const SECURITY_READONLY_KEYS = [
  'approval_policy',
  'sandbox_mode',
  'sandbox_workspace_write',
] as const;

const SECURITY_FIELD_LABELS: Record<
  (typeof SECURITY_READONLY_KEYS)[number],
  string
> = {
  approval_policy: 'Approval Policy',
  sandbox_mode: 'Sandbox Mode',
  sandbox_workspace_write: 'Sandbox Workspace Write',
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CodexSettings() {
  const { t, i18n } = useTranslation();
  const isNonEnglish = !i18n.language.startsWith('en');
  const queryClient = useQueryClient();

  // ---- Queries ----
  const configQuery = useQuery(codexConfigReadConfigOptions());
  const rawQuery = useQuery({
    ...codexConfigReadRawConfigOptions(),
    enabled: false, // only fetch when raw editor is expanded
  });

  const config = configQuery.data?.config as ConfigRecord | undefined;
  const origins = configQuery.data?.origins as ConfigRecord | undefined;

  // ---- Drafts: same pattern as useCategorySettings ----
  // draftOverrides stores user edits; base values come from config via useMemo.
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>({});

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

  const handleDraftChange = useCallback(
    (key: string, value: string) => {
      setDraftOverrides((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  // ---- Mutations ----
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: codexConfigReadConfigOptions().queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: codexStatusGetStatusOptions().queryKey,
    });
  }, [queryClient]);

  const updateMutation = useMutation({
    ...codexConfigUpdateConfigMutation(),
    onSuccess: (data, variables) => {
      // Optimistically update the query cache with the returned config
      queryClient.setQueryData(codexConfigReadConfigOptions().queryKey, data);
      invalidate();
      showSnackbar(t('Config saved'), 'success');
      // Only clear drafts for saved keys, preserve other pending edits
      const savedKeys = new Set(
        variables.body.edits.map((e) => e.keyPath),
      );
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

  // ---- Raw editor (Monaco) ----
  const dark = useThemeStore((s) => s.dark);
  const [rawExpanded, setRawExpanded] = useState(false);
  const [rawDraft, setRawDraft] = useState('');
  const [rawDirty, setRawDirty] = useState(false);
  const monacoRef = useRef<Parameters<OnMount>[0] | null>(null);

  const handleMonacoMount: OnMount = useCallback((editor) => {
    monacoRef.current = editor;
  }, []);

  const handleExpandRaw = useCallback(() => {
    const next = !rawExpanded;
    setRawExpanded(next);
    if (next) {
      void rawQuery.refetch().then((result) => {
        if (result.data) {
          setRawDraft(result.data.content);
          setRawDirty(false);
        }
      });
    }
  }, [rawExpanded, rawQuery]);

  const rawMutation = useMutation({
    ...codexConfigUpdateRawConfigMutation(),
    onSuccess: () => {
      invalidate();
      void rawQuery.refetch();
      setRawDirty(false);
      showSnackbar(t('Config file saved and reloaded'), 'success');
    },
    onError: (err) => {
      showSnackbar(
        t('Failed to save config file: {{msg}}', { msg: String(err) }),
        'error',
      );
    },
  });

  // ---- Loading state ----
  if (configQuery.isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
        {t('Loading...')}
      </div>
    );
  }

  if (configQuery.isError || !config) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-card/50 px-4 py-3 text-sm text-destructive">
        {t('Failed to load Codex config')}
      </div>
    );
  }

  return (
    <section className="space-y-6">
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
                profileOptions={def.key === 'profile' ? profileOptions : undefined}
                serviceTierOptions={
                  def.key === 'service_tier' ? serviceTierOptions : undefined
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
          {t('Approval policy and sandbox mode are changed from the chat security badge.')}
        </p>
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

      {/* Raw config.toml editor */}
      <div className="space-y-3 border-t border-border pt-4">
        <button
          type="button"
          onClick={handleExpandRaw}
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {rawExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <FileText className="h-4 w-4" />
          {t('Edit config.toml')}
          {rawQuery.data?.filePath && (
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              ({rawQuery.data.filePath})
            </span>
          )}
        </button>

        {rawExpanded && (
          <div className="space-y-2">
            <div className="overflow-hidden rounded-md border border-border">
              <Editor
                value={rawDraft}
                language="ini"
                theme={dark ? 'vs-dark' : 'vs'}
                height="400px"
                onMount={handleMonacoMount}
                onChange={(value) => {
                  const v = value ?? '';
                  setRawDraft(v);
                  setRawDirty(v !== (rawQuery.data?.content ?? ''));
                }}
                options={{
                  readOnly: rawMutation.isPending,
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  padding: { top: 8 },
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={!rawDirty || rawMutation.isPending}
                onClick={() => {
                  // Read latest value from Monaco editor
                  const content = monacoRef.current?.getValue() ?? rawDraft;
                  rawMutation.mutate({ body: { content } });
                }}
              >
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {t('Save & Reload')}
              </Button>
              {rawDirty && (
                <span className="text-xs text-amber-500">
                  {t('Unsaved changes')}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
