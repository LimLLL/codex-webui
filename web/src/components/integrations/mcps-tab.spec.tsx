/**
 * Tests for the OAuth recovery path when the browser blocks the login tab.
 *
 * The recovery link is the only way back into a blocked flow, so both halves of
 * its lifetime matter: it has to survive long enough to be used, and it has to
 * be released once the server reports itself authenticated. A link that outlives
 * its flow reappears on the next logout pointing at an authorization request
 * nobody started.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const AUTH_URL = 'https://auth.example.com/authorize?client_id=abc';

const mcpServersListServers = vi.fn();
const mcpServersStartOauthLogin = vi.fn();
const copyTextToClipboard = vi.fn();

vi.mock('@/generated/api/sdk.gen', () => ({
  mcpServersListServers: (...args: unknown[]) =>
    mcpServersListServers(...args) as unknown,
  mcpServersReloadAll: () => Promise.resolve({ data: {} }),
  mcpServersStartOauthLogin: (...args: unknown[]) =>
    mcpServersStartOauthLogin(...args) as unknown,
}));

vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  mcpServersListServersQueryKey: () => ['mcp', 'servers'],
}));

vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboard(text) as unknown,
}));

vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: vi.fn() }));

const { McpsTab } = await import('./mcps-tab');
const { useMcpStore } = await import('@/stores/mcp-store');

/** Whether the server reports itself as still needing to authenticate. */
let authStatus: 'notLoggedIn' | 'loggedIn' = 'notLoggedIn';

let queryClient: QueryClient;

function renderTab() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<McpsTab />, { wrapper });
}

beforeEach(() => {
  authStatus = 'notLoggedIn';
  mcpServersListServers.mockReset();
  mcpServersStartOauthLogin.mockReset();
  copyTextToClipboard.mockReset();

  mcpServersListServers.mockImplementation(() =>
    Promise.resolve({
      data: { data: [{ name: 'docs', authStatus, tools: {} }] },
    }),
  );
  mcpServersStartOauthLogin.mockResolvedValue({
    data: { authorizationUrl: AUTH_URL },
  });
  copyTextToClipboard.mockResolvedValue(undefined);
  useMcpStore.setState({ statuses: {} });
  // A blocked popup is what `window.open` returning null means.
  vi.spyOn(window, 'open').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  queryClient?.clear();
});

describe('MCP OAuth recovery when the popup is blocked', () => {
  it('surfaces the authorization URL as a link instead of copying it', async () => {
    // Copying here would depend on the click's user activation, which the
    // login request just spent — and a failed copy discarded the URL entirely,
    // leaving Login as the only recourse and repeating the same failure.
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Login/ }));

    const link = await screen.findByRole('link', {
      name: /Open authorization page/,
    });
    expect(link).toHaveAttribute('href', AUTH_URL);
    expect(copyTextToClipboard).not.toHaveBeenCalled();
  });

  it('copies the retained URL only when the user asks', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Login/ }));
    await user.click(await screen.findByRole('button', { name: /Copy link/ }));

    expect(copyTextToClipboard).toHaveBeenCalledWith(AUTH_URL);
    // Copying is not evidence the flow completed, so the link stays put.
    expect(
      screen.getByRole('link', { name: /Open authorization page/ }),
    ).toBeInTheDocument();
  });

  it('releases the URL once the server reports itself authenticated', async () => {
    // The row is keyed by server name and outlives the attempt, so without an
    // explicit release the stale link reappears on the next logout.
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Login/ }));
    await screen.findByRole('link', { name: /Open authorization page/ });

    authStatus = 'loggedIn';
    await queryClient.invalidateQueries({ queryKey: ['mcp', 'servers'] });

    await waitFor(() =>
      expect(
        screen.queryByRole('link', { name: /Open authorization page/ }),
      ).toBeNull(),
    );

    authStatus = 'notLoggedIn';
    await queryClient.invalidateQueries({ queryKey: ['mcp', 'servers'] });

    await screen.findByRole('button', { name: /Login/ });
    expect(
      screen.queryByRole('link', { name: /Open authorization page/ }),
    ).toBeNull();
  });
});
