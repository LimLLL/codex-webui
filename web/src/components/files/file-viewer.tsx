/**
 * File viewer shell — shows file path header and delegates content to the
 * appropriate viewer (Monaco for code/text, ImageViewer for images, etc.).
 */
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { filesGetMetadataOptions } from '@/generated/api/@tanstack/react-query.gen';
import { useFilesStore } from '@/stores/files-store';
import { getFileCategory, isInlineLoadingCategory } from '@/lib/file-category';
import { FileContentViewer } from './viewers';

export function FileViewer() {
  const { t } = useTranslation();
  const selectedFile = useFilesStore((s) => s.selectedFile);

  // Metadata drives the header and the viewer's loading state only. The write
  // precondition deliberately does not come from here: this query refreshes on
  // its own schedule, independently of the content query, so a modification
  // time taken from it can end up describing a revision the editor never held.
  // `filesReadFile` returns the time paired with the body it read.
  const { isLoading } = useQuery({
    ...filesGetMetadataOptions({ query: { path: selectedFile! } }),
    enabled: !!selectedFile,
  });

  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('Select a file to view')}
      </div>
    );
  }

  // Inline viewers (media, PDF, image, office previews) own their loading state.
  const loadsInline = isInlineLoadingCategory(getFileCategory(selectedFile));

  if (isLoading && !loadsInline) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('Loading...')}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* File path header */}
      <div className="flex shrink-0 items-center border-b border-border px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground">
          {selectedFile}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <FileContentViewer filePath={selectedFile} />
      </div>
    </div>
  );
}
