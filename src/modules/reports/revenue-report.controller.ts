// revenue-report.controller.ts — issue #62: revenue report API
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RevenueReportService } from './revenue-report.service';
import { RevenueReportQueryDto } from './dto/revenue-report-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('reports/revenue')
export class RevenueReportController {
  constructor(private readonly revenueReportService: RevenueReportService) {}

  @Get()
  @ApiOperation({ summary: 'Generate platform and per-instructor revenue reports over a period' })
  @ApiQuery({ name: 'startDate', required: false, description: 'ISO date — must be paired with endDate' })
  @ApiQuery({ name: 'endDate', required: false, description: 'ISO date — must be paired with startDate' })
  @ApiQuery({ name: 'instructorId', required: false })
  @ApiQuery({ name: 'courseId', required: false })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  generate(@Query() query: RevenueReportQueryDto) {
    return this.revenueReportService.generate(query);
  }
}
