/** Tests whether a two-path notification proves a rename rather than delete+create. No model is used. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { delay } from '../harness';
import type { Probe } from '../run';

export const fsWatchClassification: Probe = {
  name: 'fs-watch-classification',
  question:
    'Can unrelated delete/create be distinguished from rename using changedPaths alone?',
  run: async ({ app, workspace }) => {
    const root = path.join(workspace, 'classification');
    mkdirSync(root);
    const watchId = 'classification-directory';
    const watched = await app.request({
      method: 'fs/watch',
      params: { path: root, watchId },
    });
    if (watched.error) throw new Error(watched.error.message);
    try {
      for (const operation of ['rename', 'delete-create'] as const) {
        const oldPath = path.join(root, `${operation}-old.txt`);
        const newPath = path.join(root, `${operation}-new.txt`);
        const controlMark = app.mark();
        writeFileSync(oldPath, 'old contents');
        await delay(1500);
        if (
          !app
            .since(controlMark)
            .some(
              (note) =>
                note.method === 'fs/changed' && note.params.watchId === watchId,
            )
        )
          throw new Error(
            'Inconclusive: no control creation notification arrived; this environment cannot establish watch classification.',
          );
        const mark = app.mark();
        if (operation === 'rename') renameSync(oldPath, newPath);
        else {
          rmSync(oldPath);
          writeFileSync(newPath, 'unrelated contents');
        }
        await delay(1500);
        const events = app
          .since(mark)
          .filter(
            (note) =>
              note.method === 'fs/changed' && note.params.watchId === watchId,
          );
        console.log(
          operation,
          JSON.stringify(events.map((note) => note.params)),
        );
      }
    } finally {
      await app.request({ method: 'fs/unwatch', params: { watchId } });
    }
  },
};
