/**
 * Tests pinning file-reference recognition and resolution.
 *
 * The negative cases matter as much as the positive ones: this parser decides
 * what becomes clickable in agent prose, and over-recognition turns ordinary
 * text into affordances that lead nowhere.
 */
import { describe, expect, it } from 'vitest';
import { parseFileReference, resolveFileReferencePath } from './file-references';

describe('parseFileReference — inline code', () => {
  const parse = (raw: string) => parseFileReference(raw, 'inlineCode');

  it('accepts paths carrying a directory separator and a file-like name', () => {
    expect(parse('src/components/chat.tsx')).toEqual({
      path: 'src/components/chat.tsx',
      line: null,
    });
  });

  it('accepts explicit filesystem prefixes even without an extension', () => {
    expect(parse('./scripts/check')).toEqual({ path: './scripts/check', line: null });
    expect(parse('../shared/types.ts')).toEqual({ path: '../shared/types.ts', line: null });
    expect(parse('/workspace/src/app.ts')).toEqual({ path: '/workspace/src/app.ts', line: null });
  });

  it('accepts a bare filename once a location suffix qualifies it', () => {
    expect(parse('README.md:42')).toEqual({ path: 'README.md', line: 42 });
  });

  it('leaves bare filenames inert without a qualifying signal', () => {
    // Decided deliberately: in prose these are mentioned far more often than
    // they are referenced, so recognising them would fill text with dead links.
    expect(parse('package.json')).toBeNull();
    expect(parse('config.toml')).toBeNull();
    expect(parse('Dockerfile')).toBeNull();
  });

  it('leaves separator-bearing tokens without a file-like name inert', () => {
    expect(parse('scripts/check')).toBeNull();
    expect(parse('web/src')).toBeNull();
  });

  it('rejects dotted identifiers that merely resemble filenames', () => {
    expect(parse('config.server.port')).toBeNull();
    expect(parse('process.env.NODE_ENV')).toBeNull();
    expect(parse('security.workspaceRoots')).toBeNull();
  });

  it('rejects commands, globs, substitutions and type expressions', () => {
    expect(parse('npm run build')).toBeNull();
    expect(parse('cat src/app.ts')).toBeNull();
    expect(parse('src/**/*.ts')).toBeNull();
    expect(parse('$ROOT/src/app.ts')).toBeNull();
    expect(parse('Record<string, unknown>')).toBeNull();
  });

  it('rejects schemes, package scopes and URLs', () => {
    expect(parse('node:fs')).toBeNull();
    expect(parse('@openai/codex')).toBeNull();
    expect(parse('https://example.com/file.ts')).toBeNull();
    expect(parse('vscode://file/src/app.ts')).toBeNull();
  });

  it('does not mistake a host:port for a located file', () => {
    // `localhost` has no file-like extension, so the numeric suffix alone must
    // not be enough to admit it.
    expect(parse('localhost:3000')).toBeNull();
  });

  it('rejects shell-only home expansion and Windows path forms', () => {
    expect(parse('~/notes.md')).toBeNull();
    expect(parse('C:/project/app.ts')).toBeNull();
    expect(parse('\\\\server\\share\\app.ts')).toBeNull();
  });

  it('treats an impossible location as malformed rather than absent', () => {
    // Dropping the suffix would open the file at an arbitrary place while the
    // text named a specific one.
    expect(parse('src/app.ts:0')).toBeNull();
    expect(parse('src/app.ts:99999999')).toBeNull();
  });

  it('accepts the code-hosting line spelling', () => {
    expect(parse('src/app.ts#L42')).toEqual({ path: 'src/app.ts', line: 42 });
  });

  it('rejects directories and padded tokens', () => {
    expect(parse('src/components/')).toBeNull();
    expect(parse(' src/app.ts')).toBeNull();
    expect(parse('')).toBeNull();
  });

  it('accepts dotfiles once a directory separator is present', () => {
    expect(parse('web/.gitignore')).toEqual({ path: 'web/.gitignore', line: null });
  });

  it('rejects chained commands that begin with an explicit prefix', () => {
    // An explicit prefix admits the token before the extension rule runs, so
    // shell syntax has to be excluded on its own.
    expect(parse('./run.sh&&./other.sh')).toBeNull();
  });

  it('rejects location syntax this grammar does not implement', () => {
    expect(parse('./src/app.ts:12:3')).toBeNull();
    expect(parse('./src/app.ts:-2')).toBeNull();
    expect(parse('./src/page.ts#L12-L20')).toBeNull();
  });

  it('treats an overflowing line as malformed rather than as part of the path', () => {
    expect(parse('/src/app.ts:99999999')).toBeNull();
  });

  it('rejects a dotted-quad host carrying a port', () => {
    // `127.0.0.1` has a final component that passes the extension shape.
    expect(parse('127.0.0.1:8000')).toBeNull();
  });

  it('rejects query and fragment syntax', () => {
    expect(parse('src/app.ts#section')).toBeNull();
    expect(parse('src/app.ts?raw')).toBeNull();
  });
});

