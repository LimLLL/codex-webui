/** Persists terminal eligibility and bounds automatic recovery across server restarts. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { terminalIdentities, type TerminalIdentity } from '../database/schema';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';

export const AUTOMATIC_REPLACEMENT_LIMIT = 3;
export const AUTOMATIC_REPLACEMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Only this record, never a missing PTY or client-supplied launch path, permits recovery. */
@Injectable()
export class TerminalRegistryService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: AppDatabase) {}

  /** Reads known identity and checks context even when its physical session is gone. */
  get(contextKey: string, id: string): TerminalIdentity {
    const row = this.db
      .select()
      .from(terminalIdentities)
      .where(eq(terminalIdentities.id, id))
      .get();
    if (!row)
      throw BusinessException.notFound(
        ErrorCode.terminal.notFound,
        'Unknown terminal identity',
      );
    if (row.contextKey !== contextKey) {
      throw BusinessException.forbidden(
        ErrorCode.terminal.contextMismatch,
        'Terminal context mismatch',
      );
    }
    return row;
  }

  /** Rejects irrevocably closed identities before attachment or replacement. */
  requireOpen(contextKey: string, id: string): TerminalIdentity {
    const row = this.get(contextKey, id);
    if (row.closed)
      throw BusinessException.conflict(
        ErrorCode.terminal.closed,
        'Terminal was explicitly closed',
      );
    return row;
  }

  /** Records a newly created terminal before it is published to any client. */
  create(row: TerminalIdentity): void {
    this.db.insert(terminalIdentities).values(row).run();
  }

  /**
   * Charges an automatic attempt before spawning. Manual recovery does not erase
   * previous attempts. Retrying an already published session never charges again.
   */
  chargeAutomaticAttempt(contextKey: string, id: string): void {
    this.db.transaction(() => {
      const row = this.requireOpen(contextKey, id);
      const now = Date.now();
      const attempts = row.automaticAttempts.filter(
        (time) => time > now - AUTOMATIC_REPLACEMENT_WINDOW_MS,
      );
      if (attempts.length >= AUTOMATIC_REPLACEMENT_LIMIT) {
        throw BusinessException.conflict(
          ErrorCode.terminal.recoveryLimit,
          'Automatic recovery paused after three attempts in 24 hours. Start a replacement shell explicitly.',
          { retryAt: attempts[0] + AUTOMATIC_REPLACEMENT_WINDOW_MS },
        );
      }
      this.db
        .update(terminalIdentities)
        .set({ automaticAttempts: [...attempts, now] })
        .where(eq(terminalIdentities.id, id))
        .run();
    });
  }

  /** Publishes a new incarnation only while its original identity remains eligible. */
  publish(row: TerminalIdentity, sessionId: string): TerminalIdentity {
    const result = this.db
      .update(terminalIdentities)
      .set({ sessionId, generation: row.generation + 1 })
      .where(
        and(
          eq(terminalIdentities.id, row.id),
          eq(terminalIdentities.closed, false),
          eq(terminalIdentities.generation, row.generation),
        ),
      )
      .returning()
      .get();
    if (!result)
      throw BusinessException.conflict(
        ErrorCode.terminal.closed,
        'Terminal recovery was superseded',
      );
    return result;
  }

  /** Commits revocation synchronously before the caller kills the PTY or acknowledges close. */
  close(contextKey: string, id: string): void {
    // Unknown legacy identities cannot recover; closing their local view is safe and idempotent.
    if (
      !this.db
        .select({ id: terminalIdentities.id })
        .from(terminalIdentities)
        .where(eq(terminalIdentities.id, id))
        .get()
    )
      return;
    this.get(contextKey, id);
    this.db
      .update(terminalIdentities)
      .set({ closed: true })
      .where(eq(terminalIdentities.id, id))
      .run();
  }

  /** Saves the shared title so replacement preserves the user's terminal label. */
  rename(contextKey: string, id: string, title: string): void {
    this.requireOpen(contextKey, id);
    this.db
      .update(terminalIdentities)
      .set({ title })
      .where(eq(terminalIdentities.id, id))
      .run();
  }
}
