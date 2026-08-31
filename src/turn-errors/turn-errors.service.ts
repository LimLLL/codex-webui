/** Persists final turn errors from Codex app-server notifications for hydration after refresh. */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification, v2 } from '../codex/codex-schema';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { selectProvenanceRows } from '../conversation-branches/provenance';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { turnErrors, type TurnErrorRow } from '../database/schema';
import type {
  ThreadTurnErrorsResponseDto,
  PersistedTurnErrorDto,
} from './dto/turn-error.dto';
import {
  toPersistableTurnError,
  type PersistableTurnError,
} from './turn-error-projection';

@Injectable()
export class TurnErrorsService implements OnModuleInit {
  private readonly logger = new Logger(TurnErrorsService.name);

  constructor(
    private readonly codexManager: CodexProcessManager,
    private readonly branches: ConversationBranchesService,
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
  ) {}

  onModuleInit(): void {
    this.codexManager.addListener(
      'notification',
      (notification: ServerNotification) => {
        if (notification.method === 'error') {
          this.handleErrorNotification(notification.params);
        } else if (notification.method === 'turn/completed') {
          this.handleTurnCompleted(notification.params);
        }
      },
    );
  }

  /**
   * Reads all persisted turn errors visible to a thread.
   *
   * Branched threads inherit their prefix turns' errors from ancestors rather
   * than owning copies of those rows.
   */
  readThreadErrors(threadId: string): ThreadTurnErrorsResponseDto {
    const provenance = this.branches.resolveProvenance(threadId);
    const rows = this.db
      .select()
      .from(turnErrors)
      .where(inArray(turnErrors.threadId, provenance.threadIds))
      .orderBy(turnErrors.createdAt)
      .all();

    return {
      threadId,
      errors: selectProvenanceRows(provenance, rows)
        .map((row) => this.toDto(row))
        .sort((a, b) => a.createdAt - b.createdAt),
    };
  }

  /**
   * Handles `error` notifications. Only persists final errors (willRetry=false)
   * that have both threadId and turnId.
   */
  private handleErrorNotification(params: Record<string, unknown>): void {
    if (params.willRetry) return;

    const threadId = params.threadId as string | undefined;
    const turnId = params.turnId as string | undefined;
    if (!threadId || !turnId) return;

    const error = params.error as v2.TurnError | undefined;
    if (!error) return;

    this.upsert(threadId, turnId, toPersistableTurnError(error));
  }

  /** Handles `turn/completed` notifications with status='failed'. */
  private handleTurnCompleted(params: Record<string, unknown>): void {
    const threadId = params.threadId as string | undefined;
    const turn = params.turn as
      | {
          id?: string;
          status?: string;
          error?: v2.TurnError | null;
        }
      | undefined;

    if (!threadId || !turn?.id) return;
    if (turn.status !== 'failed' || !turn.error) return;

    this.upsert(threadId, turn.id, toPersistableTurnError(turn.error));
  }

  /**
   * Upserts one terminal error without letting a sparse later event erase detail.
   *
   * app-server commonly emits `error` before `turn/completed`. The first can
   * carry rich misalignment detail while the terminal summary is sparse, so
   * nullable fields use SQL COALESCE against the existing row.
   */
  private upsert(
    threadId: string,
    turnId: string,
    error: PersistableTurnError,
  ): void {
    try {
      const now = Date.now();
      this.db
        .insert(turnErrors)
        .values({ threadId, turnId, ...error, createdAt: now })
        .onConflictDoUpdate({
          target: [turnErrors.threadId, turnErrors.turnId],
          set: {
            message: error.message,
            errorCategory: sql`coalesce(excluded.error_category, ${turnErrors.errorCategory})`,
            additionalDetails: sql`coalesce(excluded.additional_details, ${turnErrors.additionalDetails})`,
            misalignmentErrorType: sql`coalesce(excluded.misalignment_error_type, ${turnErrors.misalignmentErrorType})`,
            misalignmentExplanation: sql`coalesce(excluded.misalignment_explanation, ${turnErrors.misalignmentExplanation})`,
            createdAt: now,
          },
        })
        .run();
    } catch (err) {
      this.logger.warn(
        `Failed to persist turn error for thread=${threadId} turn=${turnId}: ${(err as Error).message}`,
      );
    }
  }

  private toDto(row: TurnErrorRow): PersistedTurnErrorDto {
    return {
      turnId: row.turnId,
      message: row.message,
      errorCategory: row.errorCategory,
      additionalDetails: row.additionalDetails,
      misalignmentErrorType: row.misalignmentErrorType,
      misalignmentExplanation: row.misalignmentExplanation,
      createdAt: row.createdAt,
    };
  }
}
