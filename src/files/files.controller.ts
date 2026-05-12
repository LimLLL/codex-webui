/**
 * REST controller for file management operations.
 * All paths are security-validated against workspace roots.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  ApiErrorResponseDto,
  OkResponseDto,
} from '../common/dto/api-responses.dto';
import { FilesService } from './files.service';
import {
  AddWorkspaceRootRequestDto,
  FileEntryDto,
  FileMetadataDto,
  FileReadResponseDto,
  WorkspaceRootsResponseDto,
  WriteFileRequestDto,
  WriteFileResponseDto,
} from './dto/files.dto';

@ApiTags('files')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@ApiForbiddenResponse({ type: ApiErrorResponseDto })
@ApiNotFoundResponse({ type: ApiErrorResponseDto })
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Get('tree')
  @ApiOperation({ summary: 'Read directory tree (one level, lazy load)' })
  @ApiQuery({ name: 'root', required: true, description: 'Directory path' })
  @ApiOkResponse({ type: [FileEntryDto] })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async readTree(@Query('root') root: string) {
    return this.filesService.readDirectory(root);
  }

  @Get('read')
  @ApiOperation({ summary: 'Read a text file' })
  @ApiQuery({ name: 'path', required: true, description: 'File path' })
  @ApiOkResponse({ type: FileReadResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async readFile(@Query('path') filePath: string) {
    return this.filesService.readFile(filePath);
  }

  @Post('write')
  @ApiOperation({ summary: 'Write/save a file' })
  @ApiBody({ type: WriteFileRequestDto })
  @ApiCreatedResponse({ type: WriteFileResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async writeFile(@Body() body: WriteFileRequestDto) {
    if (!body.path || typeof body.content !== 'string') {
      throw new BadRequestException('path and content are required');
    }
    return this.filesService.writeFile(
      body.path,
      body.content,
      body.expectedMtime,
    );
  }

  @Get('metadata')
  @ApiOperation({ summary: 'Get file/directory metadata' })
  @ApiQuery({ name: 'path', required: true, description: 'File path' })
  @ApiOkResponse({ type: FileMetadataDto })
  async getMetadata(@Query('path') filePath: string) {
    return this.filesService.getMetadata(filePath);
  }

  @Get('roots')
  @ApiOperation({
    summary: 'List configured workspace roots and home directory',
  })
  @ApiOkResponse({ type: WorkspaceRootsResponseDto })
  getRoots() {
    return {
      roots: this.filesService.getWorkspaceRoots(),
      homeDir: this.filesService.getHomeDir(),
    };
  }

  @Post('roots')
  @ApiOperation({ summary: 'Register a workspace root (e.g. thread cwd)' })
  @ApiBody({ type: AddWorkspaceRootRequestDto })
  @ApiCreatedResponse({ type: OkResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  addRoot(@Body() body: AddWorkspaceRootRequestDto) {
    if (!body.root) {
      throw new BadRequestException('root is required');
    }
    this.filesService.addWorkspaceRoot(body.root);
    return { ok: true };
  }

  @Delete('delete')
  @ApiOperation({ summary: 'Delete a file or empty directory' })
  @ApiQuery({ name: 'path', required: true })
  @ApiOkResponse({ type: OkResponseDto })
  async deletePath(@Query('path') filePath: string) {
    await this.filesService.deletePath(filePath);
    return { ok: true };
  }
}
