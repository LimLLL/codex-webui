/**
 * Handles thread and turn operations by delegating to Codex app-server.
 */
import { Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { isNotMaterializedError } from './thread-errors';

@Injectable()
export class ThreadsService {
  constructor(
    private readonly codex: CodexService,
    private readonly resumeRegistry: ThreadResumeRegistryService,
  ) {}

  /**
   * Creates a new thread (conversation).
   *
   * @param params - Thread start parameters (model, cwd, approvalPolicy, etc.)
   * @returns The created thread with resolved settings
   */
  async startThread(
    params: v2.ThreadStartParams,
  ): Promise<v2.ThreadStartResponse> {
    const response = await this.codex.request<v2.ThreadStartResponse>(
      'thread/start',
      params,
    );
    this.resumeRegistry.markResumed(response.thread.id);
    this.resumeRegistry.cacheResponse(response.thread.id, response);
    return response;
  }

  /**
   * Lists threads with optional filtering and pagination.
   *
   * @param params - List parameters (cursor, limit, archived, searchTerm, etc.)
   * @returns Paginated thread list
   */
  async listThreads(
    params: v2.ThreadListParams,
  ): Promise<v2.ThreadListResponse> {
    return this.codex.request<v2.ThreadListResponse>('thread/list', params);
  }

  /**
   * Lists thread IDs currently loaded in the Codex app-server memory.
   *
   * @param params - Optional pagination cursor and limit
   * @returns Paginated loaded thread IDs
   */
  async listLoadedThreads(
    params: v2.ThreadLoadedListParams,
  ): Promise<v2.ThreadLoadedListResponse> {
    return this.codex.request<v2.ThreadLoadedListResponse>(
      'thread/loaded/list',
      params,
    );
  }

  /**
   * Reads a single thread by ID.
   *
   * If `includeTurns` is requested but the thread is not yet materialized
   * (no user messages), falls back to reading without turns — an
   * unmaterialized thread has no turns anyway.
   *
   * @param threadId - The thread identifier
   * @param includeTurns - Whether to include turn history
   * @returns The thread data
   */
  async readThread(
    threadId: string,
    includeTurns = false,
  ): Promise<v2.ThreadReadResponse> {
    try {
      return await this.codex.request<v2.ThreadReadResponse>('thread/read', {
        threadId,
        includeTurns,
      });
    } catch (err) {
      // Thread not materialized — retry without turns if that was requested.
      if (includeTurns && isNotMaterializedError(err)) {
        const response = await this.codex.request<v2.ThreadReadResponse>(
          'thread/read',
          { threadId, includeTurns: false },
        );
        return { thread: { ...response.thread, turns: [] } };
      }
      throw err;
    }
  }

  /**
   * Ensures a persisted thread is resumed once for the current app-server generation.
   *
   * @param threadId - The thread identifier
   * @returns The resumed or already-active thread with resolved settings
   */
  async resumeThread(threadId: string): Promise<v2.ThreadResumeResponse> {
    return this.resumeRegistry.ensureResumed(threadId);
  }

  /**
   * Starts a new turn (user message + agent response cycle).
   *
   * @param params - Turn start parameters (threadId, input, model overrides, etc.)
   * @returns The created turn
   */
  async startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse> {
    return this.codex.request<v2.TurnStartResponse>('turn/start', params);
  }

  /**
   * Sends additional user input to the currently active turn.
   *
   * @param params - Turn steer parameters including the active turn precondition
   * @returns The turn id accepted by app-server
   */
  async steerTurn(params: v2.TurnSteerParams): Promise<v2.TurnSteerResponse> {
    return this.codex.request<v2.TurnSteerResponse>('turn/steer', params);
  }

  /**
   * Interrupts an in-progress turn.
   *
   * @param threadId - The thread identifier
   * @param turnId - The turn to interrupt
   */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.codex.request('turn/interrupt', { threadId, turnId });
  }

  /**
   * Archives a thread so it no longer appears in the active thread list.
   *
   * @param threadId - The thread identifier
   */
  async archiveThread(threadId: string): Promise<void> {
    await this.codex.request<v2.ThreadArchiveResponse>('thread/archive', {
      threadId,
    });
    this.resumeRegistry.forget(threadId);
  }

  /**
   * Restores an archived thread back into the active thread list.
   *
   * @param threadId - The thread identifier
   * @returns The restored thread
   */
  async unarchiveThread(threadId: string): Promise<v2.ThreadUnarchiveResponse> {
    return this.codex.request<v2.ThreadUnarchiveResponse>('thread/unarchive', {
      threadId,
    });
  }

  /**
   * Starts context compaction for a thread.
   *
   * @param threadId - The thread identifier
   */
  async compactThread(threadId: string): Promise<void> {
    await this.codex.request<v2.ThreadCompactStartResponse>(
      'thread/compact/start',
      { threadId },
    );
  }

  /**
   * Forks a thread into a new live thread with extended history persistence.
   *
   * @param threadId - The source thread identifier
   * @returns The forked thread and resolved settings
   */
  async forkThread(threadId: string): Promise<v2.ThreadForkResponse> {
    const response = await this.codex.request<v2.ThreadForkResponse>(
      'thread/fork',
      {
        threadId,
        persistExtendedHistory: true,
      },
    );
    this.resumeRegistry.markResumed(response.thread.id);
    this.resumeRegistry.cacheResponse(response.thread.id, response);
    return response;
  }

  /**
   * Rolls back turns from the end of a thread history.
   *
   * @param threadId - The thread identifier
   * @param numTurns - Number of turns to remove from the end
   * @returns The updated thread with turns populated
   */
  async rollbackThread(
    threadId: string,
    numTurns: number,
  ): Promise<v2.ThreadRollbackResponse> {
    return this.codex.request<v2.ThreadRollbackResponse>('thread/rollback', {
      threadId,
      numTurns,
    });
  }

  /**
   * Updates the user-facing name for a thread.
   *
   * @param threadId - The thread identifier
   * @param name - Non-empty display name
   */
  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.codex.request<v2.ThreadSetNameResponse>('thread/name/set', {
      threadId,
      name,
    });
  }
}
