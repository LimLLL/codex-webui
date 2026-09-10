/**
 * Confirmation must mean "the settings the user asked for are in force".
 *
 * Comparing only the sandbox variant tag looked right and was not: two
 * `workspaceWrite` policies with different writable roots, or with network
 * access flipped, authorize materially different things. Releasing Send on that
 * comparison announced a change effective while the conversation ran under a
 * different sandbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threadSecurityPolicyReadSecurityPolicy } from '@/generated/api/sdk.gen';
import {
  applyThreadPolicy,
  policySatisfies,
  refreshThreadPolicy,
  settleIfObserved,
  sandboxMode,
  useThreadPolicyStore,
} from './thread-policy-store';
import type {
  PatchThreadSecurityPolicyDto,
  ThreadSecurityPolicyDto,
} from '@/generated/api';

vi.mock('@/generated/api/sdk.gen', () => ({
  threadSecurityPolicyReadSecurityPolicy: vi.fn(),
}));
vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: vi.fn() }));

/** Holds one response so tests can deliver it after a competing operation. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('policy request ordering', () => {
  const read = vi.mocked(threadSecurityPolicyReadSecurityPolicy);
  type Reply = Awaited<
    ReturnType<typeof threadSecurityPolicyReadSecurityPolicy<true>>
  >;
  const reply = (policy: ThreadSecurityPolicyDto): Reply =>
    ({ data: policy }) as Reply;

  beforeEach(() => {
    vi.useFakeTimers();
    useThreadPolicyStore.setState({
      pendingByThread: {},
      observedByThread: {},
    });
    read.mockReset();
    read.mockResolvedValue(reply(observed()));
  });
  afterEach(() => {
    useThreadPolicyStore.getState().forgetPolicy('thread');
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not let an older patch rejection settle a newer selection', async () => {
    const oldPatch = deferred<unknown>();
    const newPatch = deferred<unknown>();
    const oldApply = applyThreadPolicy(
      'thread',
      { approvalPolicy: 'never' },
      () => oldPatch.promise,
    );
    const newApply = applyThreadPolicy(
      'thread',
      { approvalPolicy: 'on-request' },
      () => newPatch.promise,
    );
    oldPatch.reject(new Error('old request refused'));
    await oldApply;
    expect(
      useThreadPolicyStore.getState().pendingByThread.thread?.outcome,
    ).toBe('pending');
    newPatch.resolve({});
    await newApply;
  });

  it('uses newer evidence when a deadline read resolves out of order', async () => {
    await applyThreadPolicy(
      'thread',
      { approvalPolicy: 'never' },
      async () => ({}),
    );
    const expiry = deferred<Reply>();
    read.mockReturnValueOnce(expiry.promise);
    await vi.advanceTimersByTimeAsync(8_000);
    await refreshThreadPolicy('thread'); // Fresh mismatch, newer than the expiry read.
    expiry.resolve(reply(observed({ approvalPolicy: 'never' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      useThreadPolicyStore.getState().observedByThread.thread?.policy
        .approvalPolicy,
    ).toBe('on-request');
    expect(
      useThreadPolicyStore.getState().pendingByThread.thread?.outcome,
    ).toBe('ineffective');
  });

  it('does not let an expired selection settle its replacement', async () => {
    await applyThreadPolicy(
      'thread',
      { approvalPolicy: 'never' },
      async () => ({}),
    );
    const expiry = deferred<Reply>();
    read.mockReturnValueOnce(expiry.promise);
    await vi.advanceTimersByTimeAsync(8_000);
    await applyThreadPolicy(
      'thread',
      { approvalPolicy: 'never' },
      async () => ({}),
    );
    expiry.resolve(reply(observed()));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      useThreadPolicyStore.getState().pendingByThread.thread?.outcome,
    ).toBe('pending');
  });

  it('does not publish a response issued before a newer read still in flight', async () => {
    const older = deferred<Reply>();
    const newer = deferred<Reply>();
    read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = refreshThreadPolicy('thread');
    const second = refreshThreadPolicy('thread');
    older.resolve(reply(observed({ approvalPolicy: 'never' })));
    await first;
    expect(
      useThreadPolicyStore.getState().observedByThread.thread,
    ).toBeUndefined();
    newer.resolve(reply(observed()));
    await second;
  });

  it('ends with unknown when the final policy read hangs', async () => {
    await applyThreadPolicy(
      'thread',
      { approvalPolicy: 'never' },
      async () => ({}),
    );
    read.mockImplementationOnce(
      (options) =>
        new Promise<never>((_, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    await vi.advanceTimersByTimeAsync(16_000);
    expect(
      useThreadPolicyStore.getState().pendingByThread.thread?.outcome,
    ).toBe('unknown');
  });

  it('does not call a lost PATCH response a refusal', async () => {
    read.mockResolvedValue(reply(observed({ approvalPolicy: 'never' })));
    await applyThreadPolicy('thread', { approvalPolicy: 'never' }, async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(
      useThreadPolicyStore.getState().pendingByThread.thread,
    ).toBeUndefined();
    expect(
      useThreadPolicyStore.getState().observedByThread.thread?.policy
        .approvalPolicy,
    ).toBe('never');
  });

  it('reports an explicit REST boundary refusal as rejected', async () => {
    await applyThreadPolicy('thread', { approvalPolicy: 'never' }, async () => {
      throw { statusCode: 409, errorCode: 'threads.thread_not_loaded' };
    });
    expect(
      useThreadPolicyStore.getState().pendingByThread.thread?.outcome,
    ).toBe('rejected');
  });
});

describe('confirmation evidence freshness', () => {
  it('does not confirm from an old matching cache after a newer read fails', async () => {
    const read = vi.mocked(threadSecurityPolicyReadSecurityPolicy);
    useThreadPolicyStore.getState().forgetPolicy('freshness');
    read.mockResolvedValueOnce({
      data: observed({ approvalPolicy: 'never' }),
    } as Awaited<
      ReturnType<typeof threadSecurityPolicyReadSecurityPolicy<true>>
    >);
    await refreshThreadPolicy('freshness');
    useThreadPolicyStore
      .getState()
      .requestPolicy(
        'freshness',
        { approvalPolicy: 'never' },
        Date.now() + 8_000,
      );
    // Matching current evidence can confirm without waiting for an ACK (C).
    settleIfObserved('freshness');
    expect(
      useThreadPolicyStore.getState().pendingByThread.freshness,
    ).toBeUndefined();
    useThreadPolicyStore
      .getState()
      .requestPolicy(
        'freshness',
        { approvalPolicy: 'never' },
        Date.now() + 8_000,
      );
    read.mockRejectedValueOnce(new TypeError('network lost'));
    await refreshThreadPolicy('freshness');
    settleIfObserved('freshness');
    expect(
      useThreadPolicyStore.getState().pendingByThread.freshness?.outcome,
    ).toBe('pending');
    useThreadPolicyStore.getState().forgetPolicy('freshness');
  });
});

/** Builds an observed policy; `observed: false` models "never reported". */
function observed(
  overrides: Partial<ThreadSecurityPolicyDto> = {},
): ThreadSecurityPolicyDto {
  return {
    observed: true,
    source: 'notification',
    approvalPolicy: 'on-request',
    sandboxPolicy: null,
    approvalsReviewer: null,
    ...overrides,
  };
}

