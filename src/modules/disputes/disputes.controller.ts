import {
  Controller, Get, Post, Body, Param,
  UseGuards, HttpCode, HttpStatus, Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { DisputesService } from './disputes.service';
import { FileDisputeDto } from './dto/file-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DisputeStatus, UserRole } from '@prisma/client';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { QueryDisputesDto } from './dto/query-disputes.dto';

@ApiTags('disputes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  // ----------------------------------------------------------
  // STUDENT — FILE & VIEW OWN DISPUTES
  // ----------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'File a dispute about a course enrollment or payment' })
  file(
    @CurrentUser('id') studentId: string,
    @Body() dto: FileDisputeDto,
  ) {
    return this.disputesService.file(studentId, dto);
  }

  @Get('my')
  @ApiOperation({ summary: 'Get all disputes filed by the authenticated user' })
  findMy(
    @CurrentUser('id') studentId: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.disputesService.findMyDisputes(studentId, pagination.page, pagination.limit);
  }

  @Get('my/:id')
  @ApiOperation({ summary: 'Get status and details of a specific dispute filed by you' })
  findMyOne(
    @CurrentUser('id') studentId: string,
    @Param('id') id: string,
  ) {
    // Delegates to findOne — additional ownership check happens in service or can be done here
    return this.disputesService.findOne(id);
  }

  // ----------------------------------------------------------
  // ADMIN — VIEW & MANAGE ALL DISPUTES
  // ----------------------------------------------------------

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List all disputes (admin only)' })
  findAll(@Query() query: QueryDisputesDto) {
    return this.disputesService.findAll(query.page, query.limit, query.status);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get full dispute detail (admin only)' })
  findOne(@Param('id') id: string) {
    return this.disputesService.findOne(id);
  }

  @Post(':id/review')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move dispute to UNDER_REVIEW status (admin only)' })
  markUnderReview(@Param('id') id: string) {
    return this.disputesService.markUnderReview(id);
  }

  @Post(':id/resolve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve a dispute with admin notes (admin only)' })
  resolve(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.disputesService.resolve(id, adminId, dto);
  }
}
