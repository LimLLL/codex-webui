/** REST controller for Codex plugin marketplace operations. */
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
  @ApiQuery({ name: 'forceRemoteSync', required: false, type: Boolean })
  @ApiOkResponse({ type: PluginListResponseDto })
  listPlugins(
    @Query('cwds') cwds?: string | string[],
    @Query('forceRemoteSync') forceRemoteSync?: string,
  ): Promise<v2.PluginListResponse> {
    return this.pluginsService.listPlugins({
      cwds: this.parseStringList(cwds),
      forceRemoteSync: this.parseOptionalBoolean(
        forceRemoteSync,
        'forceRemoteSync',
      ),
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
    if (!body) throw new BadRequestException('Request body is required');
    return this.pluginsService.installPlugin({
      marketplacePath: this.requireTrimmedString(
        body.marketplacePath,
        'marketplacePath',
      ),
      pluginName: this.requireTrimmedString(body.pluginName, 'pluginName'),
      forceRemoteSync: this.parseOptionalBoolean(
        body.forceRemoteSync,
        'forceRemoteSync',
      ),
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
    if (!body) throw new BadRequestException('Request body is required');
    return this.pluginsService.uninstallPlugin({
      pluginId: this.requireTrimmedString(body.pluginId, 'pluginId'),
      forceRemoteSync: this.parseOptionalBoolean(
        body.forceRemoteSync,
        'forceRemoteSync',
      ),
    });
  }

  private requireTrimmedString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }
    return value.trim();
  }

  private parseOptionalBoolean(
    value: boolean | string | undefined,
    field: string,
  ): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new BadRequestException(`${field} must be a boolean`);
  }

  private parseStringList(value?: string | string[]): string[] | undefined {
    if (value === undefined) return undefined;
    const values = Array.isArray(value) ? value : value.split(',');
    const trimmed = values.map((item) => item.trim()).filter(Boolean);
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
