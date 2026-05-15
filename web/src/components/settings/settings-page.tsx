/**
 * Settings page with General and runtime configuration sections.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  Sun,
  Moon,
  Globe,
  LogOut,
  RotateCcw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  listSettings,
  resetSetting,
  settingsQueryKey,
  updateSetting,
  type RuntimeSetting,
  type SettingCategory,
  type SettingValue,
} from '@/lib/settings-api';
import { useThemeStore } from '@/stores/theme-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { showSnackbar } from '@/stores/snackbar-store';
import { clearApiToken } from '@/auth-token';
import { resetSocket } from '@/socket';

type SettingsSection = 'general' | 'terminal' | 'files' | 'security';

const RUNTIME_SECTIONS: { key: SettingsSection; category: SettingCategory }[] = [
  { key: 'terminal', category: 'terminal' },
  { key: 'files', category: 'files' },
  { key: 'security', category: 'security' },
];

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dark = useThemeStore((s) => s.dark);
  const toggleDark = useThemeStore((s) => s.toggleDark);
  const threadId = useTimelineStore((s) => s.threadId);
  const refreshTerminalConfig = useTerminalStore((s) => s.refreshConfig);
  const [section, setSection] = useState<SettingsSection>('general');
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>(
    {},
  );

  // Find the active runtime category (if any)
  const activeCategory = RUNTIME_SECTIONS.find(
    (s) => s.key === section,
  )?.category;

  const settingsQuery = useQuery({
    queryKey: settingsQueryKey(activeCategory ?? 'terminal'),
    queryFn: () => listSettings(activeCategory ?? 'terminal'),
    enabled: !!activeCategory,
  });

  const currentSettings = useMemo(
    () => settingsQuery.data?.settings ?? [],
    [settingsQuery.data],
  );

  // Base values from server, merged with any in-progress user edits
  const drafts = useMemo(() => {
    const base = Object.fromEntries(
      currentSettings.map((s) => [s.key, formatSettingValue(s.value)]),
    );
    return { ...base, ...draftOverrides };
  }, [currentSettings, draftOverrides]);

  const onMutationSuccess = () => {
    setDraftOverrides({});
    if (activeCategory) {
      void queryClient.invalidateQueries({
        queryKey: settingsQueryKey(activeCategory),
      });
    }
    if (section === 'terminal') {
      void refreshTerminalConfig();
    }
  };

  const updateMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: SettingValue | null }) =>
      updateSetting(key, value),
    onSuccess: () => {
      onMutationSuccess();
      showSnackbar(t('Setting saved'), 'success');
    },
  });

  const resetMutation = useMutation({
    mutationFn: (key: string) => resetSetting(key),
    onSuccess: () => {
      onMutationSuccess();
      showSnackbar(t('Setting reset'), 'success');
    },
  });

  const navigateBack = () => {
    if (threadId) {
      void navigate({ to: '/t/$threadId', params: { threadId } });
    } else {
      void navigate({ to: '/' });
    }
  };

  const handleLogout = () => {
    clearApiToken();
    resetSocket();
    void navigate({ to: '/login', search: { redirect: '/' } });
  };

  const handleDraftChange = (key: string, value: string) => {
    setDraftOverrides((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = (setting: RuntimeSetting) => {
    const parsed = parseDraftValue(setting, drafts[setting.key] ?? '');
    if (!parsed.ok) {
      showSnackbar(t(parsed.error), 'error');
      return;
    }
    updateMutation.mutate({ key: setting.key, value: parsed.value });
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-8">
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
          <h1 className="text-xl font-semibold">{t('Settings')}</h1>
        </div>

        <div className="flex flex-wrap gap-2">
          {(['general', 'terminal', 'files', 'security'] as const).map((s) => (
            <Button
              key={s}
              variant={section === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => { setSection(s); setDraftOverrides({}); }}
            >
              {t(sectionLabel(s))}
            </Button>
          ))}
        </div>

        <Separator />

        {section === 'general' ? (
          <GeneralSettings
            dark={dark}
            toggleDark={toggleDark}
            language={i18n.language}
            changeLanguage={(lang) => void i18n.changeLanguage(lang)}
            onLogout={handleLogout}
          />
        ) : (
          <RuntimeSettingsSection
            category={activeCategory!}
            settings={currentSettings}
            drafts={drafts}
            isLoading={settingsQuery.isLoading}
            isSaving={updateMutation.isPending || resetMutation.isPending}
            onDraftChange={handleDraftChange}
            onSave={handleSave}
            onReset={(key) => resetMutation.mutate(key)}
          />
        )}
      </div>
    </div>
  );
}

// ── General ───────────────────────────────────────────────────────────

function GeneralSettings({
  dark,
  toggleDark,
  language,
  changeLanguage,
  onLogout,
}: {
  dark: boolean;
  toggleDark: () => void;
  language: string;
  changeLanguage: (lang: string) => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t('Appearance')}
        </h2>
        <div className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-4 py-3">
          <div className="flex items-center gap-3">
            {dark ? (
              <Moon className="h-4 w-4" />
            ) : (
              <Sun className="h-4 w-4" />
            )}
            <span className="text-sm">{t('Theme')}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={toggleDark}
          >
            {dark ? t('Light mode') : t('Dark mode')}
          </Button>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-4 py-3">
          <div className="flex items-center gap-3">
            <Globe className="h-4 w-4" />
            <span className="text-sm">{t('Language')}</span>
          </div>
          <div className="flex gap-1">
            <Button
              variant={language.startsWith('zh') ? 'default' : 'outline'}
              size="sm"
              className="h-8"
              onClick={() => changeLanguage('zh-CN')}
            >
              简体中文
            </Button>
            <Button
              variant={!language.startsWith('zh') ? 'default' : 'outline'}
              size="sm"
              className="h-8"
              onClick={() => changeLanguage('en')}
            >
              English
            </Button>
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t('Account')}
        </h2>
        <div className="flex items-center justify-between rounded-lg border border-destructive/30 bg-card/50 px-4 py-3">
          <div className="flex items-center gap-3">
            <LogOut className="h-4 w-4 text-destructive" />
            <span className="text-sm">{t('Sign out of this session')}</span>
          </div>
          <Button
            variant="destructive"
            size="sm"
            className="h-8"
            onClick={onLogout}
          >
            {t('Logout')}
          </Button>
        </div>
      </section>
    </>
  );
}

// ── Runtime Settings ──────────────────────────────────────────────────

const CATEGORY_HINTS: Record<string, string> = {
  terminal:
    'Runtime changes apply only to new terminals and future detach timers.',
  files: 'File upload limits take effect after server restart.',
  security: 'Workspace root changes take effect immediately for new file operations.',
};

function RuntimeSettingsSection({
  category,
  settings,
  drafts,
  isLoading,
  isSaving,
  onDraftChange,
  onSave,
  onReset,
}: {
  category: SettingCategory;
  settings: RuntimeSetting[];
  drafts: Record<string, string>;
  isLoading: boolean;
  isSaving: boolean;
  onDraftChange: (key: string, value: string) => void;
  onSave: (setting: RuntimeSetting) => void;
  onReset: (key: string) => void;
}) {
  const { t } = useTranslation();
  const hint = CATEGORY_HINTS[category];

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t(sectionLabel(category))}
        </h2>
        {hint && (
          <p className="text-xs text-muted-foreground">{t(hint)}</p>
        )}
      </div>

      {isLoading && (
        <div className="rounded-lg border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
          {t('Loading...')}
        </div>
      )}

      {!isLoading && settings.length === 0 && (
        <div className="rounded-lg border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
          {t('No settings found')}
        </div>
      )}

      {settings.map((setting) => (
        <SettingEditor
          key={setting.key}
          setting={setting}
          draft={drafts[setting.key] ?? ''}
          disabled={isSaving}
          onDraftChange={onDraftChange}
          onSave={onSave}
          onReset={onReset}
        />
      ))}
    </section>
  );
}

// ── Single setting editor ─────────────────────────────────────────────

function SettingEditor({
  setting,
  draft,
  disabled,
  onDraftChange,
  onSave,
  onReset,
}: {
  setting: RuntimeSetting;
  draft: string;
  disabled: boolean;
  onDraftChange: (key: string, value: string) => void;
  onSave: (setting: RuntimeSetting) => void;
  onReset: (key: string) => void;
}) {
  const { t } = useTranslation();
  const isDbOverride = setting.source === 'db';

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card/50 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">
              {settingLabel(setting.key)}
            </h3>
            <Badge variant={sourceVariant(setting.source)}>
              {t(sourceLabel(setting.source))}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(setting.description)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('Default')}: {formatSettingValue(setting.defaultValue)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {setting.type === 'number' ? (
          <Input
            type="number"
            value={draft}
            min={setting.constraints.min}
            max={setting.constraints.max}
            step={setting.constraints.integer ? 1 : undefined}
            disabled={disabled}
            onChange={(e) => onDraftChange(setting.key, e.target.value)}
            className="h-8 w-40"
          />
        ) : (
          <Input
            value={draft}
            disabled={disabled}
            onChange={(e) => onDraftChange(setting.key, e.target.value)}
            className="h-8 w-64"
          />
        )}

        <Button
          size="sm"
          className="h-8"
          disabled={disabled}
          onClick={() => onSave(setting)}
        >
          {t('Save')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={disabled || !isDbOverride}
          onClick={() => onReset(setting.key)}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('Reset')}
        </Button>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseDraftValue(
  setting: RuntimeSetting,
  draft: string,
): { ok: true; value: SettingValue } | { ok: false; error: string } {
  if (setting.type === 'number') {
    if (!draft.trim()) return { ok: false, error: 'Value is required' };
    const value = Number(draft);
    if (!Number.isFinite(value))
      return { ok: false, error: 'Value must be a number' };
    if (setting.constraints.integer && !Number.isInteger(value)) {
      return { ok: false, error: 'Value must be an integer' };
    }
    if (
      setting.constraints.min !== undefined &&
      value < setting.constraints.min
    ) {
      return { ok: false, error: 'Value is below the minimum' };
    }
    if (
      setting.constraints.max !== undefined &&
      value > setting.constraints.max
    ) {
      return { ok: false, error: 'Value is above the maximum' };
    }
    return { ok: true, value };
  }

  if (setting.type === 'boolean') {
    return { ok: true, value: draft === 'true' };
  }

  if (setting.type === 'json') {
    try {
      return { ok: true, value: JSON.parse(draft) as SettingValue };
    } catch {
      return { ok: false, error: 'Value must be valid JSON' };
    }
  }

  return { ok: true, value: draft };
}

function formatSettingValue(value: SettingValue): string {
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function sectionLabel(section: string): string {
  const labels: Record<string, string> = {
    general: 'General',
    terminal: 'Terminal',
    files: 'Files',
    security: 'Security',
  };
  return labels[section] ?? section;
}

function settingLabel(key: string): string {
  const label = key.split('.').at(-1) ?? key;
  return label
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase());
}

function sourceLabel(source: RuntimeSetting['source']): string {
  if (source === 'db') return 'runtime override';
  if (source === 'env') return 'environment';
  return 'default';
}

function sourceVariant(
  source: RuntimeSetting['source'],
): 'default' | 'secondary' | 'outline' {
  if (source === 'db') return 'default';
  if (source === 'env') return 'secondary';
  return 'outline';
}
