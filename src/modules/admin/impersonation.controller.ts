import {
  Controller, Post, Get, Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ImpersonationService } from './impersonation.service';
import { StartImpersonationDto } from './dto/start-impersonation.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

@ApiTags('admin-impersonation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/impersonation')
export class ImpersonationController {
  constructor(private readonly impersonationService: ImpersonationService) {}

  @Post('start')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start a scoped user impersonation support session (admin only)' })
  startImpersonation(
    @CurrentUser('id') adminId: string,
    @Body() dto: StartImpersonationDto,
  ) {
    return this.impersonationService.startImpersonation(adminId, dto);
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'Retrieve impersonation audit trail (admin only)' })
  getAuditTrail(@Query() pagination: PaginationQueryDto) {
    return this.impersonationService.getAuditTrail(
      pagination.page,
      pagination.limit,
    );
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Verify an active impersonation session status' })
  verifySession(@Param('sessionId') sessionId: string) {
    return this.impersonationService.verifySession(sessionId);
  }

  @Post('sessions/:sessionId/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End an active impersonation session' })
  endSession(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') adminId: string,
  ) {
    return this.impersonationService.endSession(sessionId, adminId);
  }
}
