/**
 * TanStack Router configuration with code-based route tree.
 * Auth guard on the root layout redirects unauthenticated users to /login.
 */
import {
  createRouter,
  createRoute,
  createRootRoute,
  redirect,
  Outlet,
} from '@tanstack/react-router';
import { getApiToken } from '@/auth-token';
import { LoginRoute } from './login-route';
import { AuthenticatedLayout } from './authenticated-layout';
import { ChatView } from './chat-view';
import { ThreadView } from './thread-view';
import { FilesRoute } from './files-route';
import { TerminalRoute } from './terminal-route';
import { DiagnosticsRoute } from './diagnostics-route';
import { SettingsPage } from '@/components/settings/settings-page';
import { IntegrationsPage } from '@/components/integrations/integrations-page';

export type LoginSearch = { redirect: string };
export type IntegrationsSearch = { tab: 'plugins' | 'apps' | 'mcps' };

const INTEGRATION_TABS = ['plugins', 'apps', 'mcps'] as const;

function sanitizeIntegrationsSearch(search: Record<string, unknown>): IntegrationsSearch {
  const tab = search.tab;
  return {
    tab: INTEGRATION_TABS.includes(tab as IntegrationsSearch['tab'])
      ? (tab as IntegrationsSearch['tab'])
      : 'plugins',
  };
}

/** Sanitizes redirect target to prevent open-redirect attacks. */
function sanitizeRedirect(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.startsWith('/api/')) return '/';
  return value;
}

/** Bare root — just renders child routes. */
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

/** Login route — redirects to / if already authenticated. */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: sanitizeRedirect(search.redirect),
  }),
  beforeLoad: ({ search }) => {
    if (getApiToken()) {
      throw redirect({ to: search.redirect });
    }
  },
  component: LoginRoute,
});

/** Authenticated layout — sidebar + header + outlet. */
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  beforeLoad: ({ location }) => {
    if (!getApiToken()) {
      throw redirect({
        to: '/login',
        search: { redirect: location.href },
      });
    }
  },
  component: AuthenticatedLayout,
});

/** Index route — empty chat state (no thread selected). */
const indexRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/',
  component: ChatView,
});

/** Thread route — specific thread by id. */
export const threadRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/t/$threadId',
  component: ThreadView,
});

/** Global files view. */
const filesRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/files',
  component: FilesRoute,
});

/** Global terminal view. */
const terminalRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/terminal',
  component: TerminalRoute,
});

/** Diagnostics panel. */
const diagnosticsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/diagnostics',
  component: DiagnosticsRoute,
});

/** Settings page. */
const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/settings',
  component: SettingsPage,
});

/** Integrations page (plugins, apps, MCPs). */
const integrationsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/integrations',
  validateSearch: sanitizeIntegrationsSearch,
  component: IntegrationsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authenticatedRoute.addChildren([
    indexRoute,
    threadRoute,
    filesRoute,
    terminalRoute,
    diagnosticsRoute,
    settingsRoute,
    integrationsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
