/**
 * Zustand store for shared web terminal metadata.
 *
 * xterm buffer contents intentionally stay outside Zustand to avoid large state
 * updates; only tab metadata and active selections are persisted in sessionStorage.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { getSocket } from '@/socket';
import { showSnackbar } from '@/stores/snackbar-store';
import i18n from '@/i18n';
import type {
  TerminalAck,
  TerminalConfig,
  TerminalContextState,
  TerminalDownloadPayload,
  TerminalMetadata,
} from '@/types/terminal';

const STORAGE_KEY = 'codex-webui.terminal-tabs.v1';
const DEFAULT_CONFIG: TerminalConfig = {
  maxSessions: 10,
  graceMs: 45_000,
  scrollback: 5_000,
  defaultCwd: null,
};

interface TerminalState {
  config: TerminalConfig;
  contexts: Record<string, TerminalContextState>;
  terminals: Record<string, TerminalMetadata>;
  configLoaded: boolean;

  fetchConfig: () => Promise<TerminalConfig>;
  refreshConfig: () => Promise<TerminalConfig>;
  ensureContext: (contextKey: string, cwd?: string, autoCreate?: boolean) => Promise<void>;
  listContext: (contextKey: string) => Promise<TerminalMetadata[]>;
  createTerminal: (contextKey: string, cwd?: string) => Promise<TerminalMetadata | null>;
  reconnectTerminal: (
    contextKey: string,
    terminalId: string,
  ) => Promise<{ terminal: TerminalMetadata; state: string } | null>;
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
    cols: number,
    rows: number,
  ) => void;
  downloadTerminal: (contextKey: string, terminalId: string) => Promise<void>;
  selectTerminal: (contextKey: string, terminalId: string | null) => void;
  upsertTerminal: (terminal: TerminalMetadata) => void;
  markTerminalClosed: (contextKey: string, terminalId: string) => void;
  markTerminalExpired: (terminalId: string, error?: string) => void;
}

function emptyContext(): TerminalContextState {
  return { terminalIds: [], activeTerminalId: null, hydrated: false };
}

/** Prevents concurrent ensureContext calls for the same context key. */
const ensureLocks = new Map<string, Promise<void>>();

function emitAck<T>(event: string, payload: Record<string, unknown>): Promise<TerminalAck<T>> {
  const socket = getSocket();
  return new Promise((resolve) => {
    socket
      .timeout(10_000)
      .emit(event, payload, (error: Error | null, response?: TerminalAck<T>) => {
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }
        resolve(response ?? { ok: false, error: 'Empty terminal response' });
      });
  });
}

