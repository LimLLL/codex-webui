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
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { FilesService } from './files.service';

@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Get('tree')
  @ApiOperation({ summary: 'Read directory tree (one level, lazy load)' })
  @ApiQuery({ name: 'root', required: true, description: 'Directory path' })
  async readTree(@Query('root') root: string) {
    return this.filesService.readDirectory(root);
  }

  @Get('read')
  @ApiOperation({ summary: 'Read a text file' })
  @ApiQuery({ name: 'path', required: true, description: 'File path' })
  async readFile(@Query('path') filePath: string) {
    return this.filesService.readFile(filePath);
  }

  @Post('write')
  @ApiOperation({ summary: 'Write/save a file' })
  async writeFile(
    @Body()
    body: {
      path: string;
      content: string;
      expectedMtime?: number;
    },
  ) {
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
  async getMetadata(@Query('path') filePath: string) {
    return this.filesService.getMetadata(filePath);
  }

  @Get('roots')
  @ApiOperation({
    summary: 'List configured workspace roots and home directory',
  })
  getRoots() {
    return {
      roots: this.filesService.getWorkspaceRoots(),
      homeDir: this.filesService.getHomeDir(),
    };
  }

  @Post('roots')
  @ApiOperation({ summary: 'Register a workspace root (e.g. thread cwd)' })
  addRoot(@Body() body: { root: string }) {
    if (!body.root) {
      throw new BadRequestException('root is required');
    }
    this.filesService.addWorkspaceRoot(body.root);
    return { ok: true };
  }

  @Delete('delete')
  @ApiOperation({ summary: 'Delete a file or empty directory' })
  @ApiQuery({ name: 'path', required: true })
  async deletePath(@Query('path') filePath: string) {
    await this.filesService.deletePath(filePath);
    return { ok: true };
  }
}
