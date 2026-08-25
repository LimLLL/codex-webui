/** Startup scanner that adopts externally created paginated fork metadata. */
import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import {
  BRANCH_START_SENTINEL,
  type ConversationBranchEdge,
} from '../database/schema';
import {
  ConversationBranchMutationsService,
  type AdoptedForkRecord,
} from './conversation-branch-mutations.service';
import { ConversationBranchRolloutScanner } from './conversation-branch-rollout-scanner';
import type { RolloutCandidate } from './conversation-branch-rollout-types';
import type {
  BranchAdoptionDiagnosticDto,
  BranchAdoptionStatusDto,
} from './dto/conversation-branches.dto';

function emptyStatus(status: BranchAdoptionStatusDto['status']) {
  return {
    status,
    generation: 0,
    scannedFiles: 0,
    parsedFiles: 0,
    fullyParsedFiles: 0,
    adoptedEdges: 0,
    adoptedVersions: 0,
    topologyOnlyEdges: 0,
    skippedLegacyForks: 0,
    skippedFiles: 0,
    conflicts: 0,
    diagnostics: [],
  } satisfies BranchAdoptionStatusDto;
}

@Injectable()
export class ConversationBranchAdoptionService implements OnModuleInit {
  private readonly logger = new Logger(ConversationBranchAdoptionService.name);
  private readonly scanner = new ConversationBranchRolloutScanner();
  private status: BranchAdoptionStatusDto = emptyStatus('pending');
  private runToken = 0;
  /** In-flight scan, keyed by generation, so startup cannot scan twice. */
  private inFlight: { generation: number; done: Promise<unknown> } | null =
    null;

  constructor(
    private readonly codexManager: CodexProcessManager,
    private readonly mutations: ConversationBranchMutationsService,
  ) {
    this.codexManager.addLifecycleListener((event) => {
      if (event.type !== 'appServerReady') return;
      const init = this.codexManager.getInitResult();
      if (!init?.codexHome) return;
      this.startScan(init.codexHome, event.generation);
    });
  }

  onModuleInit(): void {
    const init = this.codexManager.getInitResult();
    if (init?.codexHome) {
      this.startScan(init.codexHome, this.codexManager.getGeneration());
    }
  }

  /** Reads the latest startup adoption scanner status. */
  getStatus(): BranchAdoptionStatusDto {
    return {
      ...this.status,
      diagnostics: this.status.diagnostics.map((item) => ({ ...item })),
    };
  }

  /** Throws when deletion should not be reachable yet. */
  assertReadyForDeletion(): void {
    if (this.status.status === 'ready') return;
    throw new BusinessException(
      ErrorCode.threads.deleteScanNotReady,
      HttpStatus.CONFLICT,
      'Branch adoption scan has not completed',
      { status: this.status.status },
    );
  }

  /** Blocking diagnostics that intersect a planned deletion id set. */
  getBlockingDiagnostics(
    threadIds: Iterable<string>,
  ): BranchAdoptionDiagnosticDto[] {
    const ids = new Set(threadIds);
    return this.status.diagnostics.filter((item) => {
      if (item.severity !== 'error') return false;
      return (
        (item.threadId !== undefined && ids.has(item.threadId)) ||
        (item.parentThreadId !== undefined && ids.has(item.parentThreadId))
      );
    });
  }

  /** Runs a scan now; exposed for startup and focused tests. */
  async scanCodexHome(
    codexHome: string,
    generation = this.codexManager.getGeneration(),
  ): Promise<BranchAdoptionStatusDto> {
    const token = ++this.runToken;
    this.status = { ...emptyStatus('running'), generation };
    try {
      const result = await this.scanner.scan(codexHome);
      const records = this.classifyCandidates(
        result.candidates,
        result.diagnostics,
      );
      const persisted = this.mutations.replaceAdoptedForks(records);
      const conflicts = result.diagnostics.filter(
        (item) => item.severity === 'error',
      ).length;
      const ready = {
        status: 'ready',
        generation,
        scannedFiles: result.files.length,
        parsedFiles: result.headers.size,
        fullyParsedFiles: result.summaries.size,
        adoptedEdges: persisted.adoptedEdges,
        adoptedVersions: persisted.adoptedVersions,
        topologyOnlyEdges: persisted.topologyOnlyEdges,
        skippedLegacyForks: result.skippedLegacyForks,
        skippedFiles: result.skippedFiles,
        conflicts,
        diagnostics: result.diagnostics,
      } satisfies BranchAdoptionStatusDto;

      if (this.runToken === token) this.status = ready;
      this.logger.log(
        `Branch adoption scan ready: files=${result.files.length} adoptedEdges=${persisted.adoptedEdges} conflicts=${conflicts}`,
      );
      return this.getStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = {
        ...this.status,
        status: 'failed',
        generation,
        errorMessage: message,
      } satisfies BranchAdoptionStatusDto;
      if (this.runToken === token) this.status = failed;
      this.logger.warn(`Branch adoption scan failed: ${message}`);
      return this.getStatus();
    }
  }

