// reports.controller.ts
import {
  Controller, Get, Post, Patch, Body, Param,
  Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiParam } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportStatusDto } from './dto/update-report-status.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ReportTargetType, ReportStatus, UserRole } from '@prisma/client';

@ApiTags('reports (reporter-facing)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // ----------------------------------------------------------
  // REPORTER ROUTES
  // ----------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Report an abusive course, comment, or profile' })
  create(@CurrentUser('id') reporterId: string, @Body() dto: CreateReportDto) {
    return this.reportsService.create(reporterId, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: 'List reports submitted by the authenticated user' })
  @ApiQuery({ name: 'status', required: false, enum: ReportStatus })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findMine(
    @CurrentUser('id') reporterId: string,
    @Query('status') status?: ReportStatus,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.reportsService.findMine(reporterId, status, page, limit);
  }

  @Get('mine/:id')
  @ApiOperation({ summary: 'Get the status of a report the authenticated user filed' })
  findOneMine(@Param('id') id: string, @CurrentUser('id') reporterId: string) {
    return this.reportsService.findOneForReporter(id, reporterId);
  }

  // ----------------------------------------------------------
  // ADMIN ROUTES
  // ----------------------------------------------------------

  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List all abuse reports (admin)' })
  @ApiQuery({ name: 'status', required: false, enum: ReportStatus })
  @ApiQuery({ name: 'targetType', required: false, enum: ReportTargetType })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'severity', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  adminFindAll(
    @Query('status') status?: ReportStatus,
    @Query('targetType') targetType?: ReportTargetType,
    @Query('category') category?: string,
    @Query('severity') severity?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.reportsService.adminFindAll(
      { status, targetType, category, severity },
      page,
      limit,
    );
  }

  @Get('admin/top-targets')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List the most-reported targets, ranked by report count' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  adminTopTargets(@Query('limit') limit?: number) {
    return this.reportsService.adminTopReportedTargets(limit);
  }

  @Get('admin/target/:targetType/:targetId/count')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get the total and open report count for a specific target' })
  @ApiParam({ name: 'targetType', enum: ReportTargetType })
  adminTargetCount(
    @Param('targetType') targetType: ReportTargetType,
    @Param('targetId') targetId: string,
  ) {
    return this.reportsService.getCountForTarget(targetType, targetId);
  }

  @Get('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get full detail of a single report (admin)' })
  adminFindOne(@Param('id') id: string) {
    return this.reportsService.adminFindOne(id);
  }

  @Patch('admin/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Review a report: mark under review, resolve, or dismiss it' })
  adminUpdateStatus(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: UpdateReportStatusDto,
  ) {
    return this.reportsService.adminUpdateStatus(id, adminId, dto);
  }
}
