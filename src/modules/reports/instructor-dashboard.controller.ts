import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { InstructorDashboardQueryDto } from './dto/instructor-dashboard-query.dto';
import { InstructorDashboardService } from './instructor-dashboard.service';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('instructors')
export class InstructorDashboardController {
  constructor(private readonly dashboardService: InstructorDashboardService) {}

  @Get('me/dashboard')
  @ApiOperation({
    summary:
      'Get instructor dashboard with per-course metrics: enrollments, completion rate, quiz/exam scores, ratings, and pending submissions',
  })
  getDashboard(
    @CurrentUser('id') instructorId: string,
    @Query() query: InstructorDashboardQueryDto,
  ) {
    return this.dashboardService.getDashboard(instructorId, query);
  }
}
