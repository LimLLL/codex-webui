/** Row editor for structured Codex config settings. */
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ConfigSourceBadge } from '@/components/codex-config/config-override-controls';
import type { ConfigEditDto } from '@/generated/api/types.gen';
import { cn } from '@/lib/utils';
import type { FieldDef } from './codex-settings-defs';

/** Props for one structured config field editor row. */
export interface FieldEditorProps {
  /** Field definition to render. */
  def: FieldDef;
  /** Current draft string. */
  draft: string;
  /** Whether the draft differs from the latest config/read value. */
  dirty: boolean;
  /** Source layer label for the effective value. */
  origin: string | null;
  /** Whether this key path is currently set in user config. */
  overridden: boolean;
  /** Disables edits while writes are pending. */
  saving: boolean;
  /** Dynamic profile names, used only by the profile selector. */
  profileOptions?: string[];
  /** Dynamic service tier ids, used only by the service tier selector. */
  serviceTierOptions?: string[];
  /** Updates the local draft for a key path. */
  onDraftChange: (key: string, value: string) => void;
  /** Saves the current draft as a concrete override. */
  onSave: (key: ConfigEditDto['keyPath']) => void;
  /** Clears this leaf key back to inherited behavior. */
  onClear: (key: ConfigEditDto['keyPath']) => void;
}

/** Per-field editor row with an explicit clear-to-inherit action. */
export function ConfigFieldEditor({
  def,
  draft,
  dirty,
  origin,
  overridden,
  saving,
  profileOptions,
  serviceTierOptions,
  onDraftChange,
  onSave,
  onClear,
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
        <ConfigSourceBadge source={origin} />
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
            <option value="" disabled>
              {t('(not set)')}
            </option>
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
        {overridden && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={saving}
            onClick={() => onClear(def.key)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('Return to inheritance')}
          </Button>
        )}
      </div>
    </div>
  );
}
