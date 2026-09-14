/** Durable lifecycle behavior uses real SQLite; controlled PTYs expose allocation and race outcomes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { terminalFixture } from './terminal.testing';
import { AUTOMATIC_REPLACEMENT_WINDOW_MS } from './terminal-registry.service';
import { TerminalGateway } from './terminal.gateway';
import type { Socket } from 'socket.io';

const ptys = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: ptys.spawn }));
let fixture: Awaited<ReturnType<typeof terminalFixture>>;
let exit: (event: { exitCode: number; signal?: number }) => void;

beforeEach(async () => {
  ptys.spawn.mockReset().mockImplementation(() => ({
    pid: 123,
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: (callback: typeof exit) => {
      exit = callback;
    },
  }));
  fixture = await terminalFixture();
});
afterEach(async () => {
  vi.useRealTimers();
  await fixture.dispose();
  fixture.database.sqlite.close();
});

/** Expires a session using the actual detach/grace path. */
async function reclaim(id: string, socket = 'a') {
  vi.useFakeTimers();
  fixture.service.detach(socket, id);
  await vi.advanceTimersByTimeAsync(31);
}

describe('durable recovery and closure', () => {
  it('keeps another recovering browser alive when the first requester disconnects during preparation', async () => {
    const terminal = await fixture.service.open('a', { contextKey: 'global' });
    await reclaim(terminal.id);
    let finish!: (cwd: string) => void;
    fixture.files.resolveSafePath = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    let firstConnected = true;
    const first = fixture.service.recover(
      'a',
      'global',
      terminal.id,
      false,
      () => firstConnected,
    );
    const second = fixture.service.recover(
      'b',
      'global',
      terminal.id,
      false,
      () => true,
    );
    firstConnected = false;
    ptys.spawn.mockClear();
    const results = Promise.allSettled([first, second]);
    finish(fixture.directory);
    const [disconnected, attached] = await results;
    expect(disconnected.status).toBe('rejected');
    expect(attached.status).toBe('fulfilled');
    expect(ptys.spawn).toHaveBeenCalledTimes(1);
    expect(fixture.service.list('global')[0].attachedCount).toBe(1);
  });

  it('cleans the remaining sessions when one shutdown disposer fails', async () => {
    const kills = [
      vi.fn().mockImplementationOnce(() => {
        throw new Error('kill failed');
      }),
      vi.fn(),
    ];
    for (const kill of kills) {
      ptys.spawn.mockReturnValueOnce({
        pid: 123,
        kill,
        write: vi.fn(),
        resize: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn(),
      });
      await fixture.service.open('a', { contextKey: 'global' });
    }
    expect(() => fixture.service.onModuleDestroy()).not.toThrow();
    expect(kills[0]).toHaveBeenCalledOnce();
    expect(kills[1]).toHaveBeenCalledOnce();
  });

  it('recovers after restart from the original launch directory despite a changed global default', async () => {
    const terminal = await fixture.service.open('a', {
      contextKey: 'thread:t',
      cwd: fixture.directory,
    });
    fixture.service.onModuleDestroy();
    const restarted = await terminalFixture(fixture.database);
    try {
      restarted.update({ defaultCwd: '/missing-new-default' });
      const result = await restarted.service.recover(
        'b',
        'thread:t',
        terminal.id,
        false,
      );
      expect(result.terminal).toMatchObject({
        id: terminal.id,
        cwd: fixture.directory,
        generation: 1,
      });
      expect(result.terminal.sessionId).not.toBe(terminal.sessionId);
    } finally {
      await restarted.dispose();
    }
  });

  it('does not create again when publication and cleanup both fail', async () => {
    const terminal = await fixture.service.open('a', { contextKey: 'global' });
    await reclaim(terminal.id);
    fixture.database.sqlite.exec(
      "CREATE TRIGGER refuse_terminal_publish BEFORE UPDATE ON terminal_identities WHEN NEW.session_id != OLD.session_id BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END",
    );
    const kill = vi.fn().mockImplementationOnce(() => {
      throw new Error('kill failed');
    });
    ptys.spawn.mockClear().mockReturnValue({
      pid: 321,
      kill,
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    });
    await expect(
      fixture.service.recover('a', 'global', terminal.id, false),
    ).rejects.toMatchObject({ errorCode: 'terminal.cleanup_failed' });
    await expect(
      fixture.service.recover('b', 'global', terminal.id, true),
    ).rejects.toMatchObject({ errorCode: 'terminal.cleanup_failed' });
    expect(ptys.spawn).toHaveBeenCalledTimes(1);
    expect(fixture.service.list('global')).toEqual([]);
    expect(fixture.registry.get('global', terminal.id).sessionId).toBe(
      terminal.sessionId,
    );
  });

  it('spawns zero processes when an offline browser returns after acknowledged close and service restart', async () => {
    const terminal = await fixture.service.open('a', { contextKey: 'global' });
    await fixture.service.reconnect('b', 'global', terminal.id);
    fixture.service.detach('b');
    fixture.service.close('a', 'global', terminal.id);
    const restarted = await terminalFixture(fixture.database);
    try {
      ptys.spawn.mockClear();
      await expect(
        restarted.service.recover('b', 'global', terminal.id, false),
      ).rejects.toMatchObject({ errorCode: 'terminal.closed' });
      expect(ptys.spawn).not.toHaveBeenCalled();
    } finally {
      await restarted.dispose();
    }
  });

  it('shares one replacement across concurrent sockets and a lost acknowledgement', async () => {
    const terminal = await fixture.service.open('a', {
      contextKey: 'global',
      title: 'Build',
    });
    await reclaim(terminal.id);
    ptys.spawn.mockClear();
    const gateway = new TerminalGateway(fixture.service);
    const request = (id: string) =>
      gateway.handleRecover({ id, connected: true } as Socket, {
        contextKey: 'global',
        terminalId: terminal.id,
        manual: false,
      });
    // The first return value deliberately never reaches its caller. A subsequent request must resolve the same PTY.
    const [, b, c] = await Promise.all([
      request('lost-ack'),
      request('b'),
      request('c'),
    ]);
    const retry = await request('lost-ack');
    expect(ptys.spawn).toHaveBeenCalledTimes(1);
    expect(b.terminal?.sessionId).not.toBe(terminal.sessionId);
    expect(c.terminal?.sessionId).toBe(b.terminal?.sessionId);
    expect(retry.terminal?.sessionId).toBe(b.terminal?.sessionId);
    expect(retry.terminal?.title).toBe('Build');
  });

  it('closes both exited-retained and already-reclaimed terminals and never re-enables them', async () => {
    const ended = await fixture.service.open('a', { contextKey: 'global' });
    exit({ exitCode: 0 });
    expect(fixture.service.list('global')[0].status).toBe('exited');
    fixture.service.close('a', 'global', ended.id);
    fixture.service.close('a', 'global', ended.id);
    const lost = await fixture.service.open('a', { contextKey: 'global' });
    await reclaim(lost.id);
    fixture.service.close('a', 'global', lost.id);
    expect(fixture.service.list('global')).toEqual([]);
    await expect(
      fixture.service.recover('a', 'global', lost.id, true),
    ).rejects.toMatchObject({ errorCode: 'terminal.closed' });
  });

  it('rechecks revocation after asynchronous cwd validation', async () => {
    const terminal = await fixture.service.open('a', { contextKey: 'global' });
    await reclaim(terminal.id);
    let release!: (value: string) => void;
    fixture.files.resolveSafePath = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const recovering = fixture.service.recover(
      'a',
      'global',
      terminal.id,
      false,
    );
    fixture.service.close('b', 'global', terminal.id);
    ptys.spawn.mockClear();
    release(fixture.directory);
    await expect(recovering).rejects.toMatchObject({
      errorCode: 'terminal.closed',
    });
    expect(ptys.spawn).not.toHaveBeenCalled();
  });

  it('discovery attaches exited sessions, but cannot create when a listed session expires', async () => {
    const terminal = await fixture.service.open('a', { contextKey: 'global' });
    exit({ exitCode: 0 });
    expect(
      (await fixture.service.reconnect('a', 'global', terminal.id)).terminal
        .status,
    ).toBe('exited');
    expect(fixture.service.list('global')).toHaveLength(1);
    await reclaim(terminal.id);
    ptys.spawn.mockClear();
    await expect(
      fixture.service.reconnect('a', 'global', terminal.id),
    ).rejects.toMatchObject({ errorCode: 'terminal.session_lost' });
    expect(fixture.service.list('global')).toEqual([]);
    expect(ptys.spawn).not.toHaveBeenCalled();
  });

  it('bounds automatic attempts across restart, while manual recovery preserves the budget', async () => {
    const terminal = await fixture.service.open('a', { contextKey: 'global' });
    for (let i = 0; i < 3; i++) {
      await reclaim(terminal.id);
      await fixture.service.recover('a', 'global', terminal.id, false);
    }
    await reclaim(terminal.id);
    const restarted = await terminalFixture(fixture.database);
    try {
      await expect(
        restarted.service.recover('a', 'global', terminal.id, false),
      ).rejects.toMatchObject({ errorCode: 'terminal.recovery_limit' });
      await restarted.service.recover('a', 'global', terminal.id, true);
      expect(
        restarted.registry.get('global', terminal.id).automaticAttempts,
      ).toHaveLength(3);
      restarted.service.detach('a');
      await vi.advanceTimersByTimeAsync(AUTOMATIC_REPLACEMENT_WINDOW_MS + 31);
      await expect(
        restarted.service.recover('a', 'global', terminal.id, false),
      ).resolves.toMatchObject({ terminal: { generation: 5 } });
    } finally {
      await restarted.dispose();
    }
  });

  it('rejects unknown/context-mismatched identities and stale or unattached input separately', async () => {
    const terminal = await fixture.service.open('a', { contextKey: 'global' });
    await expect(
      fixture.service.recover('a', 'global', 'unknown', false),
    ).rejects.toMatchObject({ errorCode: 'terminal.not_found' });
    await expect(
      fixture.service.recover('a', 'thread:x', terminal.id, false),
    ).rejects.toMatchObject({ errorCode: 'terminal.context_mismatch' });
    expect(() =>
      fixture.service.write(
        'b',
        'global',
        terminal.id,
        terminal.sessionId,
        'x',
      ),
    ).toThrow(
      expect.objectContaining({ errorCode: 'terminal.socket_not_attached' }),
    );
    await reclaim(terminal.id);
    await fixture.service.recover('a', 'global', terminal.id, false);
    expect(() =>
      fixture.service.write(
        'a',
        'global',
        terminal.id,
        terminal.sessionId,
        'x',
      ),
    ).toThrow(expect.objectContaining({ errorCode: 'terminal.stale_session' }));
  });

  it('does not kill or acknowledge close when durable revocation fails', async () => {
    const terminal = await fixture.service.open('a', { contextKey: 'global' });
    fixture.database.sqlite.exec(
      "CREATE TRIGGER refuse_terminal_close BEFORE UPDATE ON terminal_identities BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END",
    );
    expect(() => fixture.service.close('a', 'global', terminal.id)).toThrow(
      'disk unavailable',
    );
    expect(fixture.registry.get('global', terminal.id).closed).toBe(false);
    expect(fixture.service.list('global')).toHaveLength(1);
  });
});

