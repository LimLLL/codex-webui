/**
 * Recognition of file references inside agent-authored markdown.
 *
 * Agent replies name files two ways: as markdown link destinations, which state
 * navigation intent outright, and as inline-code tokens, which do not. Both are
 * parsed here so the two admission rules sit beside each other and beside the
 * location grammar they share.
 *
 * Recognition is structural only. A token shaped like a path is not evidence
 * that the file exists — the open attempt is what establishes that. The agreed
 * failure mode is therefore "not recognised" rather than "recognised, clickable
 * and dead": inert text at least promises nothing.
 */

/** A recognised file reference. */
export interface FileReference {
  /** Path to open, percent-decoded for link destinations, literal for inline code. */
  path: string;
  /** One-based line number, or null when the reference carried no location. */
  line: number | null;
}

/**
 * Where a candidate token came from.
 *
 * A `link` destination is admitted on weaker structural evidence because the
 * markdown link syntax already declares the author's intent to navigate, and it
 * arrives percent-encoded. An `inlineCode` token declares nothing and is
 * literal: in agent prose, backticks carry shell commands, symbol names, config
 * keys and package names far more often than paths, so a token there must earn
 * admission structurally.
 */
export type ReferenceSource = 'link' | 'inlineCode';

/** Beyond this a numeric suffix is not plausibly a line number. */
const MAX_LINE = 1_000_000;

/**
 * Characters that disqualify an inferred inline-code token: shell syntax,
 * globs, quoting, type parameters, argument lists.
 *
 * Applied to inline code only. A filename may legally contain brackets or
 * parentheses — a route-group directory, for instance — and rejecting those in
 * an explicit link would send the link back to the broken anchor this whole
 * change exists to remove.
 */
