/** Shared terminal metadata and lifecycle operations; PTY buffers belong to the retained host. */
import { create } from 'zustand';
import { getSocket } from '@/socket';
import { showSnackbar } from '@/stores/snackbar-store';
import i18n from '@/i18n';
import { emitTerminalAck, saveTerminalOutput } from '@/lib/terminal-transport';
import { useTerminalViewStore } from './terminal-view-store';
import { useWorkspaceStore } from './workspace-store';
import type {
  TerminalAck,
  TerminalConfig,
  TerminalContextState,
  TerminalDownloadPayload,
  TerminalMetadata,
} from '@/types/terminal';

interface TerminalState {
  config: TerminalConfig;
  contexts: Record<string, TerminalContextState>;
  terminals: Record<string, TerminalMetadata>;
  closing: Record<string, boolean>;
  configLoaded: boolean;
  fetchConfig: () => Promise<TerminalConfig>;
  refreshConfig: () => Promise<TerminalConfig>;
  ensureContext: (contextKey: string) => Promise<void>;
  listContext: (contextKey: string) => Promise<TerminalMetadata[] | null>;
  createTerminal: (
    contextKey: string,
    cwd?: string,
  ) => Promise<TerminalMetadata | null>;
  reconnectTerminal: (
    contextKey: string,
    terminalId: string,
  ) => Promise<TerminalAck>;
  recoverTerminal: (
    contextKey: string,
    terminalId: string,
    manual: boolean,
  ) => Promise<TerminalAck>;
  detachTerminal: (terminalId: string) => void;
  closeTerminal: (contextKey: string, terminalId: string) => Promise<boolean>;
  renameTerminal: (
    contextKey: string,
    terminalId: string,
    title: string,
  ) => Promise<boolean>;
  resizeTerminal: (
    contextKey: string,
    terminalId: string,
    sessionId: string,
    cols: number,
    rows: number,
  ) => void;
  downloadTerminal: (contextKey: string, terminalId: string) => Promise<void>;
  selectTerminal: (contextKey: string, terminalId: string | null) => void;
  upsertTerminal: (terminal: TerminalMetadata) => void;
  markTerminalClosed: (contextKey: string, terminalId: string) => void;
  markTerminalExpired: (terminalId: string, error?: string) => void;
  recordFailure: (terminalId: string, response: TerminalAck) => void;
}

const emptyContext = (): TerminalContextState => ({
  terminalIds: [],
  activeTerminalId: null,
  hydrated: false,
});
const discovery = new Map<string, Promise<void>>();
const attachments = new Map<string, Promise<TerminalAck>>();
const contextEpoch = (context: string) =>
  useTerminalViewStore.getState().contextEpochs[context] ?? 0;
const lostCodes = new Set([
  'terminal.session_lost',
  'terminal.not_found',
  'terminal.recovery_limit',
]);

