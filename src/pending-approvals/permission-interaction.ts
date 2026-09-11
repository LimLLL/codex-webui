/** Lossless permission presentation and selection encoding for the pinned protocol. */
import type {
  InteractionPresentationDto,
  PermissionOptionDto,
} from './dto/interaction.dto';
import { nonempty, onlyKeys, record } from './request-validation';

/** Renders a known path expression without interpreting globs as literal paths. */
function pathLabel(value: unknown): string | null {
  const path = record(value);
  if (!path) return null;
  if (
    path.type === 'path' &&
    onlyKeys(path, ['type', 'path']) &&
    nonempty(path.path)
  )
    return path.path;
  if (
    path.type === 'glob_pattern' &&
    onlyKeys(path, ['type', 'pattern']) &&
    nonempty(path.pattern)
  )
    return `glob: ${path.pattern}`;
  if (path.type !== 'special' || !onlyKeys(path, ['type', 'value']))
    return null;
  const special = record(path.value);
  if (!special || typeof special.kind !== 'string') return null;
  if (
    ['root', 'minimal', 'tmpdir', 'slash_tmp'].includes(special.kind) &&
    onlyKeys(special, ['kind'])
  )
    return `scope: ${special.kind}`;
  if (
    special.kind === 'project_roots' &&
    onlyKeys(special, ['kind', 'subpath']) &&
    (special.subpath == null || typeof special.subpath === 'string')
  )
    return `scope: project_roots${special.subpath ? ` / ${special.subpath}` : ''}`;
  // The protocol's unknown special scope is not a grant we can interpret safely.
  return null;
}

/** Enumerates every understood grant and restriction, or rejects the whole profile. */
function permissionOptions(value: unknown): PermissionOptionDto[] | null {
  const profile = record(value);
  if (!profile || !onlyKeys(profile, ['network', 'fileSystem'])) return null;
  const options: PermissionOptionDto[] = [];
  if (profile.network != null) {
    const network = record(profile.network);
    if (
      !network ||
      !onlyKeys(network, ['enabled']) ||
      typeof network.enabled !== 'boolean'
    )
      return null;
    options.push({
      id: 'network',
      label: network.enabled ? 'Network access' : 'Network access disabled',
      access: 'network',
      required: !network.enabled,
    });
  }
  if (profile.fileSystem != null) {
    const fs = record(profile.fileSystem);
    if (!fs || !onlyKeys(fs, ['read', 'write', 'entries', 'globScanMaxDepth']))
      return null;
    if (
      fs.globScanMaxDepth !== undefined &&
      (!Number.isSafeInteger(fs.globScanMaxDepth) ||
        Number(fs.globScanMaxDepth) < 0)
    )
      return null;
    for (const access of ['read', 'write'] as const) {
      if (fs[access] == null) continue;
      if (!Array.isArray(fs[access])) return null;
      for (const [i, path] of (fs[access] as unknown[]).entries()) {
        if (!nonempty(path)) return null;
        options.push({
          id: `${access}:${i}`,
          label: path,
          access,
          required: false,
        });
      }
    }
    if (fs.entries !== undefined) {
      if (!Array.isArray(fs.entries)) return null;
      for (const [i, raw] of fs.entries.entries()) {
        const entry = record(raw);
        if (
          !entry ||
          !onlyKeys(entry, ['access', 'path']) ||
          !['read', 'write', 'deny'].includes(String(entry.access))
        )
          return null;
        const label = pathLabel(entry.path);
        if (label === null) return null;
        options.push({
          id: `entry:${i}`,
          label,
          access: entry.access as PermissionOptionDto['access'],
          required: entry.access === 'deny',
        });
      }
    }
  }
  return options;
}

/** Presents complete known permissions; an unknown profile exposes no grant action. */
export function presentPermissions(
  params: Record<string, unknown>,
): InteractionPresentationDto {
  const options = permissionOptions(params.permissions);
  const depth = record(
    record(params.permissions)?.fileSystem,
  )?.globScanMaxDepth;
  return {
    kind: 'permissions',
    supported: options !== null,
    unsupportedReason:
      options === null
        ? 'This client cannot interpret the complete requested permission scope. Only denial is available.'
        : null,
    message: [
      typeof params.reason === 'string' ? params.reason : '',
      typeof depth === 'number' ? `Glob scan depth: ${depth}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    cwd: typeof params.cwd === 'string' ? params.cwd : null,
    environmentId:
      typeof params.environmentId === 'string' ? params.environmentId : null,
    serverName: null,
    url: null,
    fields: [],
    permissions: options ?? [],
  };
}

/**
 * Encodes user-selected option IDs from the original immutable profile. Deny
 * entries always accompany selected filesystem grants, and session scope must
 * be explicit. No caller-supplied path or raw permission object is accepted.
 */
export function encodePermissions(
  params: Record<string, unknown>,
  result: unknown,
): unknown {
  const response = record(result);
  if (
    !response ||
    !onlyKeys(response, ['selected', 'scope']) ||
    !Array.isArray(response.selected) ||
    !response.selected.every((id) => typeof id === 'string') ||
    (response.scope !== 'turn' && response.scope !== 'session')
  )
    throw new Error('Invalid permission selection');
  const selected = new Set(response.selected);
  const prompt = presentPermissions(params);
  if (selected.size === 0) return { permissions: {}, scope: 'turn' };
  if (
    !prompt.supported ||
    selected.size !== response.selected.length ||
    [...selected].some(
      (id) =>
        !prompt.permissions.some(
          (option) => option.id === id && !option.required,
        ),
    )
  )
    throw new Error('Cannot grant an unknown or unrequested permission');
  const profile = record(params.permissions)!;
  const permissions: Record<string, unknown> = {};
  if (selected.has('network'))
    permissions.network = structuredClone(profile.network);
  if ([...selected].some((id) => id !== 'network')) {
    const fs = record(profile.fileSystem)!;
    const entries = Array.isArray(fs.entries)
      ? fs.entries.filter(
          (entry: unknown, i: number) =>
            record(entry)?.access === 'deny' || selected.has(`entry:${i}`),
        )
      : undefined;
    permissions.fileSystem = {
      read: Array.isArray(fs.read)
        ? fs.read.filter((_: unknown, i: number) => selected.has(`read:${i}`))
        : null,
      write: Array.isArray(fs.write)
        ? fs.write.filter((_: unknown, i: number) => selected.has(`write:${i}`))
        : null,
      ...(entries !== undefined && { entries }),
      ...(fs.globScanMaxDepth !== undefined && {
        globScanMaxDepth: fs.globScanMaxDepth,
      }),
    };
  }
  return { permissions, scope: response.scope };
}
