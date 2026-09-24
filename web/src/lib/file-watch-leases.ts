/** One disposable browser lease, re-established after Socket.IO reconnect. */
import i18n from '@/i18n';
import { getSocket } from '@/socket';
import { emitFileChange } from './file-change-events';
import { showSnackbar } from '@/stores/snackbar-store';
let nextLease = 0;

/**
 * Never buffers an acquire while offline: it may belong to an unmounted surface
 * by the time the socket reconnects. Every effect gets a fresh id, so Strict
 * Mode and overlapping pickers can release independently during path resolution.
 */
export function acquireFileWatch(path: string): () => void {
  const socket = getSocket();
  const leaseId = `surface:${++nextLease}`;
  let active = true;
  const acquire = () => {
    if (!socket.connected || !active) return;
    socket.emit(
      'fs.watch.acquire',
      { path, leaseId },
      (result: { ok: boolean; error?: string }) => {
        if (!active) return;
        if (!result.ok)
          showSnackbar(
            result.error ?? i18n.t('Filesystem watch unavailable'),
            'warning',
          );
        else
          emitFileChange({
            source: 'external',
            kind: 'invalidate',
            paths: [path],
          });
      },
    );
  };
  socket.on('connect', acquire);
  acquire();
  return () => {
    active = false;
    socket.off('connect', acquire);
    if (socket.connected) socket.emit('fs.watch.release', { leaseId });
  };
}
