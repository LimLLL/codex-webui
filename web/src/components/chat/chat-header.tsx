import { Activity, Moon, Sun, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useConnectionStore } from '@/stores/connection-store';

interface Props {
  dark: boolean;
  onToggleDark: () => void;
  onToggleDiagnostics: () => void;
}

export function ChatHeader({ dark, onToggleDark, onToggleDiagnostics }: Props) {
  const { t, i18n } = useTranslation();
  const connected = useConnectionStore((s) => s.connected);

  const toggleLanguage = () => {
    const next = i18n.language.startsWith('zh') ? 'en' : 'zh-CN';
    void i18n.changeLanguage(next);
  };

  return (
    <>
      <header className="glass sticky top-0 z-10 flex items-center gap-3 px-4 py-3 md:px-6">
        <h1 className="flex-1 text-lg font-semibold tracking-tight">
          Codex WebUI
        </h1>
        <Badge
          variant={connected ? 'default' : 'secondary'}
          className="text-xs transition-colors duration-300"
        >
          <span
            className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
              connected
                ? 'animate-pulse bg-green-400'
                : 'bg-muted-foreground'
            }`}
          />
          {connected ? t('Connected') : t('Disconnected')}
        </Badge>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={onToggleDiagnostics}
            >
              <Activity className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('Diagnostics')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={toggleLanguage}
            >
              <Globe className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {i18n.language.startsWith('zh') ? 'English' : '简体中文'}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={onToggleDark}
            >
              {dark ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {dark ? t('Light mode') : t('Dark mode')}
          </TooltipContent>
        </Tooltip>
      </header>
      <Separator />
    </>
  );
}
