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
import { delay } from './utils';
export { delay, itemType, text } from './utils';
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
  /** Position on the single incoming wire; comparable with {@link IncomingRequest.arrival}. */
  arrival: number;
}

/** A server-initiated request, which the client must answer. */
export interface IncomingRequest {
  id: number | string;
  /** Plain string for the same reason as {@link Note.method}. */
  method: string;
  params: Record<string, unknown>;
  /**
   * Position on the single incoming wire, shared with notifications.
   *
   * Notifications and requests are recorded in separate arrays, so "I found
   * this notification in the log after the request arrived" says nothing about
   * which came first. Anything that depends on one preceding the other has to
   * compare these instead of assuming.
   */
  arrival: number;
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

/**
 * Returned by a responder to leave a server request deliberately unanswered.
 *
 * Answering immediately is right for probes that only need the turn to proceed,
 * but it makes a whole class of question unmeasurable: anything about the state
 * of the world *while* the agent is blocked. Reading history after replying
 * measures the post-decision world and quietly answers a different question.
 */
export const HOLD: unique symbol = Symbol('hold');

/** Marks a responder's return value as a JSON-RPC error rather than a result. */
const ERROR_REPLY: unique symbol = Symbol('errorReply');

/**
 * A JSON-RPC error a responder can return in place of a result.
 *
 * Withholding an answer and refusing to give one are different dispositions,
 * and the difference is measurable: silence leaves the agent blocked, while a
 * refusal is something app-server has to classify and act on. A harness that
 * can only send results can only measure half of that.
 */
export interface ErrorReply {
  [ERROR_REPLY]: true;
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Builds an error reply for a server-initiated request.
 *
 * @param code - JSON-RPC error code
 * @param message - Human-readable reason
 * @param data - Optional structured detail
 * @returns A value a responder returns to refuse the request
 */
export function rpcError(
  code: number,
  message: string,
  data?: unknown,
): ErrorReply {
  return {
    [ERROR_REPLY]: true,
    code,
    message,
    ...(data !== undefined && { data }),
  };
}

/** Distinguishes a refusal from an ordinary result object. */
function isErrorReply(value: unknown): value is ErrorReply {
  return value !== null && typeof value === 'object' && ERROR_REPLY in value;
}

/** Strips the internal tag, leaving the wire shape of a JSON-RPC error. */
function errorPayload(reply: ErrorReply): Record<string, unknown> {
  return {
    code: reply.code,
    message: reply.message,
    ...(reply.data !== undefined && { data: reply.data }),
  };
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
  /** Requests a responder chose to hold, keyed by request id. */
  private readonly heldById = new Map<string, IncomingRequest>();
  /** Shared arrival counter across both incoming kinds; see {@link IncomingRequest.arrival}. */
  private arrivals = 0;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private respond: (request: IncomingRequest) => unknown,
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
        arrival: this.arrivals++,
      };
      this.requests.push(request);
      const reply = this.respond(request);
      // A held request stays unanswered until the probe releases it, which is
      // what keeps the agent genuinely blocked while the probe observes.
      if (reply === HOLD) {
        this.heldById.set(String(id), request);
        return;
      }
      if (isErrorReply(reply)) {
        this.send({ id, error: errorPayload(reply) });
        return;
      }
      this.send({ id, result: reply });
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
        arrival: this.arrivals++,
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

  /**
   * Replaces the server-request policy after the connection is up.
   *
   * A probe usually only knows which requests it wants to hold once it has
   * decided what it is measuring, which is after {@link start} has run.
   *
   * @param respond - Returns the result to send, or {@link HOLD} to withhold it
   */
  setServerResponder(respond: (request: IncomingRequest) => unknown): void {
    this.respond = respond;
  }

  /**
   * Waits until a server-initiated request satisfies a predicate.
   *
   * Separate from {@link waitFor} because requests and notifications are
   * different streams; a request that never arrives means the fixture failed to
   * provoke the thing under measurement, which is not the same as a timeout
   * waiting for an event.
   *
   * @param predicate - Tested against every request from `from` onwards
   * @param options - Where to start looking and how long to wait
   * @returns The matching request, or undefined on timeout
   */
  async waitForRequest(
    predicate: (request: IncomingRequest) => boolean,
    options: { from?: number; timeoutMs?: number } = {},
  ): Promise<IncomingRequest | undefined> {
    const from = options.from ?? 0;
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    for (;;) {
      const found = this.requests.slice(from).find(predicate);
      if (found) return found;
      if (Date.now() >= deadline) return undefined;
      await delay(200);
    }
  }

  /** Server requests currently held unanswered, in arrival order. */
  held(): IncomingRequest[] {
    return [...this.heldById.values()];
  }

  /**
   * Answers a request that was held, unblocking the agent.
   *
   * @param id - Request id, as delivered
   * @param result - The JSON-RPC result to send
   * @throws Error when that id is not being held, so a probe cannot silently
   *   believe it released something it never held
   */
  release(id: number | string, result: unknown): void {
    const key = String(id);
    if (!this.heldById.delete(key))
      throw new Error(`Request ${key} is not held; nothing to release`);
    this.send({ id, result });
  }

  /**
   * Refuses a held request with a JSON-RPC error instead of a result.
   *
   * This is the disposition a client has when it genuinely cannot answer — it
   * neither approves anything nor leaves the agent blocked. What app-server
   * does with it is not documented anywhere, so it has to be measured before
   * any production code relies on it.
   *
   * @param id - Request id, as delivered
   * @param error - The refusal to send, built with {@link rpcError}
   * @throws Error when that id is not being held
   */
  releaseWithError(id: number | string, error: ErrorReply): void {
    const key = String(id);
    if (!this.heldById.delete(key))
      throw new Error(`Request ${key} is not held; nothing to refuse`);
    this.send({ id, error: errorPayload(error) });
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

  /**
   * Kills the child and waits for it to actually exit.
   *
   * A crash is not a shutdown. {@link close} sends SIGTERM and returns
   * immediately, which lets the app-server run whatever cleanup it has and lets
   * the next process start before the old one released the CODEX_HOME database.
   * Both are exactly what a restart-recovery measurement must be denied: the
   * question is what survives an app-server that got no chance to tidy up.
   *
   * @param signal - Signal to send; the default cannot be caught or handled
   * @returns Resolves once the child process has exited
   * @throws If signal delivery fails or the child does not exit within ten seconds
   */
  kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.child.off('exit', onExit);
        this.child.off('error', onError);
      };
      const onExit = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        onError(new Error(`Child did not exit after ${signal}`));
      }, 10_000);
      this.child.once('exit', onExit);
      this.child.once('error', onError);
      try {
        if (!this.child.kill(signal)) {
          onError(new Error(`Could not deliver ${signal} to child`));
        }
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
