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
import type { ThreadSecurityPolicyDto } from './dto/thread-security-policy.dto';

/** A seed does not contain every field exposed by the full notification. */
export interface ObservedThreadSettings {
  source: 'response' | 'notification';
  settings: Partial<v2.ThreadSettings>;
}

type SettingsSeed = Pick<
  v2.ThreadResumeResponse,
  | 'cwd'
  | 'model'
  | 'modelProvider'
  | 'serviceTier'
  | 'reasoningEffort'
  | 'approvalPolicy'
  | 'approvalsReviewer'
  | 'sandbox'
>;

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
  private readonly cache = new Map<string, ObservedThreadSettings>();
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
    if (!cached?.settings.collaborationMode) {
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
    return (
      cached.settings.model ??
      cached.settings.collaborationMode?.settings.model ??
      null
    );
  }

  /**
   * Returns the most recently observed thread-level reasoning effort, if any.
   *
   * Callers use this to avoid writing a null effort when switching to a
   * collaboration mode preset that does not select one, which app-server
   * treats as clearing the effort rather than leaving it untouched.
   */
  readObservedEffort(threadId: string): ReasoningEffort | null {
    return this.cache.get(threadId)?.settings.effort ?? null;
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

  /** Returns the latest observation without loading or changing a thread. */
  readSettings(threadId: string): ObservedThreadSettings | undefined {
    return this.cache.get(threadId);
  }

  /**
   * Seeds settings missing from observations using a start/resume/fork response.
   * Notifications can arrive before that response resolves; their fields always
   * win. Seeds never invent collaboration mode, personality, or profile identity.
   */
  seedResponse(threadId: string, response: SettingsSeed): void {
    // A complete notification or an earlier seed already supplies these leaves.
    // Keeping its identity also preserves in-flight mutation observation guards.
    const cached = this.cache.get(threadId);
    if (cached) {
      // The measured notification omits the tier. A notification arriving
      // before this response must not prevent the only available local seed.
      if (cached.settings.serviceTier === undefined)
        this.cache.set(threadId, {
          ...cached,
          settings: { ...cached.settings, serviceTier: response.serviceTier },
        });
      return;
    }
    this.cache.set(threadId, {
      source: 'response',
      settings: {
        cwd: response.cwd,
        model: response.model,
        modelProvider: response.modelProvider,
        serviceTier: response.serviceTier,
        effort: response.reasoningEffort,
        approvalPolicy: response.approvalPolicy,
        approvalsReviewer: response.approvalsReviewer,
        sandboxPolicy: response.sandbox,
      },
    });
  }

  /** Returns observed security settings; null means unknown, never a default. */
  readSecurityPolicy(threadId: string): ThreadSecurityPolicyDto {
    const cached = this.cache.get(threadId);
    const settings = cached?.settings;
    return {
      observed:
        settings?.approvalPolicy !== undefined &&
        settings.sandboxPolicy !== undefined,
      source: cached?.source ?? 'unknown',
      approvalPolicy: settings?.approvalPolicy ?? null,
      sandboxPolicy: settings?.sandboxPolicy ?? null,
      approvalsReviewer: settings?.approvalsReviewer ?? null,
    };
  }

  /**
   * Records effort displaced by an accepted mode request, not effective settings.
   * The empty RPC acknowledgement only queues the change. If a newer observation
   * already left the requested mode, do not resurrect its displaced-effort state.
   * @param before - Observation captured immediately before submitting the RPC
   * @returns The actual observed mode, which may still be unknown or unchanged
   */
  recordAcceptedCollaborationMode(
    threadId: string,
    collaborationMode: CollaborationMode,
    displaced: DisplacedEffort | null,
    before?: ObservedThreadSettings,
  ): ThreadCollaborationModeStateDto {
    const current = this.cache.get(threadId);
    if (
      current === before ||
      current?.settings.collaborationMode?.mode === collaborationMode.mode
    ) {
      this.recordDisplacedEffort(threadId, displaced);
    }
    return this.readCollaborationMode(threadId);
  }

  /**
   * Applies app-server notifications that change or invalidate observed
   * settings. Deleted threads are dropped here rather than at each deletion
   * call site so the cache cannot outlive the thread it describes.
   */
  observeNotification(notification: ServerNotification): void {
    if (notification.method === 'thread/closed') {
      this.cache.delete(notification.params.threadId);
      return;
    }
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

  /** Records observable settings while preserving the lifecycle-seeded local tier. */
  recordThreadSettings(
    threadId: string,
    threadSettings: v2.ThreadSettings,
  ): void {
    this.cache.set(threadId, {
      source: 'notification',
      settings: {
        ...threadSettings,
        serviceTier: this.cache.get(threadId)?.settings.serviceTier,
      },
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
    cached: ObservedThreadSettings,
  ): ThreadCollaborationModeStateDto {
    const mode = cached.settings.collaborationMode!;
    return {
      observed: true,
      source: 'notification',
      mode: mode.mode,
      model: mode.settings.model,
      reasoningEffort: mode.settings.reasoning_effort ?? null,
    };
  }
}
