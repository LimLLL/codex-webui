/**
 * Can a server-initiated request id repeat within one app-server connection?
 *
 * This decides whether the backend's approval response contract is sound. A
 * decision is committed against `(process generation, requestId)` — nothing
 * else. That pair is a safe identity only if ids never repeat for the lifetime
 * of a generation. If they can repeat, a browser holding a stale card can
 * commit a decision against a DIFFERENT request that later inherited the id,
 * which means approving something the user never saw.
 *
 * The suspicion is not abstract: the persistence layer upserts on that exact
 * key, which is a design that expects collisions.
 *
 * Provoking enough requests to answer this used to mean paying for model turns.
 * It does not: an expired external ChatGPT credential makes app-server ask the
 * client to refresh its token, and it asks repeatedly, across retries and
 * across turns, before giving up. That yields a dense stream of real
 * server-initiated requests with no inference and no spend.
 *
 * Reuse is most plausible at boundaries where a counter might be scoped to
 * something shorter than the connection, so the probe crosses them all:
 *
 *  1. many requests within one turn (the retry rounds),
 *  2. a second turn on the same thread,
 *  3. a different thread entirely,
 *  4. a request retired by INTERRUPTION rather than by an answer — the one path
 *     that frees an id without the client ever deciding.
 */
import { strict as assert } from 'node:assert';
import { HOLD, rpcError, delay } from '../harness';
import type { IncomingRequest } from '../harness';
import type { Probe } from '../run';

/** Account id claimed by the dead credential. */
const ACCOUNT_ID = 'probe-workspace-0000';

