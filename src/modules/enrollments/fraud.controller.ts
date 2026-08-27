// fraud.controller.ts
// Admin-only REST endpoints for the fraud review queue.
// All routes require ADMIN role.

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { FraudDetectionService, ReviewFlagDto } from './fraud-detection.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole, FraudFlagStatus, FraudRiskLevel } from '@prisma/client';

@ApiTags('fraud-review')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('enrollments/fraud')
export class FraudController {
  constructor(private readonly fraudDetection: FraudDetectionService) {}

  // -------------------------------------------------------------------------
  // GET /enrollments/fraud/queue — paginated review queue
  // -------------------------------------------------------------------------

  @Get('queue')
  @ApiOperation({
    summary: 'Admin: get paginated fraud review queue',
    description:
      'Returns all enrollment fraud flags filtered by status and/or risk level. ' +
      'Sorted by risk score descending so the most dangerous cases appear first.',
  })
  @ApiQuery({ name: 'status',    required: false, enum: FraudFlagStatus })
  @ApiQuery({ name: 'riskLevel', required: false, enum: FraudRiskLevel })
  @ApiQuery({ name: 'page',      required: false, type: Number })
  @ApiQuery({ name: 'limit',     required: false, type: Number })
  getQueue(
    @Query('status')    status?: FraudFlagStatus,
    @Query('riskLevel') riskLevel?: FraudRiskLevel,
    @Query('page')      page?: number,
    @Query('limit')     limit?: number,
  ) {
    return this.fraudDetection.getFraudReviewQueue({ status, riskLevel }, page, limit);
  }

  // -------------------------------------------------------------------------
  // GET /enrollments/fraud/student/:studentId — aggregate risk profile
  // -------------------------------------------------------------------------

  @Get('student/:studentId')
  @ApiOperation({
    summary: 'Admin: get aggregate risk profile for a student',
    description:
      'Returns the full fraud history for a specific student account including ' +
      'total flag count, confirmed fraud count, and maximum risk score recorded.',
  })
  @ApiParam({ name: 'studentId', description: 'Platform user ID of the student' })
  getStudentProfile(@Param('studentId') studentId: string) {
    return this.fraudDetection.getStudentRiskProfile(studentId);
  }

  // -------------------------------------------------------------------------
  // GET /enrollments/fraud/:flagId — single flag detail
  // -------------------------------------------------------------------------

  @Get(':flagId')
  @ApiOperation({
    summary: 'Admin: get single fraud flag detail',
    description:
      'Returns full detail for a single fraud flag including the associated ' +
      'enrollment, course, student, and reviewer information.',
  })
  @ApiParam({ name: 'flagId', description: 'UUID of the EnrollmentFraudFlag record' })
  getFlag(@Param('flagId') flagId: string) {
    return this.fraudDetection.getFlagById(flagId);
  }

  // -------------------------------------------------------------------------
  // POST /enrollments/fraud/:flagId/review — resolve a flag
  // -------------------------------------------------------------------------

  @Post(':flagId/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin: clear or confirm a fraud flag',
    description:
      'Resolves an OPEN or HELD fraud flag. ' +
      'CLEARED = no fraud found, enrollment proceeds normally. ' +
      'CONFIRMED = fraud confirmed; downstream voids are handled separately.',
  })
  @ApiParam({ name: 'flagId', description: 'UUID of the EnrollmentFraudFlag record' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['decision'],
      properties: {
        decision: {
          type: 'string',
          enum: ['CLEARED', 'CONFIRMED'],
          description: 'Admin resolution decision',
        },
        reviewNotes: {
          type: 'string',
          description: 'Optional free-text note recorded against the flag',
        },
      },
    },
  })
  reviewFlag(
    @Param('flagId')       flagId: string,
    @CurrentUser('id')     adminId: string,
    @Body()                dto: ReviewFlagDto,
  ) {
    return this.fraudDetection.reviewFlag(flagId, adminId, dto);
  }
}
