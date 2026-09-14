/**
 * WebSocket gateway for shared terminal sessions.
 * Bridges xterm.js clients with node-pty and broadcasts shared PTY state to
 * every socket attached to the same context terminal.
 */
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy, UseFilters, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { TerminalService } from './terminal.service';
import { TerminalExceptionFilter, terminalErrorAck } from './terminal-errors';
import { BusinessException } from '../common/business.exception';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ErrorCode } from '../common/error-codes';
import type {
  TerminalAck,
  TerminalContextDto,
  TerminalDetachDto,
  TerminalIdDto,
  TerminalInputDto,
  TerminalOpenParams,
  TerminalRenameDto,
  TerminalResizeDto,
  TerminalRecoverDto,
} from './terminal.types';

@WebSocketGateway({ namespace: '/ws', cors: { origin: '*' } })
// The application-wide `APP_GUARD` does not reach `@SubscribeMessage` handlers —
// measured: removing this decorator lets an invalid token through `terminal.list`
// with `ok: true`. Connection-level authentication in the conversation gateway is
// what covers the socket today, which leaves this gateway's events depending on a
// different gateway's handler. This makes that dependency explicit and local.
// The filter is gateway-scoped so the guard's refusal still reaches the caller's
// acknowledgement with its code intact.
@UseFilters(TerminalExceptionFilter)
@UseGuards(ApiKeyGuard)
export class TerminalGateway
  implements OnGatewayInit, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(TerminalGateway.name);
  private unregisterListeners: Array<() => void> = [];

  @WebSocketServer()
  server!: Server;

  constructor(private readonly terminalService: TerminalService) {}

  afterInit(): void {
    this.unregisterListeners = [
      this.terminalService.onOutput((event) => {
        this.emitToSockets(event.socketIds, 'terminal.output', {
          terminalId: event.terminalId,
          sessionId: event.sessionId,
          sequence: event.sequence,
          data: event.data,
        });
      }),
      this.terminalService.onMetadata((event) => {
        this.emitToSockets(event.socketIds, 'terminal.metadata', {
          terminal: event.terminal,
        });
      }),
      this.terminalService.onExit((event) => {
        this.emitToSockets(event.socketIds, 'terminal.exit', {
          terminal: event.terminal,
          closed: false,
        });
      }),
      this.terminalService.onClosed((event) => {
        this.emitToSockets(event.socketIds, 'terminal.exit', {
          terminalId: event.terminalId,
          contextKey: event.contextKey,
          closed: true,
        });
      }),
    ];
  }

  handleDisconnect(client: Socket): void {
    this.terminalService.detach(client.id);
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregisterListeners) unregister();
    this.unregisterListeners = [];
  }

  /** Returns terminal runtime limits and defaults. */
  @SubscribeMessage('terminal.config')
  handleConfig(): TerminalAck {
    return { ok: true, config: this.terminalService.getConfig() };
  }

  /** Lists terminals for a context. */
  @SubscribeMessage('terminal.list')
  handleList(@MessageBody() data: TerminalContextDto): TerminalAck {
    try {
      return {
        ok: true,
        terminals: this.terminalService.list(data.contextKey),
        config: this.terminalService.getConfig(),
      };
    } catch (error) {
      return this.toErrorAck(error);
    }
  }

  /** Opens a new terminal and attaches the caller. */
  @SubscribeMessage('terminal.open')
  async handleOpen(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalOpenParams,
  ): Promise<TerminalAck> {
    try {
      const terminal = await this.terminalService.open(
        client.id,
        data,
        () => client.connected,
      );
      this.logger.debug(`Client ${client.id} opened terminal ${terminal.id}`);
      return { ok: true, terminal, config: this.terminalService.getConfig() };
    } catch (error) {
      return this.toErrorAck(error);
    }
  }

  /** Attaches the caller to an existing terminal and returns VT state. */
  @SubscribeMessage('terminal.reconnect')
  async handleReconnect(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalIdDto,
  ): Promise<TerminalAck> {
    try {
      const { terminal, state, sequence } =
        await this.terminalService.reconnect(
          client.id,
          data.contextKey,
          data.terminalId,
          () => client.connected,
        );
      return {
        ok: true,
        terminal,
        state,
        sequence,
        config: this.terminalService.getConfig(),
      };
    } catch (error) {
      return this.toErrorAck(error);
    }
  }

  /** Recovers a presented terminal, with an explicit manual action after the automatic budget is exhausted. */
  @SubscribeMessage('terminal.recover')
  async handleRecover(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalRecoverDto,
  ): Promise<TerminalAck> {
    try {
      if (typeof data.manual !== 'boolean') {
        throw BusinessException.badRequest(
          ErrorCode.http.badRequest,
          'Recovery requires an explicit automatic or manual mode',
        );
      }
      const attachment = await this.terminalService.recover(
        client.id,
        data.contextKey,
        data.terminalId,
        data.manual,
        () => client.connected,
      );
      return {
        ok: true,
        ...attachment,
        config: this.terminalService.getConfig(),
      };
    } catch (error) {
      return this.toErrorAck(error);
    }
  }

  /** Detaches the caller without killing the PTY. */
  @SubscribeMessage('terminal.detach')
  handleDetach(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalDetachDto | null,
  ): TerminalAck {
    try {
      this.terminalService.detach(
        client.id,
        typeof data?.terminalId === 'string' ? data.terminalId : undefined,
      );
      return { ok: true };
    } catch (error) {
      return this.emitError(client, error);
    }
  }

  /** Writes user input to a shared terminal. */
  @SubscribeMessage('terminal.input')
  handleInput(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalInputDto,
  ): TerminalAck {
    try {
      this.terminalService.write(
        client.id,
        data.contextKey,
        data.terminalId,
        data.sessionId,
        data.data,
      );
      return { ok: true };
    } catch (error) {
      return this.emitError(client, error);
    }
  }

  /** Resizes the terminal. Last resize wins. */
  @SubscribeMessage('terminal.resize')
  handleResize(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalResizeDto,
  ): TerminalAck {
    try {
      const terminal = this.terminalService.resize(
        client.id,
        data.contextKey,
        data.terminalId,
        data.sessionId,
        data.cols,
        data.rows,
      );
      return { ok: true, terminal };
    } catch (error) {
      return this.emitError(client, error);
    }
  }

  /** Renames a terminal tab for all attached clients. */
  @SubscribeMessage('terminal.rename')
  handleRename(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalRenameDto,
  ): TerminalAck {
    try {
      const terminal = this.terminalService.rename(
        client.id,
        data.contextKey,
        data.terminalId,
        data.title,
      );
      return { ok: true, terminal };
    } catch (error) {
      return this.emitError(client, error);
    }
  }

  /** Returns a plain-text snapshot of the terminal buffer. */
  @SubscribeMessage('terminal.download')
  async handleDownload(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalIdDto,
  ): Promise<TerminalAck<{ filename: string; content: string }>> {
    try {
      const payload = await this.terminalService.download(
        client.id,
        data.contextKey,
        data.terminalId,
      );
      return { ok: true, data: payload };
    } catch (error) {
      return this.emitError(client, error);
    }
  }

  /** Closes and kills a terminal session for every attached client. */
  @SubscribeMessage('terminal.close')
  handleClose(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TerminalIdDto,
  ): TerminalAck {
    try {
      this.terminalService.close(client.id, data.contextKey, data.terminalId);
      return { ok: true };
    } catch (error) {
      return this.emitError(client, error);
    }
  }

  private emitToSockets(
    socketIds: string[],
    event: string,
    payload: Record<string, unknown>,
  ): void {
    for (const socketId of socketIds) {
      this.server.to(socketId).emit(event, payload);
    }
  }

  private emitError<T = unknown>(
    client: Socket,
    error: unknown,
  ): TerminalAck<T> {
    const ack = this.toErrorAck<T>(error);
    client.emit('terminal.error', ack);
    return ack;
  }

  private toErrorAck<T = unknown>(error: unknown): TerminalAck<T> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Terminal operation failed: ${message}`);
    return terminalErrorAck<T>(error);
  }
}