function saveBlob(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      contexts: {},
      terminals: {},
      configLoaded: false,

      fetchConfig: async () => {
        if (get().configLoaded) return get().config;
        return get().refreshConfig();
      },

      refreshConfig: async () => {
        const response = await emitAck('terminal.config', {});
        if (response.ok && response.config) {
          set({ config: response.config, configLoaded: true });
          return response.config;
        }
        showSnackbar(response.error ?? i18n.t('Failed to load terminal config'), 'error');
        return get().config;
      },

      ensureContext: async (contextKey, cwd, autoCreate = true) => {
        // Prevent concurrent calls for the same context (React strict mode double-invoke)
        const pending = ensureLocks.get(contextKey);
        if (pending) {
          await pending;
          return;
        }

        const run = async () => {
          await get().fetchConfig();
          const previousIds = get().contexts[contextKey]?.terminalIds ?? [];
          const terminals = await get().listContext(contextKey);
          const currentIds = terminals.map((terminal) => terminal.id);

          for (const terminalId of previousIds) {
            if (!currentIds.includes(terminalId)) {
              get().markTerminalExpired(terminalId, i18n.t('Terminal no longer exists'));
            }
          }

          if (terminals.length === 0 && previousIds.length === 0 && autoCreate) {
            await get().createTerminal(contextKey, cwd);
          }
        };

        const promise = run().finally(() => ensureLocks.delete(contextKey));
        ensureLocks.set(contextKey, promise);
        await promise;
      },

      listContext: async (contextKey) => {
        const response = await emitAck('terminal.list', { contextKey });
        if (!response.ok) {
          showSnackbar(response.error ?? i18n.t('Failed to list terminals'), 'error');
          return [];
        }
        if (response.config) set({ config: response.config, configLoaded: true });
        const terminals = response.terminals ?? [];
        set((state) => {
          const nextTerminals = { ...state.terminals };
          for (const terminal of terminals) nextTerminals[terminal.id] = terminal;
          const existing = state.contexts[contextKey] ?? emptyContext();
          const terminalIds = terminals.map((terminal) => terminal.id);
          return {
            terminals: nextTerminals,
            contexts: {
              ...state.contexts,
              [contextKey]: {
                terminalIds,
                activeTerminalId:
                  existing.activeTerminalId && terminalIds.includes(existing.activeTerminalId)
                    ? existing.activeTerminalId
                    : terminalIds[0] ?? null,
                hydrated: true,
              },
            },
          };
        });
        return terminals;
      },

      createTerminal: async (contextKey, cwd) => {
        const response = await emitAck('terminal.open', { contextKey, cwd });
        if (!response.ok || !response.terminal) {
          showSnackbar(response.error ?? i18n.t('Failed to open terminal'), 'error');
          return null;
        }
        if (response.config) set({ config: response.config, configLoaded: true });
        get().upsertTerminal(response.terminal);
        get().selectTerminal(contextKey, response.terminal.id);
        return response.terminal;
      },

      reconnectTerminal: async (contextKey, terminalId) => {
        const response = await emitAck('terminal.reconnect', { contextKey, terminalId });
        if (!response.ok || !response.terminal) {
          get().markTerminalExpired(terminalId, response.error);
          return null;
        }
        if (response.config) set({ config: response.config, configLoaded: true });
        get().upsertTerminal(response.terminal);
        return { terminal: response.terminal, state: response.state ?? '' };
      },

      detachTerminal: (terminalId) => {
        getSocket().emit('terminal.detach', { terminalId });
      },

      closeTerminal: async (contextKey, terminalId) => {
        const response = await emitAck('terminal.close', { contextKey, terminalId });
        if (!response.ok) {
          showSnackbar(response.error ?? i18n.t('Failed to close terminal'), 'error');
          return false;
        }
        get().markTerminalClosed(contextKey, terminalId);
        return true;
      },

      renameTerminal: async (contextKey, terminalId, title) => {
        const response = await emitAck('terminal.rename', { contextKey, terminalId, title });
        if (!response.ok || !response.terminal) {
          showSnackbar(response.error ?? i18n.t('Failed to rename terminal'), 'error');
          return false;
        }
        get().upsertTerminal(response.terminal);
        return true;
      },

      resizeTerminal: (contextKey, terminalId, cols, rows) => {
        getSocket().emit('terminal.resize', { contextKey, terminalId, cols, rows });
      },

      downloadTerminal: async (contextKey, terminalId) => {
        const response = await emitAck<TerminalDownloadPayload>('terminal.download', {
          contextKey,
          terminalId,
        });
        if (!response.ok || !response.data) {
          showSnackbar(response.error ?? i18n.t('Download failed'), 'error');
          return;
        }
        saveBlob(response.data.content, response.data.filename);
      },

      selectTerminal: (contextKey, terminalId) => {
        set((state) => {
          const context = state.contexts[contextKey] ?? emptyContext();
          return {
            contexts: {
              ...state.contexts,
              [contextKey]: { ...context, activeTerminalId: terminalId },
            },
          };
        });
      },

      upsertTerminal: (terminal) => {
        set((state) => {
          const context = state.contexts[terminal.contextKey] ?? emptyContext();
          const terminalIds = context.terminalIds.includes(terminal.id)
            ? context.terminalIds
            : [...context.terminalIds, terminal.id];
          return {
            terminals: { ...state.terminals, [terminal.id]: terminal },
            contexts: {
              ...state.contexts,
              [terminal.contextKey]: {
                terminalIds,
                activeTerminalId: context.activeTerminalId ?? terminal.id,
                hydrated: true,
              },
            },
          };
        });
      },

      markTerminalClosed: (contextKey, terminalId) => {
        set((state) => {
          const context = state.contexts[contextKey] ?? emptyContext();
          const terminalIds = context.terminalIds.filter((id) => id !== terminalId);
          const terminals = Object.fromEntries(
            Object.entries(state.terminals).filter(([id]) => id !== terminalId),
          );
          return {
            terminals,
            contexts: {
              ...state.contexts,
              [contextKey]: {
                ...context,
                terminalIds,
                activeTerminalId:
                  context.activeTerminalId === terminalId
                    ? terminalIds[0] ?? null
                    : context.activeTerminalId,
              },
            },
          };
        });
      },

      markTerminalExpired: (terminalId, error) => {
        set((state) => {
          const terminal = state.terminals[terminalId];
          if (!terminal) return {};
          return {
            terminals: {
              ...state.terminals,
              [terminalId]: {
                ...terminal,
                status: 'expired',
                attachedCount: 0,
                error: error ?? i18n.t('Terminal expired'),
              },
            },
          };
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        contexts: state.contexts,
        terminals: state.terminals,
        config: state.config,
        configLoaded: state.configLoaded,
      }),
    },
  ),
);
