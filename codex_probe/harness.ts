/**
 * Typed JSON-RPC harness for driving `codex app-server` directly.
 *
 * Probes exist because the vendored protocol README describes intent, not
 * behaviour. Several conclusions this project relies on — that persistence
 * happens at item completion rather than turn completion, that a mid-conversation
 * policy change is consumed by the next real turn, that `reloadUserConfig` does
 * not reach an already-loaded thread — contradicted what both the docs and
 * careful reasoning predicted. They are only knowable by asking the binary.
 *
 * Request params are typed from the generated `ClientRequest` union, so a
 * malformed call fails at compile time rather than as an opaque
 * `-32600 invalid type: map, expected a sequence` after the process is already
 * running. Regenerate the schema (`pnpm codex:schema`) after a CLI bump and the
 * probes break where the protocol actually moved.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type {
  ClientRequest,
  ServerNotification,
  ServerRequest,
} from '../src/codex/codex-schema';

/** Every method the pinned app-server accepts as a client request. */
export type RpcMethod = ClientRequest['method'];

/** Params the pinned schema defines for one method. */
export type RpcParams<M extends RpcMethod> = Extract<
  ClientRequest,
  { method: M }
>['params'];

/** `Omit` that maps over a union instead of collapsing it to its shared keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * One method paired with that method's params, as a discriminated union.
 *
 * The pairing has to live in the TYPE rather than rely on inference. An earlier
 * signature took the method and params as two arguments and inferred the method
 * from the first — which TypeScript silently abandons the moment a caller names
 * any type argument, because it has no partial type-argument inference. Every
 * probe named the result type, so every probe fell back to the default `M` (the
 * whole method union), `RpcParams<M>` widened to the union of all params, and a
 * `turn/start` call carrying `thread/start` params compiled without a word.
 * Correlating the two fields here restores the check regardless of what the
 * caller does with the result type.
 */
export type RpcCall = DistributiveOmit<ClientRequest, 'id'>;

/** One JSON-RPC reply. Errors are returned, not thrown: a refusal is data. */
export interface RpcReply<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** Method names the pinned schema exports, for reference at call sites. */
export type KnownNotification = ServerNotification['method'];
export type KnownServerRequest = ServerRequest['method'];

/**
 * A server-initiated notification, kept verbatim for later inspection.
 *
 * `method` is a plain string rather than {@link KnownNotification}: a method
 * the exported schema does not list is precisely what a probe is looking for,
 * and narrowing here would hide it. (It would not even narrow — a union of a
 * literal type with `string` collapses to `string`.)
 */
export interface Note {
  method: string;
  params: Record<string, unknown>;
}

/** A server-initiated request, which the client must answer. */
export interface IncomingRequest {
  id: number | string;
  /** Plain string for the same reason as {@link Note.method}. */
  method: string;
  params: Record<string, unknown>;
}

/** Outcome of one turn driven to completion. */
export interface TurnRun {
  turnId?: string;
  /** Notifications emitted from `turn/start` until this turn completed. */
  events: Note[];
  /** Server requests received while it ran, in arrival order. */
  requests: IncomingRequest[];
  /** True when the turn completed rather than running out of time. */
  completed: boolean;
  /** Set when `turn/start` itself was refused. */
  error?: RpcReply<unknown>['error'];
}

export interface AppServerOptions {
  /** Path to the codex binary. Defaults to the repo's pinned dependency. */
  bin?: string;
  /** CODEX_HOME for this run. */
  home: string;
  /** How to answer server-initiated requests. Defaults to accepting approvals. */
  onServerRequest?: (request: IncomingRequest) => unknown;
  /** Extra environment for the child. */
  env?: Record<string, string>;
}

/** Answers approvals with `accept`, everything else with an empty result. */
function defaultServerResponse(request: IncomingRequest): unknown {
  return request.method.endsWith('requestApproval')
    ? { decision: 'accept' }
    : {};
}

