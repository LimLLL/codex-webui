/** Authenticated backend boundary for catalog drafts, activation and independent repair. */
import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CatalogActivityService } from './catalog-activity.service';
import { CatalogService } from './catalog.service';
import {
  ApplyCatalogDto,
  CatalogApplyResultDto,
  CatalogBlockersDto,
  CatalogContentDto,
  CatalogDocumentDto,
  CatalogStateDto,
  ChangeCatalogSourceDto,
  SaveCatalogDraftDto,
  SeedCatalogDto,
} from './catalog.dto';

@ApiTags('codex')
@ApiBearerAuth()
@Controller('codex/catalog')
export class CatalogController {
  constructor(
    private readonly catalogs: CatalogService,
    private readonly activity: CatalogActivityService,
  ) {}
  /** Reads lifecycle, pointer and recovery status, including startup failures. */
  @Get()
  @ApiOkResponse({ type: CatalogStateDto })
  state(): CatalogStateDto {
    return this.catalogs.state();
  }
  /** Reads the complete saved draft without contacting the child. */
  @Get('draft')
  @ApiOkResponse({ type: CatalogDocumentDto })
  readDraft(): CatalogDocumentDto {
    return this.catalogs.readDraft();
  }
  /** Resolves and exports the current configured full catalog. */
  @Get('effective')
  @ApiOkResponse({ type: CatalogDocumentDto })
  readEffective(): Promise<CatalogDocumentDto> {
    return this.catalogs.readEffective();
  }
  /** Validates JSON with the pinned native parser without publishing it. */
  @Post('validate')
  @HttpCode(200)
  @ApiOkResponse({ type: CatalogDocumentDto })
  validate(@Body() body: CatalogContentDto): Promise<CatalogDocumentDto> {
    return this.catalogs.validate(body?.content);
  }
  /** Validates and saves only an unreferenced draft with an expected-content precondition. */
  @Put('draft')
  @ApiOkResponse({ type: CatalogDocumentDto })
  saveDraft(@Body() body: SaveCatalogDraftDto): Promise<CatalogDocumentDto> {
    return this.catalogs.saveDraft(body?.content, body?.expectedDraft);
  }
  /** Seeds every entry from the bundled or currently resolved full catalog. */
  @Post('seed')
  @HttpCode(200)
  @ApiOkResponse({ type: CatalogDocumentDto })
  seed(@Body() body: SeedCatalogDto): Promise<CatalogDocumentDto> {
    return this.catalogs.seed(body?.source, body?.expectedDraft);
  }
  /** Lists upstream activity and local operations that prevent safe application. */
  @Get('blockers')
  @ApiOkResponse({ type: CatalogBlockersDto })
  blockers(): Promise<CatalogBlockersDto> {
    return this.activity.inspect();
  }
  /** Applies the exact approved draft and restarts only after establishing idle. */
  @Post('apply')
  @HttpCode(200)
  @ApiOkResponse({ type: CatalogApplyResultDto })
  apply(@Body() body: ApplyCatalogDto): Promise<CatalogApplyResultDto> {
    return this.catalogs.apply(body?.expectedDraft, body?.expectedPointer);
  }
  /** Explicitly removes the managed user override and restarts. */
  @Post('default')
  @HttpCode(200)
  @ApiOkResponse({ type: CatalogApplyResultDto })
  useDefault(
    @Body() body: ChangeCatalogSourceDto,
  ): Promise<CatalogApplyResultDto> {
    return this.catalogs.useDefault(body?.expectedPointer);
  }
  /** Restores the previous activation, including while the child cannot initialize. */
  @Post('restore')
  @HttpCode(200)
  @ApiOkResponse({ type: CatalogApplyResultDto })
  restore(
    @Body() body: ChangeCatalogSourceDto,
  ): Promise<CatalogApplyResultDto> {
    return this.catalogs.restore(body?.expectedPointer);
  }
  /** Restarts after raw-file repair, refusing active work if the child is running. */
  @Post('restart')
  @HttpCode(200)
  @ApiOkResponse({ type: CatalogStateDto })
  restart(): Promise<CatalogStateDto> {
    return this.catalogs.restartAfterRepair();
  }
}
