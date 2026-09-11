/** Real ingress ownership around a mocked child transport for backend integration tests. */
import { EventEmitter } from 'node:events';
import type {
  CodexProcessManager,
  CodexLifecycleEvent,
} from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema';
import {
  ServerRequestOwner,
  type IncomingServerRequest,
  type OwnedServerRequest,
  type ServerRequestHandler,
} from '../codex/server-request-owner';

/** Supplies real admission, retirement, and connection replacement without a model process. */
export function createRequestManager() {
  const events = new EventEmitter();
  const wire = vi.fn<(message: unknown) => void>();
  const errors = vi.fn();
  const admissions = new Map<string | number, OwnedServerRequest>();
  let generation = 1;
  let handler: ServerRequestHandler | null = null;
  const newOwner = () =>
    new ServerRequestOwner(
      wire,
      (event) => events.emit('serverRequestRetired', event),
      errors,
    );
  let owner = newOwner();
  const install = () => {
    if (handler)
      owner.setHandler((owned) => {
        admissions.set(owned.request.id, owned);
        return handler!(owned);
      });
  };
  const manager = {
    getGeneration: () => generation,
    setServerRequestHandler: (next: ServerRequestHandler) => {
      handler = next;
      install();
    },
    addListener: (name: string, listener: (...args: unknown[]) => void) => {
      events.on(name, listener);
    },
    addLifecycleListener: (listener: (event: CodexLifecycleEvent) => void) => {
      events.on('lifecycle', listener);
      return () => events.off('lifecycle', listener);
    },
  } as unknown as CodexProcessManager;
  return {
    manager,
    wire,
    errors,
    /** Drives the exact ingress path used by the real JSON-RPC client. */
    receive: (request: IncomingServerRequest) => {
      owner.receive(request);
      return admissions.get(request.id);
    },
    /** Delivers lifecycle evidence before observers, matching the transport. */
    notify: (notification: ServerNotification) => {
      owner.observe(notification.method, notification.params);
      events.emit('notification', notification);
    },
    /** The fresh owner can reuse wire IDs, including across backend-counter resets. */
    restart: (nextGeneration = generation + 1) => {
      owner.close();
      events.emit('lifecycle', {
        type: 'appServerUnavailable',
        generation,
        message: 'test restart',
      });
      generation = nextGeneration;
      owner = newOwner();
      admissions.clear();
      install();
    },
    close: () => owner.close(),
  };
}
