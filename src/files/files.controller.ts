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
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import {
  ApiErrorResponseDto,
  OkResponseDto,
} from '../common/dto/api-responses.dto';
import { FilesService, type FileUploadInput } from './files.service';
import {
  AddWorkspaceRootRequestDto,
  CopyPathRequestDto,
  CopyPathResponseDto,
  CreateDirectoryRequestDto,
  CreateDirectoryResponseDto,
  CreateFileRequestDto,
  CreateFileResponseDto,
  FileEntryDto,
  FileMetadataDto,
  FileReadResponseDto,
  MovePathRequestDto,
  MovePathResponseDto,
  RenamePathRequestDto,
  RenamePathResponseDto,
  UploadFilesResponseDto,
  WorkspaceRootsResponseDto,
  WriteFileRequestDto,
  WriteFileResponseDto,
} from './dto/files.dto';

interface MultipartFilePart {
  filename: string;
  file: Readable;
}

interface MultipartFilesRequest extends FastifyRequest {
  files: () => AsyncIterableIterator<MultipartFilePart>;
}

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

  @Post('create-file')
  @ApiOperation({ summary: 'Create a new file' })
  @ApiBody({ type: CreateFileRequestDto })
  @ApiCreatedResponse({ type: CreateFileResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async createFile(@Body() body: CreateFileRequestDto) {
    if (!body.path) {
      throw new BadRequestException('path is required');
    }
    return {
      ok: true,
      ...(await this.filesService.createFile(
        body.path,
        body.content ?? '',
        body.overwrite ?? false,
      )),
    };
  }

  @Post('create-directory')
  @ApiOperation({ summary: 'Create a new directory' })
  @ApiBody({ type: CreateDirectoryRequestDto })
  @ApiCreatedResponse({ type: CreateDirectoryResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async createDirectory(@Body() body: CreateDirectoryRequestDto) {
    if (!body.path) {
      throw new BadRequestException('path is required');
    }
    return {
      ok: true,
      ...(await this.filesService.createDirectory(
        body.path,
        body.recursive ?? false,
        body.overwrite ?? false,
      )),
    };
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

  @Post('rename')
  @ApiOperation({
    summary: 'Rename a file or directory within the same parent',
  })
  @ApiBody({ type: RenamePathRequestDto })
  @ApiCreatedResponse({ type: RenamePathResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async renamePath(@Body() body: RenamePathRequestDto) {
    if (!body.path || !body.newName) {
      throw new BadRequestException('path and newName are required');
    }
    return {
      ok: true,
      ...(await this.filesService.renamePath(
        body.path,
        body.newName,
        body.overwrite ?? false,
      )),
    };
  }

  @Post('copy')
  @ApiOperation({ summary: 'Copy a file or directory' })
  @ApiBody({ type: CopyPathRequestDto })
  @ApiCreatedResponse({ type: CopyPathResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async copyPath(@Body() body: CopyPathRequestDto) {
    if (!body.sourcePath || !body.destinationPath) {
      throw new BadRequestException(
        'sourcePath and destinationPath are required',
      );
    }
    return {
      ok: true,
      ...(await this.filesService.copyPath(
        body.sourcePath,
        body.destinationPath,
        body.overwrite ?? false,
      )),
    };
  }

  @Post('move')
  @ApiOperation({ summary: 'Move a file or directory' })
  @ApiBody({ type: MovePathRequestDto })
  @ApiCreatedResponse({ type: MovePathResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async movePath(@Body() body: MovePathRequestDto) {
    if (!body.sourcePath || !body.destinationPath) {
      throw new BadRequestException(
        'sourcePath and destinationPath are required',
      );
    }
    return {
      ok: true,
      ...(await this.filesService.movePath(
        body.sourcePath,
        body.destinationPath,
        body.overwrite ?? false,
      )),
    };
  }

  @Get('metadata')
  @ApiOperation({ summary: 'Get file/directory metadata' })
  @ApiQuery({ name: 'path', required: true, description: 'File path' })
  @ApiOkResponse({ type: FileMetadataDto })
  async getMetadata(@Query('path') filePath: string) {
    return this.filesService.getMetadata(filePath);
  }

  @Get('serve')
  @ApiOperation({
    summary: 'Serve a file inline with correct Content-Type (for img/pdf/etc.)',
  })
  @ApiQuery({ name: 'path', required: true, description: 'File path' })
  @ApiQuery({
    name: 'access_token',
    required: false,
    type: String,
    description: 'JWT token (RFC 6750 §2.3 fallback for <img>/<video> tags)',
  })
  @ApiProduces('application/octet-stream')
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async serveFile(@Query('path') filePath: string, @Res() reply: FastifyReply) {
    const download = await this.filesService.prepareDownload(filePath);
    const mimeType = guessMimeType(download.filename);
    reply.header('Content-Type', mimeType);
    reply.header('Content-Length', download.size);
    reply.header(
      'Content-Disposition',
      this.buildInlineDisposition(download.filename),
    );
    // Security: prevent MIME sniffing, XSS via SVG/HTML, token leakage via Referrer
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'unsafe-inline'",
    );
    // no-store: URL may carry access_token query param (RFC 6750 §2.3 cache caveat)
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(download.stream);
  }

  @Get('download')
  @ApiOperation({ summary: 'Download a file' })
  @ApiQuery({ name: 'path', required: true, description: 'File path' })
  @ApiProduces('application/octet-stream')
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async downloadFile(
    @Query('path') filePath: string,
    @Res() reply: FastifyReply,
  ) {
    const download = await this.filesService.prepareDownload(filePath);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', download.size);
    reply.header(
      'Content-Disposition',
      this.buildContentDisposition(download.filename),
    );
    return reply.send(download.stream);
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
  @ApiOperation({ summary: 'Delete a file, symlink, or directory' })
  @ApiQuery({ name: 'path', required: true })
  @ApiQuery({ name: 'recursive', required: false, type: Boolean })
  @ApiOkResponse({ type: OkResponseDto })
  async deletePath(
    @Query('path') filePath: string,
    @Query('recursive') recursive?: string,
  ) {
    await this.filesService.deletePath(
      filePath,
      this.parseBooleanQuery(recursive),
    );
    return { ok: true };
  }

  @Post('upload')
  @ApiOperation({ summary: 'Upload one or more files into a directory' })
  @ApiConsumes('multipart/form-data')
  @ApiQuery({ name: 'destinationPath', required: true })
  @ApiQuery({ name: 'overwrite', required: false, type: Boolean })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ApiCreatedResponse({ type: UploadFilesResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async uploadFiles(
    @Query('destinationPath') destinationPath: string,
    @Query('overwrite') overwrite: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    if (!destinationPath) {
      throw new BadRequestException('destinationPath is required');
    }
    const multipartRequest = request as MultipartFilesRequest;
    if (typeof multipartRequest.files !== 'function') {
      throw new BadRequestException('multipart file upload is not available');
    }

    return {
      ok: true,
      ...(await this.filesService.saveUploadedFiles(
        destinationPath,
        this.toUploadInputs(multipartRequest.files()),
        this.parseBooleanQuery(overwrite),
      )),
    };
  }

  /** Converts multipart file parts into service upload descriptors. */
  private async *toUploadInputs(
    files: AsyncIterable<MultipartFilePart>,
  ): AsyncIterable<FileUploadInput> {
    for await (const file of files) {
      yield {
        filename: file.filename,
        relativePath: file.filename,
        stream: file.file,
      };
    }
  }

  /** Parses optional boolean query flags used by destructive file operations. */
  private parseBooleanQuery(value: string | undefined): boolean {
    return value === 'true' || value === '1';
  }

  /** Builds a safe Content-Disposition attachment header value. */
  private buildContentDisposition(filename: string): string {
    const fallback = filename.replace(/[\r\n"\\]/g, '_');
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  /** Builds a Content-Disposition inline header for browser rendering. */
  private buildInlineDisposition(filename: string): string {
    const fallback = filename.replace(/[\r\n"\\]/g, '_');
    return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
}

/** Maps file extension to MIME type for inline serving. */
function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const MIME_MAP: Record<string, string> = {
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    avif: 'image/avif',
    // Documents
    pdf: 'application/pdf',
    // Text / code
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    mjs: 'text/javascript',
    json: 'application/json',
    xml: 'application/xml',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    // Media
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    // Archives
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    // Fonts
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
  };
  return MIME_MAP[ext] ?? 'application/octet-stream';
}
