/** Image viewer using the authenticated /api/files/serve endpoint. */
import { useState } from 'react';
import { ImageIcon, ZoomIn, ZoomOut, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { buildFileServeUrl } from '@/auth-token';

interface Props {
  filePath: string;
}

export function ImageViewer({ filePath }: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  // Reset state when switching to a different image (adjusting state during render)
  const [prevFilePath, setPrevFilePath] = useState(filePath);
  if (filePath !== prevFilePath) {
    setPrevFilePath(filePath);
    setError(false);
    setZoom(1);
    setRotation(0);
  }

  const src = buildFileServeUrl(filePath);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <ImageIcon className="h-8 w-8 opacity-40" />
        <span className="text-sm">{t('Failed to load image')}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={() => setZoom((z) => Math.max(0.1, z - 0.25))}
          title={t('Zoom out')}
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[3rem] text-center text-xs text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
          title={t('Zoom in')}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={() => setRotation((r) => (r + 90) % 360)}
          title={t('Rotate')}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-xs"
          onClick={() => {
            setZoom(1);
            setRotation(0);
          }}
        >
          {t('Reset')}
        </Button>
      </div>

      {/* Image area with checkerboard background for transparency */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
        <img
          src={src}
          alt={filePath.split('/').pop() ?? ''}
          onError={() => setError(true)}
          className="max-w-none object-contain transition-transform"
          style={{
            transform: `scale(${zoom}) rotate(${rotation}deg)`,
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}
