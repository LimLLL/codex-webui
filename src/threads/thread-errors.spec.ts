import { CodexRpcError, CodexUnavailableError } from '../codex/codex-errors';
import {
  isDescendantRejectedError,
  isInvalidForkBoundaryError,
  isNotMaterializedError,
  isThreadServerUnavailableError,
  isUnsupportedForkBoundaryFieldError,
} from './thread-errors';

/** Builds an RPC error as app-server would return it. */
function rpc(code: number, message: string, data?: unknown): CodexRpcError {
  return new CodexRpcError({ code, message, data }, { method: 'thread/read' });
}

describe('thread-errors', () => {
  describe('isNotMaterializedError', () => {
    // Both messages are verbatim from codex-cli 0.149.1 for a thread that was
    // created but never sent to. The two history modes disagree on both the
    // wording and the error code, so matching either one alone breaks the
    // other mode's thread creation.
    it('recognizes the legacy wording', () => {
      expect(
        isNotMaterializedError(
          rpc(
            -32600,
            'thread abc is not materialized yet; includeTurns is unavailable before first user message',
          ),
        ),
      ).toBe(true);
    });

    it('recognizes the paginated wording, which names the missing call', () => {
      expect(
        isNotMaterializedError(rpc(-32601, 'list_turns is not supported yet')),
      ).toBe(true);
    });

    it('does not classify unrelated failures as unmaterialized', () => {
      expect(isNotMaterializedError(rpc(-32600, 'thread not found'))).toBe(
        false,
      );
      expect(isNotMaterializedError(new Error('socket hang up'))).toBe(false);
    });
  });

  describe('fork boundary predicates', () => {
    it('separates an unsupported field from a rejected boundary', () => {
      const unsupported = rpc(-32600, 'unknown field `beforeTurnId`');
      expect(isUnsupportedForkBoundaryFieldError(unsupported)).toBe(true);
      // Must not also match, or classification would depend on call order.
      expect(isInvalidForkBoundaryError(unsupported)).toBe(false);
    });

    it('recognizes a boundary the server refuses', () => {
      const rejected = rpc(-32600, 'turn abc is in-progress');
      expect(isInvalidForkBoundaryError(rejected)).toBe(true);
      expect(isUnsupportedForkBoundaryFieldError(rejected)).toBe(false);
    });

    it('ignores non-RPC errors', () => {
      expect(isInvalidForkBoundaryError(new Error('boom'))).toBe(false);
      expect(isUnsupportedForkBoundaryFieldError(new Error('boom'))).toBe(
        false,
      );
    });
  });

  describe('isDescendantRejectedError', () => {
    it('recognizes the delete refusal', () => {
      // Verbatim from 0.149.1 when deleting a thread that has forks.
      expect(
        isDescendantRejectedError(
          rpc(
            -32600,
            'cannot delete thread 01a0 : forked history still references it',
          ),
        ),
      ).toBe(true);
    });

    it('ignores unrelated invalid requests', () => {
      expect(isDescendantRejectedError(rpc(-32600, 'invalid limit'))).toBe(
        false,
      );
    });
  });

  describe('isThreadServerUnavailableError', () => {
    it('matches only the transport-level error', () => {
      expect(isThreadServerUnavailableError(new CodexUnavailableError())).toBe(
        true,
      );
      expect(isThreadServerUnavailableError(rpc(-32600, 'anything'))).toBe(
        false,
      );
    });
  });

  it('matches against structured data as well as the message', () => {
    expect(
      isNotMaterializedError(
        rpc(-32601, 'request failed', {
          reason: 'list_turns is not supported',
        }),
      ),
    ).toBe(true);
  });
});
