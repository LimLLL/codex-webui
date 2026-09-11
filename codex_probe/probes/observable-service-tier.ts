/**
 * Without resuming a thread, can a client read its current service tier?
 *
 * The backend caches every thread setting it observes, but only two things ever
 * write that cache: a `thread/settings/updated` notification, and a
 * start/resume/fork response. A browser that merely loses its socket for a
 * while misses the notification and never re-reads, so a tier changed by the
 * CLI or another client keeps displaying the old value indefinitely. The user
 * then believes they are on standard speed while a paid tier is in force.
 *
 * The generated schema already narrows the question: `v2.Thread` carries
 * `model` and `reasoningEffort` but NOT `serviceTier`, while `v2.ThreadSettings`
 * does. So `thread/read` cannot be the answer, and the open question is whether
 * anything other than a resume returns `ThreadSettings`.
 *
 * That matters because resume is not a free read. Cold-resuming a thread with
 * an active goal was measured to let app-server start a continuation turn on its
 * own, so "just resume to refresh the display" is not an acceptable repair. But
 * upstream documents that resuming a thread that is still LOADED rejoins it
 * rather than reloading it, and whether rejoining is inert is exactly the kind
 * of claim this directory exists to stop assuming.
 *
 * Two traps this probe is built to avoid, both of which produced false
 * negatives in its first version:
 *
 *  - A thread that has never run a turn is not materialized on disk, so resume
 *    fails with "no rollout found" and measures nothing about rejoining. The
 *    thread is therefore given a real turn first, via `thread/shellCommand`,
 *    which needs no model and spends nothing.
 *  - "No notification arrived" is only meaningful against a control that proves
 *    notifications arrive at all for this thread. An approval-policy update is
 *    already known to emit one, so it runs as that control.
 */
import { delay } from '../harness';
import type { Probe } from '../run';

/** Candidate read methods the generated `ClientRequest` union does not export. */
const UNEXPORTED_READS = [
  'thread/settings/read',
  'thread/settings/get',
  'thread/settings/list',
] as const;

/** Reads a record field without widening the generated protocol types. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Finds a service tier anywhere in a reply, without assuming where it sits.
 *
 * Deliberately recursive rather than keyed to one path: the point is to
 * discover whether the value is reachable at all, and a probe that looked only
 * where it expected would report absence for a value that was simply nested
 * somewhere else.
 *
 * @param value - Any decoded reply or notification payload
 * @param path - Accumulated location, for reporting where a hit was found
 * @param depth - Remaining recursion budget
 * @returns Every `serviceTier` found, with the path it was found at
 */
function findServiceTier(
  value: unknown,
  path = '$',
  depth = 6,
): Array<{ path: string; value: unknown }> {
  if (depth <= 0 || value === null || typeof value !== 'object') return [];
  const found: Array<{ path: string; value: unknown }> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (key === 'serviceTier') found.push({ path: childPath, value: child });
    found.push(...findServiceTier(child, childPath, depth - 1));
  }
  return found;
}

/**
 * Extracts the method list app-server enumerates when it rejects an unknown one.
 *
 * This turns an incidental diagnostic into the actual measurement: the server
 * states its entire accepted surface, which settles "does a settings read exist
 * at runtime" far more definitively than trying names one at a time ever could.
 *
 * @param message - The `Invalid request: unknown variant ...` error text
 * @returns Every method named in the enumeration, or an empty list if absent
 */
