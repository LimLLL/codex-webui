import { ApiProperty } from '@nestjs/swagger';

/** Login request carrying the deployment API key. */
export class LoginRequestDto {
  @ApiProperty()
  apiKey!: string;
}

/** JWT login response returned after API key validation succeeds. */
export class LoginResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({ description: 'Token lifetime in seconds.' })
  expiresIn!: number;
}

/** Logout response body is intentionally empty; the client clears local state. */
export class LogoutResponseDto {}
