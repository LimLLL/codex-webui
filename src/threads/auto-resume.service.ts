/** Resumes socket-subscribed threads after the Codex app-server restarts. */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CodexProcessManager,
  type CodexLifecycleEvent,
} from '../codex/codex-process-manager.service';
import { ActiveThreadRegistryService } from './active-thread-registry.service';
import { ThreadsGateway } from './threads.gateway';
import { ThreadsService } from './threads.service';

@Injectable()
export class AutoResumeService implements OnModuleInit {
  private readonly logger = new Logger(AutoResumeService.name);
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly codexManager: CodexProcessManager,
    private readonly registry: ActiveThreadRegistryService,
    private readonly threadsService: ThreadsService,
    private readonly gateway: ThreadsGateway,
  ) {}

  onModuleInit(): void {
    this.codexManager.addLifecycleListener((event) => {
      if (event.type === 'appServerRestarting') {
        this.gateway.emitLifecycle({
          type: 'appServerRestarting',
          generation: event.generation,
          delayMs: event.delayMs,
        });
        return;
      }

      if (event.type === 'appServerUnavailable') {
        this.gateway.emitLifecycle({
          type: 'appServerUnavailable',
          generation: event.generation,
          message: event.message,
        });
        return;
      }

      if (event.type === 'appServerReady') {
        void this.handleReady(event);
      }
    });
  }

  private async handleReady(
    event: Extract<CodexLifecycleEvent, { type: 'appServerReady' }>,
  ): Promise<void> {
    this.gateway.emitLifecycle({
      type: 'appServerReady',
      generation: event.generation,
      restarted: event.restarted,
    });

    if (!event.restarted) return;

    const threadIds = this.registry.snapshot();
    if (threadIds.length === 0) {
      this.gateway.emitLifecycle({
        type: 'autoResumeCompleted',
        generation: event.generation,
        resumedThreadIds: [],
        failedThreadIds: [],
      });
      return;
    }

    const results = await Promise.allSettled(
      threadIds.map((threadId) => this.resumeOnce(threadId)),
    );
    const resumedThreadIds: string[] = [];
    const failedThreadIds: string[] = [];

    results.forEach((result, index) => {
      const threadId = threadIds[index];
      if (result.status === 'fulfilled') {
        resumedThreadIds.push(threadId);
      } else {
        failedThreadIds.push(threadId);
        this.logger.warn(
          `Auto-resume failed for thread=${threadId}: ${(result.reason as Error).message}`,
        );
      }
    });

    this.gateway.emitLifecycle({
      type: 'autoResumeCompleted',
      generation: event.generation,
      resumedThreadIds,
      failedThreadIds,
    });
  }

  private resumeOnce(threadId: string): Promise<void> {
    const existing = this.inFlight.get(threadId);
    if (existing) return existing;

    const resume = this.threadsService
      .resumeThread(threadId)
      .then(() => undefined)
      .finally(() => this.inFlight.delete(threadId));
    this.inFlight.set(threadId, resume);
    return resume;
  }
}
