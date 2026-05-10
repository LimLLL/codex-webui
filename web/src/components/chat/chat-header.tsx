import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useConnectionStore } from '@/stores/connection-store';

interface Props {
  dark: boolean;
  onToggleDark: () => void;
}

export function ChatHeader({ dark, onToggleDark }: Props) {
  const connected = useConnectionStore((s) => s.connected);

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
          {connected ? 'Connected' : 'Disconnected'}
        </Badge>
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
      </header>
      <Separator />
    </>
  );
}