export class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    (reply: RpcReply<unknown>) => void
  >();
  private stderrBuffer = '';

  /** Every notification received, oldest first. */
  readonly notes: Note[] = [];
  /** Every server-initiated request received, oldest first. */
  readonly requests: IncomingRequest[] = [];

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly respond: (request: IncomingRequest) => unknown,
  ) {
    this.child = child;
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString();
    });
    readline
      .createInterface({ input: this.child.stdout })
      .on('line', (line) => {
        this.handleLine(line);
      });
  }

  /**
   * Spawns an app-server and completes the initialize handshake.
   *
   * @param options - Binary, home directory and server-request policy
   * @returns A connected app-server ready for requests
   */
  static async start(options: AppServerOptions): Promise<AppServer> {
    const bin = options.bin ?? 'codex';
    const child = spawn(bin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env, CODEX_HOME: options.home },
    });
    const app = new AppServer(
      child,
      options.onServerRequest ?? defaultServerResponse,
    );
    await app.request({
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'codex-webui-probe',
          title: 'codex-webui probe',
          version: '0.0.0',
        },
        // `requestAttestation` is required since 0.149.0; probes cannot attest.
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
    app.notify('initialized');
    return app;
  }

  /** Routes one stdout line: reply, server request, or notification. */
  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // app-server writes only JSONL on stdout; anything else is not ours.
      return;
    }
    const id = message.id as number | string | undefined;
    const method = message.method as string | undefined;

    // A message carrying BOTH id and method is a server-initiated request and
    // must be answered, or the turn that raised it blocks forever.
    if (id !== undefined && method) {
      const request: IncomingRequest = {
        id,
        method,
        params: (message.params ?? {}) as Record<string, unknown>,
      };
      this.requests.push(request);
      this.send({ id, result: this.respond(request) });
      return;
    }
    if (typeof id === 'number' && this.pending.has(id)) {
      this.pending.get(id)!(message);
      this.pending.delete(id);
      return;
    }
    if (method) {
      this.notes.push({
        method,
        params: (message.params ?? {}) as Record<string, unknown>,
      });
    }
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * Issues one request and waits for its reply.
   *
   * `Result` is an assertion, not a check: the pinned schema types request
   * params but not responses. Params are genuinely checked, and stay checked
   * even here, because {@link RpcCall} correlates method and params in the type
   * rather than through inference.
   *
   * @param call - A method paired with that method's params
   * @returns The reply, whose `error` is data rather than an exception
   */
  request<Result = unknown>(call: RpcCall): Promise<RpcReply<Result>> {
    return new Promise((resolve) => {
      const id = ++this.nextId;
      this.pending.set(id, resolve as (reply: RpcReply<unknown>) => void);
      this.send({ id, ...call });
    });
  }

  /**
   * Issues a request for a method the pinned schema does not export.
   *
   * The generated `ClientRequest` union covers only what upstream chose to
   * export, and several methods this project depends on are absent from it
   * while working perfectly at runtime — `thread/settings/update` among them.
   * Schema silence is not evidence of absence, so probing those is the whole
   * point. Keeping the escape hatch separate rather than loosening
   * {@link request} means every untyped call is greppable, and the list of them
   * is itself a record of where the exported schema falls short.
   *
   * @param method - A method name the schema does not define
   * @param params - Params sent verbatim, unchecked
   * @returns The reply, whose `error` is data rather than an exception
   */
  requestRaw<Result = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<RpcReply<Result>> {
    return new Promise((resolve) => {
      const id = ++this.nextId;
      this.pending.set(id, resolve as (reply: RpcReply<unknown>) => void);
      this.send({ id, method, params });
    });
  }

  /** Sends a notification, which has no reply. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ method, params });
  }

  /** Notifications received since a previously recorded mark. */
  since(mark: number): Note[] {
    return this.notes.slice(mark);
  }

  /** Current position in the notification log, for use with {@link since}. */
  mark(): number {
    return this.notes.length;
  }

  /**
   * Waits until a notification satisfies a predicate.
   *
   * @param predicate - Tested against every notification from `mark` onwards
   * @param options - Where to start looking and how long to wait
   * @returns The matching notification, or undefined on timeout
   */
  async waitFor(
    predicate: (note: Note) => boolean,
    options: { from?: number; timeoutMs?: number } = {},
  ): Promise<Note | undefined> {
    const from = options.from ?? 0;
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    for (;;) {
      const found = this.notes.slice(from).find(predicate);
      if (found) return found;
      if (Date.now() >= deadline) return undefined;
      await delay(200);
    }
  }

  /**
   * Runs one turn and waits for it to finish.
   *
   * @param threadId - Conversation to run in
   * @param text - The user message
   * @param options - Timeout for the whole turn
   * @returns Everything observed while it ran
   */
  async runTurn(
    threadId: string,
    text: string,
    options: { timeoutMs?: number } = {},
  ): Promise<TurnRun> {
    const noteMark = this.mark();
    const requestMark = this.requests.length;
    const started = await this.request<{ turn: { id: string } }>({
      method: 'turn/start',
      params: {
        threadId,
        // `input` is a SEQUENCE of UserInput. Passing the map shape that reads
        // naturally produces `-32600 invalid type: map, expected a sequence`;
        // the correlated params type is what makes that a compile error.
        input: [{ type: 'text', text, text_elements: [] }],
      },
    });
    if (started.error) {
      return {
        events: [],
        requests: [],
        completed: false,
        error: started.error,
      };
    }
    const turnId = started.result?.turn?.id;
    const done = await this.waitFor(
      (note) =>
        note.method === 'turn/completed' &&
        (note.params.turn as { id?: string } | undefined)?.id === turnId,
      { from: noteMark, timeoutMs: options.timeoutMs },
    );
    return {
      turnId,
      events: this.since(noteMark),
      requests: this.requests.slice(requestMark),
      completed: Boolean(done),
    };
  }

  /** Anything the child wrote to stderr, for diagnosing a failed start. */
  stderr(): string {
    return this.stderrBuffer;
  }

  close(): void {
    this.child.kill();
  }
}

/** Sleeps, for settling windows where no notification marks the boundary. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads an item's protocol type, which differs by view between snake and camel. */
export function itemType(item: unknown): string {
  const record = (item ?? {}) as Record<string, unknown>;
  return text(record.item_type) || text(record.type) || 'unknown';
}

/**
 * Renders an unknown protocol value as text without stringifying an object.
 *
 * Probe output is read by a human comparing orders and statuses, and a stray
 * `[object Object]` in that list is indistinguishable from a real value.
 *
 * @param value - Any field read off an untyped protocol payload
 * @returns The value when it is a string or number, otherwise an empty string
 */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}
