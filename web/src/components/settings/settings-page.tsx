/**
 * Settings page shell with tab routing to category sub-components.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useThemeStore } from '@/stores/theme-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { clearApiToken } from '@/auth-token';
import { resetSocket } from '@/socket';
import { sectionLabel } from './setting-helpers';
import { GeneralSettings } from './general-settings';
import { AccountSettings } from './account/account-settings';
import { CodexSettings } from './codex-settings';
import { CatalogSettings } from './catalog/catalog-settings';
import { TerminalSettings } from './terminal-settings';
import { FilesSettings } from './files-settings';
import { SecuritySettings } from './security-settings';

const SECTIONS = [
  'general',
  'account',
  'codex',
  'terminal',
  'files',
  'security',
] as const;

type SettingsSection = (typeof SECTIONS)[number];

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const dark = useThemeStore((s) => s.dark);
  const toggleDark = useThemeStore((s) => s.toggleDark);
  const threadId = useTimelineStore((s) => s.threadId);
  const [section, setSection] = useState<SettingsSection>('general');

  const navigateBack = () => {
    if (threadId) {
      void navigate({ to: '/t/$threadId', params: { threadId } });
    } else {
      void navigate({ to: '/' });
    }
  };

  const handleLogout = () => {
    clearApiToken();
    resetSocket();
    void navigate({ to: '/login', search: { redirect: '/' } });
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-4 sm:px-6 sm:py-8">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={navigateBack}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-semibold">{t('Settings')}</h1>
        </div>

        <div className="flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <Button
              key={s}
              variant={section === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSection(s)}
            >
              {t(sectionLabel(s))}
            </Button>
          ))}
        </div>

        <Separator />

        {section === 'general' && (
          <GeneralSettings
            dark={dark}
            toggleDark={toggleDark}
            language={i18n.language}
            changeLanguage={(lang) => void i18n.changeLanguage(lang)}
            onLogout={handleLogout}
          />
        )}
        {section === 'account' && <AccountSettings />}
        {section === 'codex' && (
          <>
            <CodexSettings />
            <CatalogSettings />
          </>
        )}
        {section === 'terminal' && <TerminalSettings />}
        {section === 'files' && <FilesSettings />}
        {section === 'security' && <SecuritySettings />}
      </div>
    </div>
  );
}
