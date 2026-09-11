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

/** Credential field names used by login, refresh and attestation payloads. */
const AUDIT_CREDENTIAL_KEYS = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'token',
  'clientsecret',
  'authorization',
]);

/**
 * Redacts credentials recursively in both directions without changing the wire
 * payload. Boolean flags such as account/read's refreshToken are not secrets.
 */
const auditLogReplacer = (key: string, value: unknown): unknown => {
  if (key === 'steer' || key === 'detailedExplanation') return '[REDACTED]';
  if (
    typeof value === 'string' &&
    AUDIT_CREDENTIAL_KEYS.has(key.replaceAll('_', '').toLowerCase())
  )
    return '[REDACTED]';
  return bigintReplacer(key, value);
};

/** Serializes an audit entry, omitting credentials and private error detail. */
export function serializeCodexAuditEntry(
  dir: 'in' | 'out',
  msg: unknown,
): string {
  return JSON.stringify(
    { ts: new Date().toISOString(), dir, msg },
    auditLogReplacer,
  );
}
import type {
  InitializeParams,
  InitializeResponse,
  RequestId,
  ServerNotification,
  ServerRequest,
} from './codex-schema';
import { CodexRpcError } from './codex-errors';
import { CodexAcceptedWork } from './codex-accepted-work';
import {
  ServerRequestOwner,
  type ServerRequestRetirement,
} from './server-request-owner';

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
  observationSequence: number;
  method: string;
  params: unknown;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexJsonRpcClientEvents {
  /** Successful correlated responses, observed before the caller is resolved. */
  response: [
    {
      method: string;
      params: unknown;
      result: unknown;
      requestSequence: number;
      responseSequence: number;
    },
  ];
  notification: [ServerNotification];
  serverRequest: [ServerRequest];
  serverRequestRetired: [ServerRequestRetirement];
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
  /** Sole ingress owner; observer registration never confers response authority. */
  readonly serverRequests = new ServerRequestOwner(
    (message) => {
      this.writeJsonl('out', message);
      this.send(message);
    },
    (event) => this.emit('serverRequestRetired', event),
    (message) => this.logger.error(message),
  );
  /** Generation-local work ledger, populated only by this connection's outgoing requests. */
  readonly acceptedWork = new CodexAcceptedWork();
  private readonly logger = new Logger(CodexJsonRpcClient.name);
  private nextId = 1;
  private observationSequence = 0;
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
    this.acceptedWork.dispatch(id, method, params);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out`));
      }, timeoutMs ?? this.requestTimeoutMs);

      this.pending.set(id, {
        observationSequence: this.observationSequence,
        method,
        params,
        resolve: resolve,
        reject,
        timer,
      });

      try {
        this.writeJsonl('out', message);
        this.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        // A transport exception cannot establish that none of the request reached Core.
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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

  /** Kills the underlying app-server process and closes the log stream. */
  destroy(): void {
    this.closed = true;
    this.serverRequests.close();
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client destroyed'));
    }
    this.pending.clear();
    this.jsonlStream.end();
    this.process.kill();
  }

  /**
   * Writes a raw JSONL line: {"ts","dir","msg"} — each line is valid JSON.
   *
   * Bails once the client is closed: both `destroy()` and the process `close`
   * handler end the stream, but stdout keeps draining its buffer afterwards, so
   * late-arriving frames would otherwise write after end and raise an uncaught
   * ERR_STREAM_WRITE_AFTER_END on the audit stream.
   */
  private writeJsonl(dir: 'in' | 'out', msg: unknown): void {
    if (this.closed) return;
    const line = serializeCodexAuditEntry(dir, msg);
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
      this.acceptedWork.processExited();
      this.closed = true;
      this.serverRequests.close();
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
        // Do not include the raw line: malformed error notifications can still
        // contain explanation or continuation text that must never reach logs.
        this.logger.warn('Failed to parse JSON-RPC message');
      }
    }
  }

  /** Current wire observation order, used to reject stale asynchronous settings evidence. */
  getObservationSequence(): number {
    return this.observationSequence;
  }

  private handleMessage(message: JsonRpcMessage): void {
    this.observationSequence++;
    // Response to a client-initiated request
    if ('id' in message && ('result' in message || 'error' in message)) {
      const response = message;
      const pending = this.pending.get(response.id);
      // Handle even late responses after timeout, before exposing a result to callers.
      if (response.error) {
        if (response.error.code === -32600 || response.error.code === -32602)
          this.acceptedWork.refused(response.id);
      } else {
        this.acceptedWork.response(response.id, response.result);
        if (pending?.method === 'thread/queue/delete')
          this.acceptedWork.queueDeleted(pending.params, response.result);
      }
      if (!pending) return;

      this.pending.delete(response.id);
      clearTimeout(pending.timer);

      if (response.error) {
        pending.reject(
          new CodexRpcError(response.error, {
            method: pending.method,
            requestId: response.id,
          }),
        );
      } else {
        this.emit('response', {
          method: pending.method,
          params: pending.params,
          result: response.result,
          requestSequence: pending.observationSequence,
          responseSequence: this.observationSequence,
        });
        pending.resolve(response.result);
      }
      return;
    }

    // Server-initiated request (has id + method, no result/error)
    if ('id' in message && 'method' in message) {
      if (this.serverRequests.receive(message))
        this.emit('serverRequest', structuredClone(message) as ServerRequest);
      return;
    }

    // Server notification (has method, no id)
    if ('method' in message && !('id' in message)) {
      this.serverRequests.observe(message.method, message.params);
      this.acceptedWork.notification(message.method, message.params);
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
