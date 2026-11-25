import {
  Controller, Get, Post, Body, Param, UseGuards, HttpCode, HttpStatus, Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AssignmentsService, AssignmentViewer } from './assignments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { ReviewAssignmentDto } from './dto/review-assignment.dto';
import { PendingSubmissionsQueryDto } from './dto/pending-submissions-query.dto';
import { SubmitAssignmentDto } from './dto/submit-assignment.dto';

@ApiTags('assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Get('lesson/:lessonId')
  @ApiOperation({
    summary: 'Get assignment for a lesson',
    description:
      'Students receive only their own submission; the course instructor and admins receive all.',
  })
  findByLesson(
    @Param('lessonId') lessonId: string,
    @CurrentUser() user: AssignmentViewer,
  ) {
    return this.assignmentsService.findByLesson(lessonId, user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create assignment for a lesson (instructor)' })
  create(
    @Body() dto: CreateAssignmentDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: UserRole,
  ) {
    return this.assignmentsService.create(dto.lessonId, dto, userId, userRole);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Student submits practical assignment' })
  submit(
    @Param('id') assignmentId: string,
    @CurrentUser('id') studentId: string,
    @Body() dto: SubmitAssignmentDto,
  ) {
    return this.assignmentsService.submit(
      studentId, assignmentId, dto.submissionUrl, dto.notes,
    );
  }

  @Post('submissions/:id/review')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Instructor approves or rejects a submission' })
  review(
    @Param('id') submissionId: string,
    @CurrentUser('id') instructorId: string,
    @CurrentUser('role') userRole: UserRole,
    @Body() dto: ReviewAssignmentDto,
  ) {
    return this.assignmentsService.review(
      submissionId, instructorId, dto.approved, dto.feedback, userRole,
    );
  }

  @Get('my/submissions')
  @ApiOperation({ summary: 'Get all assignment submissions by the authenticated student' })
  mySubmissions(@CurrentUser('id') studentId: string) {
    return this.assignmentsService.findSubmissionsByStudent(studentId);
  }

  @Get('instructor/pending')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get all pending submissions for instructor review (paginated)' })
  pendingReviews(
    @CurrentUser('id') instructorId: string,
    @Query() query: PendingSubmissionsQueryDto,
  ) {
    return this.assignmentsService.findPendingForInstructor(instructorId, query.page, query.limit);
  }
}
