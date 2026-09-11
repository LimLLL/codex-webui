/**
 * What are a client's dispositions for a server-initiated request, and what
 * does each one actually do?
 *
 * This decides an architectural question rather than a detail. The JSON-RPC
 * client fans `serverRequest` out to observers; whether any of them answers is
 * emergent. Requests this client has no handler for — machine-facing ones, and
 * human-facing ones with no renderer — are logged and dropped. Dropping is only
 * defensible if app-server eventually gives up on its own.
 *
 * So the probe measures both halves:
 *
 *  [A] Silence. Hold an approval and watch for a bounded window. If app-server
 *      neither resolves the request nor ends the turn, "log and return" is not
 *      a disposition at all — it is an indefinite hang, and every unhandled
 *      method is a way to wedge a conversation.
 *
 *  [B] Refusal. Answer the same request with a JSON-RPC error. This is the only
 *      honest disposition available to a client that cannot satisfy a request
 *      it nonetheless received. Nothing upstream documents what app-server does
 *      with it, so production code must not assume it is safe: it could settle
 *      the turn cleanly, wedge it anyway, or kill the connection for every
 *      other conversation sharing the process.
 *
 * The window in [A] proves blocking within it, not that no timeout exists at
 * any horizon. That is the honest bound, and it is enough: a client cannot rely
 * on a timeout it has not seen.
 */
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { HOLD, rpcError, delay } from '../harness';
import type { Probe } from '../run';

/** One shell write, which a read-only sandbox must escalate rather than run. */
const TASK =
  'Run exactly one shell command: `echo probe > probe.txt`. ' +
  'Do not use apply_patch or any file-editing tool, and do not ask me anything first.';

/** How long silence is observed before concluding the turn is genuinely blocked. */
const SILENCE_WINDOW_MS = 45_000;

/**
 * Error code the upstream reference client uses to refuse a server request it
 * does not support. Matching it keeps this measurement about the disposition
 * this project would ship rather than one invented for the probe.
 */
const UNSUPPORTED_REQUEST_CODE = -32000;

/** Reads a record field without widening the generated protocol types. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads a string field, treating any other type as absent rather than coercing it. */
function stringField(value: unknown, key: string): string {
  const field = asRecord(value)[key];
  return typeof field === 'string' ? field : '';
}

