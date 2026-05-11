/**
 * Session-level bottom panel with file tree + tabbed terminal/file viewer.
 * Appears below the chat timeline.
 */
import { useState, useCallback } from 'react';
import { FileCode, Terminal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FileTree } from '@/components/files/file-tree';
import { FileViewer } from '@/components/files/file-viewer';
import { TerminalView } from '@/components/terminal/terminal-view';
import { useFilesStore } from '@/stores/files-store';
import { cn } from '@/lib/utils';

interface Props {
  cwd: string;
  onClose: () => void;
}

interface FileTab {
  path: string;
  name: string;
}

export function SessionPanel({ cwd, onClose }: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'terminal' | string>('terminal');
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const selectFile = useFilesStore((s) => s.selectFile);

  const handleFileClick = useCallback(
    async (filePath: string) => {
      const name = filePath.split('/').pop() ?? filePath;
      setFileTabs((prev) => {
        if (prev.some((t) => t.path === filePath)) return prev;
        return [...prev, { path: filePath, name }];
      });
      setActiveTab(filePath);
      await selectFile(filePath);
    },
    [selectFile],
  );

  const closeTab = useCallback(
    (path: string) => {
      setFileTabs((prev) => {
        const next = prev.filter((t) => t.path !== path);
        if (activeTab === path) {
          // Switch to the tab on the left, or terminal if none left
          const closedIdx = prev.findIndex((t) => t.path === path);
          const leftTab = prev[closedIdx - 1];
          setActiveTab(leftTab ? leftTab.path : next.length > 0 ? next[0].path : 'terminal');
        }
        return next;
      });
    },
    [activeTab],
  );

  return (
    <div className="flex h-full border-t border-border bg-background">
      {/* File tree — fixed width */}
      <div className="flex w-52 shrink-0 flex-col border-r border-border overflow-hidden">
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {t('Explorer')}
        </div>
        <FileTree onFileClick={handleFileClick} />
      </div>

      {/* Tabbed right area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Tab bar */}
        <div className="flex shrink-0 items-center border-b border-border bg-muted/20">
          <button
            type="button"
            onClick={() => setActiveTab('terminal')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
              activeTab === 'terminal'
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Terminal className="h-3 w-3" />
            {t('Terminal')}
          </button>

          {fileTabs.map((tab) => (
            <button
              key={tab.path}
              type="button"
              onClick={() => setActiveTab(tab.path)}
              className={cn(
                'group flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
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

          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-2 py-1.5 text-muted-foreground hover:text-foreground"
            title={t('Close panel')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Tab content */}
        <div className="min-h-0 flex-1">
          {activeTab === 'terminal' ? (
            <TerminalView cwd={cwd} />
          ) : (
            <FileViewer />
          )}
        </div>
      </div>
    </div>
  );
}
