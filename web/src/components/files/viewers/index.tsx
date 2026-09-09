/**
 * File content viewer dispatcher — routes to the appropriate viewer by file type.
 * Office files can be delegated to OnlyOffice when configured.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { settingsListSettings } from '@/generated/api/sdk.gen';
import { getFileCategory } from '@/lib/file-category';
import { useFilesStore } from '@/stores/files-store';
import { showSnackbar } from '@/stores/snackbar-store';
import { ArchiveViewer } from './archive-viewer';
import { AudioViewer } from './audio-viewer';
import { BinaryViewer } from './binary-viewer';
import { CodeViewer } from './code-viewer';
import { DocxViewer } from './docx-viewer';
import { FontViewer } from './font-viewer';
import { ImageViewer } from './image-viewer';
import { OnlyOfficeViewer } from './onlyoffice-viewer';
import { PdfViewer } from './pdf-viewer';
import { filePreviewSource, type PreviewSource } from './preview-source';
import { ReadOnlyCodeViewer } from './read-only-code-viewer';
import { VideoViewer } from './video-viewer';
import { XlsxViewer } from './xlsx-viewer';

interface Props {
  filePath: string;
  source?: PreviewSource;
}

/** Dispatches to the appropriate viewer component based on file extension. */
export function FileContentViewer({ filePath, source }: Props) {
  const { t } = useTranslation();
  const previewSource = source ?? filePreviewSource(filePath);
  const category = getFileCategory(filePath);
  const onlyOfficeUrl = useOnlyOfficeUrl();
  const canUseOnlyOffice = previewSource.kind === 'file' && !!onlyOfficeUrl;

  // Line navigation is the text editor's alone. Deciding that here, where the
  // viewer is chosen, keeps a competing file-type table out of the markdown
  // parser — and a line meant for a PDF must not drift into a page number.
  const honoursLine = category === 'code' && previewSource.kind === 'file';
  const pendingLine = useFilesStore((s) => s.pendingLine);
  const clearPendingLine = useFilesStore((s) => s.clearPendingLine);
  useEffect(() => {
    if (pendingLine === null || honoursLine) return;
    // Consumed rather than left standing, so it cannot latch onto whichever
    // text file the user opens next.
    clearPendingLine();
    showSnackbar(t('Line navigation is not available for this file type'), 'info');
  }, [pendingLine, honoursLine, clearPendingLine, t]);

  if ((category === 'docx' || category === 'xlsx' || category === 'pptx') && canUseOnlyOffice) {
    return <OnlyOfficeViewer filePath={filePath} />;
  }

  switch (category) {
    case 'image':
      return <ImageViewer filePath={filePath} source={previewSource} />;
    case 'pdf':
      return <PdfViewer source={previewSource} />;
    case 'video':
      return <VideoViewer source={previewSource} />;
    case 'audio':
      return <AudioViewer source={previewSource} />;
    case 'font':
      return <FontViewer source={previewSource} />;
    case 'archive':
      return previewSource.kind === 'file' ? (
        <ArchiveViewer filePath={filePath} />
      ) : (
        <UnsupportedViewer message={t('Nested archive previews are not supported')} />
      );
    case 'docx':
      return <DocxViewer source={previewSource} />;
    case 'xlsx':
      return <XlsxViewer source={previewSource} />;
    case 'pptx':
      return <UnsupportedViewer message={t('Configure OnlyOffice to preview presentations')} />;
    case 'binary':
      return <BinaryViewer source={previewSource} />;
    case 'code':
    default:
      return previewSource.kind === 'file' ? (
        <CodeViewer filePath={filePath} />
      ) : (
        <ReadOnlyCodeViewer source={previewSource} />
      );
  }
}

/** Reads the OnlyOffice URL setting; empty means native viewers remain active. */
function useOnlyOfficeUrl(): string | null {
  const query = useQuery({
    queryKey: ['settings', 'general', 'onlyofficeUrl'],
    queryFn: async () => {
      const { data } = await settingsListSettings({
        query: { category: 'general' },
        throwOnError: true,
      });
      return data.settings;
    },
    staleTime: 30_000,
  });
  const setting = query.data?.find((item) => item.key === 'general.onlyofficeUrl');
  return typeof setting?.value === 'string' && setting.value.trim()
    ? setting.value.trim()
    : null;
}

function UnsupportedViewer({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}
