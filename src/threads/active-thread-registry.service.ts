/** Tracks live socket subscriptions so app-server restarts resume only open threads. */
import { Injectable } from '@nestjs/common';

@Injectable()
export class ActiveThreadRegistryService {
  private readonly socketThreads = new Map<string, Set<string>>();
  private readonly threadSockets = new Map<string, Set<string>>();

  /** Registers a socket subscription for a thread and returns the current ref count. */
  subscribe(socketId: string, threadId: string): number {
    const socketSet = this.socketThreads.get(socketId) ?? new Set<string>();
    socketSet.add(threadId);
    this.socketThreads.set(socketId, socketSet);

    const threadSet = this.threadSockets.get(threadId) ?? new Set<string>();
    threadSet.add(socketId);
    this.threadSockets.set(threadId, threadSet);
    return threadSet.size;
  }

  /** Removes a socket subscription for a thread and returns the remaining ref count. */
  unsubscribe(socketId: string, threadId: string): number {
    const socketSet = this.socketThreads.get(socketId);
    socketSet?.delete(threadId);
    if (socketSet && socketSet.size === 0) this.socketThreads.delete(socketId);

    const threadSet = this.threadSockets.get(threadId);
    threadSet?.delete(socketId);
    if (!threadSet || threadSet.size === 0) {
      this.threadSockets.delete(threadId);
      return 0;
    }
    return threadSet.size;
  }

  /** Removes all subscriptions owned by a disconnected socket. */
  removeSocket(socketId: string): string[] {
    const threadIds = [...(this.socketThreads.get(socketId) ?? [])];
    for (const threadId of threadIds) {
      this.unsubscribe(socketId, threadId);
    }
    return threadIds;
  }

  /** Returns thread ids that currently have at least one socket subscriber. */
  snapshot(): string[] {
    return [...this.threadSockets.keys()];
  }
}