const workspaceWrite = (
  roots: string[],
  networkAccess = false,
): NonNullable<ThreadSecurityPolicyDto['sandboxPolicy']> => ({
  type: 'workspaceWrite',
  writableRoots: roots,
  networkAccess,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
});

describe('policySatisfies', () => {
  it('is never satisfied by settings the server has not reported', () => {
    const patch: PatchThreadSecurityPolicyDto = { approvalPolicy: 'never' };
    // Every field is null here because nothing was observed, which is absence
    // of evidence — not evidence that the policy is null.
    expect(policySatisfies(observed({ observed: false }), patch)).toBe(false);
    expect(policySatisfies(undefined, patch)).toBe(false);
  });

  it('confirms an approval policy only on an exact match', () => {
    expect(
      policySatisfies(observed({ approvalPolicy: 'never' }), {
        approvalPolicy: 'never',
      }),
    ).toBe(true);
    expect(
      policySatisfies(observed({ approvalPolicy: 'on-request' }), {
        approvalPolicy: 'never',
      }),
    ).toBe(false);
  });

  it('rejects a granular approval policy the picker cannot have requested', () => {
    expect(
      policySatisfies(observed({ approvalPolicy: 'never' }), {
        approvalPolicy: {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: true,
            request_permissions: true,
            mcp_elicitations: true,
          },
        },
      }),
    ).toBe(false);
  });

  it('refuses to confirm a workspace-write with different writable roots', () => {
    expect(
      policySatisfies(observed({ sandboxPolicy: workspaceWrite(['/old']) }), {
        sandboxPolicy: workspaceWrite(['/new']),
      }),
    ).toBe(false);
  });

  it('refuses to confirm a workspace-write whose network access differs', () => {
    expect(
      policySatisfies(
        observed({ sandboxPolicy: workspaceWrite(['/w'], true) }),
        {
          sandboxPolicy: workspaceWrite(['/w'], false),
        },
      ),
    ).toBe(false);
  });

  it('confirms a workspace-write when every field matches', () => {
    expect(
      policySatisfies(
        observed({ sandboxPolicy: workspaceWrite(['/w'], true) }),
        {
          sandboxPolicy: workspaceWrite(['/w'], true),
        },
      ),
    ).toBe(true);
  });

  it('compares read-only network access too', () => {
    const readOnly = (networkAccess: boolean) =>
      ({ type: 'readOnly', networkAccess }) as const;
    expect(
      policySatisfies(observed({ sandboxPolicy: readOnly(true) }), {
        sandboxPolicy: readOnly(false),
      }),
    ).toBe(false);
    expect(
      policySatisfies(observed({ sandboxPolicy: readOnly(true) }), {
        sandboxPolicy: readOnly(true),
      }),
    ).toBe(true);
  });

  it('ignores fields the patch did not name', () => {
    // Another client may change the untouched field at any time; requiring it
    // to match a remembered value would hold Send forever.
    expect(
      policySatisfies(
        observed({
          approvalPolicy: 'never',
          sandboxPolicy: workspaceWrite(['/w']),
        }),
        { approvalPolicy: 'never' },
      ),
    ).toBe(true);
  });
});

describe('sandboxMode', () => {
  it('reads the variant tag used for the badge label', () => {
    expect(sandboxMode(workspaceWrite(['/w']))).toBe('workspaceWrite');
    expect(sandboxMode(undefined)).toBeNull();
  });
});
