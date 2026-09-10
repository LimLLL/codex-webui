/**
 * Raw JSON editing for the catalog draft, peer to the raw config.toml editor.
 *
 * This is the dangerous surface: a malformed catalog stops the app-server from
 * starting at all, which is why validation runs the pinned Codex binary rather
 * than a client-side schema. It stays collapsed by default and edits the same
 * document the form does.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Editor from '@monaco-editor/react';
import { AlertTriangle, ChevronDown, ChevronRight, FileJson } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useThemeStore } from '@/stores/theme-store';

interface Props {
  content: string | null;
  onChange: (content: string) => void;
  onValidate: () => void;
  validating: boolean;
}

export function CatalogRawEditor({
  content,
  onChange,
  onValidate,
  validating,
}: Props) {
  const { t } = useTranslation();
  const dark = useThemeStore((s) => s.dark);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        <FileJson className="h-4 w-4" />
        {t('Edit catalog JSON')}
      </button>

      {expanded && (
        <div className="space-y-2">
          <p className="flex items-start gap-1.5 text-xs text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t(
              'A catalog Codex cannot parse stops it from starting. Validate before applying.',
            )}
          </p>
          <div className="overflow-hidden rounded-md border border-border">
            <Editor
              value={content ?? ''}
              language="json"
              theme={dark ? 'vs-dark' : 'vs'}
              height="400px"
              onChange={(value) => onChange(value ?? '')}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                padding: { top: 8 },
              }}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={content === null || validating}
            onClick={onValidate}
          >
            {t('Validate with Codex')}
          </Button>
        </div>
      )}
    </div>
  );
}
