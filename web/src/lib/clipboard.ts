/** Clipboard write with a legacy fallback for non-secure contexts. */

/** Focus and selection the legacy fallback displaces and must hand back. */
interface DisplacedFocus {
  element: HTMLElement | null;
  /** Anchor/focus rather than a range, so a backward selection stays backward. */
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
}

/**
 * Writes text to the clipboard, falling back to `execCommand` off HTTPS.
 *
 * `navigator.clipboard` only exists on HTTPS or localhost; on the plain-HTTP
 * LAN deployments this project sees, the fallback below is the only path.
 *
 * Timing matters to callers. Browsers honour `execCommand('copy')` only while
 * the user activation from the originating click is still live, so there are
 * two distinct fallback paths and only one of them is reliable:
 *
 * - **API unavailable** (no secure context): the fallback runs to completion
 *   before this function's first `await`, staying in the caller's own call
 *   stack, so a caller with the payload already in hand is safe.
 * - **`writeText()` rejected**: the fallback necessarily runs *after* that
 *   `await`, so it is best effort — the activation may already be gone.
 *
 * Either way, a caller that awaits a network request before calling may have
 * spent the activation. Have the payload in hand, or be ready to ask for a
 * second click (see `DiagnosticsPanel`). A secure context only guarantees the
 * API exists, not that the write is permitted: Safari and Firefox gate
 * Clipboard API writes on activation too.
 *
 * @param text - Text to place on the clipboard.
 * @returns Resolves once the text is on the clipboard.
 * @throws Error when neither the Clipboard API nor the fallback could copy.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied or transient failure - try the legacy path below.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';

  const selection = document.getSelection();
  const displaced: DisplacedFocus = {
    element:
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    anchorNode: selection?.anchorNode ?? null,
    anchorOffset: selection?.anchorOffset ?? 0,
    focusNode: selection?.focusNode ?? null,
    focusOffset: selection?.focusOffset ?? 0,
  };

  document.body.appendChild(textarea);
  // The command reads the live selection, so the scratch field has to hold
  // both focus and the selection for the duration of the copy.
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    // execCommand threw; `copied` stays false.
  }

  textarea.remove();
  restoreFocus(displaced);

  if (!copied) {
    throw new Error('Copy failed');
  }
}

/**
 * Hands focus and selection back to whatever the fallback took them from.
 *
 * Skipping this leaves the caller's page with focus on `<body>`, which strands
 * keyboard users — and a copy that has to be retried is exactly when they need
 * to reach the button again.
 *
 * @param displaced - State captured before the scratch field was inserted.
 */
function restoreFocus(displaced: DisplacedFocus): void {
  displaced.element?.focus({ preventScroll: true });

  const selection = document.getSelection();
  if (!selection || !displaced.anchorNode || !displaced.focusNode) return;
  try {
    // Restored after focus: focusing a field can reset the document selection.
    selection.setBaseAndExtent(
      displaced.anchorNode,
      displaced.anchorOffset,
      displaced.focusNode,
      displaced.focusOffset,
    );
  } catch {
    // The nodes went away while the copy ran; nothing left to restore.
  }
}
