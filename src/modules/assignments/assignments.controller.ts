import {
  Controller, Get, Post, Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AssignmentsService } from './assignments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Get('lesson/:lessonId')
  @ApiOperation({ summary: 'Get assignment for a lesson' })
  findByLesson(@Param('lessonId') lessonId: string) {
    return this.assignmentsService.findByLesson(lessonId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create assignment for a lesson (instructor)' })
  create(@Body() body: {
    lessonId: string;
    title: string;
    description: string;
    instructions?: string;
  }) {
    return this.assignmentsService.create(body.lessonId, body);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Student submits practical assignment' })
  submit(
    @Param('id') assignmentId: string,
    @CurrentUser('id') studentId: string,
    @Body() body: { submissionUrl: string; notes?: string },
  ) {
    return this.assignmentsService.submit(
      studentId, assignmentId, body.submissionUrl, body.notes,
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
    @Body() body: { approved: boolean; feedback: string },
  ) {
    return this.assignmentsService.review(
      submissionId, instructorId, body.approved, body.feedback,
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
  @ApiOperation({ summary: 'Get all pending submissions for instructor review' })
  pendingReviews(@CurrentUser('stellarAddress') address: string) {
    return this.assignmentsService.findPendingForInstructor(address);
  }
}
