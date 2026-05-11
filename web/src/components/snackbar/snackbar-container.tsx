/**
 * Global snackbar container — renders visible snackbar stack.
 * Mount once at App root level.
 */
import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Info, CheckCircle, AlertTriangle, AlertCircle } from 'lucide-react';
import {
  useSnackbarStore,
  type SnackbarItem,
  type SnackbarSeverity,
} from '@/stores/snackbar-store';
import { cn } from '@/lib/utils';

const severityConfig: Record<
  SnackbarSeverity,
  { icon: typeof Info; bg: string; border: string; text: string }
> = {
  info: {
    icon: Info,
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/30',
    text: 'text-blue-400',
  },
  success: {
    icon: CheckCircle,
    bg: 'bg-green-500/10',
    border: 'border-green-500/30',
    text: 'text-green-400',
  },
  warning: {
    icon: AlertTriangle,
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500/30',
    text: 'text-yellow-400',
  },
  error: {
    icon: AlertCircle,
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
    text: 'text-red-400',
  },
};

function SnackbarToast({ item }: { item: SnackbarItem }) {
  const dismiss = useSnackbarStore((s) => s.dismiss);

  useEffect(() => {
    if (item.duration <= 0) return;
    const timer = setTimeout(() => dismiss(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, dismiss]);

  const config = severityConfig[item.severity];
  const Icon = config.icon;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 80, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className={cn(
        'pointer-events-auto flex w-80 items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg backdrop-blur-sm',
        config.bg,
        config.border,
      )}
      role="alert"
      aria-live="polite"
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', config.text)} />
      <p className="min-w-0 flex-1 text-sm text-foreground">{item.message}</p>
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}

export function SnackbarContainer() {
  const visible = useSnackbarStore((s) => s.visible);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2">
      <AnimatePresence mode="popLayout">
        {visible.map((item) => (
          <SnackbarToast key={item.id} item={item} />
        ))}
      </AnimatePresence>
    </div>
  );
}