export const serverRequestDisposition: Probe = {
  name: 'server-request-disposition',
  question:
    'Does an unanswered server request block the turn, and is answering it with a JSON-RPC error a safe disposition?',
  needsModel: true,
  run: async ({ app, workspace }) => {
    await mkdir(workspace, { recursive: true });

    // Hold command approvals; answer anything else normally so the turn is
    // blocked by exactly the request under measurement and nothing else.
    app.setServerResponder((request) =>
      request.method === 'item/commandExecution/requestApproval'
        ? HOLD
        : request.method.endsWith('requestApproval')
          ? { decision: 'accept' }
          : {},
    );

    const started = await app.request<{ thread: { id: string } }>({
      method: 'thread/start',
      params: {
        cwd: workspace,
        // Read-only forces the write to escalate; on-request routes it to us.
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
      },
    });
    if (started.error || !started.result)
      throw new Error(`thread/start failed: ${JSON.stringify(started.error)}`);
    const threadId = started.result.thread.id;

    const mark = app.mark();
    const requestMark = app.requests.length;
    const turn = await app.request<{ turn: { id: string } }>({
      method: 'turn/start',
      params: {
        threadId,
        input: [{ type: 'text', text: TASK, text_elements: [] }],
      },
    });
    if (turn.error || !turn.result?.turn.id)
      throw new Error(`turn/start failed: ${JSON.stringify(turn.error)}`);
    const turnId = turn.result.turn.id;

    const request = await app.waitForRequest(
      (candidate) =>
        candidate.method === 'item/commandExecution/requestApproval' &&
        candidate.params.threadId === threadId,
      { from: requestMark, timeoutMs: 180_000 },
    );
    if (!request) {
      // No approval means nothing was measured. Printing a verdict here would
      // report the model's choice of tool, not the protocol.
      throw new Error(
        'No command approval arrived. The model may have used a file-editing ' +
          'tool or refused the task; this run measured nothing.',
      );
    }

    /** True while app-server still considers the held request outstanding. */
    const settlementNotes = () =>
      app
        .since(mark)
        .filter(
          (note) =>
            (note.method === 'serverRequest/resolved' &&
              String(note.params.requestId) === String(request.id)) ||
            (note.method === 'turn/completed' &&
              stringField(note.params.turn, 'id') === turnId),
        );

    // ── [A] Silence ────────────────────────────────────────────────────────
    await delay(SILENCE_WINDOW_MS);
    const duringSilence = settlementNotes();
    const stillHeld = app.held().some((held) => held.id === request.id);
    console.log(
      JSON.stringify(
        {
          step: 'A-silence',
          windowMs: SILENCE_WINDOW_MS,
          requestId: request.id,
          requestMethod: request.method,
          stillHeldLocally: stillHeld,
          settlementNotifications: duringSilence.map((note) => note.method),
        },
        null,
        2,
      ),
    );
    const blocksOnSilence = stillHeld && duringSilence.length === 0;
    console.log(
      `VERDICT unanswered-request-blocks-turn=${blocksOnSilence} (observed for ${SILENCE_WINDOW_MS}ms)`,
    );
    if (blocksOnSilence) {
      console.log(
        'CONSEQUENCE: dropping a server request without answering wedges its turn. ' +
          'Every method the client does not handle is a way to hang a conversation, ' +
          'so the transport needs a total disposition rather than a best-effort one.',
      );
    }

    // ── [B] Refusal ────────────────────────────────────────────────────────
    const refusalMark = app.mark();
    // -32000 matches what the upstream reference client sends when it refuses a
    // server request it does not support, so this measures the disposition this
    // project would actually ship rather than an invented one.
    app.releaseWithError(
      request.id,
      rpcError(
        UNSUPPORTED_REQUEST_CODE,
        'codex-webui probe: this client cannot answer this request',
      ),
    );

    const settled = await app.waitFor(
      (note) =>
        note.method === 'turn/completed' &&
        note.params.threadId === threadId &&
        stringField(note.params.turn, 'id') === turnId,
      { from: refusalMark, timeoutMs: 120_000 },
    );
    const resolvedNote = app
      .since(refusalMark)
      .find(
        (note) =>
          note.method === 'serverRequest/resolved' &&
          String(note.params.requestId) === String(request.id),
      );

    // A refusal that settles the turn but leaves the process unusable would be
    // no better than a hang for every other conversation on the same child.
    const liveAfter = await app.request<{ thread: unknown }>({
      method: 'thread/read',
      params: { threadId },
    });
    const transportUsable = !liveAfter.error;

    console.log(
      JSON.stringify(
        {
          step: 'B-refusal',
          errorCode: UNSUPPORTED_REQUEST_CODE,
          serverRequestResolvedAfterRefusal: Boolean(resolvedNote),
          turnSettledAfterRefusal: Boolean(settled),
          turnStatus: settled
            ? stringField(settled.params.turn, 'status')
            : null,
          turnError: settled
            ? (asRecord(settled.params.turn).error ?? null)
            : null,
          transportUsableAfterRefusal: transportUsable,
          transportReadError: liveAfter.error ?? null,
        },
        null,
        2,
      ),
    );
    console.log(
      `VERDICT refusal-settles-turn=${Boolean(settled)} transport-survives-refusal=${transportUsable}`,
    );
    if (settled && transportUsable) {
      console.log(
        'CONSEQUENCE: a JSON-RPC error is a safe terminal disposition. A client that ' +
          'cannot answer a request should refuse it explicitly rather than stay silent.',
      );
    } else if (!settled) {
      console.log(
        'CONSEQUENCE: refusing does NOT settle the turn, so an error reply is not a ' +
          'sufficient fallback on its own and the unanswerable case needs another route.',
      );
    }

    assert.ok(app.held().length === 0, 'A held request was never released');
  },
};
