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

    const request =
      context.getType() === 'ws'
        ? null
        : context.switchToHttp().getRequest<FastifyRequest>();
    const socket =
      context.getType() === 'ws'
        ? context.switchToWs().getClient<Socket>()
        : null;
    const token =
      context.getType() === 'ws'
        ? this.getSocketToken(socket as Socket)
        : this.getHttpToken(request as FastifyRequest);

    if (!token) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    const result = await this.authService.authenticateToken(
      token,
      this.getRequestId(request, socket),
    );
    if (!result.ok) {
      throw new UnauthorizedException('Invalid authentication token');
    }

    return true;
  }

  private getHttpToken(request: FastifyRequest): string | null {
    return this.extractBearerToken(request.headers.authorization);
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

  private getRequestId(
    request: FastifyRequest | null,
    socket: Socket | null,
  ): string | undefined {
    if (request) {
      const id = (request as unknown as { id?: unknown }).id;
      return typeof id === 'string' ? id : undefined;
    }
    return socket?.id;
  }
}
