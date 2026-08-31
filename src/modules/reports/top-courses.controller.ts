// top-courses.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TopCoursesService } from './top-courses.service';
import { TopCoursesQueryDto } from './dto/top-courses-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('reports/top-courses')
export class TopCoursesController {
  constructor(private readonly topCoursesService: TopCoursesService) {}

  @Get()
  @ApiOperation({ summary: 'Rank courses by enrollment, revenue, or completion rate over a time window' })
  getTopCourses(@Query() query: TopCoursesQueryDto) {
    return this.topCoursesService.getTopCourses(query);
  }
}
