/** Owns the disposition of every server request for exactly one RPC connection. */
import { randomUUID } from 'node:crypto';
import type { RequestId, ServerRequest } from './codex-schema';

/** Open wire envelope: generated unions cannot enumerate every runtime method. */
export interface IncomingServerRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

/** Terminal request evidence; a refusal does not assert that its turn failed. */
export interface ServerRequestRetirement {
  instanceId: string;
  request: IncomingServerRequest;
  status: 'resolved' | 'expired' | 'failed';
  message?: string;
}

/** The only authority allowed to respond to an admitted request. */
export interface OwnedServerRequest {
  readonly instanceId: string;
  readonly request: IncomingServerRequest;
  isPending(): boolean;
  respond(result: unknown): void;
  retire(): void;
}

/** Synchronous admission must persist and retain the request before returning. */
export type ServerRequestHandler = (request: OwnedServerRequest) => boolean;

/** Admission failure whose public error never includes private request contents. */
export class InvalidServerRequest extends Error {
  constructor() {
    super('This WebUI cannot handle the invalid server-request payload.');
  }
}

/**
 * Every exported method must choose a disposition. Unknown runtime methods use
 * the fallback below; they never enter the browser stream by accident.
 */
const DISPOSITIONS = {
  'item/commandExecution/requestApproval': 'human',
  'item/fileChange/requestApproval': 'human',
  'item/tool/requestUserInput': 'human',
  'item/permissions/requestApproval': 'human',
  'mcpServer/elicitation/request': 'human',
  'item/tool/call':
    'Client-registered tool execution is not available in this WebUI.',
  'account/chatgptAuthTokens/refresh':
    'This WebUI cannot refresh externally supplied ChatGPT tokens. Sign in again in Settings.',
  'attestation/generate':
    'Attestation generation is not available in this WebUI.',
  applyPatchApproval:
    'Legacy patch approval requests are not available in this WebUI.',
  execCommandApproval:
    'Legacy command approval requests are not available in this WebUI.',
} satisfies Record<ServerRequest['method'], string>;

/** Identifies implemented browser workflows, including their negative-only states. */
export function isBrowserRequestMethod(method: string): boolean {
  return (
    Object.hasOwn(DISPOSITIONS, method) &&
    DISPOSITIONS[method as keyof typeof DISPOSITIONS] === 'human'
  );
}

/**
 * Connection-local ownership, independent of EventEmitter observers and browser
 * presence. Completed IDs retain only a small tombstone so duplicate delivery
 * cannot mint a new proposal; request payloads are released on retirement.
 */
export class ServerRequestOwner {
  private readonly seen = new Set<RequestId>();
  private readonly active = new Map<
    RequestId,
    {
      owned: OwnedServerRequest;
      submitted: boolean;
    }
  >();
  private handler: ServerRequestHandler | null = null;
  private closed = false;

  constructor(
    private readonly send: (message: unknown) => void,
    private readonly retired: (event: ServerRequestRetirement) => void,
    private readonly reportError: (message: string) => void,
  ) {}

  /** Installs the single accountable admission handler before initialization. */
  setHandler(handler: ServerRequestHandler): void {
    if (this.handler && this.handler !== handler)
      throw new Error('A server-request owner is already installed');
    this.handler = handler;
  }

  /**
   * Admits a new wire request or replies with an explicit error. The return
   * value is only for observation after ownership has already been established.
   */
  receive(request: IncomingServerRequest): boolean {
    if (this.closed || this.seen.has(request.id)) return false;
    this.seen.add(request.id);
    const immutable = structuredClone(request);
    const instanceId = randomUUID();
    const entry: { submitted: boolean; owned: OwnedServerRequest } = {
      submitted: false,
      owned: {
        instanceId,
        request: immutable,
        isPending: () =>
          !this.closed &&
          this.active.get(request.id) === entry &&
          !entry.submitted,
        respond: (result: unknown) => {
          if (!entry.owned.isPending())
            throw new Error('Server request is no longer pending');
          // Consume authority before attempting I/O. An ambiguous write must
          // never make the request answerable a second time.
          entry.submitted = true;
          try {
            this.send({ id: request.id, result });
          } catch {
            this.finish(
              request.id,
              'failed',
              'The decision was committed but delivery could not be confirmed.',
            );
            throw new Error('Decision delivery could not be confirmed');
          }
        },
        retire: () => this.finish(request.id, 'expired'),
      } satisfies OwnedServerRequest,
    };
    this.active.set(request.id, entry);
    const known = Object.hasOwn(DISPOSITIONS, request.method);
    const disposition = known
      ? DISPOSITIONS[request.method as keyof typeof DISPOSITIONS]
      : null;
    if (disposition !== 'human') {
      this.refuse(
        request.id,
        known ? -32000 : -32601,
        disposition ??
          `This WebUI cannot handle server request ${request.method}.`,
      );
      return false;
    }
    try {
      if (this.handler?.(entry.owned) === true) return true;
      this.refuse(
        request.id,
        -32000,
        'This WebUI cannot present this server request.',
      );
    } catch (error) {
      // Do not log exception text: admission may be inspecting private input.
      this.reportError(`Server request admission failed: ${request.method}`);
      if (entry.owned.isPending())
        this.refuse(
          request.id,
          error instanceof InvalidServerRequest ? -32602 : -32603,
          error instanceof InvalidServerRequest
            ? error.message
            : 'This WebUI could not admit the server request.',
        );
    }
    return false;
  }

  /** Retires only evidence observed on this connection, before UI notification. */
  observe(method: string, params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const value = params as Record<string, unknown>;
    if (
      method === 'serverRequest/resolved' &&
      (typeof value.requestId === 'string' ||
        typeof value.requestId === 'number')
    )
      this.finish(value.requestId, 'resolved');
    if (
      method !== 'turn/completed' &&
      method !== 'thread/closed' &&
      method !== 'thread/deleted'
    )
      return;
    const turn = value.turn as { id?: unknown } | undefined;
    for (const [id, { owned }] of this.active) {
      const held = owned.request.params as Record<string, unknown> | undefined;
      if (
        held?.threadId === value.threadId &&
        (method !== 'turn/completed' ||
          (typeof turn?.id === 'string' && held?.turnId === turn.id))
      )
        this.finish(id, 'resolved');
    }
  }

  /** Invalidates all response authority when this connection is destroyed. */
  close(): void {
    this.closed = true;
    for (const id of this.active.keys()) this.finish(id, 'expired');
    this.seen.clear();
  }

  /** Refuses once, regardless of whether persistence or observers are available. */
  private refuse(id: RequestId, code: number, message: string): void {
    const entry = this.active.get(id);
    if (!entry?.owned.isPending()) return;
    entry.submitted = true;
    try {
      this.send({ id, error: { code, message } });
    } catch {
      this.reportError('Could not deliver the server-request refusal');
    }
    this.finish(id, 'failed', message);
  }

  /** Releases ownership before notifying fallible observers of terminal evidence. */
  private finish(
    id: RequestId,
    status: ServerRequestRetirement['status'],
    message?: string,
  ): void {
    const entry = this.active.get(id);
    if (!entry) return;
    this.active.delete(id);
    try {
      this.retired({
        instanceId: entry.owned.instanceId,
        request: entry.owned.request,
        status,
        message,
      });
    } catch {
      this.reportError('Server-request retirement observer failed');
    }
  }
}
