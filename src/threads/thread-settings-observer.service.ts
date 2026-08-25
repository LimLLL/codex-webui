/** Observes thread settings that app-server only exposes through notifications. */
import { Injectable, Logger } from '@nestjs/common';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type {
  CollaborationMode,
  ReasoningEffort,
  ServerNotification,
  v2,
} from '../codex/codex-schema';
import type { ThreadCollaborationModeStateDto } from './dto/threads.dto';

export type ThreadSettingsObservationSource = 'notification' | 'accepted';

interface CachedThreadSettings {
  source: ThreadSettingsObservationSource;
  model: string;
  /**
   * Thread-level effective effort, tracked separately from the collaboration
   * mode's own effort. Switching to a preset that does not select an effort
   * must not clear what the user already had.
   */
  effort: ReasoningEffort | null;
  collaborationMode: CollaborationMode;
}

/**
 * Effort displaced by entering a preset that dictates its own (Plan forces
 * medium). Wrapped rather than stored bare because "the thread had no effort"
 * and "nothing was displaced" are different states that must restore
 * differently.
 */
interface DisplacedEffort {
  value: ReasoningEffort | null;
}

/** Caches only settings observed from app-server for the current process generation. */
@Injectable()
export class ThreadSettingsObserverService {
  private readonly logger = new Logger(ThreadSettingsObserverService.name);
  private readonly cache = new Map<string, CachedThreadSettings>();
  /**
   * Kept out of `cache` deliberately. Observed settings describe one
   * app-server generation and are dropped on restart, but the effort Plan mode
   * displaced is still displaced after a restart — app-server persisted the
   * imposed effort, so forgetting the original would strand the thread at it.
   */
  private readonly displacedEffort = new Map<string, DisplacedEffort>();

  constructor(private readonly codexManager: CodexProcessManager) {
    this.codexManager.addListener(
      'notification',
      (notification: ServerNotification) => {
        this.observeNotification(notification);
      },
    );
    this.codexManager.addLifecycleListener((event) => {
      if (event.type === 'appServerReady') {
        this.cache.clear();
        this.logger.debug(
          `Cleared observed thread settings for generation=${event.generation}`,
        );
      }
    });
  }

  /** Returns the currently observed collaboration mode, or an explicit unknown. */
  readCollaborationMode(threadId: string): ThreadCollaborationModeStateDto {
    const cached = this.cache.get(threadId);
    if (!cached) {
      return {
        observed: false,
        source: 'unknown',
        mode: null,
        model: null,
        reasoningEffort: null,
      };
    }
    return this.toState(cached);
  }

  /** Returns the most recently observed concrete model for a thread, if any. */
  readObservedModel(threadId: string): string | null {
    const cached = this.cache.get(threadId);
    if (!cached) return null;
    return cached.model || cached.collaborationMode.settings.model || null;
  }

  /**
   * Returns the most recently observed thread-level reasoning effort, if any.
   *
   * Callers use this to avoid writing a null effort when switching to a
   * collaboration mode preset that does not select one, which app-server
   * treats as clearing the effort rather than leaving it untouched.
   */
  readObservedEffort(threadId: string): ReasoningEffort | null {
    return this.cache.get(threadId)?.effort ?? null;
  }

  /**
   * Returns the effort displaced when the thread entered an effort-dictating
   * mode, or null when nothing was displaced.
   *
   * The wrapper distinguishes "displaced an explicit null" from "nothing was
   * displaced"; a bare null could not.
   */
  readDisplacedEffort(threadId: string): DisplacedEffort | null {
    return this.displacedEffort.get(threadId) ?? null;
  }

  /** Records or clears the effort displaced by an effort-dictating preset. */
  recordDisplacedEffort(
    threadId: string,
    displaced: DisplacedEffort | null,
  ): void {
    if (displaced) this.displacedEffort.set(threadId, displaced);
    else this.displacedEffort.delete(threadId);
  }

  /** Drops all state for a thread that no longer exists. */
  forget(threadId: string): void {
    this.cache.delete(threadId);
    this.displacedEffort.delete(threadId);
  }

  /**
   * Records a successful WebUI-initiated collaboration mode update.
   *
   * App-server may omit `thread/settings/updated` when the effective settings
   * did not change, so the accepted request is still useful observable state.
   */
  recordAcceptedCollaborationMode(
    threadId: string,
    collaborationMode: CollaborationMode,
    displaced: DisplacedEffort | null,
  ): ThreadCollaborationModeStateDto {
    this.cache.set(threadId, {
      source: 'accepted',
      model: collaborationMode.settings.model,
      // The mode we just wrote becomes the thread's effective effort; a later
      // notification carrying the full settings still overwrites this.
      effort:
        collaborationMode.settings.reasoning_effort ??
        this.cache.get(threadId)?.effort ??
        null,
      collaborationMode,
    });
    this.recordDisplacedEffort(threadId, displaced);
    return this.readCollaborationMode(threadId);
  }

  /**
   * Applies app-server notifications that change or invalidate observed
   * settings. Deleted threads are dropped here rather than at each deletion
   * call site so the cache cannot outlive the thread it describes.
   */
  observeNotification(notification: ServerNotification): void {
    if (notification.method === 'thread/deleted') {
      this.forget(notification.params.threadId);
      return;
    }
    if (notification.method !== 'thread/settings/updated') return;
    this.recordThreadSettings(
      notification.params.threadId,
      notification.params.threadSettings,
    );
  }

  /** Records the full effective settings emitted by app-server. */
  recordThreadSettings(
    threadId: string,
    threadSettings: v2.ThreadSettings,
  ): void {
    this.cache.set(threadId, {
      source: 'notification',
      model: threadSettings.model,
      effort: threadSettings.effort ?? null,
      collaborationMode: threadSettings.collaborationMode,
    });
    // Something outside this client — the TUI, the desktop app, another tab —
    // can leave the effort-dictating mode without going through us. Once the
    // thread is no longer in such a mode there is nothing left to restore, and
    // keeping the old value would let a later exit overwrite the user's
    // current effort with a stale one.
    if (threadSettings.collaborationMode?.mode !== 'plan') {
      this.displacedEffort.delete(threadId);
    }
  }

  private toState(
    cached: CachedThreadSettings,
  ): ThreadCollaborationModeStateDto {
    return {
      observed: true,
      source: cached.source,
      mode: cached.collaborationMode.mode,
      model: cached.collaborationMode.settings.model,
      reasoningEffort:
        cached.collaborationMode.settings.reasoning_effort ?? null,
    };
  }
}
