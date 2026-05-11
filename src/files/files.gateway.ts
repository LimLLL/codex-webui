/**
 * WebSocket gateway for file system change notifications.
 * Watchers are created on-demand when clients subscribe to a directory,
 * and cleaned up when no clients remain in that room.
 */
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import * as chokidar from 'chokidar';
import { FilesService } from './files.service';

@WebSocketGateway({ namespace: '/ws', cors: { origin: '*' } })
export class FilesGateway implements OnModuleDestroy, OnGatewayDisconnect {
  private readonly logger = new Logger(FilesGateway.name);
  /** Active watchers keyed by directory path. */
  private readonly watchers = new Map<string, chokidar.FSWatcher>();

  @WebSocketServer()
  server!: Server;

  constructor(private readonly filesService: FilesService) {}

  /** Cleans up watchers with no remaining subscribers after a client disconnects. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleDisconnect(_client: Socket): void {
    void this.cleanupOrphanedWatchers();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
  }

  /**
   * Client subscribes to file system change events for a directory.
   * Creates a chokidar watcher if this is the first subscriber.
   *
   * @param client - Socket.IO client
   * @param data - { path: string } directory to watch
   */
  @SubscribeMessage('fs.subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { path: string },
  ): Promise<{ ok: boolean }> {
    // Validate path is within workspace roots
    try {
      await this.filesService.resolveSafePath(data.path);
    } catch {
      return { ok: false };
    }

    const room = `fs:${data.path}`;
    void client.join(room);
    this.logger.debug(`Client ${client.id} watching ${data.path}`);

    // Start watcher if not already active for this path
    if (!this.watchers.has(data.path)) {
      this.startWatcher(data.path);
    }

    return { ok: true };
  }

  /** Client unsubscribes from file system events. Cleans up watcher if no subscribers remain. */
  @SubscribeMessage('fs.unsubscribe')
  async handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { path: string },
  ): Promise<{ ok: boolean }> {
    const room = `fs:${data.path}`;
    void client.leave(room);

    // Check if room is now empty; if so, stop the watcher
    const sockets = await this.server.in(room).fetchSockets();
    if (sockets.length === 0) {
      await this.stopWatcher(data.path);
    }

    return { ok: true };
  }

  /** Creates a chokidar watcher for a specific directory. */
  private startWatcher(dirPath: string): void {
    const watcher = chokidar.watch(dirPath, {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/__pycache__/**',
        '**/.DS_Store',
      ],
      persistent: true,
      depth: 3,
      ignoreInitial: true,
    });

    const room = `fs:${dirPath}`;
    const emit = (event: string, filePath: string) => {
      this.server.to(room).emit('fs.changed', { event, path: filePath });
    };

    watcher
      .on('add', (p) => emit('add', p))
      .on('change', (p) => emit('change', p))
      .on('unlink', (p) => emit('unlink', p))
      .on('addDir', (p) => emit('addDir', p))
      .on('unlinkDir', (p) => emit('unlinkDir', p))
      .on('error', (err: Error) => {
        this.logger.warn(`Watcher error on ${dirPath}: ${err.message}`);
      });

    this.watchers.set(dirPath, watcher);
    this.logger.log(`Started watcher: ${dirPath}`);
  }

  /** Stops and removes a watcher for a directory. */
  private async stopWatcher(dirPath: string): Promise<void> {
    const watcher = this.watchers.get(dirPath);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(dirPath);
      this.logger.log(`Stopped watcher: ${dirPath}`);
    }
  }

  /** Stops watchers whose rooms have no remaining subscribers. */
  private async cleanupOrphanedWatchers(): Promise<void> {
    for (const dirPath of [...this.watchers.keys()]) {
      const room = `fs:${dirPath}`;
      const sockets = await this.server.in(room).fetchSockets();
      if (sockets.length === 0) {
        await this.stopWatcher(dirPath);
      }
    }
  }
}
