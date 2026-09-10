/** Durable file replacement and lossless top-level TOML leaf editing. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';

/** Matches the validator's input ceiling; a catalog is JSON, not a stream. */
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/**
 * Reads a catalog file without letting it stall or flood the process.
 *
 * A configured pointer is user-controlled and read on the startup and repair
 * paths, so it must not be able to disable the very server that repairs it. A
 * FIFO or device node would block the reader indefinitely with no timeout, and
 * an oversized regular file would be pulled entirely into memory before any
 * limit applied. `stat` rejects both before the file is ever opened, and the
 * read itself is asynchronous so a slow filesystem cannot hold the event loop.
 *
 * @param path - Absolute catalog path.
 * @returns File contents as UTF-8.
 * @throws If the path is not a regular file or exceeds the size ceiling.
 */
export async function readCatalogFile(path: string): Promise<string> {
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`Not a regular file: ${path}`);
  if (stats.size > MAX_CATALOG_BYTES)
    throw new Error(
      `Catalog exceeds ${MAX_CATALOG_BYTES} bytes: ${String(stats.size)}`,
    );
  return readFile(path, 'utf8');
}

/** Reads an optional file; permission and I/O errors are never treated as absence. */
export function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Replaces a file on its own filesystem and flushes both content and directory metadata. */
export function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Flushes an upstream-written config before the child is stopped for activation. */
export function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

/** Flushes directory entries after a rename or removal. */
export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Parses TOML with upstream-compatible 1.0 syntax, without serializing it again. */
export function readToml(content: string): Record<string, unknown> {
  return getStaticTOMLValue(parseTOML(content, { tomlVersion: '1.0' }));
}

/** Reads a string leaf; absence is distinct from an invalid non-string value. */
export function catalogPointer(content: string): string | null {
  const value = readToml(content).model_catalog_json;
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim())
    throw new Error('model_catalog_json must be a nonempty string');
  return value;
}

/** Edits only the catalog value span, retaining surrounding comments, whitespace and tables. */
export function editCatalogPointer(
  content: string,
  value: string | null,
): string {
  const ast = parseTOML(content, { tomlVersion: '1.0' });
  const entry = ast.body[0].body.find(
    (node) =>
      node.type === 'TOMLKeyValue' &&
      node.key.keys.length === 1 &&
      getStaticTOMLValue(node.key.keys[0]) === 'model_catalog_json',
  );
  if (entry?.type === 'TOMLKeyValue') {
    const range = value === null ? entry.range : entry.value.range;
    return (
      content.slice(0, range[0]) +
      (value === null ? '' : JSON.stringify(value)) +
      content.slice(range[1])
    );
  }
  if (value === null) return content;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return `model_catalog_json = ${JSON.stringify(value)}${newline}${content}`;
}
