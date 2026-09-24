/**
 * What does `fs/watch` actually observe, and can it replace a client-side
 * filesystem watcher?
 *
 * This matters because the backend once ran chokidar and removed it: closing
 * watchers blocked the event loop on large directories, and `files.gateway.ts`
 * has been a no-op stub ever since. The vendored README documents `fs/watch`
 * only as "accepts absolute file or directory paths", which leaves every
 * property a consumer depends on unmeasured:
 *
 *   - Is watching a directory RECURSIVE? A file-tree consumer is worthless if
 *     it only sees direct children, and worse than worthless if it silently
 *     misses nested edits while appearing to work.
 *   - What is a `changedPaths` batch? One path per event, coalesced, deduped?
 *   - Does a rename report the old path, the new path, or both? Path-keyed
 *     client state can only be repaired if the old path is identifiable.
 *   - Is a delete distinguishable from a modification without a stat round trip?
 *   - Does watching need a thread, or is it connection-scoped as the README's
 *     "subscribe this connection" wording implies?
 *   - What does watching a non-existent path do, and what does re-using a
 *     `watchId` do? Both are reachable from ordinary UI state.
 *   - How expensive is `fs/unwatch`? That is the exact failure that killed the
 *     previous watcher, so an unmeasured answer here repeats the mistake.
 *   - When a watched FILE is renamed, does the watch follow the file or stay
 *     pinned to the path? "Survives replacement at the same path" is a
 *     different fact and cannot be substituted for this one.
 *   - When a watch registered on a missing directory fires as that directory
 *     appears, does it go on to report children, or only ever its own path?
 *
 * No model is involved: every step is a filesystem mutation made directly by
 * this probe, so the run is free and the timing is not confounded by a turn.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { delay } from '../harness';
import type { Note } from '../harness-types';
import type { Probe } from '../run';

/** How long to wait for a change notification before calling it absent. */
const SETTLE_MS = 1_500;

/** Collects the changed paths carried by every `fs/changed` note in a slice. */
function changedPaths(notes: Note[], watchId: string): string[] {
  return notes
    .filter(
      (note) => note.method === 'fs/changed' && note.params.watchId === watchId,
    )
    .flatMap((note) => (note.params.changedPaths as string[]) ?? []);
}

/** Prints one observation, relative to the watched root for readability. */
function report(
  tag: string,
  root: string,
  notes: Note[],
  watchId: string,
): void {
  const relevant = notes.filter(
    (note) => note.method === 'fs/changed' && note.params.watchId === watchId,
  );
  const paths = changedPaths(notes, watchId).map((p) =>
    p.startsWith(root) ? `.${p.slice(root.length)}` : p,
  );
  console.log(
    `${tag} notes=${relevant.length} paths=${paths.length} ${JSON.stringify(paths)}`,
  );
}

