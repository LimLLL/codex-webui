/** Terminal acknowledgements preserve business codes, including guard failures before handlers run. */
import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import type { TerminalAck } from './terminal.types';

/** Projects safe business failures without conflating unexpected failures with missing sessions. */
export function terminalErrorAck<T = unknown>(error: unknown): TerminalAck<T> {
  if (error instanceof BusinessException) {
    return {
      ok: false,
      error: error.message,
      errorCode: error.errorCode,
      params: error.params,
    };
  }
  return {
    ok: false,
    error: 'Terminal operation failed',
    errorCode: ErrorCode.terminal.operationFailed,
  };
}

/** Gateway-local filter covers authentication guards as well as unhandled event errors. */
@Catch()
export class TerminalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(TerminalExceptionFilter.name);

  /** Nest's Socket.IO invocation arguments are socket, data, acknowledgement and event pattern. */
  catch(error: unknown, host: ArgumentsHost): void {
    const reply = terminalErrorAck(error);
    this.logger.warn(
      { error: String(error), errorCode: reply.errorCode },
      'Terminal request refused',
    );
    const acknowledge = host.getArgByIndex<unknown>(2);
    if (typeof acknowledge === 'function') {
      (acknowledge as (result: TerminalAck) => void)(reply);
    } else {
      host.switchToWs().getClient<Socket>().emit('terminal.error', reply);
    }
  }
}
