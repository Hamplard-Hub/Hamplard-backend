// refunds.controller.ts
import {
  Controller, Get, Post, Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RefundsService } from './refunds.service';
import { CreateRefundDto } from './dto/create-refund.dto';
import { ApproveRefundDto } from './dto/approve-refund.dto';
import { RejectRefundDto } from './dto/reject-refund.dto';
import { ProcessRefundDto } from './dto/process-refund.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RefundStatus, UserRole } from '@prisma/client';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { QueryRefundsDto } from './dto/query-refunds.dto';

@ApiTags('refunds')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refundsService: RefundsService) {}

  // ----------------------------------------------------------
  // STUDENT
  // ----------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Student requests a refund for a cancelled or disputed enrollment' })
  create(@CurrentUser('id') studentId: string, @Body() dto: CreateRefundDto) {
    return this.refundsService.create(studentId, dto);
  }

  @Get('my')
  @ApiOperation({ summary: 'Get the authenticated student\'s refund requests' })
  findMy(
    @CurrentUser('id') studentId: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.refundsService.findByStudent(studentId, pagination.page, pagination.limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get refund status (owner or admin)' })
  findOne(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.refundsService.findOne(id, userId, role);
  }

  // ----------------------------------------------------------
  // ADMIN
  // ----------------------------------------------------------

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin lists refund requests' })
  findAll(@Query() query: QueryRefundsDto) {
    return this.refundsService.findAll({ status: query.status, page: query.page, limit: query.limit });
  }

  @Post(':id/approve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin approves a refund request (full or partial amount)' })
  approve(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: ApproveRefundDto,
  ) {
    return this.refundsService.approve(id, adminId, dto);
  }

  @Post(':id/reject')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin rejects a refund request' })
  reject(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: RejectRefundDto,
  ) {
    return this.refundsService.reject(id, adminId, dto);
  }

  @Post(':id/process')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin marks an approved refund as processed with the on-chain tx hash' })
  process(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: ProcessRefundDto,
  ) {
    return this.refundsService.process(id, adminId, dto);
  }
}
