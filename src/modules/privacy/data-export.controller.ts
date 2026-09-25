import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Header,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
  ApiProduces,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DataExportService } from './data-export.service';
import { RequestDataExportDto } from './dto/request-data-export.dto';
import { QueryExportHistoryDto } from './dto/query-export-history.dto';

@ApiTags('privacy')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('privacy/data-exports')
export class DataExportController {
  constructor(private readonly dataExportService: DataExportService) {}

  /**
   * POST /api/v1/privacy/data-exports
   * Request a full export of the authenticated user's personal data.
   * Identity comes from the verified JWT — never from the request body.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a GDPR export of your personal data',
    description:
      'Compiles the authenticated user\'s data across all modules into a downloadable ' +
      'JSON document. Tracks the job so its status can be polled. Only one export may ' +
      'be requested per 24h cooldown window.',
  })
  @ApiOkResponse({ description: 'Export request accepted; job status returned' })
  requestExport(
    @CurrentUser('id') userId: string,
    @Body() dto: RequestDataExportDto,
  ) {
    void dto;
    return this.dataExportService.requestExport(userId);
  }

  /**
   * GET /api/v1/privacy/data-exports
   * List the authenticated user's export requests (newest first).
   */
  @Get()
  @ApiOperation({ summary: 'List your data export requests' })
  listMyExports(
    @CurrentUser('id') userId: string,
    @Query() query: QueryExportHistoryDto,
  ) {
    return this.dataExportService.listMyExports(userId);
  }

  /**
   * GET /api/v1/privacy/data-exports/:jobId
   * Track the status of a specific export job. Only the requester can see it.
   */
  @Get(':jobId')
  @ApiOperation({
    summary: 'Track the status of a data export job',
    description:
      'Returns PENDING / PROCESSING / COMPLETED / FAILED / EXPIRED for a job belonging ' +
      'to the authenticated user. Job ids are not enumerable across accounts.',
  })
  getExportStatus(@CurrentUser('id') userId: string, @Param('jobId') jobId: string) {
    return this.dataExportService.getExportStatus(userId, jobId);
  }

  /**
   * GET /api/v1/privacy/data-exports/:jobId/download
   * Download the compiled export as a JSON file.
   */
  @Get(':jobId/download')
  @ApiOperation({
    summary: 'Download your compiled data export as a JSON file',
    description:
      'Returns the export document with a Content-Disposition attachment header. ' +
      'Downloads are counted; exports expire 7 days after completion.',
  })
  @ApiProduces('application/json')
  @Header('Content-Type', 'application/json')
  async downloadExport(
    @CurrentUser('id') userId: string,
    @Param('jobId') jobId: string,
  ): Promise<StreamableFile> {
    const { filename, payload } = await this.dataExportService.downloadExport(
      userId,
      jobId,
    );

    return new StreamableFile(Buffer.from(JSON.stringify(payload, null, 2), 'utf8'), {
      type: 'application/json',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /**
   * POST /api/v1/privacy/data-exports/cleanup
   * Destroy expired export payloads (housekeeping; safe to call anytime).
   */
  @Post('cleanup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Expire and purge downloadable payloads of overdue export jobs',
  })
  cleanup() {
    return this.dataExportService.cleanupExpiredExports();
  }
}
