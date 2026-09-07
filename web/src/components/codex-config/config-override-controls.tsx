/** Reusable controls for nullable Codex config overrides. */
import { useState } from 'react';
import { RotateCcw, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import type { ApprovalReviewerValue } from '@/lib/codex-config';

/** Props shared by nullable override controls. */
interface BaseOverrideControlProps<T> {
  /** User-facing field label. */
  label: string;
  /** Optional concise field description. */
  description?: string;
  /** Effective value after applying inheritance. */
  effectiveValue: T;
  /** Source layer label for the effective value. */
  source: string | null;
  /** Whether this exact key path is currently set in user config. */
  overridden: boolean;
  /** Disables edits while a write is in flight. */
  saving: boolean;
  /** Commits a concrete override value, or null to clear this leaf key. */
  onCommit: (value: T | null) => void;
}

/** Select option used by string-valued override controls. */
export interface OverrideSelectOption<T extends string> {
  /** Actual config value sent to app-server. */
  value: T;
  /** User-facing option label. */
  label: string;
}

/** Compact badge for a config origin layer. */
export function ConfigSourceBadge({ source }: { source: string | null }) {
  const { t } = useTranslation();
  if (!source) return null;
  return (
    <Badge
      variant={source === 'user' ? 'secondary' : 'outline'}
      className="text-[10px]"
    >
      {t(source)}
    </Badge>
  );
}

/** Boolean override control that keeps inheritance separate from true/false. */
export function ConfigBooleanOverrideControl({
  label,
  description,
  effectiveValue,
  source,
  overridden,
  saving,
  onCommit,
}: BaseOverrideControlProps<boolean>) {
  const { t } = useTranslation();
  const [draft, setDraft] = useDraftValue(effectiveValue);

  const dirty = draft !== effectiveValue;

  return (
    <OverrideFrame
      label={label}
      description={description}
      source={source}
      overridden={overridden}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Switch checked={draft} disabled={saving} onCheckedChange={setDraft} />
        <span className="w-16 text-xs text-muted-foreground">
          {draft ? t('Enabled') : t('Disabled')}
        </span>
        <CommitButton
          overridden={overridden}
          saving={saving}
          dirty={dirty}
          onClick={() => onCommit(draft)}
        />
        {overridden && (
          <ClearOverrideButton
            saving={saving}
            onClick={() => onCommit(null)}
          />
        )}
      </div>
    </OverrideFrame>
  );
}

/** String select override control that never models inheritance as an option. */
export function ConfigSelectOverrideControl<T extends string>({
  label,
  description,
  effectiveValue,
  source,
  overridden,
  saving,
  options,
  onCommit,
}: BaseOverrideControlProps<T> & {
  /** Real config values exposed by the picker. */
  options: readonly OverrideSelectOption<T>[];
}) {
  const [draft, setDraft] = useDraftValue(effectiveValue);

  const dirty = draft !== effectiveValue;

  return (
    <OverrideFrame
      label={label}
      description={description}
      source={source}
      overridden={overridden}
    >
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value as T)}
          className={cn(
            'h-8 min-w-40 rounded-md border border-input bg-background px-3 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          )}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <CommitButton
          overridden={overridden}
          saving={saving}
          dirty={dirty}
          onClick={() => onCommit(draft)}
        />
        {overridden && (
          <ClearOverrideButton
            saving={saving}
            onClick={() => onCommit(null)}
          />
        )}
      </div>
    </OverrideFrame>
  );
}

/** Approval reviewer control with explicit security confirmation. */
export function ApprovalReviewerControl({
  label,
  description,
  effectiveValue,
  source,
  overridden,
  saving,
  options,
  onCommit,
}: BaseOverrideControlProps<ApprovalReviewerValue> & {
  /** Real reviewer values exposed by the picker. */
  options: readonly OverrideSelectOption<ApprovalReviewerValue>[];
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useDraftValue(effectiveValue);
  const [pendingValue, setPendingValue] = useState<
    ApprovalReviewerValue | null | undefined
  >(undefined);

  const dirty = draft !== effectiveValue;
  const confirmingClear = pendingValue === null;

  const closeDialog = () => setPendingValue(undefined);
  const commitPending = () => {
    if (pendingValue !== undefined) {
      onCommit(pendingValue);
    }
    closeDialog();
  };

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-medium">{label}</span>
        <InheritanceStateBadge overridden={overridden} />
        <ConfigSourceBadge source={source} />
      </div>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      <p className="text-xs text-amber-600 dark:text-amber-400">
        {t(
          'Approval reviewer controls who can authorize permission requests, including sandbox escapes, blocked network access, MCP approvals, and app escalations.',
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={draft}
          disabled={saving}
          onChange={(event) =>
            setDraft(event.target.value as ApprovalReviewerValue)
          }
          className={cn(
            'h-8 min-w-44 rounded-md border border-input bg-background px-3 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          )}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <CommitButton
          overridden={overridden}
          saving={saving}
          dirty={dirty}
          label={overridden ? t('Save reviewer') : t('Override reviewer')}
          onClick={() => setPendingValue(draft)}
        />
        {overridden && (
          <ClearOverrideButton
            saving={saving}
            label={t('Return to inheritance')}
            onClick={() => setPendingValue(null)}
          />
        )}
      </div>

      <AlertDialog
        open={pendingValue !== undefined}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmingClear
                ? t('Return approval reviewer to inheritance')
                : t('Confirm approval reviewer change')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmingClear
                ? t(
                    'This clears only this reviewer override. Future approval routing will inherit from the next configured layer, or the built-in user default.',
                  )
                : t(
                    'This changes who reviews permission requests. Automatic review or a guardian subagent can approve or deny operations without the prompt first routing to you when policy allows.',
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={commitPending}>
              {confirmingClear ? t('Clear override') : t('Confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface OverrideFrameProps {
  /** Field label. */
  label: string;
  /** Optional field description. */
  description?: string;
  /** Origin layer label. */
  source: string | null;
  /** Whether this field is set in user config. */
  overridden: boolean;
  /** Field controls. */
  children: React.ReactNode;
}

function OverrideFrame({
  label,
  description,
  source,
  overridden,
  children,
}: OverrideFrameProps) {
  return (
    <div className="space-y-2 rounded-lg border border-border/50 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        <InheritanceStateBadge overridden={overridden} />
        <ConfigSourceBadge source={source} />
      </div>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {children}
    </div>
  );
}

function InheritanceStateBadge({ overridden }: { overridden: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge variant={overridden ? 'secondary' : 'outline'} className="text-[10px]">
      {overridden ? t('override') : t('inherited')}
    </Badge>
  );
}

function CommitButton({
  overridden,
  saving,
  dirty,
  label,
  onClick,
}: {
  overridden: boolean;
  saving: boolean;
  dirty: boolean;
  label?: string;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      className="h-8"
      disabled={saving || (overridden && !dirty)}
      onClick={onClick}
    >
      {label ?? (overridden ? t('Save') : t('Override'))}
    </Button>
  );
}

function ClearOverrideButton({
  saving,
  label,
  onClick,
}: {
  saving: boolean;
  label?: string;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8"
      disabled={saving}
      onClick={onClick}
    >
      <RotateCcw className="h-3.5 w-3.5" />
      {label ?? t('Return to inheritance')}
    </Button>
  );
}

function useDraftValue<T>(effectiveValue: T): [T, (value: T) => void] {
  const [state, setState] = useState<{ base: T; draft: T }>({
    base: effectiveValue,
    draft: effectiveValue,
  });
  const draft = Object.is(state.base, effectiveValue)
    ? state.draft
    : effectiveValue;
  const setDraft = (value: T) => {
    setState({ base: effectiveValue, draft: value });
  };
  return [draft, setDraft];
}
