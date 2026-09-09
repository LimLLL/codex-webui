/**
 * Integration tests for file references in agent messages.
 *
 * The parser is unit-tested separately; what these pin is the wiring around it,
 * where a silent break looks like the feature simply not existing: the remark
 * tag surviving the mdast → hast → React hand-off, the URL sanitizer not eating
 * a located bare filename, and links reaching the panel instead of navigating
 * the browser to a path that 404s.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './markdown-renderer';

/** Renders completed agent markdown with reference opening wired to a spy. */
function renderMarkdown(content: string) {
  const onOpenFileReference = vi.fn();
  const user = userEvent.setup();
  render(
    <MarkdownRenderer
      content={content}
      completed
      onOpenFileReference={onOpenFileReference}
    />,
  );
  return { onOpenFileReference, user };
}

describe('MarkdownRenderer file references — inline code', () => {
  it('opens a qualifying path and reports no line', async () => {
    const { onOpenFileReference, user } = renderMarkdown('See `src/app.ts` for details.');

    await user.click(screen.getByRole('button', { name: /src\/app\.ts/ }));

    expect(onOpenFileReference).toHaveBeenCalledWith({ path: 'src/app.ts', line: null });
  });

  it('carries a line suffix through to the callback', async () => {
    const { onOpenFileReference, user } = renderMarkdown('Fails at `src/app.ts:42` today.');

    await user.click(screen.getByRole('button', { name: /src\/app\.ts:42/ }));

    expect(onOpenFileReference).toHaveBeenCalledWith({ path: 'src/app.ts', line: 42 });
  });

  it('leaves a bare filename inert', () => {
    renderMarkdown('Add it to `package.json` first.');

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('leaves a command inert', () => {
    renderMarkdown('Run `cat src/app.ts` to check.');

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('leaves fenced code blocks untouched', () => {
    renderMarkdown('```\nsrc/app.ts\n```');

    // Asserted by title rather than by role: the block ships its own copy
    // control, so "no buttons at all" would pass for the wrong reason.
    expect(screen.queryByTitle('src/app.ts')).toBeNull();
  });

  it('activates from the keyboard', async () => {
    const { onOpenFileReference, user } = renderMarkdown('See `src/app.ts` for details.');

    await user.tab();
    await user.keyboard('{Enter}');

    expect(onOpenFileReference).toHaveBeenCalledWith({ path: 'src/app.ts', line: null });
  });
});

describe('MarkdownRenderer file references — links', () => {
  it('opens a relative destination instead of navigating', async () => {
    const { onOpenFileReference, user } = renderMarkdown('[the entry](src/main.ts)');

    await user.click(screen.getByRole('button', { name: 'the entry' }));

    expect(onOpenFileReference).toHaveBeenCalledWith({ path: 'src/main.ts', line: null });
  });

  it('opens a workspace-absolute destination', async () => {
    // The shape reported in issue #17: an absolute workspace path rendered as
    // an anchor sent the browser to `http://<host>/workspaces/...` and 404ed.
    const { onOpenFileReference, user } = renderMarkdown(
      '[README.md](/workspaces/codex-webui/README.md)',
    );

    await user.click(screen.getByRole('button', { name: 'README.md' }));

    expect(onOpenFileReference).toHaveBeenCalledWith({
      path: '/workspaces/codex-webui/README.md',
      line: null,
    });
  });

  it('survives the URL sanitizer for a located bare filename', async () => {
    // The stock transform blanks a destination whose first colon precedes any
    // slash; without the narrow rewrite this link would arrive with no href.
    const { onOpenFileReference, user } = renderMarkdown('[the readme](README.md:42)');

    await user.click(screen.getByRole('button', { name: 'the readme' }));

    expect(onOpenFileReference).toHaveBeenCalledWith({ path: './README.md', line: 42 });
  });

  it('opens a filename the inline blacklist would have rejected', async () => {
    const { onOpenFileReference, user } = renderMarkdown('[page](app/%28group%29/page.tsx)');

    await user.click(screen.getByRole('button', { name: 'page' }));

    expect(onOpenFileReference).toHaveBeenCalledWith({
      path: 'app/(group)/page.tsx',
      line: null,
    });
  });

  it('leaves an unparseable local destination inert rather than navigable', () => {
    // Falling through to an anchor here would navigate to a path the static
    // server has nothing at — the very defect this change removes.
    renderMarkdown('[broken](src/app.ts:0)');

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not rewrite image sources', () => {
    // The sanitizer exception is for link hrefs only. Applied to images it
    // rewrote the source into a real path and issued a request for it; the
    // stock sanitizer is supposed to blank this destination instead.
    renderMarkdown('![shot](README.md:42)');

    // The stock sanitizer blanks this destination, and React drops an empty
    // src entirely — so no request goes out. Before the fix the src was the
    // rewritten `./README.md:42` and the browser fetched it.
    expect(screen.getByAltText('shot')).not.toHaveAttribute('src');
  });

  it('keeps external destinations as ordinary anchors', () => {
    renderMarkdown('[docs](https://example.com/guide)');

    const anchor = screen.getByRole('link', { name: 'docs' });
    expect(anchor).toHaveAttribute('href', 'https://example.com/guide');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('activates once when a link label is code formatted', async () => {
    const { onOpenFileReference, user } = renderMarkdown('[`src/app.ts`](src/app.ts)');

    const controls = screen.getAllByRole('button');
    expect(controls).toHaveLength(1);

    await user.click(controls[0]);
    expect(onOpenFileReference).toHaveBeenCalledTimes(1);
  });
});

describe('MarkdownRenderer while streaming', () => {
  it('holds inferred inline references until the message completes', () => {
    // An unterminated link presents its code-formatted label as a standalone
    // token; activating it would open the label and then change target.
    const onOpenFileReference = vi.fn();
    render(
      <MarkdownRenderer
        content="[`src/a.ts`](src/b.ts"
        completed={false}
        onOpenFileReference={onOpenFileReference}
      />,
    );

    expect(screen.queryByTitle('src/a.ts')).toBeNull();
  });

  it('still activates a complete explicit link', async () => {
    const onOpenFileReference = vi.fn();
    const user = userEvent.setup();
    render(
      <MarkdownRenderer
        content="[entry](src/main.ts)"
        completed={false}
        onOpenFileReference={onOpenFileReference}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'entry' }));

    expect(onOpenFileReference).toHaveBeenCalledWith({ path: 'src/main.ts', line: null });
  });
});

describe('MarkdownRenderer without an opener', () => {
  it('leaves references inert when no conversation owns the message', () => {
    // Nothing to resolve a relative path against, so nothing should invite a click.
    render(<MarkdownRenderer content="See `src/app.ts` here." completed />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not leave a local link navigable', () => {
    render(<MarkdownRenderer content="[entry](src/main.ts)" completed />);

    expect(screen.queryByRole('link')).toBeNull();
  });
});
