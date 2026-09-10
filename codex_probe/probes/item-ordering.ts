/**
 * When two items overlap, do the live and persisted orders agree?
 *
 * They do not, and the difference is load-bearing for the merge rules. A
 * streaming client renders items in `item/started` order; persistence appends
 * at item COMPLETION. Start a slow command, then a quick one, and the quick one
 * finishes first — so live reads [SLOW, QUICK] while history reads
 * [QUICK, SLOW], with no field able to reconcile them: items carry no timestamp
 * and no sequence, only turns do.
 *
 * The consequence the client encodes: live order is authoritative for items
 * live actually saw, and persisted adjacency only places items it never saw.
 * The true order of overlapping items is unrecoverable, and this project
 * refuses to fake it by inventing timestamps or sorting opaque ids.
 *
 * A second question is answered here too: does a terminal payload carry the
 * whole accumulated output or just the tail? It carries the whole thing, which
 * is why repairing a fragment is replacement and never concatenation — the
 * opposite choice silently duplicates everything already streamed.
 */
import { delay, text } from '../harness';
import type { Probe } from '../run';

/** Recognises which labelled command an item belongs to. */
function label(command: unknown): string {
  const value = text(command);
  if (value.includes('SLOW_MARKER')) return 'SLOW';
  if (value.includes('QUICK_MARKER')) return 'QUICK';
  return '???';
}

/** Formats an item as its label plus a short id. */
function tag(item: Record<string, unknown> | undefined): string {
  const id = text(item?.id).slice(0, 6);
  return `${label(item?.command)}(${id})`;
}

export const itemOrdering: Probe = {
  name: 'item-ordering',
  question: 'Does persisted item order match live order when items overlap?',
  run: async ({ app, workspace }) => {
    const start = await app.request<{ thread: { id: string } }>({
      method: 'thread/start',
      params: {
        cwd: workspace,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      },
    });
    if (start.error || !start.result) {
      console.log(`thread/start ERR ${JSON.stringify(start.error)}`);
      return;
    }
    const threadId = start.result.thread.id;

    const mark = app.mark();
    await app.request({
      method: 'thread/shellCommand',
      params: {
        threadId,
        command: 'echo SLOW_MARKER; sleep 8; echo SLOW_TAIL; sleep 8',
      },
    });
    await delay(2_500);
    await app.request({
      method: 'thread/shellCommand',
      params: {
        threadId,
        command: 'echo QUICK_MARKER',
      },
    });
    await delay(3_000);

    const liveOrder = app
      .since(mark)
      .filter((note) => note.method === 'item/started')
      .map((note) => tag(note.params.item as Record<string, unknown>));
    console.log(`LIVE order (item/started)   : ${JSON.stringify(liveOrder)}`);

    const mid = await app.request<{
      data: Array<{ item?: Record<string, unknown> }>;
    }>({ method: 'thread/items/list', params: { threadId, limit: 50 } });
    console.log(
      `persisted WHILE SLOW RUNS   : ${JSON.stringify((mid.result?.data ?? []).map((entry) => tag(entry.item)))}`,
    );

    for (let attempt = 0; attempt < 40; attempt++) {
      if (app.since(mark).some((note) => note.method === 'turn/completed'))
        break;
      await delay(1_000);
    }
    await delay(1_000);

    const completionOrder = app
      .since(mark)
      .filter((note) => note.method === 'item/completed')
      .map((note) => tag(note.params.item as Record<string, unknown>));
    console.log(
      `COMPLETION order            : ${JSON.stringify(completionOrder)}`,
    );

    const final = await app.request<{
      data: Array<{ item?: Record<string, unknown> }>;
    }>({ method: 'thread/items/list', params: { threadId, limit: 50 } });
    const persistedOrder = (final.result?.data ?? []).map((entry) =>
      tag(entry.item),
    );
    console.log(
      `persisted AFTER completion  : ${JSON.stringify(persistedOrder)}`,
    );

    const strip = (entries: string[]) =>
      entries.map((entry) => entry.split('(')[0]);
    const expectedPair = (entries: string[]) =>
      JSON.stringify(strip(entries).sort()) ===
      JSON.stringify(['QUICK', 'SLOW']);
    const started = app
      .since(mark)
      .filter((note) => note.method === 'item/started');
    const sameTurn =
      started.length === 2 &&
      typeof started[0].params.turnId === 'string' &&
      started[0].params.turnId === started[1].params.turnId;
    const sameOrder = (left: string[], right: string[]) =>
      JSON.stringify(left) === JSON.stringify(right);
    let verdict =
      'INCONCLUSIVE — need both labelled items in one turn and a successful persisted read';
    if (
      !final.error &&
      sameTurn &&
      [liveOrder, completionOrder, persistedOrder].every(expectedPair)
    ) {
      verdict = sameOrder(persistedOrder, liveOrder)
        ? 'persisted order matches LIVE/START order'
        : sameOrder(persistedOrder, completionOrder)
          ? 'persisted order matches COMPLETION order — it DIVERGES from what a live client rendered'
          : 'INCONCLUSIVE — persisted order matches neither observed order';
    }
    console.log(`\nVERDICT: ${verdict}`);

    // Terminal payload: whole accumulated output, or only the tail?
    const terminal = app
      .since(mark)
      .filter((note) => note.method === 'item/completed')
      .map((note) => (note.params.item as Record<string, unknown>) ?? {})
      .find((item) => label(item.command) === 'SLOW');
    const deltas = app
      .since(mark)
      .filter(
        (note) =>
          terminal?.id !== undefined &&
          note.method === 'item/commandExecution/outputDelta' &&
          note.params.itemId === terminal.id,
      );
    const accumulated = deltas.map((note) => text(note.params.delta)).join('');
    console.log(
      `\noutputDelta notifications for SLOW: ${deltas.length}` +
        `\nterminal aggregatedOutput: ${JSON.stringify(terminal?.aggregatedOutput)}`,
    );
    console.log(
      deltas.length >= 2 && terminal?.aggregatedOutput === accumulated
        ? 'Terminal payload equals the whole accumulated output from multiple SLOW deltas.'
        : 'INCONCLUSIVE accumulation — need multiple SLOW deltas matching the terminal output.',
    );
  },
};
