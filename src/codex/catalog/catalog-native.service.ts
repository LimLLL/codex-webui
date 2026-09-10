/** Bounded full-catalog export and validation using the executing Codex binary. */
import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  catalogPointer,
  editCatalogPointer,
  readCatalogFile,
} from './catalog-files';
import { resolve } from 'node:path';
import { CatalogPathsService } from './catalog-paths.service';

export const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
export type CatalogEntry = Record<string, unknown> & { slug: string };
export interface ModelCatalog {
  models: CatalogEntry[];
}

/** Checks the document envelope and unique identifiers, leaving entry schema validation to Codex. */
export function parseCatalog(content: string): ModelCatalog {
  if (Buffer.byteLength(content) > CATALOG_MAX_BYTES)
    throw new Error('Catalog exceeds 8 MiB');
  const value: unknown = JSON.parse(content);
  if (
    !value ||
    typeof value !== 'object' ||
    !('models' in value) ||
    !Array.isArray(value.models) ||
    value.models.length === 0
  ) {
    throw new Error('Catalog must contain a nonempty models array');
  }
  const seen = new Set<string>();
  for (const entry of value.models as unknown[]) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('slug' in entry) ||
      typeof entry.slug !== 'string' ||
      !entry.slug.trim()
    )
      throw new Error('Each model needs a nonempty slug');
    if (seen.has(entry.slug))
      throw new Error(`Duplicate model slug: ${entry.slug}`);
    seen.add(entry.slug);
  }
  return value as ModelCatalog;
}

@Injectable()
export class CatalogNativeService {
  constructor(private readonly paths: CatalogPathsService) {}

  /** Exports the entire bundled catalog without consulting user configuration or remote cache. */
  async bundled(): Promise<string> {
    return this.isolated(async (directory) =>
      this.run(['debug', 'models', '--bundled'], directory),
    );
  }

  /** Resolves current configuration using a disposable cache copy; never writes the user's remote cache. */
  async effective(): Promise<string> {
    return this.isolated(async (directory) => {
      for (const name of ['config.toml', 'models_cache.json', 'auth.json']) {
        try {
          let content = await readFile(join(this.paths.home, name), 'utf8');
          if (name === 'config.toml') {
            const pointer = catalogPointer(content);
            if (pointer)
              content = editCatalogPointer(
                content,
                resolve(this.paths.home, pointer),
              );
          }
          await writeFile(join(directory, name), content, { mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return this.run(['debug', 'models'], directory, true);
    });
  }

  /** Parses a candidate with the real upstream parser in an isolated, credential-free Codex home. */
  async validate(content: string): Promise<ModelCatalog> {
    parseCatalog(content);
    return this.isolated(async (directory) => {
      const candidate = join(directory, 'candidate.json');
      await writeFile(candidate, content, { mode: 0o600 });
      await writeFile(
        join(directory, 'config.toml'),
        `model_catalog_json = ${JSON.stringify(candidate)}\n`,
        { mode: 0o600 },
      );
      return parseCatalog(await this.run(['debug', 'models'], directory));
    });
  }

  /** Validates a referenced catalog without ever writing that file. */
  async validateFile(path: string): Promise<ModelCatalog> {
    // Bounded acquisition, not just bounded parsing: the path is user-supplied.
    return this.validate(await readCatalogFile(path));
  }

  private async isolated<T>(
    operation: (directory: string) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'codex-webui-catalog-'));
    try {
      return await operation(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** Uses argument arrays, caps combined output, and reaps the subprocess on timeout or overflow. */
  private run(
    args: string[],
    home: string,
    effective = false,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.paths.binary, args, {
        cwd: effective ? process.cwd() : home,
        env: effective
          ? { ...process.env, CODEX_HOME: home }
          : {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              CODEX_HOME: home,
              XDG_CONFIG_HOME: home,
              TMPDIR: home,
            },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new Error('Catalog command exceeded 20 seconds');
        child.kill('SIGKILL');
      }, 20_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const receive = (chunk: string, output: boolean) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > CATALOG_MAX_BYTES) {
          failure = new Error('Catalog command output exceeded 8 MiB');
          child.kill('SIGKILL');
          return;
        }
        if (output) stdout += chunk;
        else stderr = (stderr + chunk).slice(-16_384);
      };
      child.stdout.on('data', (chunk: string) => receive(chunk, true));
      child.stderr.on('data', (chunk: string) => receive(chunk, false));
      child.on('error', (error) => {
        failure = error;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new Error(stderr.trim() || `Catalog command exited ${code}`));
        else {
          try {
            parseCatalog(stdout);
            resolve(stdout);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    });
  }
}
