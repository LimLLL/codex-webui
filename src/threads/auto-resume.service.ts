/** Reattaches backend-observed execution after child replacement; never replays user input. */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CodexProcessManager,
  type CodexLifecycleEvent,
} from '../codex/codex-process-manager.service';
import { ThreadExecutionInventoryService } from './thread-execution-inventory.service';
import { ThreadsGateway } from './threads.gateway';
import { ThreadsService } from './threads.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';

@Injectable()
export class AutoResumeService implements OnModuleInit {
  private readonly logger = new Logger(AutoResumeService.name);
  private handledGeneration = 0;

  constructor(
    private readonly codexManager: CodexProcessManager,
    private readonly inventory: ThreadExecutionInventoryService,
    private readonly threadsService: ThreadsService,
    private readonly gateway: ThreadsGateway,
    private readonly catalogAdmission: CatalogAdmissionService,
  ) {}

  /** Connects process lifecycle to session reattachment, independent of Socket.IO membership. */
  onModuleInit(): void {
    this.codexManager.addLifecycleListener((event) => {
      if (
        event.type === 'appServerRestarting' ||
        event.type === 'appServerUnavailable'
      ) {
        this.gateway.emitLifecycle(event);
      } else if (event.type === 'appServerReady') {
        void this.handleReady(event).catch((error: unknown) => {
          this.logger.error(
            `Backend recovery failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    });
  }

  /** Restores each generation once, retaining failed obligations for later explicit or process recovery. */
  private async handleReady(
    event: Extract<CodexLifecycleEvent, { type: 'appServerReady' }>,
  ): Promise<void> {
    if (event.generation <= this.handledGeneration) return;
    this.handledGeneration = event.generation;
    this.gateway.emitLifecycle(event);
    if (!event.restarted) return;

    const resumedThreadIds: string[] = [];
    const failedThreadIds: string[] = [];
    const restored = new Set<string>();
    const release = this.catalogAdmission.enter(
      'Restoring execution sessions after app-server restart',
    );
    try {
      for (const threadId of this.inventory.snapshot()) {
        if (!this.isCurrent(event.generation)) return;
        if (!this.inventory.has(threadId)) continue;
        try {
          await this.resumeWithParents(
            threadId,
            new Set(),
            restored,
            event.generation,
          );
          resumedThreadIds.push(threadId);
        } catch (error) {
          if (!this.isCurrent(event.generation)) return;
          failedThreadIds.push(threadId);
          this.logger.warn(
            `Session reattachment failed for thread=${threadId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      release();
    }
    if (!this.isCurrent(event.generation)) return;
    this.gateway.emitLifecycle({
      type: 'autoResumeCompleted',
      generation: event.generation,
      resumedThreadIds,
      failedThreadIds,
    });
  }

  /**
   * Reattaches required owners before a child and avoids repeating shared parents.
   * Only headers actually returned by resume can retire old turn obligations.
   * A writable session does not imply that interrupted execution continued.
   */
  private async resumeWithParents(
    threadId: string,
    ancestors: Set<string>,
    restored: Set<string>,
    generation: number,
  ): Promise<void> {
    this.assertCurrent(generation);
    if (this.inventory.isDeleted(threadId))
      throw new Error('Recovery target was deleted');
    if (restored.has(threadId)) return;
    if (ancestors.has(threadId))
      throw new Error('Cyclic subagent ownership during recovery');
    ancestors.add(threadId);
    const recordedParent = this.inventory.parentOf(threadId);
    if (recordedParent)
      await this.resumeWithParents(
        recordedParent,
        ancestors,
        restored,
        generation,
      );
    const { thread } = await this.threadsService.readThread(threadId);
    this.assertCurrent(generation);
    if (
      recordedParent &&
      thread.parentThreadId &&
      recordedParent !== thread.parentThreadId
    ) {
      throw new Error(
        'Spawned thread owner changed during session reattachment',
      );
    }
    if (thread.parentThreadId)
      await this.resumeWithParents(
        thread.parentThreadId,
        ancestors,
        restored,
        generation,
      );
    this.assertCurrent(generation);
    if (this.inventory.isDeleted(threadId))
      throw new Error('Recovery target was deleted');
    const response = await this.threadsService.resumeThread(threadId, {
      recordActive: false,
    });
    this.assertCurrent(generation);
    if (response.mode !== 'writable')
      throw new Error('Writer ownership refused during session reattachment');
    restored.add(threadId);
    this.inventory.observeRestoredTurns(
      threadId,
      response.initialTurnsPage.data,
    );
  }

  private isCurrent(generation: number): boolean {
    return (
      generation === this.codexManager.getGeneration() &&
      this.codexManager.getClient() !== null
    );
  }

  private assertCurrent(generation: number): void {
    if (!this.isCurrent(generation))
      throw new Error(
        'Session reattachment was superseded by process replacement',
      );
  }
}
