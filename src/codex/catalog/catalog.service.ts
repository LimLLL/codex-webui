/** Coordinates full catalog drafts, native validation, pointer activation and independent repair. */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  CodexProcessManager,
  isCatalogStartupFailure,
} from '../codex-process-manager.service';
import { readFileSync } from 'node:fs';
import type { v2 } from '../codex-schema';
import { CatalogAdmissionService } from './catalog-admission.service';
import { CatalogActivityService } from './catalog-activity.service';
import { catalogPointer, syncFile, writeAtomic } from './catalog-files';
import {
  CatalogNativeService,
  parseCatalog,
  type ModelCatalog,
} from './catalog-native.service';
import {
  CatalogStorageService,
  type CatalogActivation,
} from './catalog-storage.service';
import type {
  CatalogApplyResultDto,
  CatalogDocumentDto,
  CatalogStateDto,
  CatalogWarningDto,
} from './catalog.dto';

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  constructor(
    private readonly storage: CatalogStorageService,
    private readonly native: CatalogNativeService,
    private readonly manager: CodexProcessManager,
    private readonly activity: CatalogActivityService,
    private readonly admission: CatalogAdmissionService,
  ) {}

  /** Returns control-plane status even if config or the recovery record is malformed. */
  state(): CatalogStateDto {
    const result: CatalogStateDto = {
      ready: Boolean(this.manager.getClient()),
      startupError: this.manager.getStartupError(),
      configuredPointer: null,
      managed: false,
      pointerApplied: false,
      runningPaths: [...this.storage.runningPaths],
      activation: null,
      repairError: null,
    };
    try {
      const pointer = this.storage.pointer();
      result.configuredPointer = pointer;
      result.managed = this.storage.isManaged(pointer);
      // Configured and running are different facts: an applied change needs a
      // restart, so reporting the configured pointer as the active catalog
      // would claim a model list the child is not actually serving.
      //
      // Same evidence the raw-config save uses for `restartRequired`, so the two
      // cannot disagree and offer a restart the panel then hides. With no child
      // there is nothing to compare against. Removing a pointer while the child
      // still holds one *is* a real mismatch: a restart would change the list.
      result.pointerApplied =
        !result.ready || this.storage.matchesRunningCatalog(pointer);
      result.activation = this.storage.activation();
    } catch (error) {
      result.repairError = this.message(error);
    }
    return result;
  }
  /** Reads the persistent draft without requiring a running child. */
  readDraft(): CatalogDocumentDto {
    return { content: this.storage.draft(), warnings: [] };
  }
  /** Runs native parsing and adds semantic warnings without normalizing or dropping JSON fields. */
  async validate(content: string): Promise<CatalogDocumentDto> {
    this.requireContent(content);
    try {
      const catalog = await this.native.validate(content);
      return { content, warnings: this.entryWarnings(catalog) };
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }
  /** Saves a validated, unreferenced draft with direct optimistic content comparison. */
  async saveDraft(
    content: string,
    expectedDraft: string | null,
  ): Promise<CatalogDocumentDto> {
    if (expectedDraft !== null) this.requireContent(expectedDraft);
    const result = await this.validate(content);
    const release = this.admission.begin();
    try {
      this.storage.saveDraft(content, expectedDraft);
      this.logger.log('Saved catalog draft');
      return result;
    } catch (error) {
      throw new ConflictException(this.message(error));
    } finally {
      release();
    }
  }
  /** Seeds all exported entries, including hidden models; explicit overwrite preconditions protect drafts. */
  async seed(
    source: 'bundled' | 'effective',
    expectedDraft: string | null,
  ): Promise<CatalogDocumentDto> {
    if (!['bundled', 'effective'].includes(source))
      throw new BadRequestException('source must be bundled or effective');
    const content =
      source === 'bundled'
        ? await this.native.bundled()
        : await this.native.effective();
    return this.saveDraft(content, expectedDraft);
  }
  /** Exports complete current resolution, without pretending it is the child's frozen in-memory catalog. */
  async readEffective(): Promise<CatalogDocumentDto> {
    const content = await this.native.effective();
    return {
      content,
      warnings: [
        {
          code: 'resolvedCatalog',
          message:
            'Resolved from current configuration; an existing process may still use its startup catalog.',
        },
      ],
    };
  }
  /** Publishes the exact approved draft, switches the pointer, and restarts only when all work is idle. */
  async apply(
    expectedDraft: string,
    expectedPointer: string | null,
  ): Promise<CatalogApplyResultDto> {
    this.requireContent(expectedDraft);
    this.requirePointer(expectedPointer);
    const draft = this.storage.draft();
    if (draft === null || draft !== expectedDraft)
      throw new ConflictException('Draft changed; reload before applying');
    const validation = await this.validate(draft);
    return this.activate(
      expectedPointer,
      () => {
        if (this.storage.draft() !== draft)
          throw new ConflictException('Draft changed during validation');
        return { after: this.storage.candidatePath(), content: draft };
      },
      validation.warnings,
    );
  }
  /** Removes only a still-owned user override; lower configuration layers remain intact. */
  async useDefault(
    expectedPointer: string | null,
  ): Promise<CatalogApplyResultDto> {
    this.requirePointer(expectedPointer);
    if (!this.storage.isManaged(expectedPointer))
      throw new ConflictException(
        'Only a WebUI-managed catalog can be disabled here',
      );
    return this.activate(expectedPointer, () => ({ after: null }));
  }
  /** Restores the previous pointer without copying an entire config file or replaying turns. */
  async restore(
    expectedPointer: string | null,
  ): Promise<CatalogApplyResultDto> {
    this.requirePointer(expectedPointer);
    const record = this.storage.activation();
    if (
      !record ||
      record.outcome === 'reverted' ||
      record.after !== expectedPointer
    )
      throw new ConflictException(
        'No matching previous activation is available',
      );
    if (record.before)
      await this.native.validateFile(
        this.storage.resolvePointer(record.before),
      );
    if (!this.manager.getClient()) {
      if (!this.manager.isStopped())
        throw new ConflictException('App-server is still starting or stopping');
      const release = this.admission.begin();
      try {
        this.manager.suspendRetries();
        this.storage.revert(record);
        await this.manager.restartControlled(release);
        return { ...this.state(), warnings: [] };
      } finally {
        release();
      }
    }
    return this.activate(expectedPointer, () => ({ after: record.before }));
  }
  /** Restarts after explicit offline raw-file repair, first aborting any unfinished activation. */
  async restartAfterRepair(): Promise<CatalogStateDto> {
    const release = this.admission.begin();
    try {
      if (this.manager.getClient()) {
        const blockers = await this.activity.inspect();
        if (!blockers.canApply)
          throw new ConflictException({
            message: blockers.blockers.map(
              (blocker) => `${blocker.threadId ?? 'Server'}: ${blocker.reason}`,
            ),
          });
      } else if (!this.manager.isStopped())
        throw new ConflictException('App-server is still starting or stopping');
      this.manager.suspendRetries();
      this.storage.recoverPending();
      const pointer = this.storage.pointer();
      if (pointer)
        await this.native.validateFile(this.storage.resolvePointer(pointer));
      await this.manager.restartControlled(release);
      return this.state();
    } finally {
      release();
    }
  }
  /** Returns model warnings after a config save; unavailable evidence is explicitly reported. */
  async configWarnings(
    config: Record<string, unknown>,
  ): Promise<CatalogWarningDto[]> {
    try {
      let catalog: ModelCatalog;
      if (this.storage.runningContent)
        catalog = parseCatalog(this.storage.runningContent);
      else catalog = parseCatalog(await this.native.effective());
      const warnings: CatalogWarningDto[] = [];
      for (const field of ['model', 'review_model']) {
        const model = config[field];
        if (typeof model !== 'string' || !model) continue;
        const exact = catalog.models.find((entry) => entry.slug === model);
        if (exact) {
          if (exact.visibility !== 'list')
            warnings.push({
              code: 'modelHidden',
              model,
              message: `${field} is present but hidden in the picker`,
            });
          continue;
        }
        const suffix = /^[A-Za-z0-9_-]+\/([^/]+)$/.exec(model)?.[1];
        const inherited = catalog.models.some(
          (entry) =>
            model.startsWith(entry.slug) || suffix?.startsWith(entry.slug),
        );
        warnings.push({
          code: inherited ? 'modelMetadataInherited' : 'modelMissing',
          model,
          message: `${field} has no exact catalog entry${inherited ? '; Codex can inherit metadata by prefix/namespace' : '; Codex may use fallback metadata'}`,
        });
      }
      return warnings;
    } catch (error) {
      return [
        {
          code: 'catalogUnavailable',
          message: `Cannot check configured models: ${this.message(error)}`,
        },
      ];
    }
  }
  /** Checks a raw replacement before persisting; a changed pointer never silently rewires draft files. */
  async validateRawConfig(content: string): Promise<void> {
    try {
      const pointer = catalogPointer(content);
      if (!pointer) return;
      const resolved = this.storage.resolvePointer(pointer);
      await this.native.validateFile(resolved);
    } catch (error) {
      throw new BadRequestException(this.message(error));
    }
  }
  /** Executes one activation with durable intent, conditional pointer edits and first-start-only rollback. */
  private async activate(
    expected: string | null,
    candidate: () => { after: string | null; content?: string },
    warnings: CatalogWarningDto[] = [],
  ): Promise<CatalogApplyResultDto> {
    const release = this.admission.begin();
    let record: CatalogActivation | undefined;
    try {
      if (this.storage.pointer() !== expected)
        throw new ConflictException(
          'Catalog pointer changed; reload before applying',
        );
      if (this.storage.activation()?.outcome === 'pending')
        throw new ConflictException(
          'Resolve the pending activation before applying again',
        );
      const client = this.manager.getClient();
      if (client) {
        const blockers = await this.activity.inspect();
        if (!blockers.canApply)
          throw new ConflictException({
            message: blockers.blockers.map(
              (blocker) =>
                `${blocker.name ?? blocker.threadId ?? 'Server'}: ${blocker.reason}`,
            ),
          });
      } else {
        throw new ConflictException(
          'App-server unavailable: repair raw config or restore the previous catalog before applying',
        );
      }
      this.manager.suspendRetries();
      const config = await client.request<v2.ConfigReadResponse>(
        'config/read',
        { includeLayers: true },
      );
      const user = config?.layers?.find(
        (layer) => layer.name.type === 'user' && !layer.name.profile,
      );
      const origin = config?.origins.model_catalog_json?.name;
      if (
        origin &&
        (origin.type === 'project' ||
          origin.type === 'sessionFlags' ||
          (origin.type === 'user' && origin.profile))
      ) {
        throw new ConflictException(
          'A higher-precedence catalog setting prevents user-level activation',
        );
      }
      const runningPath = [...this.storage.runningPaths][0] ?? null;
      const configured =
        typeof config.config.model_catalog_json === 'string'
          ? this.storage.resolvePointer(config.config.model_catalog_json)
          : null;
      if (configured !== runningPath)
        throw new ConflictException(
          'Catalog source changed since startup; restart or repair before applying',
        );
      if (
        runningPath &&
        this.storage.runningContent !== null &&
        readFileSync(runningPath, 'utf8') !== this.storage.runningContent
      ) {
        throw new ConflictException(
          'Running catalog file changed externally; restart or repair before replacing its backup',
        );
      }
      const prepared = candidate();
      record = { outcome: 'pending', before: expected, after: prepared.after };
      this.storage.record(record);
      if (prepared.content !== undefined) {
        this.storage.assertUnreferenced(prepared.after!);
        writeAtomic(prepared.after!, prepared.content);
      }
      await client.request('config/batchWrite', {
        edits: [
          {
            keyPath: 'model_catalog_json',
            value: prepared.after,
            mergeStrategy: 'replace',
          },
        ],
        expectedVersion: user?.version,
        reloadUserConfig: false,
      });
      if (this.storage.pointer() !== prepared.after)
        throw new Error(
          'Config write did not install the intended catalog pointer',
        );
      syncFile(this.storage.paths.configFile);
      try {
        await this.manager.restartControlled(() => {
          if (
            prepared.after &&
            !this.storage.runningPaths.has(
              this.storage.resolvePointer(prepared.after),
            )
          ) {
            throw new Error(
              'Another configuration layer prevented catalog activation',
            );
          }
          this.storage.record({ ...record!, outcome: 'accepted' });
          // Admission reopens synchronously before ready listeners claim recovery work.
          release();
        });
      } catch (error) {
        if (isCatalogStartupFailure(error)) {
          this.storage.revert(record);
          await this.manager.restartControlled(release);
          throw new BadRequestException(
            `Catalog startup rejected; previous catalog restored: ${this.message(error)}`,
          );
        }
        throw error;
      }
      this.logger.log('Catalog activation accepted');
      return { ...this.state(), warnings };
    } catch (error) {
      // Before restart the old process is still healthy; undo only this unfinished pointer write.
      if (
        record &&
        this.manager.getClient() &&
        this.storage.activation()?.outcome === 'pending'
      )
        this.storage.revert(record);
      throw error;
    } finally {
      release();
    }
  }
  private entryWarnings(catalog: ModelCatalog): CatalogWarningDto[] {
    return catalog.models.flatMap((entry) => {
      const messages = entry.model_messages as
        | { instructions_template?: unknown }
        | undefined;
      const instructions =
        messages?.instructions_template ?? entry.base_instructions;
      return typeof instructions === 'string' && !instructions.trim()
        ? [
            {
              code: 'emptyInstructions',
              model: entry.slug,
              message: 'The model has empty base instructions',
            },
          ]
        : [];
    });
  }
  private requireContent(content: unknown): asserts content is string {
    if (typeof content !== 'string')
      throw new BadRequestException('content must be a string');
  }
  private requirePointer(value: unknown): asserts value is string | null {
    if (value !== null && (typeof value !== 'string' || !value.trim()))
      throw new BadRequestException(
        'expectedPointer must be a nonempty string or null',
      );
  }
  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
