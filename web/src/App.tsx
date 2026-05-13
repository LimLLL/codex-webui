import { useCallback, useEffect, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatHeader } from '@/components/chat/chat-header';
import { ChatTimeline } from '@/components/chat/chat-timeline';
import { ChatInput } from '@/components/chat/chat-input';
import { ThreadSidebar } from '@/components/chat/thread-sidebar';
import type { GlobalView } from '@/types/views';
import { DiagnosticsPanel } from '@/components/diagnostics/diagnostics-panel';
import { SessionPanel } from '@/components/chat/session-panel';
import { FilesPanel } from '@/components/files/files-panel';
import { TerminalView } from '@/components/terminal/terminal-view';
import { LoginPage } from '@/components/login';
import { SnackbarContainer } from '@/components/snackbar/snackbar-container';
import { TerminalRiskGate } from '@/components/terminal/terminal-risk-gate';
import { CodexStatusBanner } from '@/components/codex-status-banner';
import { useCodexSocket } from '@/hooks/use-codex-socket';
import { useTimelineStore } from '@/stores/timeline-store';
import { useFilesStore } from '@/stores/files-store';
import { authLogin, filesGetRoots, filesAddRoot } from '@/generated/api';
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

  const threadId = useTimelineStore((s) => s.threadId);
  const threadCwd = useTimelineStore((s) => s.threadCwd);
  const setRootDir = useFilesStore((s) => s.setRootDir);

  // Only connect socket after authentication
  useCodexSocket(authenticated);

  // Validate existing token on mount
  useEffect(() => {
    const token = getApiToken();
    if (!token) return;
    filesGetRoots({ throwOnError: true })
      .then(({ data }) => {
        setAuthenticated(true);
        setHomeDir(data.homeDir);
      })
      .catch(() => {
        clearApiToken();
      });
  }, []);

  useEffect(() => {
    const handleAuthExpired = () => {
      clearApiToken();
      resetSocket();
      setAuthenticated(false);
    };
    window.addEventListener('codex-webui:auth-expired', handleAuthExpired);
    return () => window.removeEventListener('codex-webui:auth-expired', handleAuthExpired);
  }, []);

  const handleLogin = useCallback(async (apiKey: string): Promise<boolean> => {
    try {
      const { data: loginData } = await authLogin({
        body: { apiKey },
        throwOnError: true,
      });
      setApiToken(loginData.accessToken);
      const { data } = await filesGetRoots({ throwOnError: true });
      setHomeDir(data.homeDir);
      resetSocket();
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
    const dir = globalView === 'chat' ? threadCwd : globalView === 'files' ? homeDir : null;
    if (dir) {
      // Register as workspace root, then update store
      void filesAddRoot({ body: { root: dir }, throwOnError: true, meta: { silent: true } })
        .then(() => setRootDir(dir))
        .catch(() => { /* root rejected — keep previous state */ });
    } else {
      setRootDir(null);
    }
  }, [globalView, threadCwd, homeDir, setRootDir]);

  const handleViewChange = useCallback((view: GlobalView) => {
    setGlobalView(view);
    if (view !== 'chat') {
      setSessionPanelOpen(false);
    }
  }, []);

  if (!authenticated) {
    return (
      <>
        <LoginPage onLogin={handleLogin} />
        <SnackbarContainer />
      </>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden bg-background">
        <ThreadSidebar activeView={globalView} onViewChange={handleViewChange} />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatHeader
            dark={dark}
            onToggleDark={() => setDark((d) => !d)}
            onToggleDiagnostics={() => handleViewChange(globalView === 'diagnostics' ? 'chat' : 'diagnostics')}
          />
          <CodexStatusBanner />

          {globalView === 'chat' && (
            <>
              <ChatTimeline onEditMessage={setInput} />

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

              {threadId && (
                <ChatInput
                  value={input}
                  onChange={setInput}
                  panelOpen={sessionPanelOpen}
                  onTogglePanel={() => setSessionPanelOpen((o) => !o)}
                />
              )}
            </>
          )}

          {globalView === 'files' && <FilesPanel />}

          {globalView === 'diagnostics' && <DiagnosticsPanel />}

          {globalView === 'terminal' && (
            <div className="min-h-0 flex-1">
              <TerminalRiskGate onCancel={() => setGlobalView('chat')}>
                <TerminalView cwd={homeDir ?? '/'} />
              </TerminalRiskGate>
            </div>
          )}
        </div>
      </div>
      <SnackbarContainer />
    </TooltipProvider>
  );
}

export default App;
