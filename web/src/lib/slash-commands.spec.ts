/**
 * Tests for slash command parsing and availability.
 *
 * These guard the two behaviours that decide whether a draft is a command or
 * prose, and whether running it is safe — both of which silently corrupt the
 * composer if they regress: a false positive sends a command as a message, and
 * a false negative fires an RPC the thread cannot accept.
 */
import { describe, expect, it } from 'vitest';
import {
  SLASH_COMMANDS,
  filterSlashCommands,
  parseSlashInput,
  type SlashAvailability,
} from './slash-commands';

const writableIdle: SlashAvailability = {
  hasThread: true,
  readOnly: false,
  hasActiveTurn: false,
};

function commandNamed(name: string) {
  const command = SLASH_COMMANDS.find((entry) => entry.name === name);
  if (!command) throw new Error(`missing command: ${name}`);
  return command;
}

describe('parseSlashInput', () => {
  it('parses a bare command', () => {
    expect(parseSlashInput('/compact')).toEqual({ name: 'compact', rest: '' });
  });

  it('parses a command with trailing argument text', () => {
    expect(parseSlashInput('/goal ship the thing')).toEqual({
      name: 'goal',
      rest: 'ship the thing',
    });
  });

  it('lowercases the command name so /Plan still matches', () => {
    expect(parseSlashInput('/Plan')?.name).toBe('plan');
  });

  // A slash mid-sentence is prose. Treating it as a command would swallow
  // messages like "see src/a.ts" or "and/or".
  it('ignores a slash that does not start the draft', () => {
    expect(parseSlashInput('please run /compact')).toBeNull();
    expect(parseSlashInput('and/or')).toBeNull();
  });

  it('ignores slashes that cannot be a command name', () => {
    expect(parseSlashInput('/')).toBeNull();
    expect(parseSlashInput('/9lives')).toBeNull();
    expect(parseSlashInput('/src/components')).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  it('returns the whole catalog for an empty query', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('matches on a name prefix', () => {
    expect(filterSlashCommands('re').map((c) => c.name)).toEqual(['review']);
  });

  it('returns nothing for an unknown prefix', () => {
    expect(filterSlashCommands('zzz')).toEqual([]);
  });
});

describe('availability', () => {
  it('blocks every command without a thread', () => {
    for (const command of SLASH_COMMANDS) {
      expect(
        command.unavailableReason({ ...writableIdle, hasThread: false }),
      ).toBeTruthy();
    }
  });

  // app-server rejects steering a review or manual compaction turn, so these
  // cannot be fired while another turn holds the thread.
  it('blocks compact and review during an active turn', () => {
    const busy = { ...writableIdle, hasActiveTurn: true };
    expect(commandNamed('compact').unavailableReason(busy)).toBeTruthy();
    expect(commandNamed('review').unavailableReason(busy)).toBeTruthy();
  });

  // Plan only affects the next turn, so changing it mid-turn is meaningful.
  it('allows plan during an active turn', () => {
    expect(
      commandNamed('plan').unavailableReason({
        ...writableIdle,
        hasActiveTurn: true,
      }),
    ).toBeNull();
  });

  it('blocks thread mutations on a read-only thread', () => {
    const readOnly = { ...writableIdle, readOnly: true };
    expect(commandNamed('plan').unavailableReason(readOnly)).toBeTruthy();
    expect(commandNamed('goal').unavailableReason(readOnly)).toBeTruthy();
    expect(commandNamed('compact').unavailableReason(readOnly)).toBeTruthy();
  });

  // Feedback is about the session itself, and a broken read-only thread is
  // exactly what someone wants to report.
  it('keeps feedback available on read-only threads and during turns', () => {
    expect(
      commandNamed('feedback').unavailableReason({
        hasThread: true,
        readOnly: true,
        hasActiveTurn: true,
      }),
    ).toBeNull();
  });

  it('allows everything on a writable idle thread', () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.unavailableReason(writableIdle)).toBeNull();
    }
  });
});
