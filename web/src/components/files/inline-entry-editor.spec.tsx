/** Keyboard/composition behavior does not require a browser layout engine. */
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { InlineEntryEditor } from './inline-entry-editor';

it('never submits a composing Enter, but commits once after composition', () => {
  const commit = vi.fn();
  render(<InlineEntryEditor onCommit={commit} onCancel={vi.fn()} />);
  const input = screen.getByRole('textbox');
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '目录' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.focus(input);
  input.focus();
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.blur(input);
  expect(commit).toHaveBeenCalledExactlyOnceWith('目录');
});

it('cancels Escape without a subsequent blur committing into the parent dialog', () => {
  const commit = vi.fn(),
    cancel = vi.fn(),
    parent = vi.fn();
  render(
    <div onKeyDown={parent}>
      <InlineEntryEditor
        initialValue="draft"
        onCommit={commit}
        onCancel={cancel}
      />
    </div>,
  );
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'Escape' });
  fireEvent.blur(input);
  expect(cancel).toHaveBeenCalledOnce();
  expect(commit).not.toHaveBeenCalled();
  expect(parent).not.toHaveBeenCalled();
});

it('preserves a failed draft and allows retry after error', () => {
  const commit = vi.fn();
  const props = { onCommit: commit, onCancel: vi.fn() };
  const view = render(<InlineEntryEditor {...props} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'same-name' } });
  fireEvent.blur(input);
  view.rerender(<InlineEntryEditor {...props} pending />);
  view.rerender(<InlineEntryEditor {...props} error="Already exists" />);
  expect(input).toHaveValue('same-name');
  expect(screen.getByRole('alert')).toHaveTextContent('Already exists');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(commit).toHaveBeenCalledTimes(2);
});
