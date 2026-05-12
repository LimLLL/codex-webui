/**
 * Central authentication service for WebUI API key fallback and JWT sessions.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, timingSafeEqual } from 'node:crypto';

const JWT_SUBJECT = 'webui';
const JWT_TTL_SECONDS = 24 * 60 * 60;
const JWT_SECRET_CONTEXT = 'codex-webui-jwt';

export type AuthType = 'jwt' | 'apiKey';

export interface AuthResult {
  ok: boolean;
  authType?: AuthType;
  reason?: string;
}

interface WebUiJwtPayload {
  sub: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly apiKey: string;
  private readonly jwtSecret: string;

  constructor(
    configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    this.apiKey = configService.getOrThrow<string>('WEBUI_API_KEY');
    this.jwtSecret = this.deriveJwtSecret(this.apiKey);
  }

  /** Validates a raw API key using a timing-safe comparison. */
  validateApiKey(candidate: unknown): boolean {
    if (typeof candidate !== 'string' || !candidate) return false;
    return this.timingSafeCompare(candidate, this.apiKey);
  }

  /** Signs a short-lived JWT for the single-user WebUI session. */
  async signJwt(): Promise<{ accessToken: string; expiresIn: number }> {
    const accessToken = await this.jwtService.signAsync(
      { sub: JWT_SUBJECT },
      {
        secret: this.jwtSecret,
        algorithm: 'HS256',
        expiresIn: JWT_TTL_SECONDS,
      },
    );

    return { accessToken, expiresIn: JWT_TTL_SECONDS };
  }

  /** Verifies a JWT and ensures it was issued for this WebUI deployment. */
  async verifyJwt(token: string): Promise<boolean> {
    try {
      const payload = await this.jwtService.verifyAsync<WebUiJwtPayload>(
        token,
        {
          secret: this.jwtSecret,
          algorithms: ['HS256'],
        },
      );
      return payload.sub === JWT_SUBJECT;
    } catch {
      return false;
    }
  }

  /**
   * Authenticates a bearer token. JWT is preferred; raw API key remains as a
   * machine-to-machine fallback for health checks and local tooling.
   */
  async authenticateToken(
    token: string | null | undefined,
    requestId?: string,
  ): Promise<AuthResult> {
    if (!token) return { ok: false, reason: 'missingToken' };

    if (await this.verifyJwt(token)) {
      return { ok: true, authType: 'jwt' };
    }

    if (this.looksLikeJwt(token)) {
      this.logger.warn({ authType: 'jwt', reason: 'verifyFailed', requestId });
    }

    if (this.validateApiKey(token)) {
      this.logger.log({
        authType: 'apiKey',
        reason: 'fallbackAccepted',
        requestId,
      });
      return { ok: true, authType: 'apiKey' };
    }

    return { ok: false, reason: 'invalidToken' };
  }

  /** Emits a sanitized authentication event for audit trails. */
  logAuthEvent(
    level: 'log' | 'warn',
    fields: {
      authType: AuthType | 'apiKeyLogin';
      reason: string;
      requestId?: string;
    },
  ): void {
    this.logger[level](fields);
  }

  private deriveJwtSecret(apiKey: string): string {
    return createHmac('sha256', apiKey)
      .update(JWT_SECRET_CONTEXT)
      .digest('hex');
  }

  private timingSafeCompare(candidate: string, expected: string): boolean {
    const candidateBuffer = Buffer.from(candidate);
    const expectedBuffer = Buffer.from(expected);
    if (candidateBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(candidateBuffer, expectedBuffer);
  }

  private looksLikeJwt(token: string): boolean {
    return token.split('.').length === 3;
  }
}
