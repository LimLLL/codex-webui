/** Bounded recovery of client refusals without loading the full retained history. */
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { AppDatabase } from '../database/database.constants';
import { pendingServerRequests } from '../database/schema';
import type { ServerRequestFailureDto } from './dto/interaction.dto';

/**
 * Reads the latest twenty scoped explanations in chronological display order.
 * Filtering and limiting happen in SQLite because failure history is retained
 * indefinitely. Generation is process-local and is not response authority.
 */
export function readRecentRequestFailures(
  db: AppDatabase,
  scope: string[] | undefined,
  generation: number,
): ServerRequestFailureDto[] {
  return db
    .select({
      instanceId: pendingServerRequests.instanceId,
      threadId: pendingServerRequests.threadId,
      turnId: pendingServerRequests.turnId,
      message: pendingServerRequests.failureReason,
    })
    .from(pendingServerRequests)
    .where(
      and(
        eq(pendingServerRequests.status, 'failed'),
        eq(pendingServerRequests.generation, generation),
        isNotNull(pendingServerRequests.instanceId),
        isNotNull(pendingServerRequests.failureReason),
        scope?.length
          ? inArray(pendingServerRequests.threadId, scope)
          : undefined,
      ),
    )
    .orderBy(
      desc(pendingServerRequests.updatedAt),
      desc(pendingServerRequests.instanceId),
    )
    .limit(20)
    .all()
    .reverse()
    .map((row) => ({
      ...row,
      instanceId: row.instanceId!,
      message: row.message!,
    }));
}
