/**
 * Code/text viewer using Monaco Editor.
 * Uses TanStack Query for file content, Zustand for mtime conflict detection.
 */
import { useCallback, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { Loader2, Save } from 'lucide-react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  filesReadFileOptions,
  filesWriteFileMutation,
  filesReadFileQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { useFilesStore } from '@/stores/files-store';

interface Props {
  filePath: string;
}

export function CodeViewer({ filePath }: Props) {
  const { t } = useTranslation();
  const fileMtime = useFilesStore((s) => s.fileMtime);
  const setFileMtime = useFilesStore((s) => s.setFileMtime);
  const queryClient = useQueryClient();
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const { data: fileData, isLoading } = useQuery({
    ...filesReadFileOptions({ query: { path: filePath } }),
    placeholderData: keepPreviousData,
  });

  const writeFile = useMutation({
    ...filesWriteFileMutation(),
    onSuccess: (res) => {
      setFileMtime(res.mtime);
      void queryClient.invalidateQueries({
        queryKey: filesReadFileQueryKey({ query: { path: filePath } }),
      });
    },
  });

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const handleSave = useCallback(() => {
    const value = editorRef.current?.getValue();
    if (value !== undefined) {
      writeFile.mutate({
        body: {
          path: filePath,
          content: value,
          expectedMtime: fileMtime ?? undefined,
        },
      });
    }
  }, [filePath, fileMtime, writeFile]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('Loading...')}
      </div>
    );
  }

  const fileName = filePath.split('/').pop() ?? filePath;
  const language = guessLanguage(fileName);

  return (
    <div className="flex h-full flex-col">
      {/* Save toolbar */}
      <div className="flex shrink-0 items-center justify-end border-b border-border px-2 py-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={handleSave}
          title={t('Save (Ctrl+S)')}
        >
          <Save className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <Editor
          path={filePath}
          value={fileData?.content ?? ''}
          language={language}
          theme="vs-dark"
          height="100%"
          onMount={handleMount}
          options={{
            readOnly: false,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            padding: { top: 8 },
          }}
        />
      </div>
    </div>
  );
}

/** Maps file extension to Monaco language identifier. */
function guessLanguage(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    dockerfile: 'dockerfile',
    toml: 'ini',
    env: 'ini',
  };
  return map[ext] ?? 'plaintext';
}
