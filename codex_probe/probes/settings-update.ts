/**
 * What does `thread/settings/update` accept, and does a global config reload
 * reach a thread that is already loaded?
 *
 * Neither question is answerable from the vendored README or the generated
 * schema: the method is not exported at all, and the README's claim that
 * `reloadUserConfig` hot-reloads loaded threads was measured to be false for
 * approval policy and sandbox mode. That second result is the entire root cause
 * of "I granted full access and it still asked me to approve" — the badge was
 * writing global config at a conversation that could not hear it.
 *
 * Step [2] sends a deliberately unknown field, and the answer is the point:
 * it is accepted with an empty result. Unknown fields are IGNORED SILENTLY —
 * a misspelled field name produces no error, no warning, and no effect. That
 * is why the REST boundary in front of this validates against an allowlist
 * instead of forwarding what it is given, and why the accepted surface has to
 * be learned by trying fields one at a time rather than by reading an error.
 */
import { delay } from '../harness';
import type { Probe } from '../run';

/** Prints a reply as either its error or its result. */
function show(tag: string, reply: { error?: unknown; result?: unknown }): void {
  console.log(
    `${tag} ${reply.error ? `ERR ${JSON.stringify(reply.error)}` : `OK ${JSON.stringify(reply.result)}`}`,
  );
}

export const settingsUpdate: Probe = {
  name: 'settings-update',
  question:
    'Which fields does thread/settings/update accept, and does reloadUserConfig reach a loaded thread?',
  run: async ({ app, workspace }) => {
    const config = await app.request<{ config: Record<string, unknown> }>({
      method: 'config/read',
      params: {},
    });
    console.log(
      `[0] config approval_policy=${JSON.stringify(config.result?.config?.approval_policy)}` +
        ` sandbox_mode=${JSON.stringify(config.result?.config?.sandbox_mode)}`,
    );

    const start = await app.request<{ thread: { id: string } }>({
      method: 'thread/start',
      params: {
        cwd: workspace,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
      },
    });
    if (start.error || !start.result) {
      console.log(`[1] thread/start ERR ${JSON.stringify(start.error)}`);
      return;
    }
    const threadId = start.result.thread.id;
    console.log(`[1] thread started on on-request / read-only`);

    show(
      '[2] unknown-field probe ',
      await app.requestRaw('thread/settings/update', {
        threadId,
        __probeUnknownField: 1,
      }),
    );

    let mark = app.mark();
    show(
      '[3] approvalPolicy=never',
      await app.requestRaw('thread/settings/update', {
        threadId,
        approvalPolicy: 'never',
      }),
    );
    await delay(400);
    reportSettings(app.since(mark));

    mark = app.mark();
    show(
      '[4] sandboxPolicy=dangerFullAccess',
      await app.requestRaw('thread/settings/update', {
        threadId,
        sandboxPolicy: { type: 'dangerFullAccess' },
      }),
    );
    await delay(400);
    reportSettings(app.since(mark));

    // This thread already has explicit overrides, so absence of a notification
    // here cannot distinguish precedence from global reload behavior. This
    // measures notification delivery only; the no-overrides control experiment
    // is still needed to reproduce the broader config-default finding.
    mark = app.mark();
    show(
      '[5] batchWrite + reloadUserConfig',
      await app.request({
        method: 'config/batchWrite',
        params: {
          edits: [
            {
              keyPath: 'approval_policy',
              value: 'on-request',
              mergeStrategy: 'replace',
            },
            {
              keyPath: 'sandbox_mode',
              value: 'workspace-write',
              mergeStrategy: 'replace',
            },
          ],
          reloadUserConfig: true,
        },
      }),
    );
    await delay(1_500);
    const reloadNote = app
      .since(mark)
      .find((note) => note.method === 'thread/settings/updated');
    console.log(
      `    thread/settings/updated after reload? ${reloadNote ? 'YES' : 'NO within 1.5s; effective policy was not read'}`,
    );

    console.log(
      `\n[notifications] ${app.notes.map((note) => note.method).join(', ')}`,
    );
  },
};

/** Prints the effective settings carried by the newest settings notification. */
function reportSettings(
  notes: Array<{ method: string; params: Record<string, unknown> }>,
): void {
  console.log(
    `    notifications: ${JSON.stringify(notes.map((note) => note.method))}`,
  );
  const note = [...notes]
    .reverse()
    .find((entry) => entry.method === 'thread/settings/updated');
  if (note)
    console.log(`    effective: ${JSON.stringify(note.params.threadSettings)}`);
}
