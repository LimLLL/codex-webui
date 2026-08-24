/** Source abstraction shared by workspace files and read-only archive entries. */
import { getApiToken, getAuthorizationHeader, buildFileServeUrl } from '@/auth-token';
import { withBasePath } from '@/base-path';

export type PreviewSource =
  | { kind: 'file'; filePath: string }
  | {
      kind: 'archive';
      archivePath: string;
      entryPath: string;
      label: string;
      size?: number;
    };

export interface PreviewFetchResult {
  response: Response;
  buffer: ArrayBuffer;
}

const FILE_SOURCE_CACHE = new Map<string, PreviewSource>();

/** Creates a workspace-file preview source. */
export function filePreviewSource(filePath: string): PreviewSource {
  const existing = FILE_SOURCE_CACHE.get(filePath);
  if (existing) return existing;
  const source: PreviewSource = { kind: 'file', filePath };
  FILE_SOURCE_CACHE.set(filePath, source);
  return source;
}

/** Returns a display label for a preview source. */
export function previewSourceLabel(source: PreviewSource): string {
  return source.kind === 'file' ? source.filePath : source.label;
}

/** Builds an authenticated URL usable by native media tags and iframe-like consumers. */
export function buildPreviewUrl(source: PreviewSource): string {
  if (source.kind === 'file') return buildFileServeUrl(source.filePath);
  const token = getApiToken();
  const params = new URLSearchParams({ path: source.archivePath, entry: source.entryPath });
  if (token) params.set('access_token', token);
  return `${withBasePath('/api/files/archive/entry')}?${params.toString()}`;
}

/** Builds fetch headers for preview API calls that can send Authorization. */
export function buildPreviewHeaders(range?: string): Headers {
  const headers = new Headers();
  const auth = getAuthorizationHeader();
  if (auth) headers.set('Authorization', auth);
  if (range) headers.set('Range', range);
  return headers;
}

/** Fetches preview bytes with optional Range support. */
export async function fetchPreviewBytes(
  source: PreviewSource,
  range?: string,
): Promise<PreviewFetchResult> {
  const response = await fetch(buildPreviewUrl(source), {
    headers: buildPreviewHeaders(range),
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`Request failed (${response.status})`);
  }
  return { response, buffer: await response.arrayBuffer() };
}

/** Fetches a preview source as a Blob. */
export async function fetchPreviewBlob(source: PreviewSource): Promise<Blob> {
  const response = await fetch(buildPreviewUrl(source), {
    headers: buildPreviewHeaders(),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.blob();
}

/** Fetches a preview source as UTF-8 text. */
export async function fetchPreviewText(source: PreviewSource): Promise<string> {
  const response = await fetch(buildPreviewUrl(source), {
    headers: buildPreviewHeaders(),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.text();
}
