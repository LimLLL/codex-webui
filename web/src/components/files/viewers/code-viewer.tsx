/**
 * Code/text viewer using Monaco Editor.
 * Uses TanStack Query for file content, Zustand for mtime conflict detection.
 * Honours the transient line target set when a message reference is opened.
 */
import { useCallback, useEffect, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { AlertTriangle, Loader2, Save } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  filesReadFileOptions,
  filesWriteFileMutation,
  filesReadFileQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { useFilesStore } from '@/stores/files-store';
import { showSnackbar } from '@/stores/snackbar-store';

interface Props {
  filePath: string;
}

export function CodeViewer({ filePath }: Props) {
  const { t } = useTranslation();
  const selectedFile = useFilesStore((s) => s.selectedFile);
  const pendingLine = useFilesStore((s) => s.pendingLine);
  const clearPendingLine = useFilesStore((s) => s.clearPendingLine);
  const queryClient = useQueryClient();
  // The instance, not a readiness flag. The wrapper mounts asynchronously, so
  // its callback can land after the effect that wants the editor has already
  // run; a boolean set to the value it already held would not re-run that
  // effect. Holding the instance in state means a new editor is a new value.
  const [editor, setEditor] = useState<Parameters<OnMount>[0] | null>(null);

  // No placeholder data across paths: the previous file's content must never
  // populate this editor, or a save would write one file's text into another.
  const { data: fileData, isLoading, isError, isFetching } = useQuery({
    ...filesReadFileOptions({ query: { path: filePath } }),
  });

  // The write precondition travels with the content it describes. Read from a
  // separate metadata query it drifted: the two have independent freshness, so
  // a metadata-only refresh could adopt the file's new modification time while
  // the editor still held the old text — and a save then satisfied the server's
  // conflict check with a stale buffer, overwriting whatever had changed.
  const fileMtime = fileData?.mtime ?? null;

  const writeFile = useMutation({
    ...filesWriteFileMutation(),
    onSuccess: () => {
      // Refetching the content also refreshes its paired modification time,
      // so there is nothing separate to keep in step.
      void queryClient.invalidateQueries({
        queryKey: filesReadFileQueryKey({ query: { path: filePath } }),
      });
    },
  });

  const handleMount: OnMount = (mounted) => {
    setEditor(mounted);
  };

  /** Content is present, whether from this load or a still-valid earlier one. */
  const hasContent = fileData != null;
  /**
   * Content is present *and* current — the precondition for writing it back.
   *
   * An outstanding refresh disqualifies it. Content and metadata are separate
   * requests, so a metadata refresh can land first and adopt the file's new
   * modification time while the editor still shows the old text. Saving then
   * satisfies the server's conflict check with a stale buffer and overwrites
   * whatever changed on disk.
   */
  const contentLoaded = !isLoading && !isFetching && !isError && hasContent;

  /**
   * Returns the editor only when it is holding this file's model.
   *
   * The wrapper swaps models on a shared editor, and a disposed editor still
   * answers `getValue()` with an empty string — so neither the instance nor a
   * successful query proves that what is on screen is this file.
   */
  const editorForFile = useCallback(() => {
    if (!editor) return null;
    const model = editor.getModel();
    if (!model) return null;
    const { uri } = model;
    if (
      uri.scheme !== 'file' ||
      uri.authority !== '' ||
      uri.query !== '' ||
      uri.fragment !== '' ||
      uri.path !== filePath
    ) {
      return null;
    }
    return editor;
  }, [editor, filePath]);

  // Reveal the requested line once its file has actually arrived. Mount alone
  // is not enough — the wrapper swaps the model and applies the value in its
  // own effects, which run before this one, so readiness is checked explicitly
  // rather than assumed.
  useEffect(() => {
    if (pendingLine === null) return;
    // Re-read the store at the moment of acting rather than trusting the values
    // this effect closed over. A conversation switch can cancel the request
    // between render and effect, and the captured `pendingLine` would still
    // happily jump — in whichever file is on screen by then.
    const current = useFilesStore.getState();
    if (
      current.selectedFile !== filePath ||
      current.pendingLine !== pendingLine ||
      !contentLoaded
    ) {
      return;
    }
    const target = editorForFile();
    if (!target) return;
    const model = target.getModel();
    if (!model) return;

    const lineNumber = Math.min(pendingLine, model.getLineCount());
    target.setPosition({ lineNumber, column: 1 });
    target.revealLineInCenter(lineNumber);
    // Consumed here rather than left standing: later edits and background
    // refetches must not keep dragging the user back to this line.
    clearPendingLine();
    if (lineNumber !== pendingLine) {
      showSnackbar(
        t('Line {{line}} is beyond the end of this file', { line: pendingLine }),
        'warning',
      );
    }
  }, [
    editorForFile,
    pendingLine,
    selectedFile,
    filePath,
    contentLoaded,
    clearPendingLine,
    t,
  ]);

  const handleSave = useCallback(() => {
    // Saving is only safe once this file's content is loaded and current, and
    // the editor still holds this file's model. A failed read or a disposed
    // editor both answer with an empty buffer, and writing that back would
    // replace a file that exists with an empty one.
    const target = editorForFile();
    if (!contentLoaded || fileMtime === null || !target) {
      showSnackbar(t('Cannot save: this file has not loaded'), 'error');
      return;
    }
    writeFile.mutate({
      body: {
        path: filePath,
        content: target.getValue(),
        expectedMtime: fileMtime,
      },
    });
  }, [contentLoaded, editorForFile, filePath, fileMtime, writeFile, t]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('Loading...')}
      </div>
    );
  }

  // An explicit failure, never an empty editable buffer: a blank editor reads
  // as "this file is empty", and saving from that state destroys the file.
  //
  // Gated on content being absent rather than on the query having errored. A
  // failed *refresh* keeps the content it already had, and unmounting the
  // editor there would dispose its model — discarding whatever the user had
  // typed. That case keeps the editor and disables saving instead.
  if (!hasContent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
        <AlertTriangle className="h-5 w-5 text-destructive" />
        <span>{t('Could not open this file')}</span>
        <span className="break-all font-mono text-xs opacity-70">{filePath}</span>
      </div>
    );
  }

  const fileName = filePath.split('/').pop() ?? filePath;
  const language = guessLanguage(fileName);

  return (
    <div className="flex h-full flex-col">
      {/* Save toolbar. The banner explains why saving is unavailable, so a
          disabled control never reads as an unexplained dead button. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1">
        {isError ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('Reload failed — saving is disabled')}</span>
          </span>
        ) : isFetching ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span className="truncate">{t('Refreshing…')}</span>
          </span>
        ) : (
          <span />
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          disabled={!contentLoaded || fileMtime === null}
          onClick={handleSave}
          title={t('Save (Ctrl+S)')}
        >
          <Save className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <Editor
          path={monacoModelPath(filePath)}
          value={fileData.content}
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

/**
 * Builds the model URI the wrapper should use for a filesystem path.
 *
 * The wrapper parses its `path` prop as a URI, so an unescaped filesystem path
 * loses everything after a `#`, and `%` sequences are decoded as if they were
 * escapes. Encoding each segment makes the round trip exact: the model's
 * decoded `uri.path` comes back equal to the path asked for, which is what the
 * identity check compares against.
 *
 * @param filePath - Absolute filesystem path
 * @returns A `file://` URI addressing exactly that path
 */
function monacoModelPath(filePath: string): string {
  return `file://${filePath.split('/').map(encodeURIComponent).join('/')}`;
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
