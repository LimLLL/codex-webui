/** OpenAPI support models for structured v2 ThreadItem payloads. */
import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import {
  type SwaggerSchema,
  IMAGE_DETAIL_VALUES,
  NULLABLE_NUMBER_SCHEMA,
  oneOfSchema,
} from './openapi.schema';

/** Function-call output branch containing plain text. */
export class FunctionCallOutputInputTextDto {
  @ApiProperty({ enum: ['input_text'] })
  type!: 'input_text';

  @ApiProperty()
  text!: string;
}

/** Function-call output branch containing an image reference. */
export class FunctionCallOutputInputImageDto {
  @ApiProperty({ enum: ['input_image'] })
  type!: 'input_image';

  @ApiProperty()
  image_url!: string;

  @ApiProperty({ enum: IMAGE_DETAIL_VALUES, required: false })
  detail?: (typeof IMAGE_DETAIL_VALUES)[number];
}

/** Function-call output branch containing an audio reference. */
export class FunctionCallOutputInputAudioDto {
  @ApiProperty({ enum: ['input_audio'] })
  type!: 'input_audio';

  @ApiProperty()
  audio_url!: string;
}

/** Function-call output branch containing opaque encrypted content. */
export class FunctionCallOutputEncryptedContentDto {
  @ApiProperty({ enum: ['encrypted_content'] })
  type!: 'encrypted_content';

  @ApiProperty()
  encrypted_content!: string;
}

/** Dynamic-tool output item branch for text. */
export class DynamicToolCallOutputInputTextDto {
  @ApiProperty({ enum: ['inputText'] })
  type!: 'inputText';

  @ApiProperty()
  text!: string;
}

/** Dynamic-tool output item branch for images. */
export class DynamicToolCallOutputInputImageDto {
  @ApiProperty({ enum: ['inputImage'] })
  type!: 'inputImage';

  @ApiProperty()
  imageUrl!: string;
}

/** Dynamic-tool output item branch for audio. */
export class DynamicToolCallOutputInputAudioDto {
  @ApiProperty({ enum: ['inputAudio'] })
  type!: 'inputAudio';

  @ApiProperty()
  audioUrl!: string;
}

/** Image-generation failure branch for exhausted usage limits. */
export class ImageGenerationUsageLimitExceededFailureDto {
  @ApiProperty({ enum: ['usageLimitExceeded'] })
  type!: 'usageLimitExceeded';

  @ApiProperty()
  limitId!: string;

  @ApiProperty(NULLABLE_NUMBER_SCHEMA)
  resetsAt!: number | null;
}

/** OpenAPI schema for standalone function-call output bodies. */
export function functionCallOutputBodySchema(): SwaggerSchema {
  return oneOfSchema([
    { type: 'string' },
    {
      type: 'array',
      items: oneOfSchema([
        { $ref: getSchemaPath(FunctionCallOutputInputTextDto) },
        { $ref: getSchemaPath(FunctionCallOutputInputImageDto) },
        { $ref: getSchemaPath(FunctionCallOutputInputAudioDto) },
        { $ref: getSchemaPath(FunctionCallOutputEncryptedContentDto) },
      ]),
    },
  ]);
}

/** OpenAPI schema for dynamic-tool output content items. */
export function dynamicToolCallOutputContentItemSchema(
  nullable = false,
): SwaggerSchema {
  return oneOfSchema(
    [
      { $ref: getSchemaPath(DynamicToolCallOutputInputTextDto) },
      { $ref: getSchemaPath(DynamicToolCallOutputInputImageDto) },
      { $ref: getSchemaPath(DynamicToolCallOutputInputAudioDto) },
    ],
    nullable,
  );
}

/** Extra models referenced by structured ThreadItem oneOf schemas. */
export const THREAD_ITEM_SUPPORT_DTOS = [
  FunctionCallOutputInputTextDto,
  FunctionCallOutputInputImageDto,
  FunctionCallOutputInputAudioDto,
  FunctionCallOutputEncryptedContentDto,
  DynamicToolCallOutputInputTextDto,
  DynamicToolCallOutputInputImageDto,
  DynamicToolCallOutputInputAudioDto,
  ImageGenerationUsageLimitExceededFailureDto,
] as const;
