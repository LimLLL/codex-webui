/** REST controller for Codex plugin marketplace operations. */
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
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
  PluginInstallRequestDto,
  PluginInstallResponseDto,
  PluginListResponseDto,
  PluginReadResponseDto,
  PluginUninstallRequestDto,
  PluginUninstallResponseDto,
} from './dto/plugins.dto';
import { PluginsService } from './plugins.service';

@ApiTags('plugins')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@ApiBadRequestResponse({ type: ApiErrorResponseDto })
@Controller('plugins')
export class PluginsController {
  constructor(private readonly pluginsService: PluginsService) {}

  /** Lists plugin marketplaces and their plugins. */
  @Get()
  @ApiOperation({ summary: 'List Codex plugin marketplaces' })
  @ApiQuery({ name: 'cwds', required: false, isArray: true })
  @ApiOkResponse({ type: PluginListResponseDto })
  listPlugins(
    @Query('cwds') cwds?: string | string[],
  ): Promise<v2.PluginListResponse> {
    return this.pluginsService.listPlugins({
      cwds: this.parseStringList(cwds),
    });
  }

  /** Reads detailed plugin metadata from one marketplace. */
  @Get('detail')
  @ApiOperation({ summary: 'Read Codex plugin detail' })
  @ApiQuery({ name: 'marketplacePath', required: true })
  @ApiQuery({ name: 'pluginName', required: true })
  @ApiOkResponse({ type: PluginReadResponseDto })
  readPlugin(
    @Query('marketplacePath') marketplacePath?: string,
    @Query('pluginName') pluginName?: string,
  ): Promise<v2.PluginReadResponse> {
    return this.pluginsService.readPlugin({
      marketplacePath: this.requireTrimmedString(
        marketplacePath,
        'marketplacePath',
      ),
      pluginName: this.requireTrimmedString(pluginName, 'pluginName'),
    });
  }

  /** Installs a plugin from a marketplace. */
  @Post('install')
  @ApiOperation({ summary: 'Install Codex plugin' })
  @ApiBody({ type: PluginInstallRequestDto })
  @ApiOkResponse({ type: PluginInstallResponseDto })
  installPlugin(
    @Body() body: PluginInstallRequestDto | undefined,
  ): Promise<v2.PluginInstallResponse> {
    if (!body) {
      throw BusinessException.badRequest(
        ErrorCode.validation.bodyRequired,
        'Request body is required',
      );
    }
    return this.pluginsService.installPlugin({
      marketplacePath: this.requireTrimmedString(
        body.marketplacePath,
        'marketplacePath',
      ),
      pluginName: this.requireTrimmedString(body.pluginName, 'pluginName'),
    });
  }

  /** Uninstalls a user-installed plugin. */
  @Post('uninstall')
  @ApiOperation({ summary: 'Uninstall Codex plugin' })
  @ApiBody({ type: PluginUninstallRequestDto })
  @ApiOkResponse({ type: PluginUninstallResponseDto })
  uninstallPlugin(
    @Body() body: PluginUninstallRequestDto | undefined,
  ): Promise<v2.PluginUninstallResponse> {
    if (!body) {
      throw BusinessException.badRequest(
        ErrorCode.validation.bodyRequired,
        'Request body is required',
      );
    }
    return this.pluginsService.uninstallPlugin({
      pluginId: this.requireTrimmedString(body.pluginId, 'pluginId'),
    });
  }

  private requireTrimmedString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw BusinessException.badRequest(
        ErrorCode.plugins.fieldRequired,
        `${field} is required`,
        { field },
      );
    }
    return value.trim();
  }

  private parseStringList(value?: string | string[]): string[] | undefined {
    if (value === undefined) return undefined;
    const values = Array.isArray(value) ? value : value.split(',');
    const trimmed = values.map((item) => item.trim()).filter(Boolean);
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
