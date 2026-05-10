/**
 * File viewer/editor using Monaco Editor.
 * Supports viewing, editing, and saving files with mtime conflict detection.
 */
import { useCallback, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFilesStore } from '@/stores/files-store';

export function FileViewer() {
  const selectedFile = useFilesStore((s) => s.selectedFile);
  const fileContent = useFilesStore((s) => s.fileContent);
  const loadingFile = useFilesStore((s) => s.loadingFile);
  const saveFile = useFilesStore((s) => s.saveFile);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const handleSave = useCallback(() => {
    const value = editorRef.current?.getValue();
    if (value !== undefined) {
      void saveFile(value);
    }
  }, [saveFile]);

  if (!selectedFile) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a file to view
      </div>
    );
  }

  if (loadingFile) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading...
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
          title="Save (Ctrl+S)"
        >
          <Save className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <Editor
          defaultValue={fileContent ?? ''}
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
