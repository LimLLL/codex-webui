/** Owns drafts and one bounded activation record, including recovery before child startup. */
import { Injectable } from '@nestjs/common';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CatalogPathsService } from './catalog-paths.service';
import {
  catalogPointer,
  editCatalogPointer,
  readOptional,
  readToml,
  writeAtomic,
} from './catalog-files';

export interface CatalogActivation {
  outcome: 'pending' | 'accepted' | 'reverted';
  before: string | null;
  after: string | null;
}

/** A known file-reference conflict; other filesystem errors must propagate unchanged. */
export class CatalogReferencedError extends Error {}

@Injectable()
export class CatalogStorageService {
  /** Paths loaded by this app-server generation, retained until its process has exited. */
  readonly runningPaths = new Set<string>();
  /** Startup snapshot for warnings; editing the disk file does not reload the child catalog. */
  runningContent: string | null = null;
  constructor(readonly paths: CatalogPathsService) {}

  /** Reads raw user configuration without calling Codex. */
  config(): string {
    return readOptional(this.paths.configFile) ?? '';
  }
  /** Resolves relative catalog paths against the user configuration directory. */
  resolvePointer(pointer: string): string {
    return resolve(this.paths.home, pointer);
  }
  /** Returns the user-level pointer, preserving absence. */
  pointer(): string | null {
    return catalogPointer(this.config());
  }
  /** Creates only the application-owned catalog directory. */
  ensureDirectory(): void {
    mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
  }
  /** Reads a draft envelope; its representation deliberately is not an upstream catalog. */
  draft(): string | null {
    const text = readOptional(join(this.paths.directory, 'draft.json'));
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      !('content' in value) ||
      typeof value.content !== 'string'
    )
      throw new Error('Invalid catalog draft envelope');
    return value.content;
  }
  /** Saves only an unreferenced draft, rejecting stale browser edits and configured aliases. */
  saveDraft(content: string, expected: string | null): void {
    if (this.draft() !== expected)
      throw new Error('Draft changed; reload before saving');
    this.ensureDirectory();
    const path = join(this.paths.directory, 'draft.json');
    this.assertUnreferenced(path);
    writeAtomic(path, JSON.stringify({ content }));
  }
  /** Reads and validates the bounded activation record without trusting arbitrary JSON paths. */
  activation(): CatalogActivation | null {
    const text = readOptional(join(this.paths.directory, 'activation.json'));
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      !('outcome' in value) ||
      !['pending', 'accepted', 'reverted'].includes(String(value.outcome)) ||
      !('before' in value) ||
      !('after' in value) ||
      !this.isPointer(value.before) ||
      !this.isPointer(value.after)
    )
      throw new Error('Invalid catalog activation record; repair is required');
    return value as CatalogActivation;
  }
  /** Persists intent/outcome before any corresponding process lifecycle transition. */
  record(record: CatalogActivation): void {
    this.ensureDirectory();
    writeAtomic(
      join(this.paths.directory, 'activation.json'),
      JSON.stringify(record),
    );
  }
  /** Returns an unused managed target before the durable intent record is written. */
  candidatePath(): string {
    for (const name of ['catalog-a.json', 'catalog-b.json']) {
      const path = join(this.paths.directory, name);
      try {
        this.assertUnreferenced(path);
        return path;
      } catch (error) {
        if (!(error instanceof CatalogReferencedError)) throw error;
      }
    }
    throw new Error('No unreferenced managed catalog slot');
  }
  /** Replaces a single user leaf only when it still matches the expected value. */
  switchPointer(expected: string | null, next: string | null): void {
    const text = this.config();
    if (catalogPointer(text) !== expected)
      throw new Error(
        'Catalog pointer changed externally; no files were overwritten',
      );
    mkdirSync(this.paths.home, { recursive: true });
    writeAtomic(this.paths.configFile, editCatalogPointer(text, next));
  }
  /** Aborts an interrupted activation before any child process is spawned. */
  recoverPending(): void {
    const record = this.activation();
    if (record?.outcome !== 'pending') return;
    this.revert(record);
  }
  /** Restores only the catalog leaf, preserving unrelated edits; a conflicting pointer requires repair. */
  revert(record: CatalogActivation): void {
    const current = this.pointer();
    if (current === record.after)
      this.switchPointer(record.after, record.before);
    else if (current !== record.before)
      throw new Error(
        'Catalog pointer changed externally; automatic recovery stopped',
      );
    this.record({ ...record, outcome: 'reverted' });
  }
  /**
   * Tests whether a pointer is the catalog the running child actually loaded.
   *
   * The running set is the only evidence about the live model list; the file on
   * disk says what the *next* start would use. A `null` pointer matches only an
   * empty running set, because a child that loaded a catalog is still serving it
   * no matter what the user-level leaf now says.
   *
   * @param pointer - Catalog pointer to compare, or null for no override.
   * @returns True when the running child is already using that source.
   */
  matchesRunningCatalog(pointer: string | null): boolean {
    if (pointer === null) return this.runningPaths.size === 0;
    return this.runningPaths.has(this.resolvePointer(pointer));
  }
  /** Tests whether a pointer belongs to the two files owned by this backend. */
  isManaged(pointer: string | null): boolean {
    return (
      pointer !== null &&
      ['catalog-a.json', 'catalog-b.json'].some(
        (name) =>
          this.resolvePointer(pointer) === join(this.paths.directory, name),
      )
    );
  }
  /** Refuses direct paths, symlinks and hard-link aliases mentioned in config or loaded by the process. */
  assertUnreferenced(path: string): void {
    const references = [...this.runningPaths];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'model_catalog_json' && typeof child === 'string')
          references.push(this.resolvePointer(child));
        else visit(child);
      }
    };
    visit(readToml(this.config()));
    for (const reference of references) {
      if (resolve(reference) === resolve(path))
        throw new CatalogReferencedError(
          'Refusing to write a referenced catalog file',
        );
      try {
        const left = statSync(reference);
        const right = statSync(path);
        if (
          (left.dev === right.dev && left.ino === right.ino) ||
          realpathSync(reference) === realpathSync(path)
        )
          throw new CatalogReferencedError(
            'Refusing to write a referenced catalog alias',
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  private isPointer(value: unknown): value is string | null {
    return (
      value === null || (typeof value === 'string' && value.trim().length > 0)
    );
  }
}
