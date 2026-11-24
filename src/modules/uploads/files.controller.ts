import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import * as fs from 'fs';
import { CdnService } from './cdn.service';
import { UploadsService } from './uploads.service';

/**
 * Serves stored uploads (issue #282).
 *
 * Public files are streamed directly. Files under private folders (kyc/,
 * certificates/, and lesson media under courses/<id>/lessons/ — issue #335)
 * require a valid, unexpired `expires` + `signature` pair as issued by
 * CdnService for private assets.
 *
 * Registered after UploadsController so its specific GET routes
 * (video-jobs/:jobId, scans/:fileId) take precedence over this wildcard.
 */
@ApiTags('uploads')
@Controller('uploads')
export class FilesController {
  constructor(
    private readonly uploadsService: UploadsService,
    private readonly cdnService: CdnService,
  ) {}

  @Get('*')
  @ApiOperation({
    summary: 'Download a stored upload (private files require a signed URL)',
  })
  serveFile(
    @Param('0') filePath: string,
    @Query('expires') expires: string | undefined,
    @Query('signature') signature: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    if (!filePath) throw new NotFoundException('File not found');

    const { originPath, isPrivate } = this.uploadsService.describeStoragePath(
      `/uploads/${filePath}`,
    );

    // Check the signature before touching the disk so private file
    // existence is never revealed to unsigned requests.
    if (isPrivate) {
      const validation = this.cdnService.verifySignature(originPath, expires, signature);
      if (!validation.valid) {
        throw new ForbiddenException(validation.reason ?? 'A valid signed URL is required');
      }
    }

    const file = this.uploadsService.getStoredFileInfo(originPath);
    if (!file) throw new NotFoundException('File not found');

    const safeFilename = file.filename.replace(/["\\\r\n]/g, '_');

    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': file.isPrivate ? 'private, no-store' : 'public, max-age=86400',
      // Let the frontend (a different origin) embed media; access to private
      // files is already gated by the signature above.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });

    return new StreamableFile(fs.createReadStream(file.absolutePath), {
      type: file.contentType,
      disposition: `${file.inline ? 'inline' : 'attachment'}; filename="${safeFilename}"`,
      length: file.size,
    });
  }
}
