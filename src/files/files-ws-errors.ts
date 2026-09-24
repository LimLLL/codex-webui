/** Acknowledges guarded watch failures without exposing unexpected server errors. */
import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { BusinessException } from '../common/business.exception';

@Catch()
export class FilesExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(FilesExceptionFilter.name);

  /** Socket.IO handler arguments include the optional acknowledgement callback. */
  catch(error: unknown, host: ArgumentsHost): void {
    this.logger.warn(`Filesystem watch request refused: ${String(error)}`);
    const reply = {
      ok: false,
      error:
        error instanceof BusinessException
          ? error.message
          : 'Filesystem watch unavailable',
    };
    const acknowledge = host.getArgByIndex<unknown>(2);
    if (typeof acknowledge === 'function')
      (acknowledge as (value: typeof reply) => void)(reply);
    else host.switchToWs().getClient<Socket>().emit('fs.error', reply);
  }
}
