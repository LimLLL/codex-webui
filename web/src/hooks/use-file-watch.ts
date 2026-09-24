/** Acquires a visible directory lease and releases it on collapse or navigation. */
import { useEffect } from 'react';
import { acquireFileWatch } from '@/lib/file-watch-leases';

export function useFileWatch(path: string | null, enabled = true): void {
  useEffect(() => enabled && path ? acquireFileWatch(path) : undefined, [enabled, path]);
}
