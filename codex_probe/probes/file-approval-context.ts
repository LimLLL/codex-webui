/**
 * While a file-change approval is pending, is the thing being approved readable?
 *
 * This decides a real design question rather than satisfying curiosity. The
 * approval request carries only identities — `threadId`, `turnId`, `itemId`,
 * plus an optional reason and grant root. The proposed changes live in the
 * `item/started` event. So a client that was not receiving that conversation's
 * item stream gets an actionable card with nothing to review.
 *
 * The obvious repair is "fetch the item from history", and the obvious reason
 * to doubt it is that this project already measured persistence happening at
 * item COMPLETION. An item stalled awaiting approval has not completed. But
 * that measurement covered shell-command items, and assuming every item type
 * behaves alike is exactly the reasoning this directory exists to replace.
 *
 * The probe therefore HOLDS the approval — the agent stays genuinely blocked —
 * and reads history in that state. Answering first and reading afterwards
 * measures the post-decision world and silently answers a different question.
 *
 * It also asks a second question the renderer depends on: does one file-change
 * item describe MULTIPLE files? The browser currently keeps only the first
 * entry, so if a single approval can span several files, the user has been
 * approving writes they cannot see.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HOLD, itemType, type IncomingRequest } from '../harness';
import type { Probe } from '../run';

/** Asks for a multi-file edit through the patch tool rather than a shell write. */
const TASK =
  'Use your file-editing tool (apply_patch) to make BOTH of these edits in one go: ' +
  'in alpha.txt replace the word ALPHA with ALPHA_EDITED, and in beta.txt replace ' +
  'the word BETA with BETA_EDITED. Edit both files. Do not run shell commands to ' +
  'do it, and do not ask me anything first.';

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

/** Summarizes one proposed change without dumping an entire diff into the log. */
function describeChange(value: unknown): Record<string, unknown> {
  const change = asRecord(value);
  const diff = typeof change.diff === 'string' ? change.diff : null;
  return {
    keys: Object.keys(change).sort(),
    path: typeof change.path === 'string' ? change.path : null,
    kind: typeof change.kind === 'string' ? change.kind : null,
    hasDiff: diff !== null,
    diffLength: diff?.length ?? 0,
  };
}

export const fileApprovalContextProbe: Probe = {
  name: 'file-approval-context',
  question:
    'While a file approval is pending, can its proposed changes be read from history, and can one approval span several files?',
  needsModel: true,
  run: async ({ app, workspace }) => {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'alpha.txt'), 'ALPHA\n');
    await writeFile(path.join(workspace, 'beta.txt'), 'BETA\n');

    // Hold file-change approvals; answer everything else normally so the turn
    // is blocked by exactly the request under measurement and nothing else.
    let heldRequest: IncomingRequest | null = null;
    app.setServerResponder((request) => {
      if (request.method === 'item/fileChange/requestApproval') {
        heldRequest = request;
        return HOLD;
      }
      return request.method.endsWith('requestApproval')
        ? { decision: 'accept' }
        : {};
    });

    const started = await app.request<{ thread: { id: string } }>({
      method: 'thread/start',
      params: {
        cwd: workspace,
        // Read-only forces a write to ask; on-request is what routes it to us.
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
      },
    });
    if (started.error || !started.result)
      throw new Error(`thread/start failed: ${JSON.stringify(started.error)}`);
    const threadId = started.result.thread.id;

    const mark = app.mark();
    const turn = await app.request<{ turn: { id: string } }>({
      method: 'turn/start',
      params: {
        threadId,
        input: [{ type: 'text', text: TASK, text_elements: [] }],
      },
    });
    if (turn.error)
      throw new Error(`turn/start refused: ${JSON.stringify(turn.error)}`);

    const request = await app.waitForRequest(
      (candidate) => candidate.method === 'item/fileChange/requestApproval',
      { timeoutMs: 180_000 },
    );
    if (!request) {
      // No approval means nothing was measured. A probe that prints a verdict
      // here would be reporting the model's mood, not the protocol.
      throw new Error(
        'No file-change approval arrived. The model may have used a shell tool ' +
          'or refused the task; this run measured nothing.',
      );
    }
    heldRequest = request;
    const itemId = stringField(request.params, 'itemId');

    // The live item event, which is what a subscribed browser would have seen.
    const liveItem = app
      .since(mark)
      .filter((note) => note.method === 'item/started')
      .map((note) => asRecord(note.params).item)
      .find((item) => stringField(item, 'id') === itemId);
    const liveChanges = Array.isArray(asRecord(liveItem).changes)
      ? (asRecord(liveItem).changes as unknown[])
      : [];

    // The question: is that same item readable from history RIGHT NOW, while
    // the agent is still blocked on the approval we are holding?
    const pages: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const reply = await app.request<{
        data: Array<{ turnId: string; item: unknown }>;
        nextCursor: string | null;
      }>({
        method: 'thread/items/list',
        params: { threadId, limit: 100, ...(cursor ? { cursor } : {}) },
      });
      if (reply.error || !reply.result)
        throw new Error(
          `thread/items/list failed: ${JSON.stringify(reply.error)}`,
        );
      // Entries wrap the item alongside its turn id; the item is what carries
      // the proposed changes, so a malformed page must fail loudly rather than
      // read as "history has nothing", which is the answer under measurement.
      if (!Array.isArray(reply.result.data))
        throw new Error('thread/items/list returned no item array');
      pages.push(...reply.result.data.map((entry) => entry.item));
      if (!reply.result.nextCursor) break;
      cursor = reply.result.nextCursor;
    }
    const historyItem = pages.find(
      (item) => stringField(item, 'id') === itemId,
    );
    const historyChanges = Array.isArray(asRecord(historyItem).changes)
      ? (asRecord(historyItem).changes as unknown[])
      : [];

    console.log(
      JSON.stringify(
        {
          approvalRequestParamKeys: Object.keys(
            asRecord(request.params),
          ).sort(),
          itemId,
          liveItemType: itemType(liveItem),
          liveChangeCount: liveChanges.length,
          liveChanges: liveChanges.map(describeChange),
          historyItemPresentWhilePending: historyItem !== undefined,
          historyItemStatus:
            typeof asRecord(historyItem).status === 'string'
              ? asRecord(historyItem).status
              : null,
          historyChangeCount: historyChanges.length,
          historyChanges: historyChanges.map(describeChange),
          totalHistoryItemsWhilePending: pages.length,
        },
        null,
        2,
      ),
    );

    const multiFile = liveChanges.length > 1;
    const reviewableFromHistory =
      historyItem !== undefined && historyChanges.length === liveChanges.length;
    console.log(
      `VERDICT multi-file-single-approval=${multiFile} readable-from-history-while-pending=${reviewableFromHistory}`,
    );
    if (!reviewableFromHistory) {
      console.log(
        'CONSEQUENCE: the approval subject is NOT recoverable from history while pending. A client that did not receive the item stream cannot review it, so the backend must retain the subject alongside the pending request.',
      );
    }
    if (multiFile) {
      console.log(
        'CONSEQUENCE: one approval can cover several files, so any renderer that shows only the first change is asking the user to approve writes they cannot see.',
      );
    }

    // Decline rather than accept: the measurement is complete, and declining
    // avoids leaving edits behind in the throwaway workspace.
    app.release(request.id, { decision: 'decline' });
    const settled = await app.waitFor(
      (note) => note.method === 'turn/completed',
      { from: mark, timeoutMs: 60_000 },
    );
    console.log(`turn settled after decline: ${Boolean(settled)}`);
    if (heldRequest && app.held().length > 0)
      throw new Error('A held request was never released');
  },
};
