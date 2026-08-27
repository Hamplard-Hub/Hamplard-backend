import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DataExportService } from './data-export.service';

@ApiTags('privacy')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('privacy/data-export')
export class DataExportController {
  constructor(private readonly exportService: DataExportService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a GDPR data export' })
  requestExport(@CurrentUser('id') userId: string) {
    return this.exportService.requestExport(userId);
  }

  @Get(':jobId/status')
  @ApiOperation({ summary: 'Get export job status' })
  getJobStatus(
    @CurrentUser('id') userId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.exportService.getJobStatus(userId, jobId);
  }

  @Get(':jobId/download')
  @ApiOperation({ summary: 'Download completed export file' })
  async downloadExport(
    @CurrentUser('id') userId: string,
    @Param('jobId') jobId: string,
    @Res() res: Response,
  ) {
    const { filePath, contentType, fileName } =
      await this.exportService.downloadExport(userId, jobId);

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });

    res.sendFile(filePath);
  }
}
