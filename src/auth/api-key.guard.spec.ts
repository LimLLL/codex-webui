/** Unit tests for ApiKeyGuard query-token whitelist and bearer extraction. */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException } from '../common/business.exception';
import { ApiKeyGuard } from './api-key.guard';
import { AuthService } from './auth.service';

function mockRequest(
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  return { url, method, headers, query } as unknown;
}

function mockContext(request: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let authService: Partial<AuthService>;

  beforeEach(() => {
    authService = {
      authenticateToken: vi.fn().mockResolvedValue({ ok: true }),
      verifyJwt: vi.fn().mockResolvedValue(true),
    };
    const reflector = {
      getAllAndOverride: () => false,
    } as unknown as Reflector;
    guard = new ApiKeyGuard(authService as AuthService, reflector);
  });

  describe('query access_token whitelist', () => {
    const validJwt = 'header.payload.signature';

    it('accepts access_token on /api/files/serve', async () => {
      const req = mockRequest(
        '/api/files/serve?path=test.png&access_token=' + validJwt,
        'GET',
        {},
        { access_token: validJwt, path: 'test.png' },
      );
      await expect(guard.canActivate(mockContext(req))).resolves.toBe(true);
      expect(authService.verifyJwt).toHaveBeenCalledWith(validJwt);
    });

    it('accepts access_token on /api/files/archive/entry', async () => {
      const req = mockRequest(
        '/api/files/archive/entry?path=a.zip&entry=f.txt&access_token=' +
          validJwt,
        'GET',
        {},
        { access_token: validJwt, path: 'a.zip', entry: 'f.txt' },
      );
      await expect(guard.canActivate(mockContext(req))).resolves.toBe(true);
      expect(authService.verifyJwt).toHaveBeenCalledWith(validJwt);
    });

    it('rejects access_token on non-whitelisted endpoints', async () => {
      const req = mockRequest(
        '/api/threads?access_token=' + validJwt,
        'GET',
        {},
        { access_token: validJwt },
      );
      await expect(guard.canActivate(mockContext(req))).rejects.toThrow(
        BusinessException,
      );
    });

    it('rejects access_token on POST requests', async () => {
      const req = mockRequest(
        '/api/files/serve?access_token=' + validJwt,
        'POST',
        {},
        { access_token: validJwt },
      );
      await expect(guard.canActivate(mockContext(req))).rejects.toThrow(
        BusinessException,
      );
    });

    it('rejects non-JWT query tokens', async () => {
      const rawKey = 'not-a-jwt';
      const req = mockRequest(
        '/api/files/serve?access_token=' + rawKey,
        'GET',
        {},
        { access_token: rawKey },
      );
      await expect(guard.canActivate(mockContext(req))).rejects.toThrow(
        BusinessException,
      );
    });
  });

  describe('bearer header', () => {
    it('authenticates valid bearer token', async () => {
      const req = mockRequest('/api/threads', 'GET', {
        authorization: 'Bearer valid-token',
      });
      await expect(guard.canActivate(mockContext(req))).resolves.toBe(true);
      expect(authService.authenticateToken).toHaveBeenCalledWith(
        'valid-token',
        undefined,
      );
    });

    it('rejects missing authorization', async () => {
      const req = mockRequest('/api/threads', 'GET');
      await expect(guard.canActivate(mockContext(req))).rejects.toThrow(
        BusinessException,
      );
    });
  });
});
