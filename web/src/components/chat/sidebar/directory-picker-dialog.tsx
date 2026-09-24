/** Dialog for selecting a workspace directory to create a new thread. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DirectorySelectionTree } from '@/components/files/directory-selection-tree';

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (cwd: string) => void;
}

/** Uses the same directory tree and mutation menu as copy/move destinations. */
export function DirectoryPickerDialog({ open, onClose, onSelect }: Props) {
  const { t } = useTranslation();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  return <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
    {open && <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>{t('Select workspace directory')}</DialogTitle></DialogHeader>
      <DirectorySelectionTree selectedPath={selectedPath} onSelectedPathChange={setSelectedPath} />
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>{t('Cancel')}</Button>
        <Button size="sm" disabled={!selectedPath} onClick={() => { if (selectedPath) { onSelect(selectedPath); onClose(); } }}>{t('Confirm')}</Button>
      </DialogFooter>
    </DialogContent>}
  </Dialog>;
}
