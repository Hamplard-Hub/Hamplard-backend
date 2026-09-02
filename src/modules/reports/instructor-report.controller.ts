import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { InstructorReportQueryDto } from './dto/instructor-report-query.dto';
import { InstructorReportService } from './instructor-report.service';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('reports/instructors')
export class InstructorReportController {
  constructor(private readonly instructorReport: InstructorReportService) {}

  @Get(':instructorId/performance')
  @ApiOperation({
    summary:
      'Instructor performance report: ratings, revenue and completion rates vs platform averages',
  })
  @ApiParam({ name: 'instructorId', description: 'User id of the instructor' })
  getReport(
    @Param('instructorId') instructorId: string,
    @Query() query: InstructorReportQueryDto,
  ) {
    return this.instructorReport.getReport(instructorId, query);
  }
}
