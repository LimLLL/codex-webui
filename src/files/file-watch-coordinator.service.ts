/** Connection-owned native watches shared by authenticated browser leases. */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { ServerNotification } from '../codex/codex-schema';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { CodexService } from '../codex/codex.service';
import { FilesService } from './files.service';

export interface FileWatchChange {
  watchPath: string;
  changedPaths: string[];
  socketIds: string[];
  /** A connection gap requires a full read of the desired scope. */
  refresh?: boolean;
}

interface Lease {
  socketId: string;
  path: string | null;
}
interface Registration {
  path: string;
  watchId: string;
  epoch: number;
  ready: Promise<void>;
}

/**
 * Leases outlive app-server connections but never their browser socket. Each
 * surface supplies a unique lease id; overlapping surfaces in one session must
 * not release each other's native watch. Pending leases are recorded before
 * path resolution so navigation/disconnection can cancel an in-flight acquire.
 */
@Injectable()
export class FileWatchCoordinatorService implements OnModuleDestroy {
  private readonly logger = new Logger(FileWatchCoordinatorService.name);
  private readonly leases = new Map<string, Map<string, Lease>>();
  private readonly registrations = new Map<string, Registration>();
  private readonly byWatchId = new Map<string, Registration>();
  private readonly listeners = new Set<(change: FileWatchChange) => void>();
  private readonly unregisterLifecycle: () => void;
  private epoch = 0;
  private sequence = 0;
  private ready: boolean;

  constructor(
    private readonly files: FilesService,
    private readonly codex: CodexService,
    processManager: CodexProcessManager,
  ) {
    this.ready = processManager.getClient() !== null;
    processManager.addListener('notification', (value: unknown) =>
      this.notify(value),
    );
    this.unregisterLifecycle = processManager.addLifecycleListener((event) => {
      if (
        event.type === 'appServerUnavailable' ||
        event.type === 'appServerRestarting'
      ) {
        this.ready = false;
        this.epoch += 1;
        this.registrations.clear();
        this.byWatchId.clear();
      } else if (event.type === 'appServerReady') {
        this.ready = true;
        void this.restore(this.epoch);
      }
    });
  }

  /** Detaches callbacks and clears desired leases during application shutdown. */
  onModuleDestroy(): void {
    this.unregisterLifecycle();
    this.ready = false;
    this.epoch += 1;
    this.leases.clear();
    this.registrations.clear();
    this.byWatchId.clear();
    this.listeners.clear();
  }

