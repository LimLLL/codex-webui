/** Parser for Codex session rollout files used by branch adoption. */
import type { Dirent } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRANCH_END_SENTINEL } from '../database/schema';
import { extractRolloutUserPreview } from './conversation-branch-rollout-preview';
import type {
  BranchAdoptionDiagnosticCode,
  BranchAdoptionDiagnosticDto,
  BranchAdoptionDiagnosticSeverity,
} from './dto/conversation-branches.dto';
import type {
  HistoryBase,
  ParsedLine,
  ParsedTurn,
  RolloutCandidate,
  RolloutScanResult,
  SessionHeader,
  SessionSummary,
} from './conversation-branch-rollout-types';

/** Chunk size used while hunting for the newline that ends the header record. */
const HEADER_CHUNK_BYTES = 64 * 1024;

/** Upper bound on a single metadata header; beyond this the file is skipped. */
const HEADER_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Cap on retained diagnostics.
 *
 * One malformed multi-megabyte rollout can otherwise emit a diagnostic per
 * record, and this list is embedded in every delete preview response.
 */
const MAX_DIAGNOSTICS = 200;

export class ConversationBranchRolloutScanner {
  /**
   * Parses the rollout files beneath codexHome in two passes.
   *
   * Every file contributes its metadata header, but only files that take part
   * in a fork chain are read in full. A Codex home holding a thousand sessions
   * is routinely several gigabytes on disk while carrying a handful of forks,
   * so parsing everything would make the scan — and the deletion path gated
   * behind it — pay for history it never consults.
   *
   * @param codexHome - Codex home directory resolved from app-server
   */
  async scan(codexHome: string): Promise<RolloutScanResult> {
    const diagnostics: BranchAdoptionDiagnosticDto[] = [];
    const files = await this.listSessionFiles(codexHome);
    const headers = new Map<string, SessionHeader>();
    let skippedFiles = 0;

    for (const filePath of files) {
      const header = await this.parseSessionHeader(filePath, diagnostics);
      if (!header) {
        skippedFiles += 1;
        continue;
      }
      if (headers.has(header.threadId)) {
        skippedFiles += 1;
        this.addDiagnostic(
          diagnostics,
          'error',
          'duplicate_child_conflict',
          'Multiple session files claim the same thread id',
          header.threadId,
        );
        continue;
      }
      headers.set(header.threadId, header);
    }

    const summaries = await this.loadForkChainSummaries(headers, diagnostics);
    const { candidates, skippedLegacyForks } = this.buildCandidates(
      headers,
      summaries,
      diagnostics,
    );
    return {
      files,
      headers,
      summaries,
      candidates,
      skippedLegacyForks,
      skippedFiles,
      diagnostics,
    };
  }

  /**
   * Fully parses only the files reachable from a fork edge.
   *
   * Both ends of every fork are needed: the child for its replacement message,
   * the parent for the turn boundaries the child inherited. Ancestors join the
   * set transitively because an inherited prefix can span a whole fork chain.
   */
  private async loadForkChainSummaries(
    headers: Map<string, SessionHeader>,
    diagnostics: BranchAdoptionDiagnosticDto[],
  ): Promise<Map<string, SessionSummary>> {
    const needed = new Set<string>();
    for (const header of headers.values()) {
      if (!header.forkedFromId) continue;
      needed.add(header.threadId);
      let ancestorId: string | null = header.forkedFromId;
      while (ancestorId && !needed.has(ancestorId)) {
        needed.add(ancestorId);
        ancestorId = headers.get(ancestorId)?.forkedFromId ?? null;
      }
    }

    const summaries = new Map<string, SessionSummary>();
    for (const threadId of needed) {
      const header = headers.get(threadId);
      if (!header) continue;
      const summary = await this.parseSessionBody(header, diagnostics);
      if (summary) summaries.set(threadId, summary);
    }
    return summaries;
  }

  private async listSessionFiles(codexHome: string): Promise<string[]> {
    const roots = [
      join(codexHome, 'sessions'),
      join(codexHome, 'archived_sessions'),
    ];
    const files: string[] = [];
    for (const root of roots) {
      await this.collectJsonlFiles(root, files);
    }
    return files;
  }

