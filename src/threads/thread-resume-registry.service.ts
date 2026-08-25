/** Generation-scoped resume registry for non-idempotent thread/resume calls. */
import { Injectable, Logger } from '@nestjs/common';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ReasoningEffort, v2 } from '../codex/codex-schema';
import type { ThreadOpenResponseDto } from './dto/threads.dto';
import {
  isNotMaterializedError,
  isThreadOwnershipConflictError,
} from './thread-errors';
import {
  ThreadHistoryService,
  type MetadataFirstResumeResponse,
  type TurnsPage,
} from './thread-history.service';

/** Prevents duplicate app-server resume calls for the same thread generation. */
@Injectable()
export class ThreadResumeRegistryService {
  private readonly logger = new Logger(ThreadResumeRegistryService.name);
  private readonly inFlight = new Map<string, Promise<ThreadOpenResponseDto>>();
  private readonly resumed = new Set<string>();
  private readonly failed = new Map<string, string>();
  /** Monotonic epoch per key — stale in-flight promises check before marking resumed. */
  private readonly epoch = new Map<string, number>();
  /**
   * Caches the full resume/start response (resolved settings) per thread.
   * Used by `readAsResume` to return a complete `ThreadResumeResponse`
   * even though `thread/read` doesn't include resolved settings.
   */
  private readonly responseCache = new Map<
    string,
    v2.ThreadResumeResponse | MetadataFirstResumeResponse
  >();

  constructor(
    private readonly history: ThreadHistoryService,
    private readonly codexManager: CodexProcessManager,
  ) {
    this.codexManager.addLifecycleListener((event) => {
      if (event.type === 'appServerReady') {
        this.pruneGenerations(event.generation);
      }
    });
  }

