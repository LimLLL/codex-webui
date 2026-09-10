/** Derives restart blockers from live upstream state, never from socket subscriptions or sidebar projections. */
import { Injectable } from '@nestjs/common';
import { CodexProcessManager } from '../codex-process-manager.service';
import type { v2 } from '../codex-schema';
import { CatalogAdmissionService } from './catalog-admission.service';

export const ACTIVITY_LIMITATION =
  "Checks this managed app-server and this connection's dispatched work only. External clients and autonomous dispatch can change state after observation; this is not a global idle barrier.";

export interface CatalogBlocker {
  threadId: string | null;
  name: string | null;
  reason: string;
  processIds?: string[];
  requestMethod?: string;
  turnId?: string | null;
}
export interface CatalogBlockers {
  canApply: boolean;
  generation: number;
  blockers: CatalogBlocker[];
  scope: 'managedAppServer';
  limitations: string[];
}
interface QueuePage {
  data: unknown[];
  nextCursor: string | null;
}
interface TerminalPage {
  data: { processId: string }[];
  nextCursor: string | null;
}

@Injectable()
export class CatalogActivityService {
  constructor(
    private readonly manager: CodexProcessManager,
    private readonly admission: CatalogAdmissionService,
  ) {}
  /** Checks every loaded thread, including unmaterialized and parent-owned children, without resuming them. */
  async inspect(): Promise<CatalogBlockers> {
    const generation = this.manager.getGeneration();
    const blockers: CatalogBlocker[] = this.admission
      .pending()
      .map((reason) => ({ threadId: null, name: null, reason }));
    const client = this.manager.getClient();
    if (!client)
      return {
        canApply: false,
        generation,
        scope: 'managedAppServer',
        limitations: [ACTIVITY_LIMITATION],
        blockers: [
          ...blockers,
          {
            threadId: null,
            name: null,
            reason: 'Cannot establish idle: app-server unavailable',
          },
        ],
      };
    const localAtStart = client.acceptedWork.blockers();
    const loaded = async (): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: v2.ThreadLoadedListResponse = await client.request(
          'thread/loaded/list',
          { cursor, limit: 100 },
        );
        ids.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      return ids.sort();
    };
    try {
      const ids = await loaded();
      for (const threadId of ids) {
        try {
          const { thread } = await client.request<v2.ThreadReadResponse>(
            'thread/read',
            { threadId, includeTurns: false },
          );
          const add = (reason: string, processIds?: string[]) =>
            blockers.push({
              threadId,
              name: thread.name,
              reason,
              ...(processIds ? { processIds } : {}),
            });
          if (thread.status.type === 'active') {
            add(thread.status.activeFlags.join(', ') || 'Running turn');
            continue;
          }
          if (thread.status.type !== 'idle') {
            add('Cannot establish idle: thread is not idle');
            continue;
          }
          const terminals = await client.request<TerminalPage>(
            'thread/backgroundTerminals/list',
            { threadId, limit: 100 },
          );
          if (terminals.data.length || terminals.nextCursor)
            add(
              'Background terminals are running',
              terminals.data.map((terminal) => terminal.processId),
            );
          const goal = await client.request<v2.ThreadGoalGetResponse>(
            'thread/goal/get',
            { threadId },
          );
          if (goal.goal?.status === 'active')
            add('Active goal can continue; pause the goal first');
          const queue = await client.request<QueuePage>('thread/queue/list', {
            threadId,
            limit: 1,
          });
          if (queue.data.length || queue.nextCursor)
            add(
              'Cannot establish idle: queued submissions have no exposed paused/runnable state',
            );
        } catch (error) {
          blockers.push({
            threadId,
            name: null,
            reason: `Cannot establish idle: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (JSON.stringify(ids) !== JSON.stringify(await loaded()))
        blockers.push({
          threadId: null,
          name: null,
          reason:
            'Cannot establish idle: loaded threads changed during inspection',
        });
    } catch (error) {
      blockers.push({
        threadId: null,
        name: null,
        reason: `Cannot establish idle: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (
      generation !== this.manager.getGeneration() ||
      client !== this.manager.getClient()
    )
      blockers.push({
        threadId: null,
        name: null,
        reason: 'App-server generation changed during inspection',
      });
    // Recheck after the RPC probes: accepted work can appear while observations are in flight.
    const local = [...localAtStart, ...client.acceptedWork.blockers()];
    for (const work of local) {
      if (
        !blockers.some(
          (blocker) =>
            blocker.threadId === work.threadId &&
            blocker.turnId === work.turnId &&
            blocker.requestMethod === work.requestMethod,
        )
      ) {
        blockers.push({ ...work, name: null });
      }
    }
    return {
      canApply: blockers.length === 0,
      generation,
      blockers,
      scope: 'managedAppServer',
      limitations: [ACTIVITY_LIMITATION],
    };
  }
}