export const fsWatch: Probe = {
  name: 'fs-watch',
  question:
    'Is fs/watch recursive, what does changedPaths carry, and is unwatch cheap?',
  run: async ({ app, workspace }) => {
    const root = path.join(workspace, 'watched');
    const nested = path.join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });

    // [0] Watch before any thread exists. The README calls this a connection
    // subscription; if it actually requires a loaded thread, this fails here
    // and the whole "watch the browsed directory" design is unavailable.
    const watchId = 'probe-watch-0001';
    const watch = await app.request<{ path: string }>({
      method: 'fs/watch',
      params: { watchId, path: root },
    });
    console.log(
      `[0] fs/watch without a thread: ${
        watch.error
          ? `ERR ${JSON.stringify(watch.error)}`
          : `OK canonical=${JSON.stringify(watch.result?.path)}`
      }`,
    );
    if (watch.error) return;

    // [1] Direct child creation — the minimum a directory watch must report.
    let mark = app.mark();
    writeFileSync(path.join(root, 'direct.txt'), 'one');
    await delay(SETTLE_MS);
    report('[1] direct child created ', root, app.since(mark), watchId);

    // [2] Nested creation. This is the recursion question, and it decides
    // whether one watch per browsed directory is enough or whether every
    // expanded subtree needs its own.
    mark = app.mark();
    writeFileSync(path.join(nested, 'deep.txt'), 'two');
    await delay(SETTLE_MS);
    report('[2] nested child created', root, app.since(mark), watchId);

    // [3] Modify an existing file. Distinguishable from creation?
    mark = app.mark();
    writeFileSync(path.join(root, 'direct.txt'), 'one-modified');
    await delay(SETTLE_MS);
    report('[3] direct child modified', root, app.since(mark), watchId);

    // [4] Rename within the watched tree. Path-keyed client state can only be
    // repaired if the OLD path is reported; if only the new path arrives, a
    // reconciler cannot tell a rename from an unrelated creation.
    mark = app.mark();
    renameSync(path.join(root, 'direct.txt'), path.join(root, 'renamed.txt'));
    await delay(SETTLE_MS);
    report('[4] renamed within tree  ', root, app.since(mark), watchId);

    // [5] Directory rename — the case that motivated this entire investigation.
    mark = app.mark();
    renameSync(path.join(root, 'a'), path.join(root, 'a-renamed'));
    await delay(SETTLE_MS);
    report('[5] directory renamed    ', root, app.since(mark), watchId);

    // [6] Delete. Again: distinguishable from a write without stat'ing?
    mark = app.mark();
    rmSync(path.join(root, 'renamed.txt'));
    await delay(SETTLE_MS);
    report('[6] file deleted         ', root, app.since(mark), watchId);

    // [7] Burst. A file explorer sits over directories that tools rewrite in
    // bulk; whether 50 writes arrive as 50 notifications or one coalesced batch
    // decides whether the consumer needs its own debounce.
    mark = app.mark();
    for (let i = 0; i < 50; i += 1)
      writeFileSync(path.join(root, `burst-${i}.txt`), String(i));
    await delay(SETTLE_MS * 2);
    const burst = app.since(mark);
    const burstPaths = changedPaths(burst, watchId);
    console.log(
      `[7] 50 writes            notes=${
        burst.filter((n) => n.method === 'fs/changed').length
      } paths=${burstPaths.length} unique=${new Set(burstPaths).size}`,
    );

    // [8] Re-using a live watchId on a different path. Reachable whenever the
    // UI re-watches while navigating; silent replacement and silent ignore look
    // identical to the caller and have opposite consequences.
    const second = path.join(workspace, 'watched-2');
    mkdirSync(second, { recursive: true });
    const rewatch = await app.request<{ path: string }>({
      method: 'fs/watch',
      params: { watchId, path: second },
    });
    console.log(
      `[8] re-used watchId      ${
        rewatch.error
          ? `ERR ${JSON.stringify(rewatch.error)}`
          : `OK canonical=${JSON.stringify(rewatch.result?.path)}`
      }`,
    );
    mark = app.mark();
    writeFileSync(path.join(root, 'after-rewatch.txt'), 'x');
    writeFileSync(path.join(second, 'in-second.txt'), 'y');
    await delay(SETTLE_MS);
    report('    after re-use       ', workspace, app.since(mark), watchId);

    // [9] Watching a path that does not exist. The browser can hold a stale
    // directory, so this is an ordinary state, not an abuse.
    const missing = await app.request({
      method: 'fs/watch',
      params: {
        watchId: 'probe-watch-missing',
        path: path.join(workspace, 'nope'),
      },
    });
    console.log(
      `[9] watch missing path   ${
        missing.error
          ? `ERR ${JSON.stringify(missing.error)}`
          : `OK ${JSON.stringify(missing.result)}`
      }`,
    );

    // [10] Unwatch cost. This is the measurement that decides the design: the
    // previous in-process watcher was removed because teardown blocked. Watch a
    // deliberately large tree, then time the release.
    const big = path.join(workspace, 'big');
    for (let d = 0; d < 40; d += 1) {
      const dir = path.join(big, `dir-${d}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 50; f += 1)
        writeFileSync(path.join(dir, `f-${f}.txt`), 'x');
    }
    const bigWatchStart = Date.now();
    const bigWatch = await app.request({
      method: 'fs/watch',
      params: { watchId: 'probe-watch-big', path: big },
    });
    const watchMs = Date.now() - bigWatchStart;
    const unwatchStart = Date.now();
    const bigUnwatch = await app.request({
      method: 'fs/unwatch',
      params: { watchId: 'probe-watch-big' },
    });
    const unwatchMs = Date.now() - unwatchStart;
    console.log(
      `[10] 2000-file tree: watch=${watchMs}ms${
        bigWatch.error ? ` ERR ${JSON.stringify(bigWatch.error)}` : ''
      } unwatch=${unwatchMs}ms${
        bigUnwatch.error ? ` ERR ${JSON.stringify(bigUnwatch.error)}` : ''
      }`,
    );

    // [11] Does unwatch actually stop delivery, and is unwatching an unknown
    // id an error? A reconnecting client will do both.
    await app.request({ method: 'fs/unwatch', params: { watchId } });
    mark = app.mark();
    writeFileSync(path.join(second, 'after-unwatch.txt'), 'z');
    await delay(SETTLE_MS);
    console.log(
      `[11] after unwatch       notes=${
        app.since(mark).filter((n) => n.method === 'fs/changed').length
      }`,
    );
    const unknown = await app.request({
      method: 'fs/unwatch',
      params: { watchId: 'probe-watch-never-existed' },
    });
    console.log(
      `     unwatch unknown id  ${
        unknown.error
          ? `ERR ${JSON.stringify(unknown.error)}`
          : `OK ${JSON.stringify(unknown.result)}`
      }`,
    );

    // [12] Watching a FILE directly. The design this probe feeds wants one
    // watch per open document so an externally modified buffer can be detected
    // without watching whole trees, and the README's claim that a file watch
    // survives "replace or rename operations" is exactly the fragile part:
    // editors that write via temp-file-plus-rename replace the inode.
    const doc = path.join(workspace, 'doc.txt');
    writeFileSync(doc, 'v1');
    const fileWatch = await app.request<{ path: string }>({
      method: 'fs/watch',
      params: { watchId: 'probe-watch-file', path: doc },
    });
    console.log(
      `[12] watch a file        ${
        fileWatch.error ? `ERR ${JSON.stringify(fileWatch.error)}` : 'OK'
      }`,
    );
    mark = app.mark();
    writeFileSync(doc, 'v2');
    await delay(SETTLE_MS);
    report(
      '     in-place write   ',
      workspace,
      app.since(mark),
      'probe-watch-file',
    );

    // Replace via rename: the inode changes under the watched path.
    mark = app.mark();
    writeFileSync(`${doc}.tmp`, 'v3');
    renameSync(`${doc}.tmp`, doc);
    await delay(SETTLE_MS);
    report(
      '     replaced by rename',
      workspace,
      app.since(mark),
      'probe-watch-file',
    );

    // And again, to see whether the watch survived the first replacement.
    mark = app.mark();
    writeFileSync(`${doc}.tmp`, 'v4');
    renameSync(`${doc}.tmp`, doc);
    await delay(SETTLE_MS);
    report(
      '     replaced again   ',
      workspace,
      app.since(mark),
      'probe-watch-file',
    );

    // [13] Does a watch registered on a missing path start reporting once the
    // path appears? Step [9] accepted it silently, so this decides whether that
    // acceptance is useful or a trap.
    mark = app.mark();
    mkdirSync(path.join(workspace, 'nope'), { recursive: true });
    writeFileSync(path.join(workspace, 'nope', 'appeared.txt'), 'x');
    await delay(SETTLE_MS * 2);
    report(
      '[13] missing path created',
      workspace,
      app.since(mark),
      'probe-watch-missing',
    );

    // [14] Is the rename pair's order stable? Step [4] observed old-then-new
    // once, and a reconciler that trusts position would be wrong half the time
    // if the order is incidental. Repeat it.
    const orderRoot = path.join(workspace, 'order');
    mkdirSync(orderRoot, { recursive: true });
    await app.request({
      method: 'fs/watch',
      params: { watchId: 'probe-watch-order', path: orderRoot },
    });
    for (let i = 0; i < 5; i += 1) {
      const from = path.join(orderRoot, `from-${i}.txt`);
      writeFileSync(from, 'x');
      await delay(400);
      mark = app.mark();
      renameSync(from, path.join(orderRoot, `to-${i}.txt`));
      await delay(SETTLE_MS);
      const paths = changedPaths(app.since(mark), 'probe-watch-order').map(
        (p) => path.basename(p),
      );
      console.log(`[14.${i}] rename pair order  ${JSON.stringify(paths)}`);
    }

    // [15] Does a FILE watch follow its file to a new name, stay pinned to the
    // watched path, or die? Step [12] only proved a watch survives replacement
    // AT THE SAME PATH, which is a different fact. The reconciler's document
    // watches depend on this: if the watch follows, re-acquiring after a rename
    // double-watches; if it stays pinned, a renamed document silently stops
    // being observed; if it dies, re-acquisition is mandatory.
    const rn = path.join(workspace, 'rename-follow');
    mkdirSync(rn, { recursive: true });
    const before = path.join(rn, 'before.txt');
    const after = path.join(rn, 'after.txt');
    writeFileSync(before, 'v1');
    await app.request({
      method: 'fs/watch',
      params: { watchId: 'probe-watch-follow', path: before },
    });
    mark = app.mark();
    writeFileSync(before, 'v2');
    await delay(SETTLE_MS);
    report(
      '[15] baseline write     ',
      rn,
      app.since(mark),
      'probe-watch-follow',
    );

    mark = app.mark();
    renameSync(before, after);
    await delay(SETTLE_MS);
    report(
      '     the rename itself  ',
      rn,
      app.since(mark),
      'probe-watch-follow',
    );

    // Write to the NEW name. Reported => the watch followed the file.
    mark = app.mark();
    writeFileSync(after, 'v3');
    await delay(SETTLE_MS);
    report(
      '     write to new name  ',
      rn,
      app.since(mark),
      'probe-watch-follow',
    );

    // Recreate the OLD name. Reported => the watch stayed pinned to the path.
    mark = app.mark();
    writeFileSync(before, 'fresh');
    await delay(SETTLE_MS);
    report(
      '     recreate old name  ',
      rn,
      app.since(mark),
      'probe-watch-follow',
    );

    // [16] Separate "reports only the watched path itself" from "coalesced the
    // child into the same batch". Step [13] created the directory and wrote a
    // child together, so one notification carrying only the directory could
    // mean either. Here the two events are separated by a settle window.
    const late = path.join(workspace, 'late-dir');
    await app.request({
      method: 'fs/watch',
      params: { watchId: 'probe-watch-late', path: late },
    });
    mark = app.mark();
    mkdirSync(late, { recursive: true });
    await delay(SETTLE_MS * 2);
    report(
      '[16] dir appears alone  ',
      workspace,
      app.since(mark),
      'probe-watch-late',
    );

    mark = app.mark();
    writeFileSync(path.join(late, 'child.txt'), 'x');
    await delay(SETTLE_MS * 2);
    report(
      '     child written later',
      workspace,
      app.since(mark),
      'probe-watch-late',
    );

    console.log(
      `\n[notifications] ${[...new Set(app.notes.map((n) => n.method))].join(', ')}`,
    );
  },
};
