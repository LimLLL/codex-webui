/** A local Responses provider with explicitly released replies; never sends inference to an external service. */
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerNotification, v2 } from '../codex-schema';
import { CodexProcessManager } from '../codex-process-manager.service';
import { catalogFixture } from './catalog.testing';
import { writeAtomic } from './catalog-files';
import { CatalogActivityService } from './catalog-activity.service';
import { CatalogAdmissionService } from './catalog-admission.service';

/** Starts an isolated child and holds each model response until the test explicitly completes it. */
export async function localCatalogProvider() {
  const fixture = catalogFixture();
  const responses: ServerResponse[] = [];
  const notifications: ServerNotification[] = [];
  const changed = new Set<() => void>();
  const provider = createServer((_request, response) => {
    responses.push(response);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: `response-${responses.length}`, status: 'in_progress' } })}\n\n`,
    );
    for (const notify of changed) notify();
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  const catalog = fixture.storage.candidatePath();
  writeAtomic(
    catalog,
    readFileSync(resolve('docs/upstream/model-catalog-0.153.2.json'), 'utf8'),
  );
  const port = (provider.address() as AddressInfo).port;
  writeAtomic(
    fixture.paths.configFile,
    `model_catalog_json=${JSON.stringify(catalog)}\nmodel="gpt-5.6-sol"\nreview_model="gpt-5.6-sol"\nmodel_provider="catalog_test"\n[model_providers.catalog_test]\nname="Local test"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nexperimental_bearer_token="test-only"\nrequest_max_retries=0\n`,
  );
  const manager = new CodexProcessManager(fixture.storage);
  await manager.onModuleInit();
  const client = manager.getClient();
  if (!client) {
    provider.closeAllConnections();
    provider.close();
    fixture.cleanup();
    throw new Error(
      manager.getStartupError() ?? 'Test app-server did not initialize',
    );
  }
  client.on('notification', (event) => {
    notifications.push(event);
    for (const notify of changed) notify();
  });
  const { thread } = await client.request<v2.ThreadStartResponse>(
    'thread/start',
    { cwd: fixture.home },
  );

  /** Waits for actual I/O observations. The timer fails the test; it never clears retained work. */
  function until<T>(read: () => T | undefined): Promise<T> {
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        changed.delete(check);
        reject(new Error('Timed out waiting for native test observation'));
      }, 10_000);
      const check = () => {
        const value = read();
        if (value !== undefined) {
          clearTimeout(timer);
          changed.delete(check);
          done(value);
        }
      };
      changed.add(check);
      check();
    });
  }
  return {
    fixture,
    manager,
    client,
    thread,
    inspect: () =>
      new CatalogActivityService(
        manager,
        new CatalogAdmissionService(),
      ).inspect(),
    request: (index: number) => until(() => responses[index]),
    event: (predicate: (event: ServerNotification) => boolean) =>
      until(() => notifications.find(predicate)),
    /** Sends a complete, synthetic assistant reply so Core can perform its normal next-turn dispatch. */
    complete(index: number) {
      const response = responses[index];
      const item = {
        type: 'message',
        id: `message-${index}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Working on the task.' }],
      };
      for (const event of [
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: `response-${index + 1}`,
            status: 'completed',
            output: [item],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ])
        response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      response.end();
    },
    /** Reaps the owned child before removing its isolated files and provider sockets. */
    async close() {
      const live = manager.getClient();
      if (live) {
        const closed = new Promise<void>((done) =>
          live.once('close', () => done()),
        );
        manager.onModuleDestroy();
        await closed;
      } else manager.onModuleDestroy();
      provider.closeAllConnections();
      await new Promise<void>((done) => provider.close(() => done()));
      fixture.cleanup();
    },
  };
}
