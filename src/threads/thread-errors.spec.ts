import { CodexRpcError, CodexUnavailableError } from '../codex/codex-errors';
import {
  isDescendantRejectedError,
  isEmptyThreadItemsListRefusal,
  isInvalidForkBoundaryError,
  isThreadServerUnavailableError,
  isUnmaterializedThreadReadError,
  isUnmaterializedTurnsListError,
  isUnsupportedForkBoundaryFieldError,
} from './thread-errors';

/** Builds an RPC error as app-server would return it. */
function rpc(
  code: number,
  message: string,
  method = 'thread/read',
): CodexRpcError {
  return new CodexRpcError({ code, message }, { method });
}

describe('thread-errors', () => {
  describe('empty paginated history refusals', () => {
    it('recognizes the pinned turn-list refusal only on its method and code', () => {
      const message =
        'thread abc is not materialized yet; thread/turns/list is unavailable before first user message';
      expect(
        isUnmaterializedTurnsListError(
          rpc(-32600, message, 'thread/turns/list'),
        ),
      ).toBe(true);
      expect(
        isUnmaterializedTurnsListError(
          rpc(-32601, message, 'thread/turns/list'),
        ),
      ).toBe(false);
      expect(isUnmaterializedTurnsListError(rpc(-32600, message))).toBe(false);
    });

    it('recognizes the pinned item-list refusal only on its method and code', () => {
      const message = 'thread/items/list is not supported yet';
      expect(
        isEmptyThreadItemsListRefusal(
          rpc(-32601, message, 'thread/items/list'),
        ),
      ).toBe(true);
      expect(
        isEmptyThreadItemsListRefusal(
          rpc(-32600, message, 'thread/items/list'),
        ),
      ).toBe(false);
      expect(isEmptyThreadItemsListRefusal(rpc(-32601, message))).toBe(false);
    });

    it('recognizes the pinned thread-read refusal only on its method and code', () => {
      // Measured against 0.151.0: `thread/read` still names its backing call
      // and still answers -32601, unlike the turn-list wording above.
      const message = 'list_turns is not supported yet';
      expect(
        isUnmaterializedThreadReadError(rpc(-32601, message, 'thread/read')),
      ).toBe(true);
      expect(
        isUnmaterializedThreadReadError(rpc(-32600, message, 'thread/read')),
      ).toBe(false);
      expect(
        isUnmaterializedThreadReadError(
          rpc(-32601, message, 'thread/turns/list'),
        ),
      ).toBe(false);
    });

    it('keeps the three history refusals mutually exclusive', () => {
      const readRefusal = rpc(
        -32601,
        'list_turns is not supported yet',
        'thread/read',
      );
      const itemsRefusal = rpc(
        -32601,
        'thread/items/list is not supported yet',
        'thread/items/list',
      );
      expect(isEmptyThreadItemsListRefusal(readRefusal)).toBe(false);
      expect(isUnmaterializedTurnsListError(readRefusal)).toBe(false);
      expect(isUnmaterializedThreadReadError(itemsRefusal)).toBe(false);
    });

    it('does not accept near-match or non-RPC errors', () => {
      expect(
        isUnmaterializedTurnsListError(
          rpc(-32600, 'thread abc is not materialized', 'thread/turns/list'),
        ),
      ).toBe(false);
      expect(
        isUnmaterializedThreadReadError(
          rpc(-32601, 'list_turns is not supported', 'thread/read'),
        ),
      ).toBe(false);
      expect(isEmptyThreadItemsListRefusal(new Error('socket hang up'))).toBe(
        false,
      );
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
});
