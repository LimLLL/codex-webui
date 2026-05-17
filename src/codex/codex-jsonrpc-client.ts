/**
 * JSON-RPC client for communicating with codex app-server over stdio.
 * Handles request/response correlation, server-initiated requests, and notifications.
 */
import { Logger } from '@nestjs/common';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
/**
 * JSON replacer that converts BigInt to Number for serialization.
 * Targeted fix — does not change undefined/null semantics like toJsonSafe.
 */
const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? Number(value) : value;
import type {
  InitializeParams,
  InitializeResponse,
  RequestId,
  ServerNotification,
  ServerRequest,
} from './codex-schema';

/** Wire-level JSON-RPC message (jsonrpc field omitted per Codex protocol). */
interface JsonRpcRequest {
  method: string;
  id: RequestId;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexJsonRpcClientEvents {
  notification: [ServerNotification];
  serverRequest: [ServerRequest];
  error: [Error];
  close: [number | null, string | null];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LOG_DIR = join(globalThis.process.cwd(), 'logs');

function createJsonlStream(): WriteStream {
  mkdirSync(LOG_DIR, { recursive: true });
  return createWriteStream(join(LOG_DIR, 'codex-jsonrpc.jsonl'), {
    flags: 'a',
  });
}

export class CodexJsonRpcClient extends EventEmitter<CodexJsonRpcClientEvents> {
  private readonly logger = new Logger(CodexJsonRpcClient.name);
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private buffer = '';
  private closed = false;
  private readonly jsonlStream: WriteStream;

  constructor(
    private readonly process: ChildProcess,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    super();
    this.jsonlStream = createJsonlStream();
    this.setupStdio();
  }

  /**
   * Sends initialize request and initialized notification.
   * Must be called before any other requests.
   *
   * @param params - Initialize parameters including clientInfo and capabilities
   * @returns Server's initialize response with codexHome, platform info, etc.
   */
  async initialize(params: InitializeParams): Promise<InitializeResponse> {
    const result = await this.request<InitializeResponse>('initialize', params);
    this.notify('initialized', {});
    return result;
  }

  /**
   * Sends a JSON-RPC request and waits for the correlated response.
   *
   * @param method - The RPC method name (e.g. 'thread/start', 'model/list')
   * @param params - Method parameters
   * @param timeoutMs - Optional per-request timeout override
   * @returns The result payload from the server response
   * @throws Error if the server returns an error or the request times out
   */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.closed) {
      throw new Error('Client is closed');
    }

    const id = this.nextId++;
    const message: JsonRpcRequest = { method, id, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out`));
      }, timeoutMs ?? this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve,
        reject,
        timer,
      });

      this.writeJsonl('out', message);
      this.send(message);
    });
  }

  /**
   * Sends a fire-and-forget notification to the server.
   *
   * @param method - The notification method name
   * @param params - Notification parameters
   */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message: JsonRpcNotification = { method, params };
    this.writeJsonl('out', message);
    this.send(message);
  }

  /**
   * Responds to a server-initiated request (e.g. approval requests).
   *
   * @param id - The request ID from the server request
   * @param result - The response payload
   */
  respondToServerRequest(id: RequestId, result: unknown): void {
    if (this.closed) {
      throw new Error('Cannot respond: app-server client is closed');
    }
    const message = { id, result };
    this.writeJsonl('out', message);
    this.send(message);
  }

  /**
   * Responds to a server-initiated request with an error.
   *
   * @param id - The request ID from the server request
   * @param code - JSON-RPC error code
   * @param message - Error message
   */
  respondToServerRequestWithError(
    id: RequestId,
    code: number,
    message: string,
  ): void {
    if (this.closed) return;
    const msg = { id, error: { code, message } };
    this.writeJsonl('out', msg);
    this.send(msg);
  }

  /** Kills the underlying app-server process and closes the log stream. */
  destroy(): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client destroyed'));
    }
    this.pending.clear();
    this.jsonlStream.end();
    this.process.kill();
  }

  /** Writes a raw JSONL line: {"ts","dir","msg"} — each line is valid JSON. */
  private writeJsonl(dir: 'in' | 'out', msg: unknown): void {
    const line = JSON.stringify(
      { ts: new Date().toISOString(), dir, msg },
      bigintReplacer,
    );
    this.jsonlStream.write(line + '\n');
  }

  private setupStdio(): void {
    const { stdout, stderr } = this.process;

    if (!stdout || !stderr) {
      throw new Error('Process stdio not available');
    }

    stdout.setEncoding('utf-8');
    stdout.on('data', (chunk: string) => this.onData(chunk));

    stderr.setEncoding('utf-8');
    stderr.on('data', (chunk: string) => {
      this.logger.warn(`codex stderr: ${chunk.trim()}`);
    });

    this.process.on('close', (code, signal) => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(`Process exited (code=${code}, signal=${signal})`),
        );
      }
      this.pending.clear();
      this.jsonlStream.end();
      this.emit('close', code, signal);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed) as JsonRpcMessage;
        this.writeJsonl('in', message);
        this.handleMessage(message);
      } catch {
        this.logger.warn(
          `Failed to parse JSON-RPC message: ${trimmed.slice(0, 200)}`,
        );
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    // Response to a client-initiated request
    if ('id' in message && ('result' in message || 'error' in message)) {
      const response = message;
      const pending = this.pending.get(response.id);
      if (!pending) return;

      this.pending.delete(response.id);
      clearTimeout(pending.timer);

      if (response.error) {
        pending.reject(
          new Error(
            `RPC error ${response.error.code}: ${response.error.message}`,
          ),
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    // Server-initiated request (has id + method, no result/error)
    if ('id' in message && 'method' in message) {
      this.emit('serverRequest', message as unknown as ServerRequest);
      return;
    }

    // Server notification (has method, no id)
    if ('method' in message && !('id' in message)) {
      this.emit('notification', message as unknown as ServerNotification);
      return;
    }
  }

  private send(message: unknown): void {
    const { stdin } = this.process;
    if (!stdin || !stdin.writable) {
      throw new Error('Process stdin not writable');
    }
    stdin.write(JSON.stringify(message, bigintReplacer) + '\n');
  }
}
