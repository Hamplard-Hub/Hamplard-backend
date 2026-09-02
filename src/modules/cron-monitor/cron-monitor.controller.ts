import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CronMonitorService } from './cron-monitor.service';
import { QueryCronRunsDto } from './dto/query-cron-runs.dto';

@ApiTags('cron-monitor')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('cron-monitor')
export class CronMonitorController {
  constructor(private readonly cronMonitorService: CronMonitorService) {}

  @Get('runs')
  @ApiOperation({
    summary: 'List cron job run history with pagination and filters (admin)',
  })
  findAll(@Query() query: QueryCronRunsDto) {
    return this.cronMonitorService.findAll(query);
  }

  @Get('stats')
  @ApiOperation({
    summary:
      'Aggregated stats per job: success rate, avg duration, last run/success/failure (30-day window)',
  })
  getStats() {
    return this.cronMonitorService.getStats();
  }

  @Get('stale')
  @ApiOperation({
    summary:
      'List RUNNING cron job runs that have been active longer than the stale threshold (admin)',
  })
  @ApiQuery({
    name: 'thresholdMinutes',
    required: false,
    description: 'Minutes after which a RUNNING run is considered stale (default: 30)',
  })
  findStale(@Query('thresholdMinutes') thresholdMinutes?: string) {
    return this.cronMonitorService.findStaleRuns(
      thresholdMinutes ? parseInt(thresholdMinutes, 10) : undefined,
    );
  }

  @Post('stale/mark-failed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually trigger stale-run cleanup — marks zombie RUNNING runs as FAILED (admin)',
  })
  @ApiQuery({
    name: 'thresholdMinutes',
    required: false,
    description: 'Minutes threshold (default: 30)',
  })
  markStaleFailed(@Query('thresholdMinutes') thresholdMinutes?: string) {
    return this.cronMonitorService.markStaleRunsFailed(
      thresholdMinutes ? parseInt(thresholdMinutes, 10) : undefined,
    );
  }

  @Get('runs/:id')
  @ApiOperation({ summary: 'Get a single cron job run by ID (admin)' })
  @ApiParam({ name: 'id', description: 'CronJobRun UUID' })
  findOne(@Param('id') id: string) {
    return this.cronMonitorService.findOne(id);
  }
}
