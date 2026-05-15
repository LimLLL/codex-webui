/** REST API for runtime-configurable application settings. */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import {
  BatchUpdateSettingsDto,
  SettingDto,
  SettingsListResponseDto,
  UpdateSettingDto,
} from './dto/settings.dto';
import { SettingsService, type ResolvedSetting } from './settings.service';

@ApiTags('settings')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@ApiBadRequestResponse({ type: ApiErrorResponseDto })
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  /** Lists runtime settings with optional category filtering. */
  @Get()
  @ApiOperation({ summary: 'List runtime settings' })
  @ApiQuery({ name: 'category', required: false })
  @ApiOkResponse({ type: SettingsListResponseDto })
  listSettings(@Query('category') category?: string): SettingsListResponseDto {
    return { settings: this.settingsService.listSettings(category) };
  }

  /** Reads a single runtime setting by key. */
  @Get(':key')
  @ApiOperation({ summary: 'Read one runtime setting' })
  @ApiParam({ name: 'key' })
  @ApiOkResponse({ type: SettingDto })
  getSetting(@Param('key') key: string): ResolvedSetting {
    return this.settingsService.getSetting(key);
  }

  /** Atomically updates multiple settings after validating every value. */
  @Patch()
  @ApiOperation({ summary: 'Batch update runtime settings' })
  @ApiOkResponse({ type: SettingsListResponseDto })
  updateSettings(
    @Body() body: BatchUpdateSettingsDto,
  ): SettingsListResponseDto {
    if (!Array.isArray(body?.updates)) {
      throw new BadRequestException('updates must be an array');
    }
    return { settings: this.settingsService.updateSettings(body.updates) };
  }

  /** Updates one setting; value=null clears the DB override. */
  @Patch(':key')
  @ApiOperation({ summary: 'Update one runtime setting' })
  @ApiParam({ name: 'key' })
  @ApiOkResponse({ type: SettingDto })
  updateSetting(
    @Param('key') key: string,
    @Body() body: UpdateSettingDto,
  ): ResolvedSetting {
    if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'value')) {
      throw new BadRequestException('value is required');
    }
    return this.settingsService.updateSetting(key, body.value);
  }

  /** Clears the DB override so the setting falls back to env/default. */
  @Delete(':key')
  @ApiOperation({ summary: 'Reset one runtime setting to env/default' })
  @ApiParam({ name: 'key' })
  @ApiOkResponse({ type: SettingDto })
  resetSetting(@Param('key') key: string): ResolvedSetting {
    return this.settingsService.resetSetting(key);
  }
}
