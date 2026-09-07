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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

type FieldControl = 'input' | 'number' | 'select' | 'textarea';

interface FieldDef {
  key: ConfigEditDto['keyPath'];
  label: string;
  group: string;
  control: FieldControl;
  options?: readonly string[];
  description?: string;
}

const FIELD_DEFS: FieldDef[] = [
  // Profile
  {
    key: 'profile',
    label: 'Active Profile',
    group: 'Profile',
    control: 'select',
    options: [], // populated dynamically from config.profiles
    description: 'Switch active configuration profile',
  },
  // Model
  {
    key: 'model',
    label: 'Model',
    group: 'Model',
    control: 'input',
    description: 'Default model name',
  },
  {
    key: 'review_model',
    label: 'Review Model',
    group: 'Model',
    control: 'input',
    description: 'Model used for code review',
  },
  {
    key: 'model_provider',
    label: 'Model Provider',
    group: 'Model',
    control: 'input',
    description: 'Provider identifier (e.g. openai, anthropic)',
  },
  {
    key: 'model_context_window',
    label: 'Context Window',
    group: 'Model',
    control: 'number',
    description: 'Maximum context window size in tokens',
  },
  {
    key: 'model_auto_compact_token_limit',
    label: 'Auto Compact Limit',
    group: 'Model',
    control: 'number',
    description: 'Token threshold for automatic context compaction',
  },
  // Instructions
  {
    key: 'instructions',
    label: 'Instructions',
    group: 'Instructions',
    control: 'textarea',
    description: 'User-level instructions for the model',
  },
  {
    key: 'developer_instructions',
    label: 'Developer Instructions',
    group: 'Instructions',
    control: 'textarea',
    description: 'Developer-level behavior instructions',
  },
  {
    key: 'compact_prompt',
    label: 'Compact Prompt',
    group: 'Instructions',
    control: 'textarea',
    description: 'Custom prompt used during context compaction',
  },
  // Reasoning
  {
    key: 'model_reasoning_effort',
    label: 'Reasoning Effort',
    group: 'Reasoning',
    control: 'select',
    // Kept in sync with the backend's REASONING_EFFORT_VALUES. Unlike service
    // tiers this really is a fixed enum, but it still has to be updated on a
    // CLI bump — 0.153.2 added `max` and `ultra`.
    options: [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ],
  },
  {
    key: 'model_reasoning_summary',
    label: 'Reasoning Summary',
    group: 'Reasoning',
    control: 'select',
    options: ['auto', 'concise', 'detailed', 'none'],
  },
  {
    key: 'model_verbosity',
    label: 'Verbosity',
    group: 'Reasoning',
    control: 'select',
    options: ['low', 'medium', 'high'],
  },
  // Tools
  {
    key: 'web_search',
    label: 'Web Search',
    group: 'Tools',
    control: 'select',
    options: ['disabled', 'cached', 'live'],
  },
  // Advanced
  {
    key: 'service_tier',
    label: 'Service Tier',
    group: 'Advanced',
    control: 'select',
    // Options are supplied at render time from the model catalog; see
    // `serviceTierOptions`. No static list can be correct here.
  },
];

/** Group names in display order. */
const GROUP_ORDER = [
  'Profile',
  'Model',
  'Instructions',
  'Reasoning',
  'Tools',
  'Advanced',
];

// ---------------------------------------------------------------------------
// Security read-only fields
// ---------------------------------------------------------------------------

const SECURITY_READONLY_KEYS = [
  'approval_policy',
  'sandbox_mode',
  'sandbox_workspace_write',
  'approvals_reviewer',
] as const;

const SECURITY_FIELD_LABELS: Record<
  (typeof SECURITY_READONLY_KEYS)[number],
  string
