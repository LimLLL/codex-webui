/**
 * Tests for the clipboard write and its non-secure-context fallback.
 *
 * The fallback only ever runs where it cannot be observed during development —
 * plain-HTTP LAN access — so a regression there is invisible until a user
 * reports "copy failed" again. These pin the branch selection, the DOM cleanup
 * the fallback is responsible for, and the failure being raised rather than
 * swallowed, since every caller shows its own message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from './clipboard';

/** Installs a Clipboard API stub, or removes it to emulate an insecure origin. */
function setClipboard(writeText: ((text: string) => Promise<void>) | null) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

/** Marks the page as a secure origin, which gates the Clipboard API path. */
function setSecureContext(secure: boolean) {
  Object.defineProperty(window, 'isSecureContext', {
    value: secure,
    configurable: true,
  });
}

/** jsdom implements no copy command, so the fallback needs one supplied. */
let execCommand: ReturnType<typeof vi.fn>;

beforeEach(() => {
  execCommand = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', {
    value: execCommand,
    configurable: true,
  });
});

afterEach(() => {
  setClipboard(null);
  document.body.innerHTML = '';
});

describe('copyTextToClipboard on a secure origin', () => {
  it('writes through the Clipboard API', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setSecureContext(true);
    setClipboard(writeText);

    await copyTextToClipboard('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back when the Clipboard API rejects', async () => {
    // A secure origin still denies the write when the document lacks focus or
    // the permission was refused, so being secure is not on its own enough.
    setSecureContext(true);
    setClipboard(() => Promise.reject(new Error('not allowed')));

    await copyTextToClipboard('hello');

    expect(execCommand).toHaveBeenCalledWith('copy');
  });
});

describe('copyTextToClipboard off a secure origin', () => {
  beforeEach(() => {
    setSecureContext(false);
    setClipboard(null);
  });

  it('copies the text through the legacy command', async () => {
    let staged: string | undefined;
    execCommand.mockImplementation(() => {
      // The command reads the live selection, so the value has to be in the
      // document at this point rather than staged after the fact.
      staged = document.querySelector('textarea')?.value;
      return true;
    });

    await copyTextToClipboard('bundle contents');

    expect(staged).toBe('bundle contents');
  });

  it('copies before yielding to the caller', () => {
    // Load-bearing, and invisible from the outside: the command is only
    // honoured while the click's user activation is live, so it has to run in
    // the caller's own call stack rather than after the returned promise.
    const settled = copyTextToClipboard('hello');

    expect(execCommand).toHaveBeenCalledWith('copy');
    return settled;
  });

  it('leaves no scratch element behind', async () => {
    await copyTextToClipboard('hello');

    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports a refused copy instead of resolving', async () => {
    // `execCommand` answers false rather than throwing when the user
    // activation has expired — the case callers need to hear about.
    execCommand.mockReturnValue(false);

    await expect(copyTextToClipboard('hello')).rejects.toThrow();
  });

  it('cleans up even when the copy is refused', async () => {
    execCommand.mockReturnValue(false);

    await expect(copyTextToClipboard('hello')).rejects.toThrow();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('returns focus to the element that had it', async () => {
    // The scratch field takes focus to be copied from. Leaving it on <body>
    // strands keyboard users at the exact moment a refused copy asks them to
    // press the same button again.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    await copyTextToClipboard('hello');

    expect(document.activeElement).toBe(input);
  });

  it('restores a selection the copy displaced', async () => {
    // Copying must not visibly steal the user's own text selection.
    const paragraph = document.createElement('p');
    paragraph.textContent = 'user selected this';
    document.body.appendChild(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await copyTextToClipboard('hello');

    expect(document.getSelection()?.toString()).toBe('user selected this');
  });

  it('restores a backward selection without flipping it', async () => {
    // A range has no direction, so restoring through one silently turns a
    // right-to-left selection into a left-to-right one and moves the caret to
    // the other end — which shows up the next time the user extends it.
    const paragraph = document.createElement('p');
    paragraph.textContent = 'user selected this';
    document.body.appendChild(paragraph);
    const text = paragraph.firstChild!;
    const selection = document.getSelection();
    selection?.setBaseAndExtent(text, 9, text, 4);

    await copyTextToClipboard('hello');

    expect(document.getSelection()?.anchorOffset).toBe(9);
    expect(document.getSelection()?.focusOffset).toBe(4);
  });
});