/** Deduplicates snapshot reads per socket connection, without turning attachment into creation. */
function attach(
  contextKey: string,
  terminalId: string,
  event: 'terminal.reconnect' | 'terminal.recover',
  manual = false,
): Promise<TerminalAck> {
  const store = useTerminalStore.getState();
  if (
    store.closing[terminalId] ||
    store.terminals[terminalId]?.status === 'closed'
  ) {
    return Promise.resolve({
      ok: false,
      errorCode:
        store.terminals[terminalId]?.status === 'closed'
          ? 'terminal.closed'
          : 'terminal.superseded',
      error: 'Terminal is closed or awaiting close confirmation',
    });
  }
  const epoch = contextEpoch(contextKey);
  const connectionId = getSocket().id;
  const key = JSON.stringify([
    connectionId,
    contextKey,
    terminalId,
    event,
    manual,
    epoch,
  ]);
  const existing = attachments.get(key);
  if (existing) return existing;
  const pending = emitTerminalAck(event, {
    contextKey,
    terminalId,
    ...(event === 'terminal.recover' ? { manual } : {}),
  })
    .then((response) => {
      const current = useTerminalStore.getState();
      if (getSocket().id !== connectionId)
        return {
          ok: false,
          errorCode: 'terminal.superseded',
          error: 'Terminal operation was superseded',
        };
      if (
        contextEpoch(contextKey) !== epoch ||
        current.closing[terminalId] ||
        current.terminals[terminalId]?.status === 'closed'
      ) {
        if (!useTerminalViewStore.getState().retained[terminalId])
          current.detachTerminal(terminalId);
        return {
          ok: false,
          errorCode: 'terminal.superseded',
          error: 'Terminal operation was superseded',
        };
      }
      if (response.ok && response.terminal) {
        if (
          (current.terminals[terminalId]?.generation ?? 0) >
          response.terminal.generation
        )
          return {
            ok: false,
            errorCode: 'terminal.superseded',
            error: 'Terminal operation was superseded',
          };
        current.upsertTerminal(response.terminal);
        return {
          ...response,
          terminal:
            useTerminalStore.getState().terminals[terminalId] ??
            response.terminal,
        };
      } else current.recordFailure(terminalId, response);
      return response;
    })
    .finally(() => attachments.delete(key));
  attachments.set(key, pending);
  return pending;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  config: {
    maxSessions: 10,
    graceMs: 45_000,
    scrollback: 5_000,
    defaultCwd: null,
  },
  contexts: {},
  terminals: {},
  closing: {},
  configLoaded: false,

  /** Reads runtime limits without interpreting configuration failure as terminal loss. */
  fetchConfig: async () =>
    get().configLoaded ? get().config : get().refreshConfig(),
  refreshConfig: async () => {
    const response = await emitTerminalAck('terminal.config', {});
    if (response.ok && response.config)
      set({ config: response.config, configLoaded: true });
    else
      showSnackbar(
        response.error ?? i18n.t('Failed to load terminal config'),
        'error',
      );
    return get().config;
  },

  /**
   * Discovers extant sessions and attaches before adopting. All calls in this path
   * are creation-free, including list/attach races. Context removal invalidates
   * late results; merely navigating away preserves the originating tab collection.
   */
  ensureContext: (contextKey) => {
    const epoch = contextEpoch(contextKey);
    const key = JSON.stringify([contextKey, getSocket().id, epoch]);
    const existing = discovery.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const terminals = await get().listContext(contextKey);
      if (!terminals || contextEpoch(contextKey) !== epoch) return;
      for (const terminal of terminals) {
        if (contextEpoch(contextKey) !== epoch) return;
        const response = await get().reconnectTerminal(contextKey, terminal.id);
        if (
          !response.ok ||
          !response.terminal ||
          contextEpoch(contextKey) !== epoch ||
          get().closing[terminal.id] ||
          get().terminals[terminal.id]?.status === 'closed'
        )
          continue;
        useTerminalViewStore.getState().retain(terminal.id, contextKey);
        if (contextKey.startsWith('thread:'))
          useWorkspaceStore.getState().adoptTerminal(contextKey, terminal.id);
      }
      if (contextEpoch(contextKey) !== epoch) return;
      set((state) => ({
        contexts: {
          ...state.contexts,
          [contextKey]: {
            ...(state.contexts[contextKey] ?? emptyContext()),
            hydrated: true,
          },
        },
      }));
    })().finally(() => discovery.delete(key));
    discovery.set(key, pending);
    return pending;
  },

  /** Lists metadata without overwriting local tabs from a potentially stale inventory snapshot. */
  listContext: async (contextKey) => {
    const response = await emitTerminalAck('terminal.list', { contextKey });
    if (!response.ok || !response.terminals) {
      showSnackbar(
        response.error ?? i18n.t('Failed to list terminals'),
        'error',
      );
      return null;
    }
    if (response.config) set({ config: response.config, configLoaded: true });
    return response.terminals;
  },

  /** A user New action requests an additional terminal after current discovery settles. */
  createTerminal: async (contextKey, cwd) => {
    const epoch = contextEpoch(contextKey);
    const pending = discovery.get(
      JSON.stringify([contextKey, getSocket().id, epoch]),
    );
    if (pending) await pending;
    if (contextEpoch(contextKey) !== epoch) return null;
    const response = await emitTerminalAck('terminal.open', {
      contextKey,
      cwd,
    });
    if (!response.ok || !response.terminal) {
      showSnackbar(
        response.error ?? i18n.t('Failed to open terminal'),
        'error',
      );
      return null;
    }
    if (contextEpoch(contextKey) !== epoch) {
      get().detachTerminal(response.terminal.id);
      return null;
    }
    if (response.config) set({ config: response.config, configLoaded: true });
    get().upsertTerminal(response.terminal);
    get().selectTerminal(contextKey, response.terminal.id);
    return response.terminal;
  },

  /** Pure reattachment is safe on mount, reconnect, hidden views and discovery. */
  reconnectTerminal: (context, id) => attach(context, id, 'terminal.reconnect'),

  /** Only the currently presented view can request replacement; server eligibility remains authoritative. */
  recoverTerminal: (context, id, manual) => {
    const target = useTerminalViewStore.getState().target;
    if (
      target?.terminalId !== id ||
      !target.element.isConnected ||
      document.visibilityState === 'hidden'
    ) {
      return Promise.resolve({
        ok: false,
        errorCode: 'terminal.not_presented',
        error: 'Select this terminal to recover it',
      });
    }
    return attach(context, id, 'terminal.recover', manual);
  },

  /** Detaches only on the current transport; old disconnected events must never detach a new connection. */
  detachTerminal: (terminalId) => {
    const socket = getSocket();
    if (socket.connected) socket.emit('terminal.detach', { terminalId });
  },

  /** Logical close always reaches the server, including exited and reclaimed sessions. */
  closeTerminal: async (contextKey, terminalId) => {
    set((state) => ({ closing: { ...state.closing, [terminalId]: true } }));
    const response = await emitTerminalAck('terminal.close', {
      contextKey,
      terminalId,
    });
    if (!response.ok) {
      const uncertain = [
        'terminal.transport_timeout',
        'terminal.disconnected',
      ].includes(response.errorCode ?? '');
      set((state) => ({
        closing: { ...state.closing, [terminalId]: uncertain },
      }));
      get().recordFailure(terminalId, response);
      showSnackbar(
        response.error ?? i18n.t('Failed to close terminal'),
        'error',
      );
      return false;
    }
    get().markTerminalClosed(contextKey, terminalId);
    useTerminalViewStore.getState().release(terminalId);
    set((state) => {
      const context = state.contexts[contextKey] ?? emptyContext();
      const terminalIds = context.terminalIds.filter((id) => id !== terminalId);
      return {
        contexts: {
          ...state.contexts,
          [contextKey]: {
            ...context,
            terminalIds,
            activeTerminalId:
              context.activeTerminalId === terminalId
                ? null
                : context.activeTerminalId,
          },
        },
      };
    });
    return true;
  },

  /** Saves a shared label only after backend acceptance. */
  renameTerminal: async (contextKey, terminalId, title) => {
    const response = await emitTerminalAck('terminal.rename', {
      contextKey,
      terminalId,
      title,
    });
    if (!response.ok || !response.terminal) {
      showSnackbar(
        response.error ?? i18n.t('Failed to rename terminal'),
        'error',
      );
      return false;
    }
    get().upsertTerminal(response.terminal);
    return true;
  },

  /** Physical identity prevents delayed geometry from resizing a replacement shell. */
  resizeTerminal: (contextKey, terminalId, sessionId, cols, rows) => {
    const socket = getSocket();
    if (socket.connected)
      socket.volatile.emit('terminal.resize', {
        contextKey,
        terminalId,
        sessionId,
        cols,
        rows,
      });
  },

  /** Downloads the current retained server buffer. */
  downloadTerminal: async (contextKey, terminalId) => {
    const response = await emitTerminalAck<TerminalDownloadPayload>(
      'terminal.download',
      { contextKey, terminalId },
    );
    if (!response.ok || !response.data) {
      showSnackbar(response.error ?? i18n.t('Download failed'), 'error');
      return;
    }
    saveTerminalOutput(response.data.content, response.data.filename);
  },

  selectTerminal: (contextKey, terminalId) =>
    set((state) => ({
      contexts: {
        ...state.contexts,
        [contextKey]: {
          ...(state.contexts[contextKey] ?? emptyContext()),
          activeTerminalId: terminalId,
        },
      },
    })),

  /** Monotonic incarnation updates never revive a closed identity or select an adopted tab. */
  upsertTerminal: (terminal) =>
    set((state) => {
      const previous = state.terminals[terminal.id];
      if (
        previous?.status === 'closed' ||
        state.closing[terminal.id] ||
        (previous && previous.generation > terminal.generation)
      )
        return state;
      const context = state.contexts[terminal.contextKey] ?? emptyContext();
      const observed =
        previous?.sessionId === terminal.sessionId &&
        previous.status === 'exited'
          ? {
              ...terminal,
              status: previous.status,
              exitCode: previous.exitCode,
              signal: previous.signal,
            }
          : terminal;
      return {
        terminals: { ...state.terminals, [terminal.id]: observed },
        contexts: {
          ...state.contexts,
          [terminal.contextKey]: {
            ...context,
            terminalIds: context.terminalIds.includes(terminal.id)
              ? context.terminalIds
              : [...context.terminalIds, terminal.id],
          },
        },
      };
    }),

  /** Remote closure retains output and the view, while permanently suppressing automatic recovery. */
  markTerminalClosed: (_context, id) =>
    set((state) => ({
      // Remember closure even if its event overtook the first metadata/list acknowledgement.
      closing: { ...state.closing, [id]: true },
      terminals: state.terminals[id]
        ? {
            ...state.terminals,
            [id]: {
              ...state.terminals[id],
              status: 'closed',
              attachedCount: 0,
              errorCode: 'terminal.closed',
              error: i18n.t('Terminal closed'),
            },
          }
        : state.terminals,
    })),

  markTerminalExpired: (id, error) =>
    get().recordFailure(id, {
      ok: false,
      errorCode: 'terminal.session_lost',
      error,
    }),

  /** Only authoritative lost/closed outcomes change lifecycle; transport failures preserve it. */
  recordFailure: (id, response) => {
    if (response.errorCode === 'terminal.closed') {
      get().markTerminalClosed('', id);
      return;
    }
    set((state) => {
      const terminal = state.terminals[id];
      if (!terminal || terminal.status === 'closed') return state;
      return {
        terminals: {
          ...state.terminals,
          [id]: {
            ...terminal,
            status: lostCodes.has(response.errorCode ?? '')
              ? 'expired'
              : terminal.status,
            error: response.error,
            errorCode: response.errorCode,
          },
        },
      };
    });
  },
}));
