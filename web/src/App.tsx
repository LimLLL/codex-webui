import { useCallback, useEffect, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatHeader } from '@/components/chat/chat-header';
import { ChatTimeline } from '@/components/chat/chat-timeline';
import { ChatInput } from '@/components/chat/chat-input';
import { ThreadSidebar } from '@/components/chat/thread-sidebar';
import type { GlobalView } from '@/types/views';
import { SessionPanel } from '@/components/chat/session-panel';
import { FilesPanel } from '@/components/files/files-panel';
import { TerminalView } from '@/components/terminal/terminal-view';
import { LoginPage } from '@/components/login';
import { useCodexSocket } from '@/hooks/use-codex-socket';
import { useTimelineStore } from '@/stores/timeline-store';
import { useFilesStore } from '@/stores/files-store';
import { api } from '@/api';
import { getApiToken, setApiToken, clearApiToken } from '@/auth-token';
import { resetSocket } from '@/socket';

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [input, setInput] = useState('');
  const [dark, setDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [globalView, setGlobalView] = useState<GlobalView>('chat');
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const sessionPanelHeight = 300;

  const threadCwd = useTimelineStore((s) => s.threadCwd);
  const setRootDir = useFilesStore((s) => s.setRootDir);

  // Only connect socket after authentication
  useCodexSocket(authenticated);

  // Validate existing token on mount
  useEffect(() => {
    const token = getApiToken();
    if (!token) return;
    api.getWorkspaceRoots().then((res) => {
      setAuthenticated(true);
      setHomeDir(res.homeDir);
    }).catch(() => {
      clearApiToken();
    });
  }, []);

  const handleLogin = useCallback(async (apiKey: string): Promise<boolean> => {
    setApiToken(apiKey);
    try {
      const res = await api.getWorkspaceRoots();
      setHomeDir(res.homeDir);
      resetSocket(); // Reconnect with new token
      setAuthenticated(true);
      return true;
    } catch {
      clearApiToken();
      return false;
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  // Sync file tree root based on current view
  useEffect(() => {
    if (globalView === 'chat') {
      void setRootDir(threadCwd);
    } else if (globalView === 'files' && homeDir) {
      void setRootDir(homeDir);
    }
  }, [globalView, threadCwd, homeDir, setRootDir]);

  const handleViewChange = useCallback((view: GlobalView) => {
    setGlobalView(view);
    if (view !== 'chat') {
      setSessionPanelOpen(false);
    }
  }, []);

  if (!authenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden bg-background">
        <ThreadSidebar activeView={globalView} onViewChange={handleViewChange} />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatHeader dark={dark} onToggleDark={() => setDark((d) => !d)} />

          {globalView === 'chat' && (
            <>
              <ChatTimeline />

              {sessionPanelOpen && threadCwd && (
                <div
                  style={{ height: sessionPanelHeight }}
                  className="shrink-0"
                >
                  <SessionPanel
                    cwd={threadCwd}
                    onClose={() => setSessionPanelOpen(false)}
                  />
                </div>
              )}

              <ChatInput
                value={input}
                onChange={setInput}
                panelOpen={sessionPanelOpen}
                onTogglePanel={() => setSessionPanelOpen((o) => !o)}
              />
            </>
          )}

          {globalView === 'files' && <FilesPanel />}

          {globalView === 'terminal' && (
            <div className="min-h-0 flex-1">
              <TerminalView cwd={homeDir ?? '/'} />
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;
