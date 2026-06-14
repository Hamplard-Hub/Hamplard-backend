import {
  Controller, Get, Post, Body, Param, UseGuards, HttpCode, HttpStatus, Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { EnrollmentsService } from './enrollments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('enrollments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollmentsService: EnrollmentsService) {}

  /**
   * POST /api/v1/enrollments
   * Called by the frontend after the student's enroll() tx is confirmed on-chain.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register on-chain enrollment in the DB' })
  create(
    @CurrentUser('id') studentId: string,
    @Body() body: { courseId: string; txHash: string; amountPaid: number },
  ) {
    return this.enrollmentsService.create(
      studentId, body.courseId, body.txHash, body.amountPaid,
    );
  }

  @Get('my')
  @ApiOperation({ summary: 'Get all courses the authenticated student is enrolled in' })
  findMy(
    @CurrentUser('id') studentId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.enrollmentsService.findByStudent(studentId, page, limit);
  }

  @Get(':courseId')
  @ApiOperation({ summary: 'Get enrollment detail including progress for a specific course' })
  findOne(
    @CurrentUser('id') studentId: string,
    @Param('courseId') courseId: string,
  ) {
    return this.enrollmentsService.findOne(studentId, courseId);
  }

  @Get(':courseId/check')
  @ApiOperation({ summary: 'Check if the authenticated user is enrolled in a course' })
  isEnrolled(
    @CurrentUser('id') studentId: string,
    @Param('courseId') courseId: string,
  ) {
    return this.enrollmentsService.isEnrolled(studentId, courseId);
  }
}
