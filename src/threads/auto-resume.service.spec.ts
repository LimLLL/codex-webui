/** Recovery uses execution obligations after all browsers leave, and never submits a turn. */
import { AutoResumeService } from './auto-resume.service';
import { ThreadExecutionInventoryService } from './thread-execution-inventory.service';
import { Server } from 'socket.io';
import { makeThreadFixture } from './threads.testing';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import type { ThreadsService } from './threads.service';
import type { ThreadsGateway } from './threads.gateway';
import {
  managedTransportFixture,
  executionGoal,
  executionTurn,
} from './thread-execution.testing';

describe('AutoResumeService', () => {
  it('restores active/blocked work and an active goal after every browser disconnects', async () => {
    const source = managedTransportFixture();
    const inventory = new ThreadExecutionInventoryService(source.manager);
    const socketServer = new Server();
    const sockets = socketServer.of('/ws').adapter;
    source.events.emit('notification', {
      method: 'thread/started',
      params: {
        thread: makeThreadFixture({ id: 'child', parentThreadId: 'parent' }),
      },
    });
    for (const [threadId, turnId] of [
      ['child', 'c'],
      ['blocked', 'b'],
      ['done', 'd'],
    ]) {
      await sockets.addAll('desktop', new Set([`thread:${threadId}`]));
      await sockets.addAll('mobile', new Set([`thread:${threadId}`]));
      source.events.emit('notification', {
        method: 'turn/started',
        params: { threadId, turn: executionTurn(turnId) },
      });
    }
    source.events.emit('notification', {
      method: 'thread/status/changed',
      params: {
        threadId: 'blocked',
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      },
    });
    source.events.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'done', turn: executionTurn('d', 'completed') },
    });
    source.events.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'goal',
        turnId: null,
        goal: executionGoal('goal', 'active'),
      },
    });
    sockets.delAll('desktop');
    sockets.delAll('mobile');
    expect(sockets.sids.size).toBe(0);

    const admission = new CatalogAdmissionService();
    const order: string[] = [];
    const readThread = vi.fn((id: string) => {
      if (id === 'child') expect(order).toContain('parent');
      return Promise.resolve({
        thread: { parentThreadId: null },
      });
    });
    const resumeThread = vi.fn((id: string) => {
      expect(() => admission.begin()).toThrow('Mutations');
      order.push(id);
      return Promise.resolve({
        mode: 'writable',
        initialTurnsPage: { data: [] },
      });
    });
    const startTurn = vi.fn();
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const emitLifecycle = vi.fn((event: { type: string }) => {
      if (event.type === 'autoResumeCompleted') finish();
    });
    const service = new AutoResumeService(
      source.manager,
      inventory,
      { readThread, resumeThread, startTurn } as unknown as ThreadsService,
      { emitLifecycle } as unknown as ThreadsGateway,
      admission,
    );
    service.onModuleInit();
    source.restart();
    await completed;
    expect(order).toEqual(['parent', 'child', 'blocked', 'goal']);
    expect(resumeThread).toHaveBeenCalledWith('child', { recordActive: false });
    expect(startTurn).not.toHaveBeenCalled();
    expect(emitLifecycle).toHaveBeenLastCalledWith({
      type: 'autoResumeCompleted',
      generation: 2,
      resumedThreadIds: ['child', 'blocked', 'goal'],
      failedThreadIds: [],
    });
    const release = admission.begin();
    release();
    await sockets.close();
  });

  it('reports ownership refusal as failed and retains the obligation', async () => {
    const source = managedTransportFixture();
    const inventory = new ThreadExecutionInventoryService(source.manager);
    source.events.emit('notification', {
      method: 'turn/started',
      params: { threadId: 't', turn: executionTurn('turn') },
    });
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const emitLifecycle = vi.fn((event: { type: string }) => {
      if (event.type === 'autoResumeCompleted') finish();
    });
    const service = new AutoResumeService(
      source.manager,
      inventory,
      {
        readThread: () => Promise.resolve({ thread: { parentThreadId: null } }),
        resumeThread: () => Promise.resolve({ mode: 'readOnly' }),
      } as unknown as ThreadsService,
      { emitLifecycle } as unknown as ThreadsGateway,
      new CatalogAdmissionService(),
    );
    service.onModuleInit();
    source.restart();
    await completed;
    expect(emitLifecycle).toHaveBeenLastCalledWith({
      type: 'autoResumeCompleted',
      generation: 2,
      resumedThreadIds: [],
      failedThreadIds: ['t'],
    });
    expect(inventory.has('t')).toBe(true);
  });
});
