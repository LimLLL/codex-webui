/** Dialog for selecting a workspace directory to create a new thread. */
import { useCallback, useState } from 'react';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  filesGetRootsOptions,
  filesReadTreeOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (cwd: string) => void;
}

export function DirectoryPickerDialog({ open, onClose, onSelect }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      {open && <DirectoryPickerContent onClose={onClose} onSelect={onSelect} />}
    </Dialog>
  );
}

function DirectoryPickerContent({ onClose, onSelect }: Omit<Props, 'open'>) {
  const { t } = useTranslation();
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const rootsQuery = useQuery(filesGetRootsOptions());
  const rootDirs = rootsQuery.data
    ? Array.from(new Set([rootsQuery.data.homeDir, ...rootsQuery.data.roots]))
        .filter((d): d is string => Boolean(d))
    : [];

  const toggleDir = useCallback((dir: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  const handleConfirm = () => {
    if (selectedDir) {
      onSelect(selectedDir);
      onClose();
    }
  };

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{t('Select workspace directory')}</DialogTitle>
      </DialogHeader>

      <ScrollArea className="h-72 rounded-md border">
        <div className="py-1">
          {rootsQuery.isLoading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('Loading...')}
            </div>
          ) : rootsQuery.isError || rootDirs.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {t('Cannot load directories')}
            </div>
          ) : (
            rootDirs.map((root) => (
              <DirNode
                key={root}
                path={root}
                name={root.split('/').pop() || root}
                depth={0}
                selectedDir={selectedDir}
                expandedDirs={expandedDirs}
                onSelect={setSelectedDir}
                onToggle={toggleDir}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button size="sm" disabled={!selectedDir} onClick={handleConfirm}>
          {t('Confirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

interface DirNodeProps {
  path: string;
  name: string;
  depth: number;
  selectedDir: string | null;
  expandedDirs: Set<string>;
  onSelect: (dir: string) => void;
  onToggle: (dir: string) => void;
}

function DirNode({
  path,
  name,
  depth,
  selectedDir,
  expandedDirs,
  onSelect,
  onToggle,
}: DirNodeProps) {
  const isExpanded = expandedDirs.has(path);
  const isSelected = selectedDir === path;

  return (
    <div>
      <div
        className={cn(
          'flex cursor-pointer items-center gap-1 py-1 text-xs transition-colors hover:bg-accent/50',
          isSelected && 'bg-primary/10 text-primary',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(path)}
        onDoubleClick={() => onToggle(path)}
      >
        <button
          type="button"
          className="shrink-0 p-0.5"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(path);
          }}
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 transition-transform',
              isExpanded && 'rotate-90',
            )}
          />
        </button>
        {isExpanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-400" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
        )}
        <span className="min-w-0 truncate">{name}</span>
      </div>
      {isExpanded && (
        <DirChildren
          parentPath={path}
          depth={depth + 1}
          selectedDir={selectedDir}
          expandedDirs={expandedDirs}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      )}
    </div>
  );
}

interface DirChildrenProps {
  parentPath: string;
  depth: number;
  selectedDir: string | null;
  expandedDirs: Set<string>;
  onSelect: (dir: string) => void;
  onToggle: (dir: string) => void;
}

function DirChildren({
  parentPath,
  depth,
  selectedDir,
  expandedDirs,
  onSelect,
  onToggle,
}: DirChildrenProps) {
  const { t } = useTranslation();
  const { data: entries, isLoading, isError } = useQuery({
    ...filesReadTreeOptions({ query: { root: parentPath } }),
  });

  if (isLoading) {
    return (
      <div
        className="flex items-center gap-1 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('Loading...')}
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {t('Cannot load directories')}
      </div>
    );
  }

  const dirs = (entries ?? []).filter((e) => e.type === 'directory');

  if (dirs.length === 0) {
    return (
      <div
        className="py-1 text-xs text-muted-foreground italic"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {t('No subdirectories')}
      </div>
    );
  }

  return (
    <>
      {dirs.map((dir) => (
        <DirNode
          key={dir.path}
          path={dir.path}
          name={dir.name}
          depth={depth}
          selectedDir={selectedDir}
          expandedDirs={expandedDirs}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}
