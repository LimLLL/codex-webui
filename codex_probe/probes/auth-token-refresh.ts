/**
 * Does app-server really ask the client to refresh external ChatGPT tokens, and
 * does refusing beat staying silent?
 *
 * `account/chatgptAuthTokens/refresh` is currently classified as machine-facing
 * and dropped without a reply. The reasoning behind calling it "reachable" is
 * sound — this auth mode is documented as EXTERNAL, meaning the client owns the
 * tokens and Codex explicitly does not refresh them — but reasoning is exactly
 * what this directory exists to replace.
 *
 * The trigger is an expired credential, so the probe logs in with a
 * deliberately dead token and starts a turn. No inference happens and no tokens
 * are spent: the upstream call fails at authentication before any model work.
 *
 * The first version of this probe assumed silence meant an indefinite hang and
 * was wrong in a way that changes the design: app-server abandons the request
 * on its own timeout and RETRIES, issuing a fresh request each round. So the
 * real question is not "does it hang" but which disposition serves the user
 * better, and that is a comparison rather than a yes/no:
 *
 *  [A] Silence — what the client does today. Measures how many requests get
 *      issued, how long each round takes, and how long the turn survives.
 *  [B] Immediate refusal — the only honest answer a client holding no refresh
 *      token can give. Measures whether it fails faster and more clearly.
 *
 * Whichever is better, the comparison also settles whether refusing is safe at
 * all: an error reply that killed the connection would take every other
 * conversation on the same process down with it.
 */
import { rpcError, HOLD, delay } from '../harness';
import type { Probe } from '../run';

/** Long enough to span app-server's own timeout and at least one retry. */
const SILENCE_WINDOW_MS = 35_000;

/** Account id claimed by the dead credential, echoed back as `previousAccountId`. */
const ACCOUNT_ID = 'probe-workspace-0000';

