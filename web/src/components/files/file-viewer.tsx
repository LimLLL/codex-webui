/**
 * File viewer/editor using Monaco Editor.
 * Uses TanStack Query for file content, Zustand for selection state.
 */
import { useCallback, useRef, useEffect } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { Loader2, Save } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  filesReadFileOptions,
  filesGetMetadataOptions,
  filesWriteFileMutation,
  filesReadFileQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { useFilesStore } from '@/stores/files-store';

export function FileViewer() {
  const { t } = useTranslation();
  const selectedFile = useFilesStore((s) => s.selectedFile);
  const fileMtime = useFilesStore((s) => s.fileMtime);
  const setFileMtime = useFilesStore((s) => s.setFileMtime);
  const queryClient = useQueryClient();

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const { data: fileData, isLoading } = useQuery({
    ...filesReadFileOptions({ query: { path: selectedFile! } }),
    enabled: !!selectedFile,
  });

  const { data: metadata } = useQuery({
    ...filesGetMetadataOptions({ query: { path: selectedFile! } }),
    enabled: !!selectedFile,
  });

  // Track mtime for conflict detection
  useEffect(() => {
    if (metadata?.mtime != null) {
      setFileMtime(metadata.mtime);
    }
  }, [metadata?.mtime, setFileMtime]);

  const writeFile = useMutation({
    ...filesWriteFileMutation(),
    onSuccess: (res) => {
      setFileMtime(res.mtime);
      void queryClient.invalidateQueries({
        queryKey: filesReadFileQueryKey({ query: { path: selectedFile! } }),
      });
    },
  });

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const handleSave = useCallback(() => {
    const value = editorRef.current?.getValue();
    if (value !== undefined && selectedFile) {
      writeFile.mutate({
        body: {
          path: selectedFile,
          content: value,
          expectedMtime: fileMtime ?? undefined,
        },
      });
    }
  }, [selectedFile, fileMtime, writeFile]);

  if (!selectedFile) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('Select a file to view')}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('Loading...')}
      </div>
    );
  }

  const fileName = selectedFile.split('/').pop() ?? selectedFile;
  const language = guessLanguage(fileName);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground">
          {selectedFile}
        </span>
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
          key={selectedFile}
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
