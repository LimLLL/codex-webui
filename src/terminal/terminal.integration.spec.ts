/** Real PTYs, SQLite reopen and Socket.IO acknowledgements exercise the lifecycle boundary without a model. */
import { afterEach, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Reuse the web workspace's existing client dependency for a real wire-level test.
import {
  io,
  type Socket,
} from '../../web/node_modules/socket.io-client/build/cjs/index.js';
import { createTestDatabase } from '../database/database.testing';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { AuthService } from '../auth/auth.service';
import { TerminalGateway } from './terminal.gateway';
import { TerminalService } from './terminal.service';
import { terminalFixture } from './terminal.testing';
import type { TerminalAck, TerminalMetadata } from './terminal.types';

/** Requests a typed acknowledgement without assuming Socket.IO's default untyped event map. */
function requestAck(
  client: Socket,
  event: string,
  payload: Record<string, unknown>,
): Promise<TerminalAck> {
  return new Promise((resolve, reject) => {
    client
      .timeout(2000)
      .emit(event, payload, (error: Error | null, response: TerminalAck) => {
        if (error) reject(error);
        else resolve(response);
      });
  });
}

afterEach(() => vi.unstubAllEnvs());

/** A PID recorded from the actual shell, rather than from a mocked process object. */
async function readShellPid(
  fixture: Awaited<ReturnType<typeof terminalFixture>>,
  terminal: TerminalMetadata,
): Promise<number> {
  let output = '';
  const stop = fixture.service.onOutput((event) => {
    if (event.terminalId === terminal.id) output += event.data;
  });
  try {
    fixture.service.write(
      'a',
      terminal.contextKey,
      terminal.id,
      terminal.sessionId,
      'printf "\\nPTY_PID=%s\\n" "$$"\r',
    );
    await expect
      .poll(() => /PTY_PID=(\d+)/.exec(output)?.[1], { timeout: 5000 })
      .toBeTruthy();
    return Number(/PTY_PID=(\d+)/.exec(output)![1]);
  } finally {
    stop();
  }
}

/** Checks OS process existence so calling kill alone cannot make the test pass. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

it('terminates real PTYs on close, grace expiry and shutdown, and preserves revocation after SQLite reopen', async () => {
  vi.stubEnv('SHELL', '/bin/sh');
  const directory = mkdtempSync(join(tmpdir(), 'terminal-durable-'));
  const path = join(directory, 'test.sqlite');
  const database = createTestDatabase(path);
  const first = await terminalFixture(database);
  try {
    const terminal = await first.service.open('a', { contextKey: 'global' });
    const pid = await readShellPid(first, terminal);
    await first.service.reconnect('b', 'global', terminal.id);
    first.service.detach('b');
    first.service.close('a', 'global', terminal.id);
    await expect.poll(() => processAlive(pid), { timeout: 5000 }).toBe(false);
    first.service.onModuleDestroy();
    database.sqlite.close();
    const reopened = createTestDatabase(path);
    const second = await terminalFixture(reopened);
    try {
      await expect(
        second.service.recover('b', 'global', terminal.id, false),
      ).rejects.toMatchObject({ errorCode: 'terminal.closed' });
      expect(second.service.list('global')).toEqual([]);
      const reclaimed = await second.service.open('a', {
        contextKey: 'global',
      });
      const reclaimedPid = await readShellPid(second, reclaimed);
      second.service.detach('a');
      await expect
        .poll(() => processAlive(reclaimedPid), { timeout: 5000 })
        .toBe(false);
      const replacement = await second.service.recover(
        'a',
        'global',
        reclaimed.id,
        false,
      );
      const replacementPid = await readShellPid(second, replacement.terminal);
      expect(replacement.terminal.sessionId).not.toBe(reclaimed.sessionId);
      second.service.onModuleDestroy();
      await expect
        .poll(() => processAlive(replacementPid), { timeout: 5000 })
        .toBe(false);
    } finally {
      await second.dispose();
      reopened.sqlite.close();
    }
  } finally {
    await first.dispose();
    if (database.sqlite.open) database.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

it('preserves authorization codes over the wire and shares recovery when one caller sends no acknowledgement callback', async () => {
  vi.stubEnv('SHELL', '/bin/sh');
  const fixture = await terminalFixture();
  const module = await Test.createTestingModule({
    providers: [
      TerminalGateway,
      { provide: TerminalService, useValue: fixture.service },
      {
        provide: AuthService,
        useValue: {
          authenticateToken: (token: string) =>
            Promise.resolve({ ok: token === 'valid' }),
        },
      },
      { provide: APP_GUARD, useClass: ApiKeyGuard },
    ],
  }).compile();
  const app = module.createNestApplication(new FastifyAdapter(), {
    logger: false,
  });
  app.useWebSocketAdapter(new IoAdapter(app));
  await app.listen(0, '127.0.0.1');
  const url = `${await app.getUrl()}/ws`;
  const clients = ['valid', 'valid', 'invalid'].map((token) =>
    io(url, {
      auth: { token },
      reconnection: false,
    }),
  );
  try {
    await expect
      .poll(() => clients.every((client) => client.connected), {
        timeout: 3000,
      })
      .toBe(true);
    const refused = await requestAck(clients[2], 'terminal.list', {
      contextKey: 'global',
    });
    expect(refused).toMatchObject({
      ok: false,
      errorCode: 'auth.invalid_token',
    });
    const terminal = await fixture.service.open('a', { contextKey: 'global' });
    fixture.service.detach('a');
    await expect.poll(() => fixture.service.list('global')).toEqual([]);
    const request = {
      contextKey: 'global',
      terminalId: terminal.id,
      manual: false,
    };
    clients[0].emit('terminal.recover', request); // Its successful response is deliberately unobservable.
    const response = await requestAck(clients[1], 'terminal.recover', request);
    const retry = await requestAck(clients[0], 'terminal.recover', request);
    expect(response.ok).toBe(true);
    expect(retry.terminal?.sessionId).toBe(response.terminal?.sessionId);
    expect(fixture.service.list('global')).toHaveLength(1);
    expect(fixture.registry.get('global', terminal.id).generation).toBe(1);
  } finally {
    clients.forEach((client) => client.disconnect());
    await app.close();
    await fixture.dispose();
    fixture.database.sqlite.close();
  }
}, 15000);
