/** Excludes catalog activation from already admitted REST mutations and synchronous approval replies. */
import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { finalize, Observable } from 'rxjs';

@Injectable()
export class CatalogAdmissionService {
  private applying = false;
  private readonly operations = new Map<symbol, string>();
  /** Claims an ordinary mutation for its entire service operation, including gaps between RPC calls. */
  enter(description: string): () => void {
    this.assertOpen();
    const key = Symbol();
    this.operations.set(key, description);
    return () => {
      this.operations.delete(key);
    };
  }
  /** Rejects direct synchronous mutations, notably Socket.IO approval replies, while applying. */
  assertOpen(): void {
    if (this.applying)
      throw new ConflictException('Catalog activation is in progress');
  }
  /** Exclusively claims application before its first asynchronous check; never waits for work to finish. */
  begin(): () => void {
    this.assertOpen();
    if (this.operations.size)
      throw new ConflictException({
        message: 'Mutations are in progress',
        operations: [...this.operations.values()],
      });
    this.applying = true;
    let released = false;
    return () => {
      if (!released) this.applying = false;
      released = true;
    };
  }
  /** Returns current local operations for the blockers endpoint. */
  pending(): string[] {
    return [...this.operations.values()];
  }
}

@Injectable()
export class CatalogMutationInterceptor implements NestInterceptor {
  constructor(private readonly admission: CatalogAdmissionService) {}
  /** Covers full HTTP mutations; catalog endpoints acquire their own exclusive admission. */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context
      .switchToHttp()
      .getRequest<{ method: string; url: string }>();
    if (
      ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
      request.url.startsWith('/api/codex/catalog') ||
      request.url.startsWith('/api/auth')
    )
      return next.handle();
    const release = this.admission.enter(
      `${request.method} ${request.url.split('?')[0]}`,
    );
    try {
      return next.handle().pipe(finalize(release));
    } catch (error) {
      release();
      throw error;
    }
  }
}
