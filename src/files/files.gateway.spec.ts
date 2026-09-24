/** Real Socket.IO dispatch verifies that an invalid token never acquires a lease. */
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import {
  io,
  type Socket,
} from '../../web/node_modules/socket.io-client/build/cjs/index.js';
import { AuthService } from '../auth/auth.service';
import { FilesGateway } from './files.gateway';
import { FileWatchCoordinatorService } from './file-watch-coordinator.service';

/** Requests an acknowledgement with a finite transport deadline. */
function request(
  socket: Socket,
  event: string,
  payload: Record<string, string>,
): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(2000)
      .emit(event, payload, (error: Error | null, result: { ok: boolean }) =>
        error ? reject(error) : resolve(result),
      );
  });
}

it('authenticates watch handlers even without a global or conversation gateway guard', async () => {
  const acquire = vi.fn(() =>
    Promise.resolve({ ok: true, path: '/workspace' }),
  );
  const releaseSocket = vi.fn(() => Promise.resolve());
  const module = await Test.createTestingModule({
    providers: [
      FilesGateway,
      {
        provide: FileWatchCoordinatorService,
        useValue: { acquire, releaseSocket, subscribe: () => () => undefined },
      },
      {
        provide: AuthService,
        useValue: {
          authenticateToken: (token: string) =>
            Promise.resolve({ ok: token === 'valid' }),
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication(new FastifyAdapter(), {
    logger: false,
  });
  app.useWebSocketAdapter(new IoAdapter(app));
  await app.listen(0, '127.0.0.1');
  const url = `${await app.getUrl()}/ws`;
  const invalid = io(url, { auth: { token: 'invalid' }, reconnection: false });
  const valid = io(url, { auth: { token: 'valid' }, reconnection: false });
  try {
    await expect.poll(() => invalid.connected && valid.connected).toBe(true);
    expect(
      await request(invalid, 'fs.watch.acquire', {
        path: '/workspace',
        leaseId: 'one',
      }),
    ).toMatchObject({ ok: false });
    expect(acquire).not.toHaveBeenCalled();
    expect(
      await request(valid, 'fs.watch.acquire', {
        path: '/workspace',
        leaseId: 'two',
      }),
    ).toMatchObject({ ok: true });
    expect(acquire).toHaveBeenCalledExactlyOnceWith(
      valid.id,
      '/workspace',
      'two',
    );
    valid.disconnect();
    await expect.poll(() => releaseSocket.mock.calls.length).toBeGreaterThan(0);
  } finally {
    invalid.disconnect();
    valid.disconnect();
    await app.close();
  }
});
