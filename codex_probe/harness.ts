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
import { nativeCodexBinary } from './native-binary';
export { delay, itemType, text } from './utils';
import {
  defaultServerResponse,
  errorPayload,
  HOLD,
  isErrorReply,
  type AppServerOptions,
  type ErrorReply,
  type IncomingRequest,
  type Note,
  type RpcCall,
  type RpcReply,
  type TurnRun,
} from './harness-types';
export * from './harness-types';

export class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (reply: RpcReply<unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private transportError: Error | null = null;
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
    child.once('exit', () => this.failPending(new Error('App-server exited')));
    child.on('error', (error) => this.failPending(error));
    child.stdin.on('error', (error) => this.failPending(error));
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
    const native = nativeCodexBinary(options.bin);
    const child = spawn(native.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        CODEX_HOME: options.home,
        CODEX_MANAGED_PACKAGE_ROOT: native.packageRoot,
      },
    });
    const app = new AppServer(
      child,
      options.onServerRequest ?? defaultServerResponse,
    );
    try {
      const initialized = await app.request({
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
      if (initialized.error)
        throw new Error(`Initialize failed: ${initialized.error.message}`);
      app.notify('initialized');
      return app;
    } catch (error) {
      if (child.pid !== undefined) await app.kill();
      throw error;
    }
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
      const pending = this.pending.get(id)!;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(message);
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
    if (this.transportError) throw this.transportError;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Rejects outstanding RPCs on transport loss without answering held server requests. */
  private failPending(error: Error): void {
    this.transportError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
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
   * @param timeoutMs - Response deadline, independent of turn or held-operation waits
   * @returns The reply, whose `error` is data rather than an exception
   * @throws On transport loss or deadline; never retries a possibly accepted request
   */
  request<Result = unknown>(
    call: RpcCall,
    timeoutMs = 30_000,
  ): Promise<RpcReply<Result>> {
    return this.requestRaw<Result>(call.method, call.params, timeoutMs);
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
   * @param timeoutMs - Response deadline; does not release held operations
   * @returns The reply, whose `error` is data rather than an exception
   */
  requestRaw<Result = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<RpcReply<Result>> {
    return new Promise((resolve, reject) => {
      if (this.transportError) throw this.transportError;
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `RPC deadline exceeded: ${method} (${timeoutMs}ms); delivery unknown`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (reply: RpcReply<unknown>) => void,
        reject,
        timer,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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

  /**
   * Starts bounded normal teardown for legacy callers that do not await close.
   * A failed confirmation makes their entire run inconclusive. Sequential
   * measurements and the shared runner await kill('SIGTERM') instead.
   */
  close(): void {
    void this.kill('SIGTERM').catch((error: unknown) => {
      console.error('INCONCLUSIVE: native close could not be confirmed', error);
      process.exitCode = 2;
    });
  }

  /**
   * Signals the directly spawned native process and requires its actual exit.
   * Signal delivery alone is not termination. There is no wrapper between this
   * child handle and Codex, including for SIGKILL, which cannot be forwarded.
   *
   * @param signal - Signal to send; the default cannot be caught or handled
   * @returns Native process identity and observed termination, for measurement output
   * @throws If signal delivery fails or the child does not exit within ten seconds
   */
  kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<{
    pid: number | undefined;
    executable: string;
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    const evidence = () => ({
      pid: this.child.pid,
      executable: this.child.spawnfile,
      code: this.child.exitCode,
      signal: this.child.signalCode,
    });
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.resolve(evidence());
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.child.off('exit', onExit);
        this.child.off('error', onError);
      };
      const onExit = () => {
        cleanup();
        resolve(evidence());
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        onError(
          new Error(
            `INCONCLUSIVE: native process did not exit after ${signal}`,
          ),
        );
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
