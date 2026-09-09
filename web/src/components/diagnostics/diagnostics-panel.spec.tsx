/**
 * Tests for the diagnostics bundle copy path.
 *
 * Off HTTPS the clipboard write falls back to `execCommand`, which browsers
 * only honour while the originating click's user activation is live — and
 * building the bundle spends that budget on log files and a Codex version
 * lookup. The panel answers by keeping a bundle whose copy was refused so the
 * retry can copy from the click's own call stack. Without these, a regression
 * degrades into a button that fails identically no matter how often it is
 * pressed, which is what the fallback was added to prevent.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logsExportDiagnostics = vi.fn();
const copyTextToClipboard = vi.fn();
const showSnackbar = vi.fn();

vi.mock('@/generated/api', () => ({
  logsExportDiagnostics: (...args: unknown[]) =>
    logsExportDiagnostics(...args) as unknown,
}));

vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  logsListLogsOptions: () => ({
    queryKey: ['logs'],
    queryFn: () => Promise.resolve({ data: [], total: 0, hasMore: false }),
  }),
}));

vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboard(text) as unknown,
}));

vi.mock('@/stores/snackbar-store', () => ({
  showSnackbar: (...args: unknown[]) => showSnackbar(...args) as unknown,
}));

const { DiagnosticsPanel } = await import('./diagnostics-panel');

const BUNDLE = { exportedAt: '2026-01-01T00:00:00.000Z', logs: [] };

let queryClient: QueryClient;

function renderPanel() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<DiagnosticsPanel />, { wrapper });
}

/**
 * The copy action, addressed by its label so the download button is excluded.
 * The label announces a retained snapshot, so both wordings have to match.
 */
function copyButton(): HTMLElement {
  return screen.getByRole('button', { name: /Copy (prepared )?export/ });
}

beforeEach(() => {
  logsExportDiagnostics.mockReset();
  copyTextToClipboard.mockReset();
  showSnackbar.mockReset();
  logsExportDiagnostics.mockResolvedValue({ data: BUNDLE });
  copyTextToClipboard.mockResolvedValue(undefined);
});

afterEach(() => {
  queryClient?.clear();
});

