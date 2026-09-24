/** Tab focus is manual activation, with one tab stop and a keyboard close action. */
import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkspaceControls } from './workspace-controls';

vi.mock('@/hooks/use-breakpoint', () => ({ useBreakpoint: () => 'desktop' }));

it('does not leave inactive close controls in the roving tab order or activate views on arrow focus', () => {
  const onSelect = vi.fn(),
    onClose = vi.fn();
  const tabs = [
    { id: 'file:/first.ts', kind: 'file' as const, path: '/first.ts', documentId: 'document:first' },
    { id: 'file:/second.ts', kind: 'file' as const, path: '/second.ts', documentId: 'document:second' },
  ];
  render(
    <WorkspaceControls
      workspace={{ tabs, activeId: tabs[0].id }}
      running
      pending={1}
      onSelect={onSelect}
      onClose={onClose}
      onExplorer={vi.fn()}
      onNewTerminal={vi.fn()}
    />,
  );
  const tablist = screen.getByRole('tablist');
  const stops = [
    ...tablist.querySelectorAll<HTMLButtonElement>('button'),
  ].filter((button) => button.tabIndex === 0);
  expect(stops).toEqual([screen.getByRole('tab', { name: 'first.ts' })]);
  stops[0].focus();
  fireEvent.keyDown(stops[0], { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'second.ts' })).toHaveFocus();
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: 'Delete' });
  expect(onClose).toHaveBeenCalledWith(tabs[1]);
});
