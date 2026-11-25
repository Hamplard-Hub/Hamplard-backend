import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
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
  getReport(
    @Query() query: EngagementReportQueryDto,
    @CurrentUser('id') userId?: string,
    @CurrentUser('role') userRole?: string,
  ) {
    // Issue #435 — scope is enforced in the service against the caller.
    // Calls without a caller are internal (e.g. scheduled report jobs).
    const caller = userId || userRole ? { id: userId, role: userRole } : undefined;
    return this.engagement.getReport(query, caller);
  }
}
