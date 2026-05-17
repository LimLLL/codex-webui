/** REST controller for Codex skills inventory. */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { v2 } from '../codex/codex-schema';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import {
  SkillsConfigWriteRequestDto,
  SkillsConfigWriteResponseDto,
  SkillsListResponseDto,
} from './dto/skills.dto';
import { SkillsService } from './skills.service';

@ApiTags('skills')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@ApiBadRequestResponse({ type: ApiErrorResponseDto })
@Controller('skills')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  /** Proxies skills/list for the requested cwd and returns the raw Codex response. */
  @Get()
  @ApiOperation({ summary: 'List Codex skills for a working directory' })
  @ApiQuery({ name: 'cwd', required: true })
  @ApiOkResponse({ type: SkillsListResponseDto })
  listSkills(@Query('cwd') cwd?: string): Promise<v2.SkillsListResponse> {
    const normalizedCwd = cwd?.trim();
    if (!normalizedCwd) {
      throw new BadRequestException('cwd is required');
    }
    return this.skillsService.listSkills({ cwds: [normalizedCwd] });
  }

  /** Toggles skill enablement by path, falling back to name when path is absent. */
  @Post('config')
  @ApiOperation({ summary: 'Update Codex skill enablement config' })
  @ApiBody({ type: SkillsConfigWriteRequestDto })
  @ApiOkResponse({ type: SkillsConfigWriteResponseDto })
  writeSkillConfig(
    @Body() body: SkillsConfigWriteRequestDto | undefined,
  ): Promise<v2.SkillsConfigWriteResponse> {
    return this.skillsService.writeSkillConfig(this.parseConfigWriteBody(body));
  }

  private parseConfigWriteBody(
    body: SkillsConfigWriteRequestDto | undefined,
  ): v2.SkillsConfigWriteParams {
    if (!body) throw new BadRequestException('Request body is required');
    if (typeof body.enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean');
    }

    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (path) return { path, enabled: body.enabled };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name) return { name, enabled: body.enabled };

    throw new BadRequestException('path or name is required');
  }
}
