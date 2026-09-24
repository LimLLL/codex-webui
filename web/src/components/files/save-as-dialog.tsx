/** Recovery dialog for detached editor buffers. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  useDocumentStore,
  saveDocumentAs,
  type DocumentId,
} from '@/stores/document-store';
import { DirectorySelectionTree } from './directory-selection-tree';

interface SaveAsDialogProps {
  open: boolean;
  documentId: DocumentId | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

/**
 * Lets a detached buffer choose a policy-approved directory and recreate its
 * file through the normal create-file endpoint. The document identity remains
 * stable, so the Monaco model and undo history survive the recovery.
 */
export function SaveAsDialog({
  open,
  documentId,
  onOpenChange,
  onSaved,
}: SaveAsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && documentId && (
          <SaveAsForm
            documentId={documentId}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Starts a fresh recovery draft each time the dialog opens. */
function SaveAsForm({
  documentId,
  onClose,
  onSaved,
}: {
  documentId: DocumentId;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const document = useDocumentStore((state) => state.documents[documentId]);
  const lastPath = document?.lastPath ?? '';
  const defaultName = lastPath.split('/').pop() ?? '';
  const parentPath = lastPath.slice(0, lastPath.lastIndexOf('/')) || null;
  const [directory, setDirectory] = useState<string | null>(parentPath);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!documentId || !directory || !name.trim() || busy) return;
    if (name === '.' || name === '..' || /[/\\\0]/.test(name)) {
      setError(t('Enter a name without path separators.'));
      return;
    }
    setBusy(true);
    setError(null);
    const path = `${directory.replace(/\/$/, '')}/${name.trim()}`;
    const ok = await saveDocumentAs(documentId, path);
    setBusy(false);
    if (!ok) {
      setError(
        useDocumentStore.getState().documents[documentId]?.error ??
          t('Request failed'),
      );
      return;
    }
    onSaved?.();
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('Save As')}</DialogTitle>
        <DialogDescription>
          {t('Choose a directory and a new file name for this buffer.')}
        </DialogDescription>
      </DialogHeader>
      <DirectorySelectionTree
        selectedPath={directory}
        onSelectedPathChange={setDirectory}
        showSelectedPath
      />
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('File name')}
        disabled={busy}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('Cancel')}
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={busy || !directory || !name.trim()}
        >
          {busy ? t('Saving...') : t('Save As')}
        </Button>
      </DialogFooter>
    </>
  );
}
