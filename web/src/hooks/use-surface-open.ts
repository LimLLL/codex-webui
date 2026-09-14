/** Closes controlled and uncontrolled portalled UI when its owning workspace surface becomes inactive. */
import { useCallback, useContext, useEffect, useState } from 'react';
import { SurfaceActivityContext } from '@/lib/surface-activity';

interface OpenProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Preserves the primitive's controlled/uncontrolled behavior while withdrawing hidden dialogs. */
export function useSurfaceOpen({
  open,
  defaultOpen = false,
  onOpenChange,
}: OpenProps) {
  const active = useContext(SurfaceActivityContext);
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  if (!active && localOpen) setLocalOpen(false);
  const requested = open ?? localOpen;
  const change = useCallback(
    (next: boolean) => {
      setLocalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  useEffect(() => {
    if (!active && open) onOpenChange?.(false);
  }, [active, open, onOpenChange]);
  return { open: active && requested, onOpenChange: change };
}
