/**
 * Drives the composer slash-command palette: trigger detection, filtering,
 * and keyboard navigation.
 *
 * Mirrors the `@` mention interaction shape, with two deliberate differences:
 * the palette only opens when `/` is the very first character of the draft
 * (a slash mid-sentence is prose), and selecting a row runs a command instead
 * of inserting text.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  filterSlashCommands,
  type SlashAvailability,
  type SlashCommandDef,
} from '@/lib/slash-commands';

interface UseSlashCommandsParams {
  availability: SlashAvailability;
  /** Invoked when the user picks a runnable command. */
  onRun: (command: SlashCommandDef) => void;
}

export function useSlashCommands({
  availability,
  onRun,
}: UseSlashCommandsParams) {
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);

  const slashFiltered = useMemo(
    () => filterSlashCommands(slashQuery),
    [slashQuery],
  );

  /**
   * Called on every draft change. Opens the palette only for a draft that is
   * a bare `/command` prefix with no whitespace yet, so typing an argument or
   * ordinary prose closes it.
   */
  const detectSlash = useCallback((newValue: string) => {
    if (!newValue.startsWith('/')) {
      setSlashOpen(false);
      return;
    }
    const query = newValue.slice(1);
    if (/\s/.test(query)) {
      setSlashOpen(false);
      return;
    }
    setSlashOpen(true);
    setSlashQuery(query);
    setSlashSelectedIndex(0);
  }, []);

  const closeSlash = useCallback(() => setSlashOpen(false), []);

  const handleSlashSelect = useCallback(
    (command: SlashCommandDef) => {
      if (command.unavailableReason(availability)) return;
      setSlashOpen(false);
      onRun(command);
    },
    [availability, onRun],
  );

  /** Handles palette keyboard events. Returns true when the key was consumed. */
  const handleSlashKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!slashOpen || slashFiltered.length === 0) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIndex((i) => Math.min(i + 1, slashFiltered.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const command = slashFiltered[slashSelectedIndex];
        if (!command) return false;
        e.preventDefault();
        handleSlashSelect(command);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashOpen(false);
        return true;
      }
      return false;
    },
    [slashOpen, slashFiltered, slashSelectedIndex, handleSlashSelect],
  );

  return {
    slashOpen,
    slashFiltered,
    slashSelectedIndex,
    detectSlash,
    closeSlash,
    handleSlashSelect,
    handleSlashKeyDown,
  };
}
