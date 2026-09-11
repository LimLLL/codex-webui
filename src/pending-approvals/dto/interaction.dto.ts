/** Safe, backend-validated presentation of permissions and MCP elicitations. */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One requested access scope; required restrictions cannot be deselected. */
export class PermissionOptionDto {
  @ApiProperty() id!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ['read', 'write', 'deny', 'network'] })
  access!: 'read' | 'write' | 'deny' | 'network';
  @ApiProperty() required!: boolean;
}

/** A finite choice advertised by the MCP schema. */
export class ElicitationOptionDto {
  @ApiProperty() value!: string;
  @ApiProperty() label!: string;
}

/** Fully understood primitive form field; unsupported schemas expose no fields. */
export class ElicitationFieldDto {
  @ApiProperty() name!: string;
  @ApiProperty() title!: string;
  @ApiProperty() description!: string;
  @ApiProperty({
    enum: ['string', 'number', 'integer', 'boolean', 'enum', 'array'],
  })
  type!: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array';
  @ApiProperty() required!: boolean;
  @ApiPropertyOptional({ type: () => [ElicitationOptionDto] })
  options?: ElicitationOptionDto[];
  @ApiPropertyOptional() minimum?: number;
  @ApiPropertyOptional() maximum?: number;
  @ApiPropertyOptional() minLength?: number;
  @ApiPropertyOptional() maxLength?: number;
  @ApiPropertyOptional() minItems?: number;
  @ApiPropertyOptional() maxItems?: number;
  @ApiPropertyOptional() format?: string;
}

/**
 * Presentation chosen at admission and reconstructed from immutable parameters.
 * Browser responses select the listed permission IDs or supply the listed form
 * fields; the backend validates and encodes the actual app-server response.
 */
export class InteractionPresentationDto {
  @ApiProperty({ enum: ['permissions', 'elicitation'] }) kind!:
    | 'permissions'
    | 'elicitation';
  @ApiProperty() supported!: boolean;
  @ApiProperty({ type: String, nullable: true }) unsupportedReason!:
    | string
    | null;
  @ApiProperty() message!: string;
  @ApiProperty({ type: String, nullable: true }) serverName!: string | null;
  @ApiProperty({ type: String, nullable: true }) cwd!: string | null;
  @ApiProperty({ type: String, nullable: true }) environmentId!: string | null;
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
  @ApiProperty({ type: () => [PermissionOptionDto] })
  permissions!: PermissionOptionDto[];
  @ApiProperty({ type: () => [ElicitationFieldDto] })
  fields!: ElicitationFieldDto[];
}

/** A recorded client failure, distinct from a user decision or turn outcome. */
export class ServerRequestFailureDto {
  @ApiProperty() instanceId!: string;
  @ApiProperty({ type: String, nullable: true }) threadId!: string | null;
  @ApiProperty({ type: String, nullable: true }) turnId!: string | null;
  @ApiProperty() message!: string;
}