  private async collectJsonlFiles(
    dirPath: string,
    files: string[],
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.collectJsonlFiles(fullPath, files);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  private async parseSessionHeader(
    filePath: string,
    diagnostics: BranchAdoptionDiagnosticDto[],
  ): Promise<SessionHeader | null> {
    let firstLine: string | null;
    try {
      firstLine = await this.readFirstLine(filePath);
    } catch {
      this.addDiagnostic(
        diagnostics,
        'warning',
        'session_file_unreadable',
        'Session file could not be read',
      );
      return null;
    }
    if (!firstLine) {
      this.addDiagnostic(
        diagnostics,
        'warning',
        'session_header_missing',
        'Session file has no metadata header',
      );
      return null;
    }

    let payload: Record<string, unknown> | null = null;
    try {
      const envelope = this.asRecord(JSON.parse(firstLine));
      payload =
        envelope && this.readString(envelope, ['type']) === 'session_meta'
          ? this.asRecord(envelope.payload)
          : null;
    } catch {
      payload = null;
    }
    if (!payload) {
      this.addDiagnostic(
        diagnostics,
        'warning',
        'session_header_missing',
        'Session file has no metadata header',
      );
      return null;
    }

    const threadId = this.readString(payload, ['id', 'thread_id']);
    if (!threadId) {
      this.addDiagnostic(
        diagnostics,
        'warning',
        'session_header_invalid',
        'Session metadata header has no thread id',
      );
      return null;
    }

    return {
      threadId,
      filePath,
      forkedFromId: this.readString(payload, [
        'forked_from_id',
        'forkedFromId',
      ]),
      historyBase: this.readHistoryBase(payload),
      historyBasePresent:
        payload.history_base !== undefined || payload.historyBase !== undefined,
    };
  }

  /**
   * Reads bytes until the first newline, so a header costs one chunk not a file.
   *
   * Headers embed the full base instructions and routinely run past a single
   * chunk, so the read grows until the record ends or the cap is reached.
   */
  private async readFirstLine(filePath: string): Promise<string | null> {
    const handle = await open(filePath, 'r');
    try {
      const chunks: Buffer[] = [];
      const chunk = Buffer.alloc(HEADER_CHUNK_BYTES);
      let position = 0;
      while (position < HEADER_MAX_BYTES) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          chunk.length,
          position,
        );
        if (bytesRead === 0) break;
        const slice = chunk.subarray(0, bytesRead);
        const newline = slice.indexOf(10);
        if (newline >= 0) {
          chunks.push(Buffer.from(slice.subarray(0, newline)));
          return Buffer.concat(chunks).toString('utf8');
        }
        chunks.push(Buffer.from(slice));
        position += bytesRead;
      }
      return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null;
    } finally {
      await handle.close();
    }
  }

  private async parseSessionBody(
    header: SessionHeader,
    diagnostics: BranchAdoptionDiagnosticDto[],
  ): Promise<SessionSummary | null> {
    let buffer: Buffer;
    try {
      buffer = await readFile(header.filePath);
    } catch {
      this.addDiagnostic(
        diagnostics,
        'warning',
        'session_file_unreadable',
        'Session file could not be read',
        header.threadId,
      );
      return null;
    }

    const lines = this.parseLines(buffer, diagnostics, header.threadId);
    return {
      ...header,
      byteLength: buffer.length,
      lineOffsets: new Set([
        0,
        buffer.length,
        ...lines.map((line) => line.offset),
        ...lines.map((line) => line.nextOffset),
      ]),
      turns: this.collectTurns(lines),
    };
  }

  private parseLines(
    buffer: Buffer,
    diagnostics: BranchAdoptionDiagnosticDto[],
    threadId: string,
  ): ParsedLine[] {
    const lines: ParsedLine[] = [];
    let offset = 0;
    let ordinal = 0;
    let malformed = 0;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(10, offset);
      const end = newline < 0 ? buffer.length : newline;
      const nextOffset = newline < 0 ? end : end + 1;
      const chunk = buffer.subarray(offset, end);
      if (chunk.length > 0) {
        try {
          const envelope = this.asRecord(JSON.parse(chunk.toString('utf8')));
          if (!envelope) throw new Error('JSONL record is not an object');
          lines.push({
            ordinal,
            offset,
            nextOffset,
            type: this.readString(envelope, ['type']),
            payload: this.asRecord(envelope.payload) ?? {},
          });
        } catch {
          malformed += 1;
        }
        ordinal += 1;
      }
      offset = nextOffset;
    }
    // One diagnostic per file, not per record: a corrupt rollout would
    // otherwise bury every other finding and inflate the preview payload.
    if (malformed > 0) {
      this.addDiagnostic(
        diagnostics,
        'warning',
        'session_header_invalid',
        `Session file contains ${malformed} unparsable JSONL record(s)`,
        threadId,
      );
    }
    return lines;
  }

  private collectTurns(lines: ParsedLine[]): ParsedTurn[] {
    const byId = new Map<string, ParsedTurn>();
    for (const line of lines) {
      const turnId = this.extractTurnId(line.payload);
      if (!turnId) continue;
      const existing = byId.get(turnId);
      const previewText = extractRolloutUserPreview(line.payload);
      const next = existing ?? {
        turnId,
        ordinal: line.ordinal,
        offset: line.offset,
        hasUserMessage: false,
        previewText: '',
      };
      next.ordinal = Math.min(next.ordinal, line.ordinal);
      next.offset = Math.min(next.offset, line.offset);
      if (previewText !== null) {
        next.hasUserMessage = true;
        next.previewText = previewText;
      }
      byId.set(turnId, next);
    }
    return [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
  }

  private buildCandidates(
    headers: Map<string, SessionHeader>,
    summaries: Map<string, SessionSummary>,
    diagnostics: BranchAdoptionDiagnosticDto[],
  ): { candidates: RolloutCandidate[]; skippedLegacyForks: number } {
    const candidatesByChild = new Map<string, RolloutCandidate>();
    let skippedLegacyForks = 0;

    for (const header of headers.values()) {
      if (!header.forkedFromId) continue;
      const parent = summaries.get(header.forkedFromId);
      const child = summaries.get(header.threadId);
      if (!parent || !child) {
        this.addDiagnostic(
          diagnostics,
          'warning',
          'parent_missing',
          'Fork parent session file was not found during adoption scan',
          header.threadId,
          header.forkedFromId,
        );
        continue;
      }
      const candidate = this.buildCandidate(
        child,
        parent,
        summaries,
        diagnostics,
      );
      if (!candidate) {
        if (!child.historyBasePresent) skippedLegacyForks += 1;
        continue;
      }
      const existing = candidatesByChild.get(candidate.childThreadId);
      if (
        existing &&
        this.candidateKey(existing) !== this.candidateKey(candidate)
      ) {
        this.addDiagnostic(
          diagnostics,
          'error',
          'duplicate_child_conflict',
          'Session files disagree about one child thread fork boundary',
          candidate.childThreadId,
          candidate.parentThreadId,
        );
        candidatesByChild.delete(candidate.childThreadId);
        continue;
      }
      candidatesByChild.set(candidate.childThreadId, candidate);
    }

    return { candidates: [...candidatesByChild.values()], skippedLegacyForks };
  }

  private buildCandidate(
    child: SessionSummary,
    parent: SessionSummary,
    summaries: Map<string, SessionSummary>,
    diagnostics: BranchAdoptionDiagnosticDto[],
  ): RolloutCandidate | null {
    const base = child.historyBase;
    if (!base) {
      this.addDiagnostic(
        diagnostics,
        'warning',
        child.historyBasePresent
          ? 'history_base_invalid'
          : 'history_base_missing',
        child.historyBasePresent
          ? 'Fork history base is present but could not be parsed'
          : 'Fork uses legacy history and cannot be adopted without guessing',
        child.threadId,
        child.forkedFromId ?? undefined,
      );
      return null;
    }
    if (
      base.threadId !== parent.threadId ||
      !this.validBoundary(base, parent)
    ) {
      this.addDiagnostic(
        diagnostics,
        'warning',
        base.threadId !== parent.threadId
          ? 'history_base_parent_mismatch'
          : 'history_base_offset_mismatch',
        'Fork history base does not match a parent record boundary',
        child.threadId,
        parent.threadId,
      );
      return null;
    }

    const inheritedTurns = this.resolveInheritedTurns(
      child,
      parent,
      summaries,
      diagnostics,
    );
    if (!inheritedTurns) return null;

    const forkedTurn =
      parent.turns.find((turn) => turn.offset >= base.endByteOffset) ?? null;
    const record: RolloutCandidate = {
      childThreadId: child.threadId,
      parentThreadId: parent.threadId,
      forkBeforeTurnId: forkedTurn?.turnId ?? BRANCH_END_SENTINEL,
      commonPrefixTurnId: inheritedTurns.at(-1)?.turnId ?? null,
      inheritedTurnIds: inheritedTurns.map((turn) => turn.turnId),
    };

    // A fork only counts as a *message version* when the boundary replaces a
    // user message AND the child actually carries a replacement one. Requiring
    // both matters: an abandoned or probe fork that never sent anything would
    // otherwise surface as a phantom entry in the user's `< n/m >` switcher,
    // claiming an edit that was never made. Such forks are still adopted — just
    // as topology, which is all we can honestly say about them.
    const childMessage = child.turns.find((turn) => turn.hasUserMessage);
    if (forkedTurn?.hasUserMessage && childMessage) {
      record.messageVersion = {
        originalMessageTurnId: forkedTurn.turnId,
        originalPreviewText: forkedTurn.previewText || 'Original message',
        branchMessageTurnId: childMessage.turnId,
        branchPreviewText: childMessage.previewText || 'External edit',
      };
    }
    return record;
  }

  private resolveInheritedTurns(
    child: SessionSummary,
    parent: SessionSummary,
    summaries: Map<string, SessionSummary>,
    diagnostics: BranchAdoptionDiagnosticDto[],
    seen = new Set<string>(),
  ): ParsedTurn[] | null {
    const base = child.historyBase;
    if (!base || !this.validBoundary(base, parent)) return null;
    if (seen.has(child.threadId)) {
      this.addDiagnostic(
        diagnostics,
        'error',
        'topology_cycle',
        'Session history-base chain contains a cycle',
        child.threadId,
        parent.threadId,
      );
      return null;
    }
    seen.add(child.threadId);

    let prefix: ParsedTurn[] = [];
    if (parent.forkedFromId) {
      const grandParent = summaries.get(parent.forkedFromId);
      if (!grandParent || !parent.historyBase) {
        this.addDiagnostic(
          diagnostics,
          'warning',
          'history_base_missing',
          'Fork ancestor uses legacy history and prevents full adoption',
          child.threadId,
          parent.threadId,
        );
        return null;
      }
      const inheritedPrefix = this.resolveInheritedTurns(
        parent,
        grandParent,
        summaries,
        diagnostics,
        seen,
      );
      if (!inheritedPrefix) return null;
      prefix = inheritedPrefix;
    }

    return [
      ...prefix,
      ...parent.turns.filter((turn) => turn.offset < base.endByteOffset),
    ];
  }

  private validBoundary(base: HistoryBase, parent: SessionSummary): boolean {
    return (
      base.endByteOffset >= 0 &&
      base.endByteOffset <= parent.byteLength &&
      base.endOrdinalExclusive >= 0 &&
      parent.lineOffsets.has(base.endByteOffset)
    );
  }

  private readHistoryBase(
    payload: Record<string, unknown>,
  ): HistoryBase | null {
    const raw = this.asRecord(payload.history_base ?? payload.historyBase);
    if (!raw) return null;
    const threadId = this.readString(raw, ['thread_id', 'threadId']);
    const endOrdinalExclusive = this.readNumber(raw, [
      'end_ordinal_exclusive',
      'endOrdinalExclusive',
    ]);
    const endByteOffset = this.readNumber(raw, [
      'end_byte_offset',
      'endByteOffset',
    ]);
    if (!threadId || endOrdinalExclusive === null || endByteOffset === null) {
      return null;
    }
    return { threadId, endOrdinalExclusive, endByteOffset };
  }

  private extractTurnId(payload: Record<string, unknown>): string | null {
    const direct = this.readString(payload, ['turn_id', 'turnId']);
    if (direct) return direct;
    const metadata = this.asRecord(
      payload.internal_chat_message_metadata_passthrough,
    );
    return metadata ? this.readString(metadata, ['turn_id', 'turnId']) : null;
  }

  private candidateKey(candidate: RolloutCandidate): string {
    return JSON.stringify({
      parentThreadId: candidate.parentThreadId,
      forkBeforeTurnId: candidate.forkBeforeTurnId,
      commonPrefixTurnId: candidate.commonPrefixTurnId,
      inheritedTurnIds: candidate.inheritedTurnIds,
    });
  }

  private addDiagnostic(
    diagnostics: BranchAdoptionDiagnosticDto[],
    severity: BranchAdoptionDiagnosticSeverity,
    code: BranchAdoptionDiagnosticCode,
    message: string,
    threadId?: string,
    parentThreadId?: string,
  ): void {
    if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    diagnostics.push({ severity, code, message, threadId, parentThreadId });
  }

  private readString(
    record: Record<string, unknown>,
    keys: string[],
  ): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private readNumber(
    record: Record<string, unknown>,
    keys: string[],
  ): number | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
