import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AnalyticsService } from './analytics.service';
import {
  BatchTrackAnalyticsEventsDto,
  QueryAnalyticsEventsDto,
  TrackAnalyticsEventDto,
} from './dto/track-analytics-event.dto';

@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Post('events')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ingest a single analytics event' })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  trackEvent(
    @Body() dto: TrackAnalyticsEventDto,
    @CurrentUser('id') userId: string,
    @Req() req: Request,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.analyticsService.trackEvent(dto, {
      userId: dto.userId ?? userId,
      ipAddress: req.ip,
      userAgent: dto.userAgent ?? userAgent,
    });
  }

  @Post('events/batch')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Batch-ingest analytics events for high-frequency tracking',
  })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  trackEventsBatch(
    @Body() dto: BatchTrackAnalyticsEventsDto,
    @CurrentUser('id') userId: string,
    @Req() req: Request,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.analyticsService.trackEventsBatch(dto, {
      userId,
      ipAddress: req.ip,
      userAgent,
    });
  }

  @Get('volume')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get event volume aggregated by event type (admin)' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  getVolume(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.getVolumeByEventType(from, to);
  }

  @Get('events')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Query raw analytics events (admin only)' })
  queryRawEvents(@Query() query: QueryAnalyticsEventsDto) {
    return this.analyticsService.queryRawEvents(query);
  }
}
