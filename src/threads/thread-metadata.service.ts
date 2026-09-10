/** Shared, in-memory input to sidebar projections; never used to authorize deletion. */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import { CodexService } from '../codex/codex.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification, v2 } from '../codex/codex-schema';

/** A stored conversation together with the archive partition that listed it. */
export interface ThreadMetadataEntry {
  thread: v2.Thread;
  archived: boolean;
}

/** Freshness describes the metadata collection, not an atomic upstream database snapshot. */
export interface ThreadMetadataFreshness {
  generation: number;
  refreshedAt: number;
  stale: boolean;
  refreshing: boolean;
}

/** Only fields whose complete replacement is supplied by a notification. */
type MetadataPatch = Partial<Pick<v2.Thread, 'status' | 'name'>>;

const DISCOVERY_INTERVAL_MS = 30_000;
const CHANGE_DELAY_MS = 500;

/**
 * Changes that alter which conversations exist or which partition lists them.
 * Only these justify walking the stored list again.
 */
const METADATA_CHANGES = new Set<ServerNotification['method']>([
  'thread/started',
  'thread/archived',
  'thread/unarchived',
  'thread/deleted',
  'thread/settings/updated',
]);

/**
 * Turn lifecycle, which is the highest-frequency thing this service observes.
 *
 * Measured against 0.153.2 with turns separated beyond timestamp precision:
 * even a refused-provider turn can move `updatedAt`. Status arrives separately
 * as `thread/status/changed`, but turn notifications carry no replacement
 * conversation timestamp. Keep sorting explicitly stale until periodic discovery
 * rather than walking every stored conversation for each active turn.
 *
 * It does justify one in exactly one case. A started conversation is NOT yet in
 * the stored list — also measured — and it is turn activity that makes it
 * listable. Dropping these outright would leave a brand new conversation
 * missing from the sidebar until the next periodic discovery.
 */
const TURN_CHANGES = new Set<ServerNotification['method']>([
  'turn/started',
  'turn/completed',
]);

/** How long a started-but-unlisted conversation keeps turn activity urgent. */
const PENDING_LISTING_TTL_MS = 5 * 60 * 1000;

