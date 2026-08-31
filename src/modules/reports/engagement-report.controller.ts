import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { EngagementReportQueryDto } from './dto/engagement-report-query.dto';
import { EngagementReportService } from './engagement-report.service';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.INSTRUCTOR)
@Controller('reports/engagement')
export class EngagementReportController {
  constructor(private readonly engagement: EngagementReportService) {}

  @Get()
  @ApiOperation({
    summary:
      'Student engagement report: watch time, streaks, completion rates and inactivity flagging',
  })
  getReport(@Query() query: EngagementReportQueryDto) {
    return this.engagement.getReport(query);
  }
}
