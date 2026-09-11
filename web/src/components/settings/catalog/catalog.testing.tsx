/** Real query/SDK wiring with a controlled HTTP boundary and a minimal Monaco adapter. */
/* eslint-disable react-refresh/only-export-components -- Test fixtures are not application refresh boundaries. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { vi } from 'vitest';
import { client } from '@/generated/api/client.gen';
import type { CatalogStateDto } from '@/generated/api';
import i18n from '@/i18n';

export const entry = {
  slug: 'alpha',
  display_name: 'Alpha',
  description: 'Original description',
  visibility: 'list',
  priority: 1,
  context_window: 100,
  max_context_window: 200,
  supported_in_api: true,
  model_messages: { instructions_template: 'Keep instructions' },
  unknown_upstream: { keep: true },
};
export const documentText = JSON.stringify({
  models: [entry],
  unknown_document: 'keep',
});

/** JSON responses exercise the generated client's real throwOnError path. */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Delays a response until the test has performed another user action. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Creates a fresh QueryClient and an HTTP responder for each rendering test.
 * Overrides control real request outcomes; components and hook callbacks are not mocked.
 */
export function catalogFixture() {
  const state: CatalogStateDto = {
    ready: true,
    startupError: null,
    repairError: null,
    configuredPointer: null,
    managed: false,
    pointerApplied: true,
    runningPaths: [],
    activation: null,
  };
  const fixture = {
    state,
    content: documentText as string | null,
    overrides: new Map<
      string,
      (request: Request) => Response | Promise<Response>
    >(),
    writes: [] as Array<{ method: string; path: string; body: unknown }>,
  };
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET') {
      const body = await request.clone().text();
      fixture.writes.push({
        method: request.method,
        path,
        body: body ? (JSON.parse(body) as unknown) : null,
      });
    }
    const override = fixture.overrides.get(`${request.method} ${path}`);
    if (override) return override(request);
    if (path === '/api/codex/catalog') return json(fixture.state);
    if (path === '/api/codex/catalog/blockers')
      return json({
        scope: 'managedAppServer',
        generation: 1,
        canApply: true,
        blockers: [],
        limitations: [],
      });
    if (path === '/api/codex/catalog/draft') {
      if (request.method === 'PUT') {
        const body = (await request.json()) as {
          content: string;
          expectedDraft: string | null;
        };
        if (body.expectedDraft !== fixture.content)
          return json({ message: 'Draft changed elsewhere' }, 409);
        fixture.content = body.content;
      }
      return json({ content: fixture.content, warnings: [] });
    }
    if (
      path === '/api/codex/catalog/restart' ||
      path === '/api/codex/catalog/restore'
    )
      return json(fixture.state);
    throw new Error(`Unexpected test request: ${request.method} ${path}`);
  });
  const previous = client.getConfig();
  client.setConfig({ baseUrl: 'http://localhost', fetch });
  void i18n.changeLanguage('en');
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000 },
      mutations: { retry: false },
    },
  });
  return {
    queryClient,
    fetch,
    // The responder must see reassigned content/state as well as in-place updates.
    server: fixture,
    render: (children: ReactNode) =>
      render(
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>,
      ),
    dispose: () => {
      queryClient.clear();
      client.setConfig(previous);
    },
  };
}

/** Emulates only the editor contract used here; no Monaco workers, styling or implementation internals. */
export function TextEditor({
  value = '',
  onChange,
  onMount,
  options,
  language,
}: {
  value?: string;
  onChange?: (value: string) => void;
  onMount?: (editor: { getValue: () => string }) => void;
  options?: { readOnly?: boolean };
  language?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    onMount?.({ getValue: () => input.current?.value ?? '' });
  }, [onMount]);
  return (
    <textarea
      ref={input}
      aria-label={language === 'ini' ? 'Raw TOML' : 'Raw JSON'}
      value={value}
      readOnly={options?.readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  );
}
