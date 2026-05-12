/** Shows a once-per-session risk confirmation before opening a server terminal. */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
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

const STORAGE_KEY = 'terminal.riskConfirmed';

interface Props {
  children: ReactNode;
  onCancel: () => void;
}

/** Blocks terminal mounting until the user acknowledges server execution risk. */
export function TerminalRiskGate({ children, onCancel }: Props) {
  const { t } = useTranslation();
  const [confirmed, setConfirmed] = useState(
    () => sessionStorage.getItem(STORAGE_KEY) === 'true',
  );

  const handleContinue = () => {
    sessionStorage.setItem(STORAGE_KEY, 'true');
    setConfirmed(true);
  };

  if (confirmed) return <>{children}</>;

  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Open terminal?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('Commands execute directly on the server/container. Proceed?')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancel}>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleContinue}>
              {t('Proceed')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