describe('parseFileReference — link destinations', () => {
  const parse = (raw: string) => parseFileReference(raw, 'link');

  it('admits bare filenames that inline code would leave inert', () => {
    // The link syntax already declares intent to navigate, so the weaker
    // structural evidence is enough here.
    expect(parse('package.json')).toEqual({ path: 'package.json', line: null });
    expect(parse('CHANGELOG')).toEqual({ path: 'CHANGELOG', line: null });
  });

  it('keeps external destinations out of the filesystem channel', () => {
    expect(parse('https://example.com')).toBeNull();
    expect(parse('mailto:someone@example.com')).toBeNull();
    expect(parse('//example.com/file.ts')).toBeNull();
    expect(parse('#overview')).toBeNull();
  });

  it('parses a located path', () => {
    expect(parse('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42 });
  });

  it('admits filenames the inline blacklist would reject', () => {
    // Route-group directories are ordinary paths; rejecting them here would
    // send the link back to being a browser navigation that 404s.
    expect(parse('app/(group)/page.tsx')).toEqual({
      path: 'app/(group)/page.tsx',
      line: null,
    });
  });

  it('decodes percent-encoded destinations once', () => {
    expect(parse('docs/My%20File.md')).toEqual({ path: 'docs/My File.md', line: null });
  });

  it('does not re-read a decoded character as location syntax', () => {
    // `%23` decodes to `#`, which must stay part of the filename rather than
    // becoming a fragment.
    expect(parse('docs/a%23b.md')).toEqual({ path: 'docs/a#b.md', line: null });
  });

  it('rejects a destination whose encoding is ambiguous', () => {
    expect(parse('docs/100%.ts')).toBeNull();
  });

  it('rejects a scheme whose suffix looks like a line', () => {
    // Stripping the location first would leave a "file" named `mailto`.
    expect(parse('mailto:42')).toBeNull();
    expect(parse('javascript:42')).toBeNull();
  });
});

describe('resolveFileReferencePath', () => {
  it('returns absolute paths untouched', () => {
    expect(resolveFileReferencePath('/etc/hosts', '/work/project')).toBe('/etc/hosts');
  });

  it('resolves relative paths against the conversation directory', () => {
    expect(resolveFileReferencePath('src/app.ts', '/work/project')).toBe(
      '/work/project/src/app.ts',
    );
  });

  it('strips a leading current-directory marker', () => {
    expect(resolveFileReferencePath('./src/app.ts', '/work/project')).toBe(
      '/work/project/src/app.ts',
    );
  });

  it('leaves parent traversal for the server to resolve and authorise', () => {
    expect(resolveFileReferencePath('../sibling/app.ts', '/work/project')).toBe(
      '/work/project/../sibling/app.ts',
    );
  });

  it('tolerates a trailing separator on the conversation directory', () => {
    expect(resolveFileReferencePath('src/app.ts', '/work/project/')).toBe(
      '/work/project/src/app.ts',
    );
  });

  it('reports relative paths as unresolvable without a conversation directory', () => {
    // Every fallback — browser URL, file-tree root, server process directory —
    // would open some other file with equal confidence.
    expect(resolveFileReferencePath('src/app.ts', null)).toBeNull();
  });
});