/** Encodes one JWT segment. */
function segment(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Builds a structurally valid but long-expired ChatGPT access token.
 *
 * Structure matters: login parses this token to extract the account's email and
 * plan, so a random string would be rejected at login and the probe would never
 * reach the condition it exists to measure. The signature is deliberately
 * meaningless — upstream rejecting it is the whole point.
 *
 * @returns A JWT that will authenticate against nothing
 */
function expiredAccessToken(): string {
  const header = segment({ alg: 'none', typ: 'JWT' });
  const payload = segment({
    // Long past, so nothing treats this as merely near expiry.
    exp: 1_000_000_000,
    iat: 999_999_000,
    email: 'probe@example.invalid',
    'https://api.openai.com/auth': {
      chatgpt_account_id: ACCOUNT_ID,
      chatgpt_plan_type: 'pro',
    },
  });
  return `${header}.${payload}.probe-signature-is-not-valid`;
}

/** Reads a record field without widening the generated protocol types. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Summarizes the terminal-ish notifications a failing turn produced. */
function describeFailures(
  notes: Array<{ method: string; params: Record<string, unknown> }>,
): unknown[] {
  return notes
    .filter(
      (note) =>
        note.method === 'error' ||
        (note.method === 'turn/completed' &&
          asRecord(note.params.turn).error !== null),
    )
    .map((note) => ({
      method: note.method,
      message: asRecord(note.params.error).message ?? null,
      additionalDetails: asRecord(note.params.error).additionalDetails ?? null,
      willRetry: note.params.willRetry ?? null,
      turnStatus: asRecord(note.params.turn).status ?? null,
    }));
}

export const authTokenRefresh: Probe = {
  name: 'auth-token-refresh',
  question:
    'Does app-server request an external token refresh, and does refusing it beat the current silence?',
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
        `chatgptAuthTokens login was refused (${JSON.stringify(login.error)}), so the ` +
          'expired-credential state was never reached and this run measured nothing.',
      );
    console.log(`[0] logged in with a dead external token`);

    /** Arrival time of every refresh request, for measuring retry cadence. */
    const refreshArrivals: number[] = [];
    let holdRefreshes = true;
    const startedAt = Date.now();

    app.setServerResponder((request) => {
      if (request.method === 'account/chatgptAuthTokens/refresh') {
        refreshArrivals.push(Date.now() - startedAt);
        // Phase A holds every round so app-server's own behaviour — not the
        // client's — is what ends each one.
        if (holdRefreshes) return HOLD;
        return rpcError(
          -32601,
          'codex-webui: this client cannot refresh ChatGPT auth tokens',
        );
      }
      return request.method.endsWith('requestApproval')
        ? { decision: 'decline' }
        : {};
    });

    /** Runs one turn against the ChatGPT backend and reports how it ended. */
    const runFailingTurn = async (label: string) => {
      const started = await app.request<{ thread: { id: string } }>({
        method: 'thread/start',
        params: {
          cwd: workspace,
          // Must target the ChatGPT-backed provider, or the dead credential is
          // never exercised regardless of what config.toml selects.
          modelProvider: 'openai',
          approvalPolicy: 'never',
          sandbox: 'read-only',
        },
      });
      if (started.error || !started.result)
        throw new Error(
          `thread/start failed: ${JSON.stringify(started.error)}`,
        );
      const threadId = started.result.thread.id;

      const mark = app.mark();
      const requestMark = app.requests.length;
      const began = Date.now();
      const turn = await app.request<{ turn: { id: string } }>({
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'Say hi.', text_elements: [] }],
        },
      });
      const turnId = turn.result?.turn.id;
      const settled = await app.waitFor(
        (note) =>
          note.method === 'turn/completed' &&
          asRecord(note.params.turn).id === turnId,
        { from: mark, timeoutMs: 180_000 },
      );
      const elapsedMs = Date.now() - began;
      const refreshCount = app.requests
        .slice(requestMark)
        .filter(
          (request) => request.method === 'account/chatgptAuthTokens/refresh',
        ).length;
      console.log(
        `[${label}] turnSettled=${Boolean(settled)} elapsedMs=${elapsedMs}` +
          ` refreshRequestsIssued=${refreshCount}` +
          ` finalTurnStatus=${JSON.stringify(settled ? asRecord(settled.params.turn).status : null)}`,
      );
      console.log(
        `[${label}] failures: ${JSON.stringify(describeFailures(app.since(mark)), null, 2)}`,
      );
      return { settled: Boolean(settled), elapsedMs, refreshCount, threadId };
    };

    // ── [A] Silence: what the client does today ────────────────────────────
    const firstRequestMark = app.requests.length;
    const silencePromise = runFailingTurn('A-silence');
    const first = await app.waitForRequest(
      (candidate) => candidate.method === 'account/chatgptAuthTokens/refresh',
      { from: firstRequestMark, timeoutMs: 90_000 },
    );
    if (!first) {
      await silencePromise;
      console.log('VERDICT refresh-request-reachable=false');
      console.log(
        'CONSEQUENCE: the expired external token did not produce a refresh request. The ' +
          '"reachable" classification is not supported by this run, and a responder must not ' +
          'be justified by it.',
      );
      return;
    }
    console.log(
      `[1] refresh request reached the client: ${JSON.stringify({ id: first.id, idType: typeof first.id, params: first.params })}`,
    );
    await delay(SILENCE_WINDOW_MS);
    console.log(
      `[2] refresh requests seen while answering none, at ms: ${JSON.stringify(refreshArrivals)}`,
    );
    const silence = await silencePromise;

    // Held rounds are abandoned by app-server rather than by the probe, but the
    // harness still tracks them; clearing them keeps phase B unambiguous.
    for (const held of app.held())
      app.releaseWithError(
        held.id,
        rpcError(-32601, 'codex-webui probe: phase A cleanup'),
      );

    // ── [B] Immediate refusal ──────────────────────────────────────────────
    holdRefreshes = false;
    refreshArrivals.length = 0;
    const refusal = await runFailingTurn('B-refusal');

    // A refusal that settles the turn but wrecks the process would be worse
    // than the hang it replaces, because one conversation would take out all.
    const stillUsable = !(
      await app.request({ method: 'thread/list', params: {} })
    ).error;

    console.log(
      `\nVERDICT refresh-request-reachable=true` +
        ` silence-settles=${silence.settled} silence-ms=${silence.elapsedMs} silence-requests=${silence.refreshCount}` +
        ` refusal-settles=${refusal.settled} refusal-ms=${refusal.elapsedMs} refusal-requests=${refusal.refreshCount}` +
        ` transport-survives-refusal=${stillUsable}`,
    );
    if (
      refusal.settled &&
      stillUsable &&
      refusal.elapsedMs < silence.elapsedMs
    ) {
      console.log(
        'CONSEQUENCE: refusing is strictly better than silence — the turn fails sooner, with a ' +
          'reported error, and the process keeps serving every other conversation. The client ' +
          'must answer this request explicitly rather than dropping it.',
      );
    } else if (refusal.settled && stillUsable) {
      console.log(
        'CONSEQUENCE: refusing is safe and produces a reported failure, but does not shorten it. ' +
          'It is still the correct disposition, because silence relies on a server-side timeout ' +
          'the client does not control.',
      );
    } else if (!stillUsable) {
      console.log(
        'CONSEQUENCE: refusing damaged the transport. An error reply is NOT a safe fallback and ' +
          'the unanswerable case needs a different route entirely.',
      );
    }
  },
};