describe('directory and allocation policy', () => {
  it('uses explicit directories in both contexts despite an invalid global default', async () => {
    fixture.update({ defaultCwd: '/missing-default' });
    for (const contextKey of ['global', 'thread:t']) {
      const terminal = await fixture.service.open('a', {
        contextKey,
        cwd: fixture.directory,
      });
      expect(terminal.cwd).toBe(fixture.directory);
    }
    await expect(
      fixture.service.open('a', { contextKey: 'thread:t' }),
    ).rejects.toMatchObject({ errorCode: 'terminal.cwd_required' });
  });

  it('rejects invalid explicit directories without substituting the valid default', async () => {
    fixture.update({ defaultCwd: fixture.directory });
    await expect(
      fixture.service.open('a', {
        contextKey: 'thread:t',
        cwd: null as unknown as string,
      }),
    ).rejects.toMatchObject({ errorCode: 'terminal.invalid_cwd' });
    const file = join(fixture.directory, 'file');
    writeFileSync(file, 'x');
    await expect(
      fixture.service.open('a', { contextKey: 'global', cwd: file }),
    ).rejects.toMatchObject({ errorCode: 'terminal.cwd_not_directory' });
    await expect(
      fixture.service.open('a', {
        contextKey: 'thread:t',
        cwd: '/not-existing-webui-terminal',
      }),
    ).rejects.toThrow();
    expect(ptys.spawn).not.toHaveBeenCalled();
  });

  it('enforces capacity after async preparation across concurrent opens', async () => {
    fixture.update({ maxSessions: 1 });
    const results = await Promise.allSettled([
      fixture.service.open('a', { contextKey: 'global' }),
      fixture.service.open('b', { contextKey: 'global' }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(ptys.spawn).toHaveBeenCalledTimes(1);
  });

  it('preserves the resolved launch directory and does not attach a disconnected caller', async () => {
    const cwd = join(fixture.directory, 'project');
    mkdirSync(cwd);
    const terminal = await fixture.service.open('a', {
      contextKey: 'thread:t',
      cwd,
    });
    await reclaim(terminal.id);
    expect(
      (await fixture.service.recover('a', 'thread:t', terminal.id, false))
        .terminal.cwd,
    ).toBe(cwd);
    await expect(
      fixture.service.open('a', { contextKey: 'global' }, () => false),
    ).rejects.toMatchObject({ errorCode: 'terminal.disconnected' });
  });
});
