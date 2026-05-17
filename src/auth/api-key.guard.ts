/**
 * Global guard that validates API and WebSocket requests with JWT or API key.
 * Static assets are served outside controllers; API routes and gateway events are protected.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import type { Socket } from 'socket.io';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';

interface HttpToken {
  value: string;
  source: 'header' | 'query';
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    if (context.getType() === 'ws') {
      const socket = context.switchToWs().getClient<Socket>();
      const token = this.getSocketToken(socket);
      if (!token) {
        throw new UnauthorizedException(
          'Missing or invalid authentication token',
        );
      }
      const result = await this.authService.authenticateToken(token, socket.id);
      if (!result.ok) {
        throw new UnauthorizedException('Invalid authentication token');
      }
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const httpToken = this.getHttpToken(request);
    if (!httpToken) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    // Query tokens are JWT-only — skip API key fallback to avoid URL key exposure
    const result =
      httpToken.source === 'query'
        ? { ok: await this.authService.verifyJwt(httpToken.value) }
        : await this.authService.authenticateToken(
            httpToken.value,
            this.getRequestId(request),
          );
    if (!result.ok) {
      throw new UnauthorizedException('Invalid authentication token');
    }

    return true;
  }

  private getHttpToken(request: FastifyRequest): HttpToken | null {
    const headerToken = this.extractBearerToken(request.headers.authorization);
    if (headerToken) return { value: headerToken, source: 'header' };
    // RFC 6750 §2.3 — query param fallback, restricted to inline file preview only
    if (!this.allowsQueryAccessToken(request)) return null;
    const queryToken = (request.query as Record<string, unknown>)?.[
      'access_token'
    ];
    if (typeof queryToken !== 'string' || !queryToken.trim()) return null;
    // Query tokens must be JWT — raw API key in URL is not acceptable
    const token = queryToken.trim();
    return token.split('.').length === 3
      ? { value: token, source: 'query' }
      : null;
  }

  /** Only allow access_token query param on the inline file serve endpoint. */
  private allowsQueryAccessToken(request: FastifyRequest): boolean {
    if (request.method !== 'GET') return false;
    const url = request.url;
    return url.startsWith('/api/files/serve?') || url === '/api/files/serve';
  }

  private getSocketToken(client: Socket): string | null {
    const authToken = (client.handshake.auth as Record<string, unknown>)?.[
      'token'
    ];
    if (typeof authToken === 'string' && authToken.trim()) {
      return this.extractBearerToken(authToken) ?? authToken;
    }

    return this.extractBearerToken(client.handshake.headers.authorization);
  }

  private extractBearerToken(
    header: string | string[] | undefined,
  ): string | null {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith('Bearer ')) return null;
    const token = value.slice(7).trim();
    return token.length > 0 ? token : null;
  }

  private getRequestId(request: FastifyRequest): string | undefined {
    const id = (request as unknown as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
}