  /** Subscribes to the scoped browser-facing change stream. */
  subscribe(listener: (change: FileWatchChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Validates every acquire and registers at most one native watch per canonical path. */
  async acquire(
    socketId: string,
    requestedPath: string,
    leaseId = requestedPath,
  ): Promise<{ ok: true; path: string }> {
    const owned = this.leases.get(socketId) ?? new Map<string, Lease>();
    const existing = owned.get(leaseId);
    if (existing?.path) return { ok: true, path: existing.path };
    const lease: Lease = { socketId, path: null };
    owned.set(leaseId, lease);
    this.leases.set(socketId, owned);
    try {
      const path = await this.files.resolveWatchPath(requestedPath);
      if (this.leases.get(socketId)?.get(leaseId) !== lease)
        return { ok: true, path };
      lease.path = path;
      if (this.ready) await this.register(path);
      return { ok: true, path };
    } catch (error) {
      if (owned.get(leaseId) === lease) owned.delete(leaseId);
      if (!owned.size && this.leases.get(socketId) === owned)
        this.leases.delete(socketId);
      throw error;
    }
  }

  /** Releases without touching the filesystem; deleted and renamed paths remain releasable. */
  async release(socketId: string, leaseId: string): Promise<{ ok: true }> {
    const owned = this.leases.get(socketId);
    const lease = owned?.get(leaseId);
    owned?.delete(leaseId);
    if (!owned?.size) this.leases.delete(socketId);
    if (lease?.path) await this.releaseUnused(lease.path);
    return { ok: true };
  }

  /** Cancels pending acquisitions as well as every live lease for a disconnected socket. */
  async releaseSocket(socketId: string): Promise<void> {
    const paths = new Set(
      [...(this.leases.get(socketId)?.values() ?? [])].map(
        (lease) => lease.path,
      ),
    );
    this.leases.delete(socketId);
    for (const path of paths) if (path) await this.releaseUnused(path);
  }

  /** Finds subscribers from current leases, never from stale registration snapshots. */
  private socketIds(path: string): string[] {
    return [...this.leases.entries()]
      .filter(([, leases]) =>
        [...leases.values()].some((lease) => lease.path === path),
      )
      .map(([socketId]) => socketId);
  }

  /** Drops native resources only after the last surface in the last session releases. */
  private async releaseUnused(path: string): Promise<void> {
    if (this.socketIds(path).length) return;
    const registration = this.registrations.get(path);
    if (!registration) return;
    this.registrations.delete(path);
    this.byWatchId.delete(registration.watchId);
    await registration.ready.catch(() => undefined);
    if (registration.epoch === this.epoch && this.ready)
      await this.unwatch(registration.watchId);
  }

  /** Re-registers serially after readiness and refreshes the union of still-desired scopes. */
  private async restore(epoch: number): Promise<void> {
    const paths = new Set(
      [...this.leases.values()].flatMap((owned) =>
        [...owned.values()].flatMap((lease) =>
          lease.path ? [lease.path] : [],
        ),
      ),
    );
    for (const path of paths) {
      if (!this.ready || epoch !== this.epoch) return;
      if (!this.socketIds(path).length) continue;
      try {
        // Policy may have changed during the gap; stale leases are not authority.
        await this.files.resolveWatchPath(path);
        await this.register(path);
      } catch (error) {
        this.logger.warn(
          `Filesystem watch registration failed for ${path}: ${String(error)}`,
        );
      }
    }
    if (!this.ready || epoch !== this.epoch) return;
    for (const path of paths) this.publish(path, [path], true);
  }

  /** Installs the registration before awaiting RPC, deduplicating concurrent acquires. */
  private register(path: string): Promise<void> {
    const existing = this.registrations.get(path);
    if (existing) return existing.ready;
    const registration: Registration = {
      path,
      watchId: `webui-${this.epoch}-${this.sequence++}`,
      epoch: this.epoch,
      ready: Promise.resolve(),
    };
    this.registrations.set(path, registration);
    this.byWatchId.set(registration.watchId, registration);
    registration.ready = this.codex
      .request('fs/watch', { watchId: registration.watchId, path })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (this.registrations.get(path) === registration)
          this.registrations.delete(path);
        this.byWatchId.delete(registration.watchId);
        throw error;
      });
    return registration.ready;
  }

  /** Native cleanup is idempotent; a dead connection has already lost its watches. */
  private async unwatch(watchId: string): Promise<void> {
    try {
      await this.codex.request('fs/unwatch', { watchId });
    } catch (error) {
      this.logger.warn(
        `Filesystem unwatch failed for ${watchId}: ${String(error)}`,
      );
    }
  }

  /** Routes only ids owned by this connection epoch; no global path broadcast is permitted. */
  private notify(value: unknown): void {
    const notification = value as ServerNotification | undefined;
    if (notification?.method !== 'fs/changed') return;
    const registration = this.byWatchId.get(notification.params.watchId);
    if (!registration || registration.epoch !== this.epoch) return;
    this.publish(registration.path, [
      ...new Set(notification.params.changedPaths),
    ]);
  }

  /** Fans out once per socket even when several surfaces lease the same path. */
  private publish(path: string, changedPaths: string[], refresh = false): void {
    const socketIds = this.socketIds(path);
    if (!socketIds.length || !changedPaths.length) return;
    for (const listener of this.listeners)
      listener({ watchPath: path, changedPaths, socketIds, refresh });
  }
}
