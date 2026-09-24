/** Explicit close actions protect dirty documents and distinguish terminal termination from hiding. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  discardDocument,
  saveDocument,
  useDocumentStore,
} from '@/stores/document-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useTerminalViewStore } from '@/stores/terminal-view-store';
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store';
import { SaveAsDialog } from '@/components/files/save-as-dialog';

/** Controls a single user-requested close; async completion always targets its originating context. */
export function useWorkspaceClose(context: string) {
  const [pending, setPending] = useState<WorkspaceTab | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const { t } = useTranslation();
  const document = useDocumentStore((s) =>
    pending?.kind === 'file'
      ? s.documents[pending.documentId]
      : undefined,
  );
  const locked = busy || Boolean(document?.saving);
  const remove = (tab: WorkspaceTab) =>
    useWorkspaceStore.getState().remove(context, tab.id);
  const closeTerminal = async (
    tab: Extract<WorkspaceTab, { kind: 'terminal' }>,
  ) => {
    setBusy(true);
    const closed = await useTerminalStore
        .getState()
        .closeTerminal(context, tab.terminalId);
    setBusy(false);
    if (closed) {
      useTerminalViewStore.getState().release(tab.terminalId);
      remove(tab);
      setPending(null);
    }
  };
  const requestClose = (tab: WorkspaceTab) => {
    if (tab.kind === 'file') {
      const current = useDocumentStore.getState().documents[tab.documentId];
      if (current?.dirty || current?.detached)
        setPending(tab);
      else remove(tab);
    } else if (
      (useTerminalStore.getState().terminals[tab.terminalId]?.attachedCount ??
        0) > 1
    )
      setPending(tab);
    else void closeTerminal(tab);
  };
  const dialog = (
    <AlertDialog
      open={pending !== null && !saveAsOpen}
      onOpenChange={(open) => !open && !busy && !saveAsOpen && setPending(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(
              pending?.kind === 'terminal'
                ? 'Close shared terminal?'
                : 'Unsaved changes',
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.kind === 'terminal'
              ? t(
                  'Closing this terminal kills the process for every attached client.',
                )
              : document?.detached
                ? t('This file was deleted. Save As recovers the buffer; discard permanently removes it.')
                : t('This file has unsaved changes. Saving or discarding changes applies to every view of this file.')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {document?.error && (
          <p role="alert" className="text-sm text-destructive">
            {document.error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={locked}>{t('Cancel')}</AlertDialogCancel>
          {pending?.kind === 'file' ? (
            <>
              <Button
                variant="destructive"
                disabled={locked}
                onClick={() => {
                  discardDocument(pending.documentId);
                  remove(pending);
                  setPending(null);
                }}
              >
                {t('Discard and close')}
              </Button>
              {document?.detached ? (
                <Button disabled={locked} onClick={() => setSaveAsOpen(true)}>{t('Save As')}</Button>
              ) : (
                <Button
                  disabled={locked}
                  onClick={() => {
                    const tab = pending;
                    setBusy(true);
                    void saveDocument(tab.documentId).then((ok) => {
                      setBusy(false);
                      const current = useDocumentStore.getState().documents[tab.documentId];
                      if (ok && (!current || !current.dirty)) {
                        remove(tab);
                        setPending(null);
                      }
                    });
                  }}
                >
                  {t('Save and close')}
                </Button>
              )}
            </>
          ) : (
            pending && (
              <Button
                disabled={locked}
                onClick={() => void closeTerminal(pending)}
              >
                {t('Close terminal')}
              </Button>
            )
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  const saveAs = pending?.kind === 'file' ? (
    <SaveAsDialog
      open={saveAsOpen}
      documentId={pending.documentId}
      onOpenChange={setSaveAsOpen}
      onSaved={() => {
        setSaveAsOpen(false);
        if (!useDocumentStore.getState().documents[pending.documentId]?.dirty) {
          remove(pending);
          setPending(null);
        }
      }}
    />
  ) : null;
  return { requestClose, dialog: <>{dialog}{saveAs}</> };
}