> = {
  approval_policy: 'Approval Policy',
  sandbox_mode: 'Sandbox Mode',
  sandbox_workspace_write: 'Sandbox Workspace Write',
  approvals_reviewer: 'Approvals Reviewer',
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

  const config = configQuery.data?.config as Record<string, unknown> | undefined;
  const origins = configQuery.data?.origins as Record<string, unknown> | undefined;

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
                saving={updateMutation.isPending}
                profileOptions={def.key === 'profile' ? profileOptions : undefined}
                serviceTierOptions={
                  def.key === 'service_tier' ? serviceTierOptions : undefined
                }
                onDraftChange={handleDraftChange}
                onSave={handleSaveField}
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
          {t('Use the security badge in the chat input area to change these settings.')}
        </p>
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
              <OriginBadge origin={originLabel(origins, key)} />
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {formatReadonlyValue(config[key])}
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

// ---------------------------------------------------------------------------
// ConfigFieldEditor — per-field editor row
// ---------------------------------------------------------------------------

interface FieldEditorProps {
  def: FieldDef;
  draft: string;
  dirty: boolean;
  origin: string | null;
  saving: boolean;
  profileOptions?: string[];
  serviceTierOptions?: string[];
  onDraftChange: (key: string, value: string) => void;
  onSave: (key: ConfigEditDto['keyPath']) => void;
}

function ConfigFieldEditor({
  def,
  draft,
  dirty,
  origin,
  saving,
  profileOptions,
  serviceTierOptions,
  onDraftChange,
  onSave,
}: FieldEditorProps) {
  const { t, i18n } = useTranslation();
  const isNonEnglish = !i18n.language.startsWith('en');

  // `profile` and `service_tier` are both runtime-discovered rather than
  // statically enumerable, so they arrive as props instead of on the field def.
  const options =
    def.key === 'profile'
      ? (profileOptions ?? [])
      : def.key === 'service_tier'
        ? (serviceTierOptions ?? [])
        : (def.options ?? []);

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card/50 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t(def.label)}</span>
        {isNonEnglish && (
          <code className="text-xs text-muted-foreground">{def.key}</code>
        )}
        <OriginBadge origin={origin} />
      </div>
      {def.description && (
        <p className="text-xs text-muted-foreground">{t(def.description)}</p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        {def.control === 'select' ? (
          <select
            value={draft}
            onChange={(e) => onDraftChange(def.key, e.target.value)}
            disabled={saving}
            className={cn(
              'h-8 rounded-md border border-input bg-background px-3 text-sm',
              'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
            )}
          >
            <option value="" disabled>{t('(not set)')}</option>
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : def.control === 'textarea' ? (
          <Textarea
            value={draft}
            onChange={(e) => onDraftChange(def.key, e.target.value)}
            disabled={saving}
            className="min-h-[80px] w-full font-mono text-xs"
            spellCheck={false}
          />
        ) : def.control === 'number' ? (
          <Input
            type="number"
            value={draft}
            onChange={(e) => onDraftChange(def.key, e.target.value)}
            disabled={saving}
            className="h-8 w-48"
            min={0}
          />
        ) : (
          <Input
            value={draft}
            onChange={(e) => onDraftChange(def.key, e.target.value)}
            disabled={saving}
            className="h-8 w-64"
          />
        )}

        <Button
          size="sm"
          className="h-8"
          disabled={saving || !dirty}
          onClick={() => onSave(def.key)}
        >
          {t('Save')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OriginBadge — shows where a config value comes from
// ---------------------------------------------------------------------------

function OriginBadge({ origin }: { origin: string | null }) {
  const { t } = useTranslation();
  if (!origin) return null;
  return (
    <Badge
      variant={origin === 'user' ? 'secondary' : 'outline'}
      className="text-[10px]"
    >
      {t(origin)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extracts origin layer name for a config key from the origins map. */
function originLabel(
  origins: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!origins) return null;
  const meta = origins[key];
  if (meta && typeof meta === 'object' && 'name' in meta) {
    const name = (meta as { name: unknown }).name;
    if (name && typeof name === 'object' && 'type' in name) {
      return String((name as { type: string }).type);
    }
  }
  return null;
}

/** Converts a config value to a display string for draft editing. */
function configValueToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

type ParseResult =
  | { ok: true; value: ConfigEditDto['value'] }
  | { ok: false; error: string };

/**
 * Converts a draft string back to a JSON value appropriate for the field.
 * V1 does not support clearing/unsetting (null) because config/batchWrite
 * null semantics are unverified.
 */
function stringToConfigValue(key: string, raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'Value cannot be empty' };
  }

  // Number fields
  if (
    key === 'model_context_window' ||
    key === 'model_auto_compact_token_limit'
  ) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      return { ok: false, error: 'Value must be a valid number' };
    }
    return { ok: true, value: n };
  }

  return { ok: true, value: trimmed };
}

/** Formats a read-only config value for display. */
function formatReadonlyValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