const DISQUALIFYING_CHARS = /[\s*?[\]{}()<>|&"'`$\\!,;=]/;

/** Control characters are never part of a path worth requesting. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A scheme prefix such as `http:`, `node:`, `vscode:` or a Windows drive `C:`. */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A separator-less filename carrying a line suffix, the one scheme-like exception. */
const BARE_LOCATED_FILE = /^([^/:?#]+):\d+$/;

/** Trailing `:42` location suffix. Unbounded digits so overflow reads as malformed. */
const COLON_LOCATION = /:(\d+)$/;

/** Trailing `#L42` location suffix, the spelling used by code-hosting links. */
const HASH_LOCATION = /#L(\d+)$/;

/**
 * Location syntax this grammar does not support: columns, ranges, signed lines.
 *
 * Tested against the path *after* one suffix has been removed. Something still
 * matching means the token carried a location that was only partly understood,
 * and opening it would land somewhere the text did not name.
 */
const RESIDUAL_LOCATION = /(?::[+-]?\d+(?:[.:-]\d+)*|#L\d+(?:-L?\d+)?)$/;

/** A dotted-quad host, which reads as a file with an extension but is not one. */
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

interface SplitLocation {
  /** The candidate path with the location suffix removed. */
  base: string;
  /** Parsed one-based line, or null when no suffix was present. */
  line: number | null;
  /** A suffix was present but named an impossible line. */
  malformed: boolean;
}

/**
 * Separates a trailing location suffix from the path it qualifies.
 *
 * A suffix naming an impossible line is reported as malformed rather than
 * silently dropped: the text promised a specific place in the file, and opening
 * at an arbitrary one instead would be a worse answer than staying inert.
 *
 * @param raw - The whole candidate token
 * @returns The path, its line if valid, and whether a present suffix was invalid
 */
function splitLocation(raw: string): SplitLocation {
  for (const pattern of [HASH_LOCATION, COLON_LOCATION]) {
    const match = pattern.exec(raw);
    if (!match) continue;
    const line = Number(match[1]);
    if (!Number.isInteger(line) || line < 1 || line > MAX_LINE) {
      return { base: raw.slice(0, match.index), line: null, malformed: true };
    }
    return { base: raw.slice(0, match.index), line, malformed: false };
  }
  return { base: raw, line: null, malformed: false };
}

/**
 * Reports whether the final path component looks like a file rather than a
 * directory or a dotted identifier.
 *
 * Extensions are accepted structurally — a fixed catalogue of known extensions
 * would reject legitimate project-specific ones — but the shape is constrained
 * enough to exclude dotted config keys such as `security.workspaceRoots` and
 * environment lookups such as `process.env.NODE_ENV`.
 *
 * @param path - Candidate path with any location suffix already removed
 * @returns True when the last component carries a plausible extension
 */
function hasFileExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  // A leading dot marks a dotfile (.env, .gitignore), not an extension.
  if (dot === 0) return name.length > 1;
  if (dot < 0) return false;
  const extension = name.slice(dot + 1);
  return extension.length > 0 && extension.length <= 10 && /^[A-Za-z0-9]+$/.test(extension);
}

/**
 * Applies the stricter admission rule for tokens found inside inline code.
 *
 * A bare separator-less filename such as `package.json` or `Dockerfile` stays
 * inert by decision: in prose those are mentioned far more often than they are
 * referenced, and making every mention clickable would fill ordinary text with
 * affordances that mostly lead nowhere.
 *
 * @param base - Candidate path with any location suffix already removed
 * @param line - Parsed line number, or null when the token carried no location
 * @returns True when the token carries enough structure to be a file reference
 */
function qualifiesAsInlineCode(base: string, line: number | null): boolean {
  // An explicit filesystem prefix is intent on its own.
  if (base.startsWith('./') || base.startsWith('../') || base.startsWith('/')) return true;
  // Otherwise the token needs a file-like final component, plus either a
  // directory separator or an explicit location to distinguish it from prose.
  if (!hasFileExtension(base)) return false;
  return base.includes('/') || line !== null;
}

/**
 * Parses a candidate token into a file reference.
 *
 * For inline code the whole token must qualify: a path embedded in a larger
 * expression is deliberately not extracted, both because the surrounding syntax
 * usually means the author was describing an operation rather than a file, and
 * because guessing where the path ends inside an arbitrary expression is
 * unreliable.
 *
 * Known limitation: a host carrying a port whose final component looks like a
 * filename — `example.com:3000` — is admitted as a located file. It is not
 * distinguishable from `README.md:42` without a hostname catalogue, and the
 * open attempt fails honestly.
 *
 * @param raw - The link destination or inline-code token, verbatim
 * @param source - Which surface the token came from, selecting the admission rule
 * @returns The reference, or null when the token is not recognised as one
 */
export function parseFileReference(raw: string, source: ReferenceSource): FileReference | null {
  if (!raw || raw !== raw.trim()) return null;
  if (CONTROL_CHARS.test(raw)) return null;
  if (source === 'inlineCode' && DISQUALIFYING_CHARS.test(raw)) return null;
  // Shell-only home expansion, package scopes and the human mention syntax.
  if (raw.startsWith('~') || raw.startsWith('@')) return null;
  // Protocol-relative URL, and an in-document fragment.
  if (raw.startsWith('//') || raw.startsWith('#')) return null;

  // Schemes are rejected before the location suffix is removed. Stripping first
  // would leave `mailto:42` looking like a file named `mailto` on line 42. The
  // sole exception is the form this feature exists for: a bare filename whose
  // colon introduces a line rather than a scheme.
  const bareLocated = BARE_LOCATED_FILE.exec(raw);
  if (SCHEME_PREFIX.test(raw) && !(bareLocated && hasFileExtension(bareLocated[1]))) {
    return null;
  }

  const { base, line, malformed } = splitLocation(raw);
  if (malformed || !base) return null;
  // A trailing separator names a directory; opening one is a different action.
  if (base.endsWith('/')) return null;
  if (RESIDUAL_LOCATION.test(base)) return null;
  // Query and fragment syntax is unsupported. Tested before decoding, so an
  // encoded `#` in a real filename survives while a genuine fragment does not.
  if (base.includes('#') || base.includes('?')) return null;
  if (IPV4_HOST.test(base.slice(base.lastIndexOf('/') + 1))) return null;

  if (source === 'inlineCode') {
    return qualifiesAsInlineCode(base, line) ? { path: base, line } : null;
  }

  // Link destinations arrive percent-encoded — markdown encodes spaces in
  // angle-bracket destinations, and authors encode them by hand. Decoding once,
  // after the location has been split off, keeps encoded filename characters
  // from being re-read as location syntax.
  try {
    const path = decodeURIComponent(base);
    return CONTROL_CHARS.test(path) ? null : { path, line };
  } catch {
    // A lone `%` is a legal filename character but not legal encoding; the
    // destination is ambiguous, so it stays inert rather than opening a guess.
    return null;
  }
}

/**
 * Resolves a reference path against the conversation that produced it.
 *
 * Relative paths resolve against the conversation's working directory and
 * nothing else — not the file browser's root, not the browser URL, not the
 * server process directory. When that directory is unknown the reference is
 * unresolvable and says so, because every fallback would open some other file
 * with equal confidence.
 *
 * Parent traversal is left intact rather than rejected: reaching a sibling
 * directory is legitimate, and authorisation belongs to the server, which
 * resolves the real path and checks it against the allowed roots.
 *
 * @param path - Reference path, absolute or relative
 * @param cwd - Working directory of the conversation the reference was read in
 * @returns An absolute path, or null when a relative path has no basis to resolve against
 */
export function resolveFileReferencePath(path: string, cwd: string | null): string | null {
  if (path.startsWith('/')) return path;
  if (!cwd) return null;
  const relative = path.startsWith('./') ? path.slice(2) : path;
  return `${cwd.replace(/\/+$/, '')}/${relative}`;
}