  /**
   * Opens a thread once for the current app-server generation.
   *
   * A successful writer acquisition returns `mode=writable`. An app-server
   * ownership refusal is downgraded to `mode=readOnly` with the refusal message
   * preserved for the frontend banner.
   */
  ensureOpened(
    threadId: string,
    initialTurnsLimit = 20,
  ): Promise<ThreadOpenResponseDto> {
    const key = this.key(threadId);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    if (this.resumed.has(key)) {
      return this.readAsOpen(threadId, initialTurnsLimit);
    }

    const callEpoch = this.bumpEpoch(key);
    const promise = this.history
      .resumeMetadataFirst({
        threadId,
        initialTurnsLimit,
        itemsView: 'summary',
      })
      .then((response) => {
        if (this.epoch.get(key) === callEpoch) {
          this.markResumed(threadId);
          this.responseCache.set(threadId, response);
        }
        return this.toWritableOpen(response);
      })
      .catch(async (err: Error) => {
        if (isThreadOwnershipConflictError(err)) {
          return this.readOnlyOpen(threadId, initialTurnsLimit, err.message);
        }
        if (this.epoch.get(key) === callEpoch) {
          this.failed.set(key, err.message);
        }
        throw err;
      })
      .finally(() => {
        if (this.epoch.get(key) === callEpoch) {
          this.inFlight.delete(key);
        }
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  /** Marks a thread as already active in the current app-server generation. */
  markResumed(threadId: string): void {
    const key = this.key(threadId);
    this.resumed.add(key);
    this.failed.delete(key);
  }

  /**
   * Caches the resolved settings from a start/resume/fork response.
   * `readAsResume` merges cached settings with a fresh `thread/read`
   * to return a complete `ThreadResumeResponse`.
   */
  cacheResponse(
    threadId: string,
    response: v2.ThreadResumeResponse | MetadataFirstResumeResponse,
  ): void {
    this.responseCache.set(threadId, response);
  }

  /** Returns the cached resolved model from a successful start/resume/fork. */
  readCachedModel(threadId: string): string | null {
    const model = this.responseCache.get(threadId)?.model;
    return typeof model === 'string' && model.trim().length > 0
      ? model.trim()
      : null;
  }

  /** Returns the cached resolved reasoning effort from a start/resume/fork. */
  readCachedEffort(threadId: string): ReasoningEffort | null {
    return this.responseCache.get(threadId)?.reasoningEffort ?? null;
  }

  /** Returns true when the thread has already been resumed in this generation. */
  isResumed(threadId: string): boolean {
    return this.resumed.has(this.key(threadId));
  }

  /** Removes a thread from all registry state; bumps epoch so in-flight promises become no-ops. */
  forget(threadId: string): void {
    const key = this.key(threadId);
    this.resumed.delete(key);
    this.failed.delete(key);
    this.inFlight.delete(key);
    this.responseCache.delete(threadId);
    this.bumpEpoch(key);
  }

  /**
   * Reads metadata and a recent turn page after this process already owns the
   * thread. This keeps repeat opens cheap while preserving resolved settings
   * from the original resume/start response.
   */
  private async readAsOpen(
    threadId: string,
    initialTurnsLimit: number,
  ): Promise<ThreadOpenResponseDto> {
    const cached = this.responseCache.get(threadId);
    if (!cached) {
      throw new Error(
        `Missing cached resume response for already-resumed thread ${threadId}`,
      );
    }
    const [metadata, initialTurnsPage] = await Promise.all([
      this.history.readThreadMetadata(threadId),
      this.readInitialTurnsPage(threadId, initialTurnsLimit),
    ]);
    return this.toWritableOpen({
      ...cached,
      thread: { ...metadata.thread, turns: [] },
      cwd: metadata.thread.cwd,
      initialTurnsPage,
      turnsBackwardsCursor: initialTurnsPage.backwardsCursor,
    });
  }

  private async readOnlyOpen(
    threadId: string,
    initialTurnsLimit: number,
    message: string,
  ): Promise<ThreadOpenResponseDto> {
    const [metadata, initialTurnsPage] = await Promise.all([
      this.history.readThreadMetadata(threadId),
      this.readInitialTurnsPage(threadId, initialTurnsLimit),
    ]);
    return {
      mode: 'readOnly',
      ownership: 'refused',
      ownershipRefusalMessage: message,
      thread: { ...metadata.thread, turns: [] },
      cwd: metadata.thread.cwd,
      model: null,
      modelProvider: metadata.thread.modelProvider,
      serviceTier: null,
      instructionSources: [],
      approvalPolicy: null,
      approvalsReviewer: null,
      sandbox: null,
      reasoningEffort: null,
      initialTurnsPage,
      turnsBackwardsCursor: initialTurnsPage.backwardsCursor,
      itemsBackwardsCursor: null,
    };
  }

  private toWritableOpen(
    response: v2.ThreadResumeResponse | MetadataFirstResumeResponse,
  ): ThreadOpenResponseDto {
    const initialTurnsPage = this.readEmbeddedTurnsPage(response);
    return {
      mode: 'writable',
      ownership: 'acquired',
      ownershipRefusalMessage: null,
      thread: { ...response.thread, turns: [] },
      cwd: String(response.cwd),
      model: response.model ?? null,
      modelProvider: response.modelProvider ?? null,
      serviceTier: (response.serviceTier ?? null) as 'fast' | 'flex' | null,
      instructionSources: (response.instructionSources ?? []).map(String),
      approvalPolicy: response.approvalPolicy ?? null,
      approvalsReviewer: response.approvalsReviewer ?? null,
      sandbox: response.sandbox ?? null,
      reasoningEffort: response.reasoningEffort ?? null,
      initialTurnsPage,
      turnsBackwardsCursor:
        this.readNullableString(response, 'turnsBackwardsCursor') ??
        initialTurnsPage.backwardsCursor,
      itemsBackwardsCursor: this.readNullableString(
        response,
        'itemsBackwardsCursor',
      ),
    };
  }

  private readEmbeddedTurnsPage(
    response: v2.ThreadResumeResponse | MetadataFirstResumeResponse,
  ): TurnsPage {
    const candidate = (response as MetadataFirstResumeResponse)
      .initialTurnsPage;
    return (
      candidate ?? {
        data: [],
        nextCursor: null,
        backwardsCursor: null,
      }
    );
  }

  private async readInitialTurnsPage(
    threadId: string,
    initialTurnsLimit: number,
  ): Promise<TurnsPage> {
    try {
      return await this.history.listTurns({
        threadId,
        limit: initialTurnsLimit,
        sortDirection: 'desc',
        itemsView: 'summary',
      });
    } catch (err) {
      if (!isNotMaterializedError(err)) throw err;
      this.logger.debug(
        `Thread ${threadId} not materialized; returning an empty turn page`,
      );
      return { data: [], nextCursor: null, backwardsCursor: null };
    }
  }

  private readNullableString(
    response: v2.ThreadResumeResponse | MetadataFirstResumeResponse,
    key: 'turnsBackwardsCursor' | 'itemsBackwardsCursor',
  ): string | null {
    const value = (response as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  }

  private key(threadId: string): string {
    return `${this.codexManager.getGeneration()}:${threadId}`;
  }

  private bumpEpoch(key: string): number {
    const next = (this.epoch.get(key) ?? 0) + 1;
    this.epoch.set(key, next);
    return next;
  }

  private pruneGenerations(currentGeneration: number): void {
    const prefix = `${currentGeneration}:`;
    for (const key of this.resumed) {
      if (!key.startsWith(prefix)) this.resumed.delete(key);
    }
    for (const key of this.failed.keys()) {
      if (!key.startsWith(prefix)) this.failed.delete(key);
    }
    for (const key of this.inFlight.keys()) {
      if (!key.startsWith(prefix)) this.inFlight.delete(key);
    }
    for (const key of this.epoch.keys()) {
      if (!key.startsWith(prefix)) this.epoch.delete(key);
    }
    this.responseCache.clear();
    this.logger.debug(
      `Resume registry ready for generation=${currentGeneration}`,
    );
  }
}