  /**
   * Starts a scan unless one is already running for the same generation.
   *
   * `onModuleInit` and the `appServerReady` listener both legitimately fire on
   * a normal boot, and an unguarded second run would re-read every rollout file
   * and rewrite the adopted rows the first run is still building.
   */
  private startScan(codexHome: string, generation: number): void {
    if (this.inFlight?.generation === generation) return;
    const done = this.scanCodexHome(codexHome, generation).finally(() => {
      if (this.inFlight?.done === done) this.inFlight = null;
    });
    this.inFlight = { generation, done };
    void done;
  }

  private classifyCandidates(
    candidates: RolloutCandidate[],
    diagnostics: BranchAdoptionDiagnosticDto[],
  ): AdoptedForkRecord[] {
    const localEdges = new Map(
      this.mutations.listLocalEdges().map((edge) => [edge.childThreadId, edge]),
    );
    const parentByChild = new Map<string, string>();
    for (const edge of this.mutations.listEdges()) {
      if (edge.source === 'local') {
        parentByChild.set(edge.childThreadId, edge.parentThreadId);
      }
    }

    const safeCandidates: RolloutCandidate[] = [];
    for (const candidate of candidates) {
      const localEdge = localEdges.get(candidate.childThreadId);
      if (localEdge) {
        if (!this.edgeMatchesCandidate(localEdge, candidate)) {
          diagnostics.push({
            severity: 'error',
            code: 'local_edge_conflict',
            message:
              'Disk fork metadata contradicts a locally recorded fork edge',
            threadId: candidate.childThreadId,
            parentThreadId: candidate.parentThreadId,
          });
        }
        continue;
      }
      parentByChild.set(candidate.childThreadId, candidate.parentThreadId);
      safeCandidates.push(candidate);
    }

    return safeCandidates.flatMap((candidate) => {
      const root = this.resolveRoot(candidate.childThreadId, parentByChild);
      if (!root) {
        diagnostics.push({
          severity: 'error',
          code: 'topology_cycle',
          message: 'Adopted fork metadata would introduce a topology cycle',
          threadId: candidate.childThreadId,
          parentThreadId: candidate.parentThreadId,
        });
        return [];
      }
      const record: AdoptedForkRecord = {
        ...candidate,
        treeRootThreadId: root,
      };
      return [this.dropConflictingVersion(record, diagnostics)];
    });
  }

  private dropConflictingVersion(
    record: AdoptedForkRecord,
    diagnostics: BranchAdoptionDiagnosticDto[],
  ): AdoptedForkRecord {
    if (!record.messageVersion) return record;
    const groups = this.mutations.listGroups();
    const versions = this.mutations.listVersions();
    const commonPrefixTurnId =
      record.commonPrefixTurnId ?? BRANCH_START_SENTINEL;
    const group = groups.find(
      (item) =>
        item.treeRootThreadId === record.treeRootThreadId &&
        item.commonPrefixTurnId === commonPrefixTurnId,
    );
    if (!group) return record;

    const hasLocalVersions = versions.some(
      (item) => item.groupId === group.groupId && item.source === 'local',
    );
    if (!hasLocalVersions) return record;

    const parentVersion = versions.find(
      (item) =>
        item.groupId === group.groupId &&
        item.threadId === record.parentThreadId &&
        item.source === 'local',
    );
    const localChildVersion = versions.find(
      (item) =>
        item.groupId === group.groupId &&
        item.threadId === record.childThreadId &&
        item.source === 'local',
    );
    if (parentVersion && !localChildVersion) return record;

    diagnostics.push({
      severity: 'warning',
      code: 'local_version_conflict',
      message:
        'Disk fork metadata cannot safely be added to an existing version group',
      threadId: record.childThreadId,
      parentThreadId: record.parentThreadId,
    });
    return {
      childThreadId: record.childThreadId,
      parentThreadId: record.parentThreadId,
      treeRootThreadId: record.treeRootThreadId,
      forkBeforeTurnId: record.forkBeforeTurnId,
      commonPrefixTurnId: record.commonPrefixTurnId,
      inheritedTurnIds: record.inheritedTurnIds,
    };
  }

  private resolveRoot(
    threadId: string,
    parentByChild: Map<string, string>,
  ): string | null {
    const seen = new Set<string>();
    let current = threadId;
    while (parentByChild.has(current)) {
      if (seen.has(current)) return null;
      seen.add(current);
      current = parentByChild.get(current)!;
    }
    return current;
  }

  private edgeMatchesCandidate(
    edge: ConversationBranchEdge,
    candidate: RolloutCandidate,
  ): boolean {
    return (
      edge.parentThreadId === candidate.parentThreadId &&
      edge.forkBeforeTurnId === candidate.forkBeforeTurnId &&
      edge.commonPrefixTurnId ===
        (candidate.commonPrefixTurnId ?? BRANCH_START_SENTINEL) &&
      JSON.stringify(this.parseTurnIds(edge.inheritedTurnIds)) ===
        JSON.stringify(candidate.inheritedTurnIds)
    );
  }

  private parseTurnIds(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }
}
