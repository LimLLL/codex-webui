/** REST controller for JWT login/logout flows. */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { AuthService } from './auth.service';
import { LoginRequestDto, LoginResponseDto } from './dto/auth.dto';
import { Public } from './public.decorator';

function getRequestId(request: FastifyRequest): string | undefined {
  const id = (request as unknown as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Exchanges the deployment API key for a short-lived JWT. */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with the WebUI API key' })
  @ApiBody({ type: LoginRequestDto })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  async login(
    @Body() body: LoginRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<LoginResponseDto> {
    const requestId = getRequestId(request);
    if (!this.authService.validateApiKey(body.apiKey)) {
      this.authService.logAuthEvent('warn', {
        authType: 'apiKeyLogin',
        reason: 'invalidApiKey',
        requestId,
      });
      throw new UnauthorizedException('Invalid API key');
    }

    this.authService.logAuthEvent('log', {
      authType: 'apiKeyLogin',
      reason: 'loginSuccess',
      requestId,
    });
    return this.authService.signJwt();
  }

  /** Stateless logout; the browser clears the stored JWT. */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout the current WebUI session' })
  @ApiNoContentResponse()
  logout(): void {}
}
