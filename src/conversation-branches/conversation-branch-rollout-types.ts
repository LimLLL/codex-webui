/** Shared rollout scanner types. */
import type { AdoptedForkRecord } from './conversation-branch-mutations.service';
import type { BranchAdoptionDiagnosticDto } from './dto/conversation-branches.dto';

export interface ParsedLine {
  ordinal: number;
  offset: number;
  nextOffset: number;
  type: string | null;
  payload: Record<string, unknown>;
}

export interface ParsedTurn {
  turnId: string;
  ordinal: number;
  offset: number;
  hasUserMessage: boolean;
  previewText: string;
}

export interface HistoryBase {
  threadId: string;
  endOrdinalExclusive: number;
  endByteOffset: number;
}

/**
 * First-pass result: everything derivable from a rollout's metadata header.
 *
 * Read for every session file, so it must stay cheap — the header alone decides
 * whether a file is part of a fork chain and therefore worth parsing in full.
 */
export interface SessionHeader {
  threadId: string;
  filePath: string;
  forkedFromId: string | null;
  historyBase: HistoryBase | null;
  historyBasePresent: boolean;
}

/**
 * Second-pass result: the whole rollout parsed into turn boundaries.
 *
 * Only produced for files that participate in a fork chain, because it costs a
 * full read and JSON parse of every record in the file.
 */
export interface SessionSummary extends SessionHeader {
  byteLength: number;
  lineOffsets: Set<number>;
  turns: ParsedTurn[];
}

export type RolloutCandidate = Omit<AdoptedForkRecord, 'treeRootThreadId'>;

export interface RolloutScanResult {
  files: string[];
  headers: Map<string, SessionHeader>;
  summaries: Map<string, SessionSummary>;
  candidates: RolloutCandidate[];
  skippedLegacyForks: number;
  skippedFiles: number;
  diagnostics: BranchAdoptionDiagnosticDto[];
}
