/**
 * File content viewer dispatcher — routes to the appropriate viewer by file type.
 * Extensible: add new viewers for PDF, office, video, etc.
 */
import { getFileCategory } from '@/lib/file-category';
import { CodeViewer } from './code-viewer';
import { ImageViewer } from './image-viewer';

interface Props {
  filePath: string;
}

/**
 * Dispatches to the appropriate viewer component based on file extension.
 * Falls back to CodeViewer (Monaco) for unknown file types.
 */
export function FileContentViewer({ filePath }: Props) {
  const category = getFileCategory(filePath);

  switch (category) {
    case 'image':
      return <ImageViewer filePath={filePath} />;
    case 'code':
    default:
      return <CodeViewer filePath={filePath} />;
  }
}
