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
import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { HOLD, itemType } from '../harness';
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
    kind: change.kind ?? null,
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
    app.setServerResponder((request) => {
      if (request.method === 'item/fileChange/requestApproval') {
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
        candidate.method === 'item/fileChange/requestApproval' &&
        candidate.params.threadId === threadId &&
        candidate.params.turnId === turnId,
      { from: requestMark, timeoutMs: 180_000 },
    );
    if (!request) {
      // No approval means nothing was measured. A probe that prints a verdict
      // here would be reporting the model's mood, not the protocol.
      throw new Error(
        'No file-change approval arrived. The model may have used a shell tool ' +
          'or refused the task; this run measured nothing.',
      );
    }
    const itemId = stringField(request.params, 'itemId');

    assert.ok(itemId, 'The held request must identify its file item');
    /** A local HOLD alone does not prove upstream has not cancelled the request. */
    const assertStillPending = () => {
      assert.ok(
        app.held().some((held) => held.id === request.id),
        'Approval must remain held',
      );
      assert.ok(
        !app
          .since(mark)
          .some(
            (note) =>
              note.params.threadId === threadId &&
              ((note.method === 'serverRequest/resolved' &&
                String(note.params.requestId) === String(request.id)) ||
                (note.method === 'turn/completed' &&
                  stringField(note.params.turn, 'id') === turnId)),
          ),
        'The target request resolved while history was being measured',
      );
    };

    try {
      assertStillPending();
      // The question: is that same item readable from history RIGHT NOW, while
      // the agent is still blocked on the approval we are holding?
      const pages: unknown[] = [];
      let cursor: string | undefined;
      let historyComplete = false;
      for (let page = 0; page < 5; page++) {
        const reply = await app.request<{
          data: Array<{ turnId: string; item: unknown }>;
          nextCursor: string | null;
        }>({
          method: 'thread/items/list',
          params: {
            threadId,
            turnId,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
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
        for (const entry of reply.result.data) {
          assert.equal(
            entry.turnId,
            turnId,
            'History entry belongs to the target turn',
          );
          assert.ok(
            stringField(entry.item, 'id'),
            'History entry must wrap an identified item',
          );
          pages.push(entry.item);
        }
        const nextCursor = reply.result.nextCursor;
        if (nextCursor === null) {
          historyComplete = true;
          break;
        }
        assert.ok(
          typeof nextCursor === 'string' && nextCursor.length > 0,
          'History cursor is malformed',
        );
        cursor = nextCursor;
      }
      assert.ok(
        historyComplete,
        'Incomplete paging cannot establish that the pending item is absent',
      );
      assertStillPending();

      // Look after paging as well: an item may have arrived after the request.
      // Only their shared wire counter establishes precedence, not lookup time.
      const liveNote = app
        .since(mark)
        .find(
          (note) =>
            note.method === 'item/started' &&
            note.params.threadId === threadId &&
            note.params.turnId === turnId &&
            stringField(note.params.item, 'id') === itemId,
        );
      const liveItem = asRecord(liveNote?.params).item;
      const liveChanges = Array.isArray(asRecord(liveItem).changes)
        ? (asRecord(liveItem).changes as unknown[])
        : [];
      const itemPrecedesApproval = liveNote
        ? liveNote.arrival < request.arrival
        : null;
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
            itemStartedArrival: liveNote?.arrival ?? null,
            approvalArrival: request.arrival,
            itemPrecedesApproval,
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

      assert.ok(
        liveNote &&
          itemType(liveItem) === 'fileChange' &&
          liveChanges.length > 0,
        'No complete live file subject was observed; comparison is inconclusive',
      );
      for (const change of liveChanges) {
        assert.ok(
          stringField(change, 'path') &&
            typeof asRecord(change).diff === 'string',
          'Malformed live file change',
        );
        assert.ok(
          stringField(asRecord(change).kind, 'type'),
          'Change kind must remain an object union',
        );
      }
      const multiFile = liveChanges.length > 1;
      const reviewableFromHistory =
        historyItem !== undefined &&
        itemType(historyItem) === 'fileChange' &&
        isDeepStrictEqual(historyChanges, liveChanges);
      console.log(
        `VERDICT multi-file-single-approval=${multiFile} readable-from-history-while-pending=${reviewableFromHistory} item-started-precedes-approval=${itemPrecedesApproval}`,
      );
      if (!itemPrecedesApproval) {
        console.log(
          'CONSEQUENCE: the subject is NOT already on the wire when the approval arrives, so a backend that captures it from item/started has nothing to capture and must publish the approval without one rather than withhold it.',
        );
      }
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
    } finally {
      if (app.held().some((held) => held.id === request.id))
        app.release(request.id, { decision: 'decline' });
    }
    const settled = await app.waitFor(
      (note) =>
        note.method === 'turn/completed' &&
        note.params.threadId === threadId &&
        stringField(note.params.turn, 'id') === turnId,
      { from: mark, timeoutMs: 60_000 },
    );
    console.log(`turn settled after decline: ${Boolean(settled)}`);
    if (app.held().length > 0)
      throw new Error('A held request was never released');
  },
};
