/** Thread-scoped command primitives used by the browser composer surface. */
import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  CollaborationMode,
  ModeKind,
  ReasoningEffort,
  v2,
} from '../codex/codex-schema';
import { CodexService } from '../codex/codex.service';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import type {
  CollaborationModePresetDto,
  CollaborationModesResponseDto,
  ThreadCollaborationModeStateDto,
} from './dto/threads.dto';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';

type CollaborationModeListResponse =
  | { data?: v2.CollaborationModeMask[]; modes?: v2.CollaborationModeMask[] }
  | v2.CollaborationModeMask[];

type ThreadSettingsUpdateParams = {
  threadId: string;
  collaborationMode: CollaborationMode;
};

@Injectable()
export class ThreadCommandsService {
  constructor(
    private readonly codex: CodexService,
    private readonly resumeRegistry: ThreadResumeRegistryService,
    private readonly deletionRegistry: ThreadDeletionRegistryService,
    private readonly settingsObserver: ThreadSettingsObserverService,
  ) {}

  /** Lists collaboration mode presets provided by the Codex app-server. */
  async listCollaborationModes(): Promise<CollaborationModesResponseDto> {
    // app-server rejects this method outright when `params` is absent, even
    // though it takes no arguments: it fails with "missing field `params`".
    const response = await this.codex.request<CollaborationModeListResponse>(
      'collaborationMode/list',
      {},
    );
    return {
      data: this.readCollaborationModeMasks(response).map((preset) => ({
        name: preset.name,
        mode: preset.mode,
        model: preset.model,
        reasoningEffort: preset.reasoning_effort ?? null,
      })),
    };
  }

  /**
   * Reads the backend's observed collaboration mode state for a thread.
   *
   * This is intentionally non-authoritative when unknown: app-server exposes no
   * side-effect-free read for the current mode, so this method never mutates a
   * thread to discover state.
   */
  readCollaborationMode(threadId: string): ThreadCollaborationModeStateDto {
    return this.settingsObserver.readCollaborationMode(threadId);
  }

  /**
   * Updates the thread's next-turn collaboration mode without starting a turn.
   *
   * App-server requires the collaboration mode settings to include a concrete
   * model. We only echo a model already observed from app-server or from a
   * successful start/resume/fork response; otherwise the request fails.
   */
  async setCollaborationMode(
    threadId: string,
    mode: ModeKind,
  ): Promise<ThreadCollaborationModeStateDto> {
    this.deletionRegistry.assertMutable(threadId);

    const preset = await this.getCollaborationModePreset(mode);
    const model = preset.model ?? this.resolveCurrentThreadModel(threadId);
    const currentEffort = this.resolveCurrentThreadEffort(threadId);
    const alreadyInMode =
      this.settingsObserver.readCollaborationMode(threadId).mode === mode;
    const savedDisplaced = this.settingsObserver.readDisplacedEffort(threadId);

    // A preset that dictates an effort (Plan forces medium) overwrites the
    // thread effort, and app-server keeps no history of the previous value.
    // Remember it on the way in so leaving the mode can put it back; re-entering
    // the same mode must not overwrite the saved value with the preset's own.
    const displaced = preset.reasoningEffort
      ? alreadyInMode
        ? savedDisplaced
        : { value: currentEffort }
      : null;

    const collaborationMode: CollaborationMode = {
      mode,
      settings: {
        model,
        // A preset effort of null means "this preset does not select an
        // effort", but app-server treats a written null as clearing the
        // thread's effort. Prefer restoring exactly what the previous
        // effort-dictating mode displaced — including an explicit null, which
        // is why the saved value is wrapped rather than compared against null.
        reasoning_effort:
          preset.reasoningEffort ??
          (savedDisplaced ? savedDisplaced.value : currentEffort),
        // Null tells app-server to use the built-in developer instructions for
        // this collaboration mode instead of treating WebUI as the instruction
        // source of truth.
        developer_instructions: null,
      },
    };

    await this.codex.request<Record<string, never>>('thread/settings/update', {
      threadId,
      collaborationMode,
    } satisfies ThreadSettingsUpdateParams);

    return this.settingsObserver.recordAcceptedCollaborationMode(
      threadId,
      collaborationMode,
      displaced,
    );
  }

  /** Reads the persisted goal for a thread without mutating it. */
  async readGoal(threadId: string): Promise<v2.ThreadGoalGetResponse> {
    return this.codex.request<v2.ThreadGoalGetResponse>('thread/goal/get', {
      threadId,
    });
  }

  /** Creates or partially updates the single persisted goal for a thread. */
  async setGoal(
    params: v2.ThreadGoalSetParams,
  ): Promise<v2.ThreadGoalSetResponse> {
    this.deletionRegistry.assertMutable(params.threadId);
    return this.codex.request<v2.ThreadGoalSetResponse>(
      'thread/goal/set',
      params,
    );
  }

  /** Clears the persisted goal for a thread. */
  async clearGoal(threadId: string): Promise<v2.ThreadGoalClearResponse> {
    this.deletionRegistry.assertMutable(threadId);
    return this.codex.request<v2.ThreadGoalClearResponse>('thread/goal/clear', {
      threadId,
    });
  }

  /**
   * Starts Codex's inline code review flow for a thread.
   *
   * Detached review is deliberately excluded because this project stores and
   * pages thread history in the mode app-server documents as unsupported.
   */
  async startReview(
    threadId: string,
    target: v2.ReviewTarget,
  ): Promise<v2.ReviewStartResponse> {
    this.deletionRegistry.assertMutable(threadId);
    return this.codex.request<v2.ReviewStartResponse>('review/start', {
      threadId,
      target,
      delivery: 'inline',
    } satisfies v2.ReviewStartParams);
  }

  private async getCollaborationModePreset(
    mode: ModeKind,
  ): Promise<CollaborationModePresetDto> {
    const preset = (await this.listCollaborationModes()).data.find(
      (item) => item.mode === mode,
    );
    if (!preset) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidCollaborationMode,
        `Unknown collaboration mode: ${mode}`,
      );
    }
    return preset;
  }

  /**
   * Resolves the thread's current reasoning effort for presets that do not
   * select one. Returns null only when the effort is genuinely unknown, in
   * which case app-server keeps its own resolution.
   */
  private resolveCurrentThreadEffort(threadId: string): ReasoningEffort | null {
    return (
      this.settingsObserver.readObservedEffort(threadId) ??
      this.resumeRegistry.readCachedEffort(threadId)
    );
  }

  private resolveCurrentThreadModel(threadId: string): string {
    const observed = this.settingsObserver.readObservedModel(threadId);
    const cached = observed ?? this.resumeRegistry.readCachedModel(threadId);
    if (cached) return cached;
    throw BusinessException.badRequest(
      ErrorCode.threads.collaborationModeModelRequired,
      'Cannot set collaboration mode before resolving the thread model',
      { threadId },
    );
  }

  private readCollaborationModeMasks(
    response: CollaborationModeListResponse,
  ): v2.CollaborationModeMask[] {
    const data = Array.isArray(response)
      ? response
      : (response.data ?? response.modes);
    if (!Array.isArray(data)) {
      throw new BusinessException(
        ErrorCode.threads.collaborationModeUnavailable,
        HttpStatus.BAD_GATEWAY,
        'collaborationMode/list returned an unexpected response shape',
      );
    }
    return data;
  }
}
