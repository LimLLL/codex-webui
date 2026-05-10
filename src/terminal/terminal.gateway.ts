/**
 * WebSocket gateway for terminal sessions.
 * Bridges xterm.js on the frontend with node-pty on the backend.
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
  handleOpen(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { cwd: string; cols: number; rows: number },
  ): { terminalId: string; error?: string } {
    try {
      const session = this.terminalService.open(
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
        this.terminalService.close(session.id);
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
  handleInput(@MessageBody() data: { terminalId: string; data: string }): void {
    this.terminalService.write(data.terminalId, data.data);
  }

  /** Resizes the terminal. */
  @SubscribeMessage('terminal.resize')
  handleResize(
    @MessageBody() data: { terminalId: string; cols: number; rows: number },
  ): void {
    this.terminalService.resize(data.terminalId, data.cols, data.rows);
  }

  /** Closes a terminal session. */
  @SubscribeMessage('terminal.close')
  handleClose(@MessageBody() data: { terminalId: string }): { ok: boolean } {
    this.terminalService.close(data.terminalId);
    return { ok: true };
  }
}
