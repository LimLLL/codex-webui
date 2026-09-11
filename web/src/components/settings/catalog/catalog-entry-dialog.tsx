/**
 * Add/edit dialog for one model catalog entry.
 *
 * Every field the pinned schema carries is editable, but a new entry starts as
 * a complete copy of a template entry rather than an empty form. Upstream
 * refuses an entry that has neither `base_instructions` nor
 * `model_messages.instructions_template`, and several capability fields decide
 * whether the model can be selected at all — inheriting them is what makes a
 * full-field form usable instead of a trap.
 */
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  applyField,
  catalogFields,
  fieldText,
  VISIBILITY_VALUES,
  type CatalogField,
} from './catalog-entry-fields';
import { entryLabel, entryText, type CatalogEntry } from './use-catalog-draft';

const PRIMARY_COUNT = 9;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Entry being edited, or null when adding. */
  entry: CatalogEntry | null;
  /** Every entry in the draft, offered as templates for a new entry. */
  templates: CatalogEntry[];
  onSubmit: (entry: CatalogEntry) => void;
}

/** Edits a copy of the opening entry, preserving raw keystrokes until fields are valid. */
export function CatalogEntryDialog({
  open,
  onClose,
  entry,
  templates,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const templateId = useId();
  const [templateSlug, setTemplateSlug] = useState<string>('');
  const [draft, setDraft] = useState<CatalogEntry | null>(null);
  /** Entry the fields are derived from, so an edit cannot reshape the form. */
  const [base, setBase] = useState<CatalogEntry | null>(null);
  /**
   * Exactly what is typed, per field. A half-written number or object is not
   * parseable yet, and rendering the last parsed value instead would undo the
   * keystroke — which makes a JSON or number field impossible to edit at all.
   */
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);

  // Reset on every opening, not only when the subject changes: cancelling and
  // reopening the same entry must not resume the abandoned draft.
  const subject = entry ? entryText(entry, 'slug') : '__new__';
  const opening = open ? subject : null;
  const [session, setSession] = useState<string | null>(null);
  if (session !== opening) {
    setSession(opening);
    if (open) {
      setDraft(entry ? { ...entry } : null);
      setBase(entry ? { ...entry } : null);
      setTemplateSlug('');
      setTexts({});
      setErrors({});
      setShowAll(false);
    }
  }

  // The selected template is already copied into base. Consulting the live
  // template again would let another browser reshape this form mid-edit.
  const fields = useMemo(
    () => (base ? catalogFields(base, null) : []),
    [base],
  );
  const visible = showAll ? fields : fields.slice(0, PRIMARY_COUNT);

  const update = (field: CatalogField, raw: string | boolean) => {
    if (!draft) return;
    if (typeof raw === 'string')
      setTexts((current) => ({ ...current, [field.key]: raw }));
    const result = applyField(draft, field, raw);
    if ('error' in result) {
      setErrors((current) => ({ ...current, [field.key]: result.error }));
      return;
    }
    setErrors((current) => {
      const next = { ...current };
      delete next[field.key];
      return next;
    });
    setDraft(result.entry);
  };

  const chooseTemplate = (slug: string) => {
    setTemplateSlug(slug);
    const source = templates.find((item) => entryText(item, 'slug') === slug);
    // A copy, not a live link: later template edits must not reach this entry.
    if (source) {
      const copy = { ...source, slug: '', display_name: '' };
      setDraft(copy);
      setBase(copy);
      setTexts({});
      setErrors({});
    }
  };

  const slug = draft ? entryText(draft, 'slug').trim() : '';
  // Renaming onto another entry's slug collides just as much as adding one.
  const originalSlug = entry ? entryText(entry, 'slug') : null;
  const duplicate = templates.some(
    (item) =>
      entryText(item, 'slug') === slug &&
      entryText(item, 'slug') !== originalSlug,
  );
  const blocked =
    !draft || !slug || duplicate || Object.keys(errors).length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {entry
              ? t('Edit model: {{name}}', { name: entryLabel(entry) })
              : t('Add model')}
          </DialogTitle>
        </DialogHeader>

        {!entry && (
          <div className="space-y-1">
            <label htmlFor={templateId} className="text-xs font-medium text-muted-foreground">
              {t('Inherit from')}
            </label>
            <select
              id={templateId}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={templateSlug}
              onChange={(event) => chooseTemplate(event.target.value)}
            >
              <option value="">{t('Choose a template model…')}</option>
              {templates.map((item) => (
                <option key={entryText(item, 'slug')} value={entryText(item, 'slug')}>
                  {entryLabel(item)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {t(
                'Every field is copied from the template, including the base instructions a model needs to work. Change only what differs.',
              )}
            </p>
          </div>
        )}

        {draft && (
          <div className="space-y-3">
            {visible.map((field) => (
              <FieldEditor
                key={field.key}
                field={field}
                value={texts[field.key] ?? fieldText(draft, field)}
                error={errors[field.key]}
                onChange={(raw) => update(field, raw)}
              />
            ))}
            {fields.length > PRIMARY_COUNT && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll
                  ? t('Show fewer fields')
                  : t('Show all {{count}} fields', { count: fields.length })}
              </button>
            )}
          </div>
        )}

        {duplicate && (
          <p className="text-xs text-destructive">
            {t('A model with this slug already exists')}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={blocked}
            onClick={() => {
              if (draft) onSubmit(draft);
            }}
          >
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Renders one field with an editor matching its inferred type. */
function FieldEditor({
  field,
  value,
  error,
  onChange,
}: {
  field: CatalogField;
  value: string;
  error?: string;
  onChange: (raw: string | boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center gap-2 text-xs font-medium">
        <code>{field.key}</code>
        {field.nullable && (
          <span className="text-[10px] text-muted-foreground">
            {t('nullable')}
          </span>
        )}
      </label>
      {field.kind === 'boolean' ? (
        <Switch
          id={id}
          checked={value === 'true'}
          onCheckedChange={(checked) => onChange(checked)}
        />
      ) : field.key === 'visibility' ? (
        <select
          id={id}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {VISIBILITY_VALUES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.kind === 'json' ? (
        <Textarea
          id={id}
          className="font-mono text-xs"
          rows={value.length > 400 ? 8 : 3}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={field.kind === 'number' ? 'number' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
