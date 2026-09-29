import {
  Controller, Post, Get, Patch, Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ModerationService } from './moderation.service';
import { CreateFlagDto } from './dto/create-flag.dto';
import { ResolveFlagDto } from './dto/resolve-flag.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ReportStatus, ReportTargetType, ReportCategory, UserRole } from '@prisma/client';

@ApiTags('moderation (admin dashboard)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('moderation')
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Post('flags')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Flag content for moderation review' })
  createFlag(
    @CurrentUser('id') reporterId: string,
    @Body() dto: CreateFlagDto,
  ) {
    return this.moderationService.createFlag(reporterId, dto);
  }

  @Get('dashboard')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Moderation dashboard queue (admin only)' })
  @ApiQuery({ name: 'status', required: false, enum: ReportStatus })
  @ApiQuery({ name: 'targetType', required: false, enum: ReportTargetType })
  @ApiQuery({ name: 'category', required: false, enum: ReportCategory })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getDashboardListing(
    @Query('status') status?: ReportStatus,
    @Query('targetType') targetType?: ReportTargetType,
    @Query('category') category?: ReportCategory,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.moderationService.getDashboardListing({
      status,
      targetType,
      category,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 10,
    });
  }

  @Patch('flags/:id/resolve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update flag resolution status (admin only)' })
  resolveFlag(
    @Param('id') flagId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: ResolveFlagDto,
  ) {
    return this.moderationService.resolveFlag(flagId, adminId, dto);
  }
}
