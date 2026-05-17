/**
 * Session-level bottom panel with file tree + file tabs + shared terminal tabs.
 * Appears below the chat timeline.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { FileCode, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FileTree } from '@/components/files/file-tree';
import { FileViewer } from '@/components/files/file-viewer';
import { TerminalPane } from '@/components/terminal/terminal-pane';
import { TerminalStatusBar } from '@/components/terminal/terminal-status-bar';
import { TerminalTabs } from '@/components/terminal/terminal-tabs';
import { useTerminalSocketEvents } from '@/hooks/use-terminal-socket';
import { useFilesStore } from '@/stores/files-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { cn } from '@/lib/utils';

interface Props {
  threadId: string;
  cwd: string;
  onClose: () => void;
  /** File path to open (from @mention or image badge click). */
  openFile?: string | null;
  /** Monotonic sequence number — ensures re-clicking the same file triggers a new open. */
  openFileSeq?: number;
  /** Called after the file has been opened in a tab. */
  onFileOpened?: () => void;
}

interface FileTab {
  path: string;
  name: string;
}

function terminalTabKey(terminalId: string): string {
  return `terminal:${terminalId}`;
}

function terminalIdFromTab(tab: string): string | null {
  return tab.startsWith('terminal:') ? tab.slice('terminal:'.length) : null;
}

export function SessionPanel({ threadId, cwd, onClose, openFile, openFileSeq, onFileOpened }: Props) {
  const { t } = useTranslation();
  useTerminalSocketEvents();
  const contextKey = `thread:${threadId}`;
  const [activeTab, setActiveTab] = useState<string>('terminal');
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const selectFile = useFilesStore((s) => s.selectFile);
  const terminalContext = useTerminalStore((s) => s.contexts[contextKey]);
  const ensureContext = useTerminalStore((s) => s.ensureContext);
  const selectTerminal = useTerminalStore((s) => s.selectTerminal);

  const terminalIds = terminalContext?.terminalIds ?? [];
  const storeActiveTerminalId = terminalContext?.activeTerminalId ?? terminalIds[0] ?? null;

  // Derive activeTerminalId: resolve generic 'terminal' tab to specific terminal id
  const resolvedTab =
    activeTab === 'terminal' && storeActiveTerminalId
      ? terminalTabKey(storeActiveTerminalId)
      : activeTab;
  const activeTerminalId = terminalIdFromTab(resolvedTab) ?? storeActiveTerminalId;
  const terminalVisible = resolvedTab === 'terminal' || terminalIdFromTab(resolvedTab) !== null;

  useEffect(() => {
    void ensureContext(contextKey, cwd, true);
  }, [contextKey, cwd, ensureContext]);

  const handleFileClick = useCallback(
    (filePath: string) => {
      const name = filePath.split('/').pop() ?? filePath;
      setFileTabs((prev) => {
        if (prev.some((t) => t.path === filePath)) return prev;
        return [...prev, { path: filePath, name }];
      });
      setActiveTab(filePath);
      selectFile(filePath);
    },
    [selectFile],
  );

  // Open a file when requested externally (from @mention click, image badge, etc.)
  // Ref-backed seq avoids re-triggering on unrelated renders; useEffect avoids parent
  // state updates during child render.
  const lastProcessedSeqRef = useRef(-1);
  useEffect(() => {
    if (!openFile || openFileSeq == null || openFileSeq === lastProcessedSeqRef.current) {
      return;
    }
    lastProcessedSeqRef.current = openFileSeq;
    const name = openFile.split('/').pop() ?? openFile;
    setFileTabs((prev) => {
      if (prev.some((t) => t.path === openFile)) return prev;
      return [...prev, { path: openFile, name }];
    });
    setActiveTab(openFile);
    selectFile(openFile);
    onFileOpened?.();
  }, [openFile, openFileSeq, onFileOpened, selectFile]);

  const closeTab = useCallback(
    (path: string) => {
      setFileTabs((prev) => {
        const next = prev.filter((t) => t.path !== path);
        if (activeTab === path) {
          const closedIdx = prev.findIndex((t) => t.path === path);
          const leftTab = prev[closedIdx - 1];
          setActiveTab(
            leftTab
              ? leftTab.path
              : activeTerminalId
                ? terminalTabKey(activeTerminalId)
                : next[0]?.path ?? 'terminal',
          );
        }
        return next;
      });
    },
    [activeTab, activeTerminalId],
  );

  const handleSelectTerminal = (terminalId: string) => {
    selectTerminal(contextKey, terminalId);
    setActiveTab(terminalTabKey(terminalId));
  };

  return (
    <div className="flex h-full border-t border-border bg-background">
      <div className="flex w-52 shrink-0 flex-col overflow-hidden border-r border-border">
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {t('Explorer')}
        </div>
        <FileTree onFileClick={handleFileClick} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center border-b border-border bg-muted/20">
          {/* Scrollable tab strip — terminal tabs and file tabs flow naturally */}
          <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
            <TerminalTabs
              contextKey={contextKey}
              cwd={cwd}
              activeTerminalId={activeTerminalId}
              onSelectTerminal={handleSelectTerminal}
              className="shrink-0"
            />

            {fileTabs.map((tab) => (
              <button
                key={tab.path}
                type="button"
                onClick={() => {
                  setActiveTab(tab.path);
                  void selectFile(tab.path);
                }}
                className={cn(
                  'group flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
                  activeTab === tab.path
                    ? 'border-b-2 border-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <FileCode className="h-3 w-3" />
                {tab.name}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.path);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') closeTab(tab.path);
                  }}
                  className="ml-1 rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="shrink-0 px-2 py-1.5 text-muted-foreground hover:text-foreground"
            title={t('Close panel')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          <div className={cn('absolute inset-0', !terminalVisible && 'hidden')}>
            {terminalIds.length === 0 && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t('No terminals')}
              </div>
            )}
            {terminalIds.map((terminalId) => (
              <TerminalPane
                key={terminalId}
                contextKey={contextKey}
                terminalId={terminalId}
                active={
                  terminalVisible &&
                  terminalId === activeTerminalId
                }
                className="absolute inset-0"
              />
            ))}
          </div>
          {!terminalVisible && <FileViewer />}
        </div>

        {terminalVisible && (
          <TerminalStatusBar contextKey={contextKey} activeTerminalId={activeTerminalId} />
        )}
      </div>
    </div>
  );
}
