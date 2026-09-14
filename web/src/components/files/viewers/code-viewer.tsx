/** A disposable editor view over a shared document model and a per-view reading position. */
import { useEffect, useState, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { AlertTriangle, Loader2, RotateCcw, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  useDocumentStore,
  retainDocument,
  releaseDocument,
  reloadDocument,
  saveDocument,
} from '@/stores/document-store';
import { useWorkspaceStore, EMPTY_FILE_VIEW } from '@/stores/workspace-store';
import { showSnackbar } from '@/stores/snackbar-store';

interface Props {
  filePath: string;
  viewId: string;
  active: boolean;
}

/** Mounts one editor without owning, resetting, or disposing the document's working text. */
export function CodeViewer({ filePath, viewId, active }: Props) {
  const { t } = useTranslation();
  const document = useDocumentStore((s) => s.documents[filePath]);
  const view = useWorkspaceStore((s) => s.fileViews[viewId] ?? EMPTY_FILE_VIEW);
  const [editor, setEditor] = useState<Parameters<OnMount>[0] | null>(null);

  useEffect(() => {
    retainDocument(filePath, viewId);
    return () => releaseDocument(filePath, viewId);
  }, [filePath, viewId]);

  const mount: OnMount = useCallback(
    (instance) => {
      const saved = useWorkspaceStore.getState().fileViews[viewId]?.editor;
      if (saved) instance.restoreViewState(saved);
      setEditor(instance);
    },
    [viewId],
  );

  useEffect(() => {
    if (!editor) return;
    const saveView = () =>
      useWorkspaceStore.getState().saveEditor(viewId, editor.saveViewState());
    const cursor = editor.onDidChangeCursorPosition(saveView);
    const scroll = editor.onDidScrollChange(saveView);
    return () => {
      cursor.dispose();
      scroll.dispose();
    };
  }, [editor, viewId]);

  useEffect(() => {
    if (
      !active ||
      !editor ||
      !document?.model ||
      editor.getModel() !== document.model
    )
      return;
    editor.layout();
    const request = useWorkspaceStore.getState().fileViews[viewId]?.reveal;
    if (!request) return;
    const line = Math.max(
      1,
      Math.min(request.line, document.model.getLineCount()),
    );
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter(line);
    useWorkspaceStore.getState().consumeReveal(viewId, request.request);
    if (line !== request.line)
      showSnackbar(
        t('Line {{line}} is beyond the end of this file', {
          line: request.line,
        }),
        'warning',
      );
  }, [active, document?.model, editor, view.reveal, viewId, t]);

  useEffect(() => {
    if (!editor) return;
    const key = editor.onKeyDown((event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.browserEvent.key.toLowerCase() === 's'
      ) {
        event.preventDefault();
        void saveDocument(filePath);
      }
    });
    return () => key.dispose();
  }, [editor, filePath]);

  if (!document?.model)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground">
        {document?.error ? (
          <>
            <AlertTriangle />
            <p>{document.error}</p>
            <Button onClick={() => void reloadDocument(filePath)}>
              {t('Retry')}
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="animate-spin" />
            {t('Loading...')}
          </>
        )}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {document.error ??
            (document.conflict
              ? t('File changed on disk. Your unsaved changes are retained.')
              : document.dirty
                ? t('Unsaved changes')
                : t('Saved'))}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title={t('Refresh')}
          disabled={document.loading || document.saving}
          onClick={() => void reloadDocument(filePath)}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title={t('Save (Ctrl+S)')}
          disabled={document.saving || document.loading || !document.dirty}
          onClick={() => void saveDocument(filePath)}
        >
          <Save className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          path={document.model.uri.toString()}
          keepCurrentModel
          saveViewState={false}
          height="100%"
          theme="vs-dark"
          onMount={mount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            padding: { top: 8 },
          }}
        />
      </div>
    </div>
  );
}
