/**
 * File viewer shell — shows file path header and delegates content to the
 * appropriate viewer (Monaco for code/text, ImageViewer for images, etc.).
 */
import { useEffect } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { filesGetMetadataOptions } from '@/generated/api/@tanstack/react-query.gen';
import { useFilesStore } from '@/stores/files-store';
import { getFileCategory } from '@/lib/file-category';
import { FileContentViewer } from './viewers';

export function FileViewer() {
  const { t } = useTranslation();
  const selectedFile = useFilesStore((s) => s.selectedFile);
  const setFileMtime = useFilesStore((s) => s.setFileMtime);

  const { data: metadata, isLoading } = useQuery({
    ...filesGetMetadataOptions({ query: { path: selectedFile! } }),
    enabled: !!selectedFile,
    placeholderData: keepPreviousData,
  });

  // Track mtime for conflict detection (used by CodeViewer)
  useEffect(() => {
    if (metadata?.mtime != null) {
      setFileMtime(metadata.mtime);
    }
  }, [metadata?.mtime, setFileMtime]);

  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('Select a file to view')}
      </div>
    );
  }

  // Image files skip the loading state — they load inline via <img> tag
  const isImage = getFileCategory(selectedFile) === 'image';

  if (isLoading && !isImage) {
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