function enumeratedMethods(message: string | undefined): string[] {
  const list = message?.split('expected one of')[1];
  if (!list) return [];
  return [...list.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

export const observableServiceTier: Probe = {
  name: 'observable-service-tier',
  question:
    'Can a thread service tier be read back without resuming, and is resuming a loaded thread inert?',
  run: async ({ app, workspace }) => {
    const started = await app.request<{ thread: Record<string, unknown> }>({
      method: 'thread/start',
      params: {
        cwd: workspace,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
      },
    });
    if (started.error || !started.result)
      throw new Error(`thread/start failed: ${JSON.stringify(started.error)}`);
    const threadId = started.result.thread.id as string;
    console.log(
      `[0] thread started; start response exposes serviceTier at ${JSON.stringify(
        findServiceTier(started.result).map((hit) => hit.path),
      )}`,
    );

    // ── Materialize the thread ─────────────────────────────────────────────
    // A thread with no turn has no rollout on disk, and resume refuses it. This
    // runs a real turn without a model and without spending anything.
    const shell = await app.request({
      method: 'thread/shellCommand',
      params: { threadId, command: 'printf probe > materialize.txt' },
    });
    if (shell.error)
      throw new Error(
        `thread/shellCommand failed, so the thread was never materialized: ${JSON.stringify(shell.error)}`,
      );
    await app.waitFor(
      (note) =>
        note.method === 'turn/completed' && note.params.threadId === threadId,
      { timeoutMs: 60_000 },
    );
    console.log('[1] thread materialized by one shell turn');

    // ── 1. Does an unexported settings read exist at runtime? ──────────────
    const probeReply = await app.requestRaw(UNEXPORTED_READS[0], { threadId });
    const methods = enumeratedMethods(probeReply.error?.message);
    const settingsMethods = methods.filter((method) =>
      method.includes('settings'),
    );
    const anyUnexportedRead = UNEXPORTED_READS.some((method) =>
      methods.includes(method),
    );
    console.log(
      `[2] app-server enumerated ${methods.length} accepted methods; ` +
        `settings-related: ${JSON.stringify(settingsMethods)}; ` +
        `candidate read present: ${anyUnexportedRead}`,
    );
    if (methods.length === 0)
      throw new Error(
        'app-server did not enumerate its methods, so no conclusion about a ' +
          'settings read can be drawn from this run',
      );

    // ── 2. Does thread/read carry a tier despite the typed shape? ──────────
    const read = await app.request<{ thread: Record<string, unknown> }>({
      method: 'thread/read',
      params: { threadId },
    });
    const readTier = findServiceTier(read.result);
    console.log(
      `[3] thread/read error=${JSON.stringify(read.error ?? null)} serviceTierFound=${JSON.stringify(readTier)}`,
    );

    // ── 3. Control: a field already known to announce itself ───────────────
    let mark = app.mark();
    const control = await app.requestRaw('thread/settings/update', {
      threadId,
      approvalPolicy: 'never',
    });
    await delay(1_000);
    const controlNote = app
      .since(mark)
      .find((note) => note.method === 'thread/settings/updated');
    console.log(
      `[4] CONTROL approvalPolicy update error=${JSON.stringify(control.error ?? null)} notification=${controlNote ? 'YES' : 'NO'}`,
    );
    if (!controlNote)
      throw new Error(
        'The control update produced no settings notification, so the absence of ' +
          'one for serviceTier would prove nothing about serviceTier.',
      );

    // ── 4. Does changing the tier announce the new value? ──────────────────
    mark = app.mark();
    const update = await app.requestRaw('thread/settings/update', {
      threadId,
      serviceTier: 'priority',
    });
    await delay(1_000);
    const tierNote = app
      .since(mark)
      .find((note) => note.method === 'thread/settings/updated');
    const announcedTier = tierNote ? findServiceTier(tierNote.params) : [];
    console.log(
      `[5] serviceTier update error=${JSON.stringify(update.error ?? null)}` +
        ` notification=${tierNote ? 'YES' : 'NO'}` +
        ` announced=${JSON.stringify(announcedTier)}`,
    );

    // ── 5. Is resuming a still-loaded thread a usable, inert read? ─────────
    // An active goal is set first. The whole reason resume is under suspicion
    // as a refresh mechanism is that it can disturb autonomous work, and "no
    // turn started" does not cover a goal being cleared out from under it.
    const goalSet = await app.request({
      method: 'thread/goal/set',
      params: {
        threadId,
        objective: 'probe goal that must survive a resume',
        status: 'active',
      },
    });
    if (goalSet.error)
      throw new Error(
        `thread/goal/set failed, so goal survival was not measured: ${JSON.stringify(goalSet.error)}`,
      );
    const goalBefore = await app.request<{ goal: { status?: string } | null }>({
      method: 'thread/goal/get',
      params: { threadId },
    });
    if (goalBefore.result?.goal?.status !== 'active')
      throw new Error(
        `Goal was not active before resume (${JSON.stringify(goalBefore.result)}); nothing was measured`,
      );

    const resumeMark = app.mark();
    const resumed = await app.request<Record<string, unknown>>({
      method: 'thread/resume',
      params: { threadId, excludeTurns: true },
    });
    await delay(1_000);
    const duringResume = app.since(resumeMark).map((note) => note.method);
    const resumeTier = findServiceTier(resumed.result);
    // A read that starts work is not a read. These are the notifications that
    // would mean resuming had side effects on the conversation itself.
    const disturbed = duringResume.filter(
      (method) =>
        method === 'turn/started' ||
        method === 'turn/completed' ||
        method === 'thread/compacted',
    );
    console.log(
      `[6] thread/resume error=${JSON.stringify(resumed.error ?? null)}` +
        ` serviceTierFound=${JSON.stringify(resumeTier)}` +
        ` notifications=${JSON.stringify(duringResume)}`,
    );
    if (resumed.error)
      throw new Error(
        'Resume failed on a materialized thread, so its inertness was not measured',
      );

    const goalAfter = await app.request<{ goal: { status?: string } | null }>({
      method: 'thread/goal/get',
      params: { threadId },
    });
    const goalSurvived = goalAfter.result?.goal?.status === 'active';
    console.log(
      `[7] goal after resume: ${JSON.stringify(goalAfter.result ?? goalAfter.error)} survived=${goalSurvived}`,
    );

    // ── Verdict ────────────────────────────────────────────────────────────
    const readExposes = readTier.length > 0;
    const resumeExposes = resumeTier.length > 0;
    const resumeInert = disturbed.length === 0 && goalSurvived;
    const tierAnnounced = announcedTier.length > 0;
    console.log(
      `\nVERDICT unexported-settings-read-exists=${anyUnexportedRead}` +
        ` thread-read-exposes-tier=${readExposes}` +
        ` tier-change-announced=${tierAnnounced}` +
        ` resume-exposes-tier=${resumeExposes}` +
        ` resume-of-loaded-thread-inert=${resumeInert}` +
        ` active-goal-survives-resume=${goalSurvived}`,
    );

    if (!anyUnexportedRead && !readExposes && resumeExposes && resumeInert) {
      console.log(
        'CONSEQUENCE: resume is the only read that returns the tier, and on an already-loaded ' +
          'thread it is inert. A passive refresh may use it, but only for threads known to be ' +
          'loaded — the cold case is the one that can start a goal continuation turn.',
      );
    }
    if (!anyUnexportedRead && !readExposes && !resumeExposes) {
      console.log(
        'CONSEQUENCE: no read returns the tier at all. The observed value can only come from ' +
          'notifications, so a client that missed one cannot recover it and must present the ' +
          'display as unknown rather than as a stale value.',
      );
    }
    if (!tierAnnounced) {
      console.log(
        'CONSEQUENCE: changing the tier does NOT announce the new value even though the control ' +
          'field does, so notifications are not a complete source for it either.',
      );
    }
    if (!resumeInert) {
      console.log(
        `CONSEQUENCE: resuming a loaded thread is NOT inert (${JSON.stringify(disturbed)}), ` +
          'so it must never be used merely to refresh a display.',
      );
    }
    console.log(
      `\n[reference] accepted methods containing "settings": ${JSON.stringify(settingsMethods)}`,
    );
    console.log(
      `[reference] thread/read returned keys: ${JSON.stringify(
        Object.keys(asRecord(asRecord(read.result).thread)).sort(),
      )}`,
    );
  },
};