/** Encodes one JWT segment. */
function segment(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Builds a structurally valid but long-expired ChatGPT access token. */
function expiredAccessToken(): string {
  return [
    segment({ alg: 'none', typ: 'JWT' }),
    segment({
      exp: 1_000_000_000,
      iat: 999_999_000,
      email: 'probe@example.invalid',
      'https://api.openai.com/auth': {
        chatgpt_account_id: ACCOUNT_ID,
        chatgpt_plan_type: 'pro',
      },
    }),
    'probe-signature-is-not-valid',
  ].join('.');
}

/** Reads a record field without widening the generated protocol types. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Describes one observed request without dumping its whole payload. */
function describe(request: IncomingRequest, phase: string) {
  return {
    phase,
    id: request.id,
    idType: typeof request.id,
    method: request.method,
    arrival: request.arrival,
  };
}

export const serverRequestIdentity: Probe = {
  name: 'server-request-identity',
  question:
    'Can a server-initiated request id repeat within one connection, across turns, threads and interruption?',
  run: async ({ app, workspace }) => {
    const login = await app.request<{ type: string }>({
      method: 'account/login/start',
      params: {
        type: 'chatgptAuthTokens',
        accessToken: expiredAccessToken(),
        chatgptAccountId: ACCOUNT_ID,
        chatgptPlanType: 'pro',
      },
    });
    if (login.error)
      throw new Error(
        `chatgptAuthTokens login was refused (${JSON.stringify(login.error)}); nothing was measured`,
      );

    const observed: Array<ReturnType<typeof describe>> = [];
    let holdOne = false;
    let heldId: number | string | null = null;

    app.setServerResponder((request) => {
      if (
        holdOne &&
        heldId === null &&
        request.method === 'account/chatgptAuthTokens/refresh'
      ) {
        heldId = request.id;
        // Held so that INTERRUPTION, not a client answer, is what retires it.
        return HOLD;
      }
      return request.method === 'account/chatgptAuthTokens/refresh'
        ? rpcError(-32601, 'codex-webui probe: cannot refresh')
        : request.method.endsWith('requestApproval')
          ? { decision: 'decline' }
          : {};
    });

    /** Starts a thread whose turns will exercise the dead credential. */
    const newThread = async (): Promise<string> => {
      const started = await app.request<{ thread: { id: string } }>({
        method: 'thread/start',
        params: {
          cwd: workspace,
          modelProvider: 'openai',
          approvalPolicy: 'never',
          sandbox: 'read-only',
        },
      });
      if (started.error || !started.result)
        throw new Error(
          `thread/start failed: ${JSON.stringify(started.error)}`,
        );
      return started.result.thread.id;
    };

    /** Runs one doomed turn to completion and records every request it caused. */
    const doomedTurn = async (threadId: string, phase: string) => {
      const from = app.requests.length;
      const mark = app.mark();
      const turn = await app.request<{ turn: { id: string } }>({
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'Say hi.', text_elements: [] }],
        },
      });
      const turnId = turn.result?.turn.id;
      await app.waitFor(
        (note) =>
          note.method === 'turn/completed' &&
          asRecord(note.params.turn).id === turnId,
        { from: mark, timeoutMs: 180_000 },
      );
      for (const request of app.requests.slice(from))
        observed.push(describe(request, phase));
      return turnId;
    };

    // ── 1 & 2. Retry rounds within a turn, then a second turn ──────────────
    const threadA = await newThread();
    await doomedTurn(threadA, 'thread-A-turn-1');
    await doomedTurn(threadA, 'thread-A-turn-2');

    // ── 3. A different thread entirely ─────────────────────────────────────
    const threadB = await newThread();
    await doomedTurn(threadB, 'thread-B-turn-1');

    // ── 4. An id retired by interruption rather than by an answer ──────────
    holdOne = true;
    const from = app.requests.length;
    const mark = app.mark();
    const interrupted = await app.request<{ turn: { id: string } }>({
      method: 'turn/start',
      params: {
        threadId: threadA,
        input: [{ type: 'text', text: 'Say hi.', text_elements: [] }],
      },
    });
    const interruptedTurnId = interrupted.result?.turn.id;
    const held = await app.waitForRequest(
      (candidate) => candidate.method === 'account/chatgptAuthTokens/refresh',
      { from, timeoutMs: 90_000 },
    );
    if (!held)
      throw new Error(
        'No request arrived in the interruption phase; that boundary was not measured',
      );
    await app.request({
      method: 'turn/interrupt',
      params: { threadId: threadA, turnId: interruptedTurnId ?? '' },
    });
    const cleanup = await app.waitFor(
      (note) =>
        note.method === 'serverRequest/resolved' &&
        String(note.params.requestId) === String(held.id),
      { from: mark, timeoutMs: 60_000 },
    );
    await app.waitFor(
      (note) =>
        note.method === 'turn/completed' &&
        asRecord(note.params.turn).id === interruptedTurnId,
      { from: mark, timeoutMs: 120_000 },
    );
    await delay(1_000);
    for (const request of app.requests.slice(from))
      observed.push(describe(request, 'interrupted-turn'));
    holdOne = false;

    // A fresh turn after the interruption is where a reset counter would show.
    await doomedTurn(threadA, 'after-interrupt');

    // ── Verdict ────────────────────────────────────────────────────────────
    const ids = observed.map((entry) => String(entry.id));
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    const numeric = observed.every((entry) => entry.idType === 'number');
    const ascending =
      numeric &&
      observed.every(
        (entry, index) =>
          index === 0 || Number(entry.id) > Number(observed[index - 1].id),
      );

    console.log(
      JSON.stringify(
        {
          totalRequests: observed.length,
          distinctIds: new Set(ids).size,
          duplicateIds: [...new Set(duplicates)],
          allNumeric: numeric,
          strictlyAscending: ascending,
          firstId: observed[0]?.id ?? null,
          lastId: observed[observed.length - 1]?.id ?? null,
          interruptionEmittedServerRequestResolved: Boolean(cleanup),
          byPhase: observed.reduce<Record<string, unknown[]>>((acc, entry) => {
            (acc[entry.phase] ??= []).push(entry.id);
            return acc;
          }, {}),
        },
        null,
        2,
      ),
    );

    const unique = duplicates.length === 0;
    console.log(
      `\nVERDICT server-request-ids-unique-within-connection=${unique} strictly-ascending=${ascending}`,
    );
    if (unique) {
      console.log(
        'CONSEQUENCE: within one app-server generation the id is a sound request identity, so a ' +
          'stale decision cannot land on a different request by id reuse alone. It says nothing ' +
          'about a BACKEND restart, which resets its own generation counter independently.',
      );
    } else {
      console.log(
        'CONSEQUENCE: ids repeat, so (generation, requestId) is NOT a request identity. A response ' +
          'must carry a backend-issued instance token that a reused id cannot match.',
      );
    }

    assert.ok(
      observed.length >= 6,
      'Too few requests observed to say anything about reuse',
    );
  },
};
