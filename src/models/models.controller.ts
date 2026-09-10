/**
 * REST controller for model listing.
 */
import { Controller, Get, ParseBoolPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { ModelsService } from './models.service';
import { CODEX_V2_EXTRA_MODELS, ModelListResponseDto } from './dto/models.dto';

@ApiTags('models')
@ApiBearerAuth()
@ApiExtraModels(...CODEX_V2_EXTRA_MODELS, ApiErrorResponseDto)
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@Controller('models')
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  @Get()
  @ApiOperation({ summary: 'List available models' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'includeHidden', required: false, type: Boolean })
  @ApiOkResponse({ type: ModelListResponseDto })
  async listModels(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('includeHidden', new ParseBoolPipe({ optional: true }))
    includeHidden?: boolean,
  ) {
    return this.modelsService.listModels({
      cursor,
      limit: limit ? Number(limit) : undefined,
      includeHidden,
    });
  }
}
