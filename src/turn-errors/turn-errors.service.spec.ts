import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { AppDatabase } from '../database/database.constants';
import { createTestDatabase } from '../database/database.testing';
import { turnErrors } from '../database/schema';
import { TurnErrorsService } from './turn-errors.service';

describe('TurnErrorsService', () => {
  let sqlite: Database.Database;
  let db: AppDatabase;
  let emitter: EventEmitter;
  let service: TurnErrorsService;

  beforeEach(() => {
    const testDb = createTestDatabase();
    sqlite = testDb.sqlite;
    db = testDb.db;
    emitter = new EventEmitter();
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
      errorCategory: null,
      additionalDetails: null,
      misalignmentErrorType: null,
      misalignmentExplanation: null,
    });
    expect(typeof result.errors[0]?.createdAt).toBe('number');
  });

  it('persists structured error detail without steering data', () => {
    emit('error', {
      threadId: 't1',
      turnId: 'turn1',
      willRetry: false,
      error: {
        message: 'blocked',
        codexErrorInfo: 'misalignmentPolicyViolation',
        additionalDetails: 'policy detail',
        misalignment: {
          errorType: 'policy_conflict',
          detailedExplanation: 'explanation for the user',
          steer: { message: 'must not persist' },
        },
      },
    });

    const errors = service.readThreadErrors('t1').errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      turnId: 'turn1',
      message: 'blocked',
      errorCategory: 'misalignmentPolicyViolation',
      additionalDetails: 'policy detail',
      misalignmentErrorType: 'policy_conflict',
      misalignmentExplanation: 'explanation for the user',
    });
    expect(typeof errors[0]?.createdAt).toBe('number');
    expect(
      sqlite.prepare('select * from turn_errors where thread_id = ?').get('t1'),
    ).not.toHaveProperty('steer');
  });

  it('preserves rich detail when a later terminal notification is sparse', () => {
    emit('error', {
      threadId: 't1',
      turnId: 'turn1',
      willRetry: false,
      error: {
        message: 'initial error',
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
        additionalDetails: 'retry budget exhausted',
        misalignment: {
          errorType: 'policy_conflict',
          detailedExplanation: 'retained explanation',
          steer: null,
        },
      },
    });
    emit('turn/completed', {
      threadId: 't1',
      turn: {
        id: 'turn1',
        status: 'failed',
        error: {
          message: 'terminal summary',
          codexErrorInfo: null,
          additionalDetails: null,
          misalignment: null,
        },
      },
    });

    expect(service.readThreadErrors('t1').errors[0]).toMatchObject({
      message: 'terminal summary',
      errorCategory: 'httpConnectionFailed',
      additionalDetails: 'retry budget exhausted',
      misalignmentErrorType: 'policy_conflict',
      misalignmentExplanation: 'retained explanation',
    });
  });

  it('projects persisted structured error details for refresh hydration', () => {
    db.insert(turnErrors)
      .values({
        threadId: 't1',
        turnId: 'turn1',
        message: 'policy blocked the turn',
        errorCategory: 'misalignmentPolicyViolation',
        additionalDetails: 'The request conflicted with the active policy.',
        misalignmentErrorType: 'policy_conflict',
        misalignmentExplanation: 'The requested action was not aligned.',
        createdAt: 1000,
      })
      .run();

    expect(service.readThreadErrors('t1').errors).toEqual([
      {
        turnId: 'turn1',
        message: 'policy blocked the turn',
        errorCategory: 'misalignmentPolicyViolation',
        additionalDetails: 'The request conflicted with the active policy.',
        misalignmentErrorType: 'policy_conflict',
        misalignmentExplanation: 'The requested action was not aligned.',
        createdAt: 1000,
      },
    ]);
  });

  it('persists failed turn/completed', () => {
    emit('turn/completed', {
      threadId: 't1',
      turn: {
        id: 'turn1',
        status: 'failed',
        error: {
          message: 'turn fail',
          codexErrorInfo: 'badRequest',
          additionalDetails: 'invalid input',
          misalignment: {
            errorType: 'request_shape',
            detailedExplanation: 'The input could not be processed.',
            steer: null,
          },
        },
      },
    });
    expect(service.readThreadErrors('t1').errors).toMatchObject([
      {
        turnId: 'turn1',
        message: 'turn fail',
        errorCategory: 'badRequest',
        additionalDetails: 'invalid input',
        misalignmentErrorType: 'request_shape',
        misalignmentExplanation: 'The input could not be processed.',
      },
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
    const nowSpy = vi
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