describe('DiagnosticsPanel copy export', () => {
  it('copies the bundle it just fetched', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(copyButton());

    expect(copyTextToClipboard).toHaveBeenCalledWith(
      JSON.stringify(BUNDLE, null, 2),
    );
    expect(showSnackbar).toHaveBeenCalledWith('Copied!', 'success');
  });

  it('reuses the fetched bundle when the copy is refused', async () => {
    // The whole point of retaining it: the retry must not spend the click's
    // activation on another export, or it would fail the same way forever.
    copyTextToClipboard.mockRejectedValueOnce(new Error('Copy failed'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(copyButton());

    expect(showSnackbar).toHaveBeenCalledWith(
      'Copy failed. Click again to copy.',
      'warning',
    );

    await user.click(copyButton());

    expect(logsExportDiagnostics).toHaveBeenCalledTimes(1);
    expect(copyTextToClipboard).toHaveBeenCalledTimes(2);
    expect(showSnackbar).toHaveBeenLastCalledWith('Copied!', 'success');
  });

  it('fetches a fresh bundle once a retained one has been copied', async () => {
    // A retained bundle is a snapshot; serving it again later would hand over
    // logs from before whatever the user is now trying to report. Only a run
    // that actually retains one can prove it is released — asserting over two
    // plain successes passes whether or not the release exists.
    copyTextToClipboard.mockRejectedValueOnce(new Error('Copy failed'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(copyButton()); // fetches, copy refused, bundle retained
    await user.click(copyButton()); // copies the retained bundle
    expect(logsExportDiagnostics).toHaveBeenCalledTimes(1);

    await user.click(copyButton());

    expect(logsExportDiagnostics).toHaveBeenCalledTimes(2);
  });

  it('discards a retained bundle when the logs are refreshed', async () => {
    // Refresh asks for current diagnostics; handing back a snapshot taken
    // before it would contradict what the panel now shows.
    copyTextToClipboard.mockRejectedValueOnce(new Error('Copy failed'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(copyButton());
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    await user.click(copyButton());

    expect(logsExportDiagnostics).toHaveBeenCalledTimes(2);
  });

  it('refuses further clicks until the whole copy has settled', async () => {
    // Two exports in flight can settle out of order: the later one copies and
    // clears, then the earlier one fails and reinstates itself, leaving the
    // button holding a bundle older than the one already copied. The guard has
    // to span the clipboard write too, not just the export.
    let releaseExport!: (value: { data: typeof BUNDLE }) => void;
    let releaseCopy!: () => void;
    logsExportDiagnostics.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseExport = resolve;
      }),
    );
    copyTextToClipboard.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseCopy = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(copyButton());
    expect(copyButton()).toHaveAttribute('aria-disabled', 'true');

    // Pressed again while the export is outstanding.
    await user.click(copyButton());
    expect(logsExportDiagnostics).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseExport({ data: BUNDLE });
      await new Promise((settle) => setTimeout(settle, 0));
    });

    // Pressed again while only the clipboard write is outstanding.
    await user.click(copyButton());
    expect(logsExportDiagnostics).toHaveBeenCalledTimes(1);
    expect(copyTextToClipboard).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseCopy();
      await new Promise((settle) => setTimeout(settle, 0));
    });

    await waitFor(() =>
      expect(copyButton()).toHaveAttribute('aria-disabled', 'false'),
    );
  });

  it('locks Refresh while a copy is running', async () => {
    // Refresh drops the retained snapshot, but it cannot drop one that has not
    // been retained yet: a copy already in flight would reinstate its bundle
    // when it fails, resurrecting exactly what Refresh meant to discard.
    let releaseExport!: (value: { data: typeof BUNDLE }) => void;
    logsExportDiagnostics.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseExport = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(copyButton());

    expect(screen.getByRole('button', { name: /Refresh/ })).toBeDisabled();

    await act(async () => {
      releaseExport({ data: BUNDLE });
      await new Promise((settle) => setTimeout(settle, 0));
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Refresh/ })).toBeEnabled(),
    );
  });

  it('announces that it is holding a prepared snapshot', async () => {
    // The retained bundle changes what the next click does. Left unlabelled it
    // is invisible state, and the user cannot tell a snapshot from a fresh
    // export or know to press Refresh to drop it.
    copyTextToClipboard.mockRejectedValueOnce(new Error('Copy failed'));
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByRole('button', { name: /Copy export/ })).toBeInTheDocument();

    await user.click(copyButton());

    expect(
      screen.getByRole('button', { name: /Copy prepared export/ }),
    ).toBeInTheDocument();
  });

  it('keeps the copy control focusable while it works', async () => {
    // A natively disabled button drops focus, and the clipboard fallback hands
    // focus back to whatever held it — <body> in that case. The retry prompt
    // would then be asking keyboard users to press a button they cannot reach.
    let releaseExport!: (value: { data: typeof BUNDLE }) => void;
    logsExportDiagnostics.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseExport = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    const button = copyButton();
    await user.click(button);

    expect(document.activeElement).toBe(button);

    await act(async () => {
      releaseExport({ data: BUNDLE });
      await new Promise((settle) => setTimeout(settle, 0));
    });
  });

  it('leaves a failed export to the global error reporting', async () => {
    // The API client's error interceptor already raises a snackbar for this;
    // a local one would stack the same message on top of itself.
    logsExportDiagnostics.mockRejectedValue(new Error('export unavailable'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(copyButton());

    expect(copyTextToClipboard).not.toHaveBeenCalled();
    expect(showSnackbar).not.toHaveBeenCalled();
  });
});