/** Owns complete discovery once per backend, independent of browser count or query filters. */
@Injectable()
export class ThreadMetadataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ThreadMetadataService.name);
  private readonly changed = new Subject<void>();
  /** Emitted after publication or a freshness transition; contains no conversation content. */
  readonly changes = this.changed.asObservable();
  private collection: {
    entries: ThreadMetadataEntry[];
    generation: number;
    refreshedAt: number;
  } | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduledAt = 0;
  private failed = false;
  private dirty = true;
  private changeSequence = 0;
  private staleSequence = 0;
  private stopped = false;
  /** Live fields observed during the current walk, reapplied only to rows it actually lists. */
  private acquisitionPatches: Map<string, MetadataPatch> | null = null;
  /** Started conversations not yet listable upstream, with an expiry. */
  private readonly pendingListing = new Map<string, number>();

  constructor(
    private readonly codex: CodexService,
    private readonly manager: CodexProcessManager,
  ) {
    manager.addListener('notification', (notification: ServerNotification) => {
      if (notification.method === 'thread/deleted' && this.collection) {
        // Positive deletion evidence can update the last usable collection
        // immediately. A failed later discovery must not make this row reappear.
        this.collection = {
          ...this.collection,
          entries: this.collection.entries.filter(
            (entry) => entry.thread.id !== notification.params.threadId,
          ),
        };
      }
      if (notification.method === 'thread/started') {
        this.prunePendingListing();
        const thread = notification.params.thread;
        // A start/resume notification may name an already listed conversation.
        // Only an absent durable row needs first-turn discovery urgency.
        if (
          !thread.ephemeral &&
          !this.collection?.entries.some(
            (entry) => entry.thread.id === thread.id,
          )
        ) {
          this.pendingListing.set(
            thread.id,
            Date.now() + PENDING_LISTING_TTL_MS,
          );
        }
      }
      if (
        notification.method === 'thread/deleted' ||
        notification.method === 'thread/closed'
      ) {
        this.pendingListing.delete(notification.params.threadId);
      }
      if (this.patchInPlace(notification)) return;
      if (METADATA_CHANGES.has(notification.method)) {
        this.invalidate();
      } else if (TURN_CHANGES.has(notification.method)) {
        const { threadId } = notification.params as v2.TurnStartedNotification;
        this.prunePendingListing();
        if (this.pendingListing.has(threadId)) this.invalidate();
        else this.markStale();
      } else if (notification.method === 'thread/closed') {
        // Closure carries no replacement metadata. Retain last-known fields
        // with explicit staleness until the backend's next discovery.
        this.markStale();
      }
    });
    manager.addLifecycleListener((event) => {
      this.changeSequence++;
      this.dirty = true;
      this.clearTimer();
      // A replaced child re-lists whatever is stored; anything still waiting to
      // become listable belonged to the previous process's in-flight work.
      this.pendingListing.clear();
      this.changed.next();
      if (event.type === 'appServerReady') this.schedule(0);
    });
  }

  /** Starts backend-owned discovery even when no browser is connected. */
  onModuleInit(): void {
    if (this.manager.getClient()) this.schedule(0);
  }

  /** Stops scheduling and prevents a late acquisition from publishing after shutdown. */
  onModuleDestroy(): void {
    this.stopped = true;
    this.clearTimer();
    this.changed.complete();
  }

  /**
   * Returns a usable collection, sharing cold acquisition across concurrent callers.
   * Warm reads never perform upstream work; failure preserves the previous collection.
   * @throws ServiceUnavailableException when no complete collection has been acquired.
   */
  async read(): Promise<{
    entries: readonly ThreadMetadataEntry[];
    freshness: ThreadMetadataFreshness;
  }> {
    if (!this.collection) {
      // After an initial failure, callers share the backend retry schedule
      // rather than making every browser request start another failed walk.
      if (this.inFlight) await this.inFlight;
      else if (!this.failed) await this.refresh();
      if (!this.collection)
        throw new ServiceUnavailableException(
          'Conversation metadata is not available yet',
        );
    }
    const collection = this.collection;
    return {
      entries: collection.entries,
      freshness: {
        generation: collection.generation,
        refreshedAt: collection.refreshedAt,
        stale:
          this.dirty ||
          collection.generation !== this.manager.getGeneration() ||
          Date.now() - collection.refreshedAt >= DISCOVERY_INTERVAL_MS,
        refreshing: this.inFlight !== null,
      },
    };
  }

  /**
   * Replaces a field of one held conversation from an authoritative notification.
   *
   * Only fields the notification actually carries are written; a notification
   * that names a conversation without supplying its replacement value (a close,
   * for instance, which reports no new status) is not patchable and falls
   * through to the coarser paths.
   *
   * Field patches are retained across an in-flight walk, including cold reads.
   * Archive transitions can move a row behind a partition already visited and
   * therefore invalidate that walk instead of merely patching its returned rows.
   * @returns True when the notification has been handled
   */
  private patchInPlace(notification: ServerNotification): boolean {
    const patch = (threadId: string, fields: MetadataPatch): void => {
      if (this.acquisitionPatches) {
        this.acquisitionPatches.set(threadId, {
          ...this.acquisitionPatches.get(threadId),
          ...fields,
        });
      }
      const collection = this.collection;
      if (!collection) return;
      const index = collection.entries.findIndex(
        (entry) => entry.thread.id === threadId,
      );
      // An unheld conversation cannot be patched into existence: the stored
      // list decides what is listable, and this service does not.
      if (index === -1) {
        this.markStale();
        return;
      }
      const entries = [...collection.entries];
      entries[index] = {
        ...entries[index],
        thread: { ...entries[index].thread, ...fields },
      };
      this.collection = { ...collection, entries };
      this.changed.next();
    };

    if (notification.method === 'thread/status/changed') {
      const { threadId, status } = notification.params;
      patch(threadId, { status });
      return true;
    }
    if (notification.method === 'thread/name/updated') {
      const { threadId, threadName } = notification.params;
      patch(threadId, { name: threadName ?? null });
      // Name notifications do not supply replacement timestamps.
      this.markStale();
      return true;
    }
    if (
      notification.method === 'thread/archived' ||
      notification.method === 'thread/unarchived'
    ) {
      const archived = notification.method === 'thread/archived';
      const threadId = notification.params.threadId;
      const held = this.collection?.entries.some(
        (entry) => entry.thread.id === threadId,
      );
      if (held && this.collection) {
        this.collection = {
          ...this.collection,
          entries: this.collection.entries.map((entry) =>
            entry.thread.id === threadId ? { ...entry, archived } : entry,
          ),
        };
        this.changed.next();
      }
      if (this.inFlight || !held) this.invalidate();
      else this.markStale();
      return true;
    }
    return false;
  }

  /** Expires abandoned starts even when no further turn notifications arrive. */
  private prunePendingListing(): void {
    const now = Date.now();
    for (const [threadId, expiresAt] of this.pendingListing) {
      if (expiresAt <= now) this.pendingListing.delete(threadId);
    }
  }

  /**
   * Records that the collection may have drifted without scheduling a walk.
   *
   * Used for changes with no held field to replace and no bearing on which
   * conversations exist. The periodic discovery repairs them; forcing one per
   * event is what made an active conversation re-enumerate the whole list.
   */
  private markStale(): void {
    this.staleSequence++;
    if (this.dirty) return;
    this.dirty = true;
    this.changed.next();
  }

  /** Marks metadata stale and coalesces discrete lifecycle changes without postponing forever. */
  invalidate(): void {
    this.changeSequence++;
    const wasFresh = !this.dirty;
    this.dirty = true;
    if (wasFresh) this.changed.next();
    // An event during acquisition invalidates that acquisition. Its completion
    // schedules one replacement rather than launching another concurrent walk.
    if (!this.inFlight && this.manager.getClient())
      this.schedule(CHANGE_DELAY_MS, true);
  }

  /**
   * Acquires both archive partitions and publishes them together.
   * A failure, process replacement, or observed mutation during paging cannot
   * replace a usable collection with a partial or superseded result.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped || !this.manager.getClient()) return Promise.resolve();
    this.clearTimer();
    this.prunePendingListing();
    const generation = this.manager.getGeneration();
    const sequence = this.changeSequence;
    const staleSequence = this.staleSequence;
    const patches = new Map<string, MetadataPatch>();
    this.acquisitionPatches = patches;
    let superseded = false;
    const task = (async () => {
      try {
        const entries: ThreadMetadataEntry[] = [];
        const ids = new Set<string>();
        for (const archived of [false, true]) {
          let cursor: string | undefined;
          const cursors = new Set<string>();
          do {
            const page = await this.codex.request<v2.ThreadListResponse>(
              'thread/list',
              {
                cursor,
                limit: 200,
                archived,
                modelProviders: [],
                sortKey: 'created_at',
              },
            );
            if (
              !Array.isArray(page.data) ||
              (page.nextCursor !== null &&
                (typeof page.nextCursor !== 'string' ||
                  page.nextCursor.length === 0))
            ) {
              throw new Error(
                'Conversation metadata response omitted valid paging coverage',
              );
            }
            if (
              this.stopped ||
              generation !== this.manager.getGeneration() ||
              sequence !== this.changeSequence
            ) {
              superseded = true;
              return;
            }
            for (const thread of page.data) {
              if (ids.has(thread.id))
                throw new Error(
                  'Conversation moved or repeated during metadata discovery',
                );
              ids.add(thread.id);
              entries.push({ thread, archived });
            }
            cursor = page.nextCursor ?? undefined;
            if (cursor && cursors.has(cursor))
              throw new Error('Conversation metadata cursor did not advance');
            if (cursor) cursors.add(cursor);
          } while (cursor);
        }
        if (this.stopped) return;
        this.collection = {
          entries: entries.map((entry) => {
            const patch = patches.get(entry.thread.id);
            return patch
              ? { ...entry, thread: { ...entry.thread, ...patch } }
              : entry;
          }),
          generation,
          refreshedAt: Date.now(),
        };
        // Anything this walk found is listable now, so its turns stop being
        // urgent. Whatever it did not find keeps its expiry and its urgency.
        for (const entry of entries)
          this.pendingListing.delete(entry.thread.id);
        this.failed = false;
        this.dirty = staleSequence !== this.staleSequence;
        this.changed.next();
        this.logger.debug(
          { generation, threads: entries.length },
          'Published conversation metadata',
        );
      } catch (error) {
        this.failed = true;
        this.dirty = true;
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Conversation metadata discovery failed; retaining previous collection',
        );
        this.changed.next();
      }
    })().finally(() => {
      this.inFlight = null;
      this.acquisitionPatches = null;
      this.prunePendingListing();
      if (this.manager.getClient())
        this.schedule(superseded ? CHANGE_DELAY_MS : DISCOVERY_INTERVAL_MS);
    });
    this.inFlight = task;
    return task;
  }

  /** Schedules discovery once; an event may advance an existing periodic deadline. */
  private schedule(delay: number, advance = false): void {
    if (this.stopped) return;
    const scheduledAt = Date.now() + delay;
    if (this.timer && !advance) return;
    if (this.timer && this.scheduledAt <= scheduledAt) return;
    if (advance) this.clearTimer();
    this.scheduledAt = scheduledAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
