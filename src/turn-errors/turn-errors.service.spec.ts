import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { AppDatabase } from '../database/database.constants';
import * as schema from '../database/schema';
import { TurnErrorsService } from './turn-errors.service';

describe('TurnErrorsService', () => {
  let sqlite: Database.Database;
  let emitter: EventEmitter;
  let service: TurnErrorsService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE turn_errors (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_id)
      );
      CREATE INDEX idx_turn_errors_thread ON turn_errors (thread_id);
    `);
    emitter = new EventEmitter();
    const db = drizzle(sqlite, { schema }) as AppDatabase;
    const branches = {
      resolveProvenance: (threadId: string) => ({
        threadIds: [threadId],
        inheritedTurnIds: null,
      }),
    };
    service = new TurnErrorsService(
      emitter as unknown as CodexProcessManager,
      branches as never,
      db,
    );
    service.onModuleInit();
  });

  afterEach(() => sqlite.close());

  function emit(method: string, params: Record<string, unknown>): void {
    emitter.emit('notification', { method, params });
  }

  it('ignores retryable errors', () => {
    emit('error', {
      threadId: 't1',
      turnId: 'turn1',
      willRetry: true,
      error: { message: 'transient' },
    });
    expect(service.readThreadErrors('t1').errors).toHaveLength(0);
  });

  it('persists final error notifications', () => {
    emit('error', {
      threadId: 't1',
      turnId: 'turn1',
      willRetry: false,
      error: { message: 'fatal' },
    });
    const result = service.readThreadErrors('t1');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      turnId: 'turn1',
      message: 'fatal',
    });
  });

  it('persists failed turn/completed', () => {
    emit('turn/completed', {
      threadId: 't1',
      turn: { id: 'turn1', status: 'failed', error: { message: 'turn fail' } },
    });
    expect(service.readThreadErrors('t1').errors).toMatchObject([
      { turnId: 'turn1', message: 'turn fail' },
    ]);
  });

  it('ignores non-failed turn/completed', () => {
    emit('turn/completed', {
      threadId: 't1',
      turn: { id: 'turn1', status: 'completed', error: null },
    });
    expect(service.readThreadErrors('t1').errors).toHaveLength(0);
  });

  it('upserts — last error for same turn wins', () => {
    emit('error', {
      threadId: 't1',
      turnId: 'turn1',
      willRetry: false,
      error: { message: 'first' },
    });
    emit('turn/completed', {
      threadId: 't1',
      turn: { id: 'turn1', status: 'failed', error: { message: 'second' } },
    });
    const errors = service.readThreadErrors('t1').errors;
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('second');
  });

  it('ignores error notifications without turnId', () => {
    emit('error', {
      threadId: 't1',
      willRetry: false,
      error: { message: 'no turn' },
    });
    expect(service.readThreadErrors('t1').errors).toHaveLength(0);
  });

  it('returns errors ordered by createdAt', () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2000);
    emit('error', {
      threadId: 't1',
      turnId: 'turn1',
      willRetry: false,
      error: { message: 'a' },
    });
    emit('error', {
      threadId: 't1',
      turnId: 'turn2',
      willRetry: false,
      error: { message: 'b' },
    });
    nowSpy.mockRestore();
    const errors = service.readThreadErrors('t1').errors;
    expect(errors).toHaveLength(2);
    expect(errors[0].turnId).toBe('turn1');
    expect(errors[1].turnId).toBe('turn2');
  });
});
