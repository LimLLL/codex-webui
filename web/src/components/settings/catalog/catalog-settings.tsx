/**
 * Model catalog management: seed, edit, validate, apply.
 *
 * Saving a draft and applying it are deliberately separate actions. The
 * app-server reads the catalog once at startup, so a change only takes effect
 * through a restart — and a restart while work is running would kill it. The
 * draft therefore never touches the file the running process loaded.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getApiErrorMessage } from '@/lib/api-error';
import { CatalogEntryDialog } from './catalog-entry-dialog';
import { CatalogRawEditor } from './catalog-raw-editor';
import { CatalogBlockerList } from './catalog-blockers';
import { placeEntry } from './catalog-entry-fields';
import {
  entryLabel,
  entryText,
  useCatalogDraft,
  type CatalogEntry,
} from './use-catalog-draft';

export function CatalogSettings() {
  const { t } = useTranslation();
  const catalog = useCatalogDraft();
  const [editing, setEditing] = useState<CatalogEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const models = catalog.parsed?.models ?? [];
  const state = catalog.state.data;
  const pointer = state?.configuredPointer ?? null;
  /** A pointer this backend owns, and can therefore clear back to the default. */
  const managed = state?.managed ?? false;
  /** False only on a known mismatch; see the DTO contract. */
  const pointerApplied = state?.pointerApplied ?? true;
  const running = state?.runningPaths ?? [];
  const [conflict, setConflict] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const activation = state?.activation ?? null;
  const restorable =
    activation !== null &&
    activation.outcome !== 'reverted' &&
    activation.after === pointer;

  /** Writes a mutated model list back into the working document. */
  const writeModels = (next: CatalogEntry[]) => {
    const document = catalog.parsed ? { ...catalog.parsed, models: next } : { models: next };
    catalog.setWorking(JSON.stringify(document, null, 2));
  };

  const submitEntry = (entry: CatalogEntry) => {
    const result = placeEntry(
      models,
      editing ? entryText(editing, 'slug') : null,
      entry,
    );
    // Deleted from under the dialog, most likely through the raw editor.
    setConflict(
      'missing' in result
        ? t('“{{slug}}” is no longer in the draft; the edit was not applied.', {
            slug: result.missing,
          })
        : null,
    );
    if ('models' in result) writeModels(result.models);
    setDialogOpen(false);
    setEditing(null);
  };

  const saveDraft = () => {
    if (catalog.working === null) return;
    catalog.save.mutate({
      body: { content: catalog.working, expectedDraft: catalog.committed },
    });
  };

  const error =
    catalog.save.error ??
    catalog.seed.error ??
    catalog.apply.error ??
    catalog.useDefault.error ??
    catalog.restore.error ??
    catalog.restart.error ??
    catalog.validate.error;

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">{t('Model catalog')}</h2>
        <p className="text-xs text-muted-foreground">
          {t(
            'Codex clamps model_context_window to each model’s max_context_window. A custom catalog is the only way to raise that ceiling, or to list a model Codex does not ship.',
          )}
        </p>
        {/* "No user-level override" is all this endpoint can prove. A lower
            config layer may still supply a catalog, so claiming the bundled one
            is active would be a guess. `runningPaths` is what the child
            actually loaded, and it is the only statement about the live list. */}
        <p className="text-xs text-muted-foreground">
          {pointer
            ? t('Configured catalog: {{path}}', { path: pointer })
            : t('No user-level catalog override.')}
          {!managed && pointer && ` · ${t('not managed by this server')}`}
        </p>
        {running.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('Codex loaded: {{path}}', { path: running.join(', ') })}
          </p>
        )}
        {state?.ready && !pointer && running.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t('Codex is using the catalog it ships with.')}
          </p>
        )}
        {state?.ready && !pointerApplied && (
          <div className="space-y-1.5">
            <p className="text-xs text-amber-500">
              {t(
                'The running catalog differs from what the configuration points at now. Restart to align them.',
              )}
            </p>
            {/* A pointer changed through raw config leaves a perfectly healthy
                child, so this action cannot be tied to the error block. The
                backend still runs its own activity check before stopping it. */}
            <RestartButton catalog={catalog} />
          </div>
        )}
      </header>

      {(state?.startupError || state?.repairError) && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <p className="flex items-center gap-2 text-xs font-medium text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            {state.startupError
              ? t('Codex could not start')
              : t('Catalog state could not be read')}
          </p>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-[11px]">
            {state.startupError ?? state.repairError}
          </pre>
          <p className="text-xs text-muted-foreground">
            {t(
              'Restore the previous catalog, or repair config.toml directly below, then retry startup.',
            )}
          </p>
          {/* The only in-browser way out of a failed start: everything else in
              this panel needs a healthy child. */}
          <RestartButton catalog={catalog} />
        </div>
      )}

      {/* Draft actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={catalog.seed.isPending}
          onClick={() =>
            catalog.seed.mutate({
              body: { source: 'bundled', expectedDraft: catalog.committed },
            })
          }
        >
          {t('Seed from bundled catalog')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={catalog.seed.isPending}
          onClick={() =>
            catalog.seed.mutate({
              body: { source: 'effective', expectedDraft: catalog.committed },
            })
          }
        >
          {t('Seed from current catalog')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!catalog.parsed}
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('Add model')}
        </Button>
      </div>

      {catalog.working === null && (
        <p className="text-xs text-muted-foreground">
          {t(
            'No draft yet. Seed one first — a catalog replaces the whole model list, so starting from the full set avoids losing every official model.',
          )}
        </p>
      )}

      {/* The document survives; only the structured view steps aside, so the
          raw editor below stays the way to fix it. */}
      {catalog.working !== null && !catalog.parsed && (
        <p className="text-xs text-amber-500">
          {t(
            'This draft is not a readable catalog, so the model list is unavailable. Fix it in the JSON editor below.',
          )}
        </p>
      )}

      {conflict && <p className="text-xs text-destructive">{conflict}</p>}

      {/* Refusing the overwrite is only useful with a way out: the baseline is
          deliberately stale now, so every save would keep failing until the
          user decides whose version wins. */}
      {catalog.stale && catalog.dirty && (
        <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-xs text-amber-600 dark:text-amber-500">
            {t(
              'The saved draft changed elsewhere while you were editing. Saving now would overwrite it.',
            )}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={catalog.writing || discarding}
            onClick={() => {
              setDiscarding(true);
              setDiscardError(null);
              catalog
                .discardLocalEdits()
                .catch((error: unknown) =>
                  setDiscardError(getApiErrorMessage(error)),
                )
                .finally(() => setDiscarding(false));
            }}
          >
            {t('Discard my edits and load the saved draft')}
          </Button>
          {discardError && (
            <p className="text-xs text-destructive">{discardError}</p>
          )}
        </div>
      )}

      {/* Model list */}
      {models.length > 0 && (
        <div className="divide-y divide-border rounded-md border border-border">
          {models.map((model, index) => (
            <div
              key={`${entryText(model, 'slug')}-${index}`}
              className="flex items-center justify-between gap-2 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{entryLabel(model)}</p>
                <p className="truncate text-xs text-muted-foreground">
                  <code>{entryText(model, 'slug')}</code>
                  {' · '}
                  {String(model.context_window ?? '—')}
                  {' / '}
                  {String(model.max_context_window ?? '—')}
                  {' · '}
                  {entryText(model, 'visibility') || '—'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(model);
                    setDialogOpen(true);
                  }}
                >
                  {t('Edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    writeModels(models.filter((item) => item !== model))
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {catalog.warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-500">
          {catalog.warnings.map((warning, index) => (
            <li key={index}>
              {warning.model ? `${warning.model}: ` : ''}
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="whitespace-pre-wrap text-xs text-destructive">
          {getApiErrorMessage(error)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button
          size="sm"
          disabled={!catalog.dirty || catalog.save.isPending}
          onClick={saveDraft}
        >
          <Save className="mr-1.5 h-3.5 w-3.5" />
          {t('Save draft')}
        </Button>
        {catalog.dirty && (
          <span className="text-xs text-amber-500">{t('Unsaved changes')}</span>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!catalog.committed || catalog.dirty || catalog.apply.isPending}
          onClick={() => {
            if (catalog.committed === null) return;
            catalog.apply.mutate({
              body: {
                expectedDraft: catalog.committed,
                expectedPointer: pointer,
              },
            });
          }}
        >
          {t('Apply & restart Codex')}
        </Button>
        {managed && (
          <Button
            size="sm"
            variant="ghost"
            disabled={catalog.useDefault.isPending}
            onClick={() =>
              catalog.useDefault.mutate({ body: { expectedPointer: pointer } })
            }
          >
            {t('Use default catalog')}
          </Button>
        )}
        {/* Mirrors the backend precondition exactly. A failed activation leaves
            a `pending` record whose `before` pointer is what needs restoring,
            so restricting this to `accepted` hid the recovery path in the one
            state that needs it. */}
        {restorable && (
            <Button
              size="sm"
              variant="ghost"
              disabled={catalog.restore.isPending}
              onClick={() =>
                catalog.restore.mutate({ body: { expectedPointer: pointer } })
              }
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {t('Restore previous')}
            </Button>
          )}
      </div>

      <CatalogBlockerList query={catalog.blockers} />

      <CatalogRawEditor
        content={catalog.working}
        onChange={catalog.setWorking}
        onValidate={() => {
          if (catalog.working !== null)
            catalog.validate.mutate({ body: { content: catalog.working } });
        }}
        validating={catalog.validate.isPending}
      />

      <CatalogEntryDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        entry={editing}
        templates={models}
        onSubmit={submitEntry}
      />
    </section>
  );
}

/** Guarded restart, needed both after a failed start and for a pending pointer change. */
function RestartButton({
  catalog,
}: {
  catalog: ReturnType<typeof useCatalogDraft>;
}) {
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={catalog.restart.isPending}
      onClick={() => catalog.restart.mutate({})}
    >
      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
      {t('Restart Codex')}
    </Button>
  );
}
