/**
 * Global guard that validates API and WebSocket requests against WEBUI_API_KEY.
 * Static assets are served outside controllers; API routes and gateway events are protected.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import type { Socket } from 'socket.io';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly apiKey: string;

  constructor(configService: ConfigService) {
    this.apiKey = configService.getOrThrow<string>('WEBUI_API_KEY');
  }

  canActivate(context: ExecutionContext): boolean {
    const token =
      context.getType() === 'ws'
        ? this.getSocketToken(context.switchToWs().getClient<Socket>())
        : this.getHttpToken(
            context.switchToHttp().getRequest<FastifyRequest>(),
          );

    if (!token) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    if (token !== this.apiKey) {
      throw new UnauthorizedException('Invalid API key');
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
}
