/** Dialog wrappers for directory destinations and destructive confirmation. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { DirectorySelectionTree } from './directory-selection-tree';

interface FilePathDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  onConfirm: (path: string) => void;
}

/** Presents the shared mutation-aware directory tree as a destination chooser. */
export function FilePathDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
}: FilePathDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && (
          <FilePathForm
            title={title}
            description={description}
            onConfirm={onConfirm}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FilePathForm({
  title,
  description,
  onConfirm,
  onCancel,
}: {
  title: string;
  description?: string;
  onConfirm: (path: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <DirectorySelectionTree
        selectedPath={selectedPath}
        onSelectedPathChange={setSelectedPath}
        showSelectedPath
      />
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          disabled={!selectedPath}
          onClick={() => selectedPath && (onConfirm(selectedPath), onCancel())}
        >
          {t('Confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryName: string;
  isDirectory: boolean;
  onConfirm: (recursive: boolean) => void;
}

/** Confirms destructive file-browser deletion while preserving recursive semantics. */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  entryName,
  isDirectory,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('Delete')}</AlertDialogTitle>
          <AlertDialogDescription>
            {isDirectory
              ? t(
                  'Are you sure you want to delete the directory "{{name}}" and all its contents?',
                  { name: entryName },
                )
              : t('Are you sure you want to delete "{{name}}"?', {
                  name: entryName,
                })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onConfirm(isDirectory)}
          >
            {t('Delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
