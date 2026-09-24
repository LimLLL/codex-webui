/** Keeps deleted dirty buffers reachable even after their standalone viewer disappears. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
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
import { discardDocument, useDocumentStore } from '@/stores/document-store';
import { SaveAsDialog } from './save-as-dialog';

/** Application-owned recovery survives route changes and file-browser unmounts. */
export function DetachedDocumentRecovery() {
  const { t } = useTranslation();
  const documents = useDocumentStore((state) => state.documents);
  const [recoverId, setRecoverId] = useState<string | null>(null);
  const [discardId, setDiscardId] = useState<string | null>(null);
  const detached = Object.values(documents).filter(
    (document) => document.detached && document.dirty,
  );
  return (
    <>
      {detached.length > 0 && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 overflow-x-auto border-b px-3 py-1 text-xs"
        >
          <span className="shrink-0">
            {t('Unsaved files no longer on disk')}
          </span>
          {detached.map((document) => (
            <div key={document.id} className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                title={document.lastPath}
                onClick={() => setRecoverId(document.id)}
              >
                {t('Recover {{name}}', {
                  name: document.lastPath.split('/').pop(),
                })}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDiscardId(document.id)}
              >
                {t('Discard')}
              </Button>
            </div>
          ))}
        </div>
      )}
      <SaveAsDialog
        open={recoverId !== null}
        documentId={recoverId}
        onOpenChange={(open) => !open && setRecoverId(null)}
      />
      <AlertDialog
        open={discardId !== null}
        onOpenChange={(open) => !open && setDiscardId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Discard unsaved changes?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {documents[discardId ?? '']?.lastPath}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (discardId) discardDocument(discardId);
                setDiscardId(null);
              }}
            >
              {t('Discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
