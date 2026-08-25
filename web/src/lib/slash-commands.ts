/**
 * Typed catalog of composer slash commands.
 *
 * Commands are deliberately NOT unified behind a single execute() signature:
 * a UI-only command, a thread-state mutation, and a next-turn setting have
 * different preconditions and different failure modes, and collapsing them
 * would hide that. The catalog describes each command; the composer dispatches
 * on `name` with the concrete mutation it already owns.
 *
 * Commands already covered by a composer popover (model, reasoning, approvals,
 * MCP, skills) are intentionally absent — duplicating them would create two
 * sources of truth for the same setting.
 */
import {
  MessageSquareHeart,
  ScanSearch,
  Shrink,
  Target,
  Telescope,
  type LucideIcon,
} from 'lucide-react';

/**
 * How a command takes effect once selected.
 *
 * - `ui` — opens a dialog; nothing is sent until the user confirms
 * - `threadMutation` — calls a semantic backend endpoint immediately
 * - `nextTurnSetting` — writes thread settings that apply to the next turn
 */
export type SlashDispatchKind = 'ui' | 'threadMutation' | 'nextTurnSetting';

/** Conditions that decide whether a command can run right now. */
export interface SlashAvailability {
  hasThread: boolean;
  readOnly: boolean;
  hasActiveTurn: boolean;
}

/**
 * One command row in the palette.
 *
 * @template TName - Literal command name, so the dispatcher stays exhaustive
 */
export interface SlashCommandDef {
  /** Command name without the leading slash. */
  name: string;
  /** Natural-language i18n key describing what the command does. */
  description: string;
  /**
   * Palette glyph. Reuses the icon the command's own UI already shows (plan
   * badge, goal row, turn markers) so the palette and the resulting state read
   * as the same feature.
   */
  icon: LucideIcon;
  kind: SlashDispatchKind;
  /**
   * Returns an i18n key explaining why the command cannot run, or null when
   * it is available.
   */
  unavailableReason: (availability: SlashAvailability) => string | null;
}

/** Commands are unusable without a writable thread, whatever else is true. */
function requiresWritableThread({
  hasThread,
  readOnly,
}: SlashAvailability): string | null {
  if (!hasThread) return 'Create a thread first';
  if (readOnly) return 'This conversation is read-only';
  return null;
}

/**
 * Compaction and review start their own turn, and app-server rejects steering
 * those turn kinds, so they cannot be queued behind a running turn.
 */
function requiresIdleThread(availability: SlashAvailability): string | null {
  const blocked = requiresWritableThread(availability);
  if (blocked) return blocked;
  if (availability.hasActiveTurn) return 'Wait for the current turn to finish';
  return null;
}

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    name: 'plan',
    description: 'Toggle plan mode for multi-step planning',
    icon: Telescope,
    kind: 'nextTurnSetting',
    // Allowed mid-turn: it only affects the next turn, never the running one.
    unavailableReason: requiresWritableThread,
  },
  {
    name: 'goal',
    description: 'Set a persistent goal for Codex to work toward',
    icon: Target,
    kind: 'ui',
    unavailableReason: requiresWritableThread,
  },
  {
    name: 'review',
    description: 'Review uncommitted changes, a branch, or a commit',
    icon: ScanSearch,
    kind: 'ui',
    unavailableReason: requiresIdleThread,
  },
  {
    name: 'compact',
    description: 'Compact this conversation to free up context',
    icon: Shrink,
    kind: 'threadMutation',
    unavailableReason: requiresIdleThread,
  },
  {
    name: 'feedback',
    description: 'Send feedback about Codex to the maintainers',
    icon: MessageSquareHeart,
    kind: 'ui',
    // Feedback is about the session, so it stays usable while a turn runs and
    // on read-only threads — those are exactly when people want to report.
    unavailableReason: ({ hasThread }) =>
      hasThread ? null : 'Create a thread first',
  },
] as const;

/**
 * Filters the catalog by the text typed after `/`.
 *
 * @param query - Raw text between the slash and the cursor
 * @returns Matching commands in catalog order
 */
export function filterSlashCommands(query: string): SlashCommandDef[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter((command) =>
    command.name.startsWith(normalized),
  );
}

/**
 * Parses a composer draft that is entirely a slash command.
 *
 * Returns null unless the draft starts with `/`, because a slash anywhere else
 * is ordinary prose the user is sending to the model.
 *
 * @param value - Full composer draft
 * @returns The command name and trailing argument text, or null
 */
export function parseSlashInput(
  value: string,
): { name: string; rest: string } | null {
  if (!value.startsWith('/')) return null;
  const body = value.slice(1);
  const match = /^([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return null;
  return { name: match[1].toLowerCase(), rest: (match[2] ?? '').trim() };
}
