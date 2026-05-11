/**
 * Global snackbar/toast notification store.
 * Max 5 visible at once, rest queued. Auto-dismiss after 3s.
 */
import { create } from 'zustand';

export type SnackbarSeverity = 'info' | 'success' | 'warning' | 'error';

export interface SnackbarItem {
  id: string;
  message: string;
  severity: SnackbarSeverity;
  /** Auto-dismiss duration in ms. 0 = manual only. */
  duration: number;
}

const MAX_VISIBLE = 5;
let nextId = 0;

interface SnackbarState {
  /** Currently visible snackbars (max 5). */
  visible: SnackbarItem[];
  /** Queued snackbars waiting for a slot. */
  queue: SnackbarItem[];

  show: (message: string, severity?: SnackbarSeverity, duration?: number) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useSnackbarStore = create<SnackbarState>((set, get) => ({
  visible: [],
  queue: [],

  show: (message, severity = 'info', duration = 3000) => {
    const item: SnackbarItem = {
      id: `snack-${++nextId}`,
      message,
      severity,
      duration,
    };

    const { visible, queue } = get();
    if (visible.length < MAX_VISIBLE) {
      set({ visible: [...visible, item] });
    } else {
      set({ queue: [...queue, item] });
    }
  },

  dismiss: (id) => {
    const { visible, queue } = get();
    const nextVisible = visible.filter((s) => s.id !== id);

    // Promote from queue if there's space
    const promoted: SnackbarItem[] = [];
    const remainingQueue = [...queue];
    while (nextVisible.length + promoted.length < MAX_VISIBLE && remainingQueue.length > 0) {
      promoted.push(remainingQueue.shift()!);
    }

    set({
      visible: [...nextVisible, ...promoted],
      queue: remainingQueue,
    });
  },

  clear: () => set({ visible: [], queue: [] }),
}));

/**
 * Show a snackbar from anywhere (outside React components).
 * Import this function directly — no hooks needed.
 */
export function showSnackbar(
  message: string,
  severity: SnackbarSeverity = 'info',
  duration = 3000,
) {
  useSnackbarStore.getState().show(message, severity, duration);
}
