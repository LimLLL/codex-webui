/** Native RPC fixtures for history-window measurement; no application state is simulated. */
import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { v2 } from '../src/codex/codex-schema';
import { AppServer, type Note, type RpcReply } from './harness';

export type Page = v2.ThreadTurnsListResponse;
type PagedResume = v2.ThreadResumeResponse & { initialTurnsPage?: Page };

/** Reject unavailable evidence instead of treating a failed read as an empty page. */
export function result<T>(reply: RpcReply<T>): T {
  if (reply.error || reply.result === undefined)
    throw new Error(`RPC failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

/** Report complete identities so overlap is independently checkable. */
export function report(evidence: Record<string, unknown>): void {
  console.log(JSON.stringify(evidence));
}

/** Validate the part of the response on which the measurement depends. */
export function page(value: Page | undefined): Page {
  assert.ok(
    value && Array.isArray(value.data),
    'A real turns page is required',
  );
  assert.ok(value.data.every((turn) => typeof turn.id === 'string'));
  assert.ok(value.nextCursor === null || typeof value.nextCursor === 'string');
  return value;
}

/** Always cursorless: this must measure the head, never a deliberately old slice. */
export async function head(app: AppServer, threadId: string): Promise<Page> {
  return page(
    result(
      await app.request<Page>({
        method: 'thread/turns/list',
        params: {
          threadId,
          limit: 20,
          sortDirection: 'desc',
          itemsView: 'summary',
        },
      }),
    ),
  );
}

/** Mirrors the backend's first-open RPC, whose experimental page is not exported. */
export async function open(app: AppServer, threadId: string): Promise<Page> {
  const response = result(
    await app.requestRaw<PagedResume>('thread/resume', {
      threadId,
      excludeTurns: true,
      initialTurnsPage: {
        limit: 20,
        sortDirection: 'desc',
        itemsView: 'summary',
      },
    }),
  );
  assert.equal(response.thread.id, threadId);
  assert.equal(response.thread.historyMode, 'paginated');
  return page(response.initialTurnsPage);
}

function turnId(note: Note): string | undefined {
  return (note.params.turn as { id?: string } | undefined)?.id;
}

/** Waits for a matching live notification, never an unrelated turn's completion. */
async function event(
  app: AppServer,
  from: number,
  predicate: (note: Note) => boolean,
): Promise<Note> {
  const note = await app.waitFor(predicate, { from, timeoutMs: 20_000 });
  assert.ok(note, 'Required live event did not arrive');
  return note;
}

/** A real standalone shell turn; the terminal event is observed before any read. */
export async function shell(
  app: AppServer,
  threadId: string,
  command: string,
): Promise<string> {
  const mark = app.mark();
  result(
    await app.request({
      method: 'thread/shellCommand',
      params: { threadId, command },
    }),
  );
  const started = await event(
    app,
    mark,
    (note) =>
      note.method === 'turn/started' && note.params.threadId === threadId,
  );
  const id = turnId(started);
  assert.ok(id);
  const done = await event(
    app,
    mark,
    (note) =>
      note.method === 'turn/completed' &&
      note.params.threadId === threadId &&
      turnId(note) === id,
  );
  assert.equal((done.params.turn as v2.Turn).status, 'completed');
  return id;
}

/** Independent persisted-item evidence, without resuming in the reader process. */
export async function storedItems(
  app: AppServer,
  threadId: string,
  id: string,
) {
  const response = result(
    await app.request<v2.ThreadItemsListResponse>({
      method: 'thread/items/list',
      params: { threadId, turnId: id, limit: 100, sortDirection: 'asc' },
    }),
  );
  assert.ok(Array.isArray(response.data));
  assert.equal(response.nextCursor, null, 'Fixture items must fit in one page');
  assert.ok(response.data.every((entry) => entry.turnId === id));
  return response.data.map((entry) => entry.item);
}

export function overlap(a: string[], b: string[]): number {
  const ids = new Set(a);
  return b.filter((id) => ids.has(id)).length;
}

/**
 * Holds a shell item using a file released by the probe, not a guessed sleep.
 * Separately measures turn-header presence and unfinished-item persistence.
 */
export async function liveBoundary(
  owner: AppServer,
  reader: AppServer,
  threadId: string,
  workspace: string,
  knownIds: string[],
): Promise<string> {
  const mark = owner.mark();
  const command =
    'printf LIVE_START; while [ ! -f release-live ]; do sleep 0.05; done; printf LIVE_DONE';
  result(
    await owner.request({
      method: 'thread/shellCommand',
      params: { threadId, command, timeoutMs: 60_000 },
    }),
  );
  const started = await event(
    owner,
    mark,
    (note) =>
      note.method === 'turn/started' && note.params.threadId === threadId,
  );
  const id = turnId(started);
  assert.ok(id);
  const output = await event(
    owner,
    mark,
    (note) =>
      note.method === 'item/commandExecution/outputDelta' &&
      note.params.threadId === threadId &&
      note.params.turnId === id,
  );
  const itemId = output.params.itemId;
  assert.equal(typeof itemId, 'string');
  try {
    const ownerPage = await head(owner, threadId);
    const readerPage = await head(reader, threadId);
    const resumePage = await open(owner, threadId);
    const items = await storedItems(reader, threadId, id);
    assert.ok(
      !owner
        .since(mark)
        .some(
          (note) => note.method === 'turn/completed' && turnId(note) === id,
        ),
      'Shell must still be running',
    );
    report({
      case: 'live-before-item-completion',
      turnId: id,
      itemId,
      unfinishedItemPersisted: items.some((item) => item.id === itemId),
      windows: [ownerPage, readerPage, resumePage].map((value, index) => ({
        source: ['loaded-list', 'unloaded-list', 'loaded-resume'][index],
        ids: value.data.map((turn) => turn.id),
        containsLiveTurn: value.data.some((turn) => turn.id === id),
        overlapWithDurablePrefix: overlap(
          knownIds,
          value.data.map((turn) => turn.id),
        ),
      })),
    });

    const auxiliaryMark = owner.mark();
    result(
      await owner.request({
        method: 'thread/shellCommand',
        params: { threadId, command: 'printf AUX_DURABLE' },
      }),
    );
    const auxiliary = await event(
      owner,
      auxiliaryMark,
      (note) =>
        note.method === 'item/completed' &&
        note.params.threadId === threadId &&
        note.params.turnId === id,
    );
    const auxiliaryItem = auxiliary.params.item as v2.ThreadItem;
    assert.ok(
      !owner
        .since(auxiliaryMark)
        .some((note) => note.method === 'turn/started'),
    );
    const persisted = await storedItems(reader, threadId, id);
    assert.ok(
      persisted.some((item) => item.id === auxiliaryItem.id),
      'Completed auxiliary item must be independently readable',
    );
    const current = await head(reader, threadId);
    report({
      case: 'live-with-durable-item',
      turnId: id,
      auxiliaryItemId: auxiliaryItem.id,
      unfinishedItemPersisted: persisted.some((item) => item.id === itemId),
      containsLiveTurn: current.data.some((turn) => turn.id === id),
      ids: current.data.map((turn) => turn.id),
    });
  } finally {
    await writeFile(join(workspace, 'release-live'), 'release');
  }
  const done = await event(
    owner,
    mark,
    (note) =>
      note.method === 'turn/completed' &&
      note.params.threadId === threadId &&
      turnId(note) === id,
  );
  assert.equal((done.params.turn as v2.Turn).status, 'completed');
  const completed = await storedItems(reader, threadId, id);
  assert.ok(
    completed.some((item) => item.id === itemId),
    'Released shell item must become durable',
  );
  return id;
}
