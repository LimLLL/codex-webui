/** Local terminal attachments outlive the route or tab currently presenting them. */
import { create } from 'zustand';

interface TerminalViewState {
  retained: Record<string, string>;
  target: { terminalId: string; element: HTMLElement } | null;
  retain: (terminalId: string, contextKey: string) => void;
  release: (terminalId: string) => void;
  releaseContext: (contextKey: string) => void;
  present: (
    terminalId: string,
    contextKey: string,
    element: HTMLElement,
  ) => void;
  withdraw: (element: HTMLElement) => void;
}

/** UI removal releases attachment ownership; it never sends terminal.close. */
export const useTerminalViewStore = create<TerminalViewState>((set) => ({
  retained: {},
  target: null,
  retain: (terminalId, contextKey) =>
    set((s) => ({ retained: { ...s.retained, [terminalId]: contextKey } })),
  release: (terminalId) =>
    set((s) => ({
      retained: Object.fromEntries(
        Object.entries(s.retained).filter(([id]) => id !== terminalId),
      ),
      target: s.target?.terminalId === terminalId ? null : s.target,
    })),
  releaseContext: (contextKey) =>
    set((s) => ({
      retained: Object.fromEntries(
        Object.entries(s.retained).filter(
          ([, context]) => context !== contextKey,
        ),
      ),
      target:
        s.target && s.retained[s.target.terminalId] === contextKey
          ? null
          : s.target,
    })),
  present: (terminalId, contextKey, element) =>
    set((s) => ({
      retained: { ...s.retained, [terminalId]: contextKey },
      target: { terminalId, element },
    })),
  withdraw: (element) =>
    set((s) => (s.target?.element === element ? { target: null } : s)),
}));
