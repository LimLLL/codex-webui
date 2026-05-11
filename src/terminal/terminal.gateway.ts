/**
 * WebSocket gateway for terminal sessions.
 * Bridges xterm.js on the frontend with node-pty on the backend.
 * All operations validate socket client ownership.
 */
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { TerminalService } from './terminal.service';

@WebSocketGateway({ namespace: '/ws', cors: { origin: '*' } })
export class TerminalGateway implements OnGatewayDisconnect {
  private readonly logger = new Logger(TerminalGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly terminalService: TerminalService) {}

  handleDisconnect(client: Socket): void {
    this.terminalService.closeByClient(client.id);
  }

  /**
   * Opens a new terminal session.
   *
   * @returns { terminalId } on success
   */
  @SubscribeMessage('terminal.open')
  async handleOpen(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { cwd: string; cols: number; rows: number },
  ): Promise<{ terminalId: string; error?: string }> {
    try {
      const session = await this.terminalService.open(
        client.id,
        data.cwd,
        data.cols || 80,
        data.rows || 24,
      );

      // Forward PTY output to the client
      session.process.onData((output: string) => {
        client.emit('terminal.output', {
          terminalId: session.id,
          data: output,
        });
      });

      session.process.onExit(({ exitCode }) => {
        client.emit('terminal.exit', {
          terminalId: session.id,
          exitCode,
        });
        this.terminalService.close(client.id, session.id);
      });

      this.logger.debug(`Client ${client.id} opened terminal ${session.id}`);
      return { terminalId: session.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to open terminal: ${msg}`);
      return { terminalId: '', error: msg };
    }
  }

  /** Writes user input to the terminal. */
  @SubscribeMessage('terminal.input')
  handleInput(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { terminalId: string; data: string },
  ): void {
    this.terminalService.write(client.id, data.terminalId, data.data);
  }

  /** Resizes the terminal. */
  @SubscribeMessage('terminal.resize')
  handleResize(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { terminalId: string; cols: number; rows: number },
  ): void {
    this.terminalService.resize(
      client.id,
      data.terminalId,
      data.cols,
      data.rows,
    );
  }

  /** Closes a terminal session. */
  @SubscribeMessage('terminal.close')
  handleClose(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { terminalId: string },
  ): { ok: boolean } {
    return { ok: this.terminalService.close(client.id, data.terminalId) };
  }
}
