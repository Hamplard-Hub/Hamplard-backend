import {
  Controller, Get, Post, Patch, Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { LessonsService } from './lessons.service';
import { DripScheduleService, ConfigureCourseDripDto, ConfigureLessonDripDto } from './drip-schedule.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('lessons')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('lessons')
export class LessonsController {
  constructor(
    private readonly lessonsService: LessonsService,
    private readonly dripScheduleService: DripScheduleService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get lesson content (validating drip unlock schedule)' })
  async findOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
    if (userId) {
      await this.dripScheduleService.validateLessonAccess(userId, id);
    }
    return this.lessonsService.findLesson(id);
  }

  @Post('modules')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a course module' })
  createModule(@Body() body: { courseId: string; title: string; position: number }) {
    return this.lessonsService.createModule(body.courseId, body.title, body.position);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a lesson to a module' })
  createLesson(
    @Body() body: {
      moduleId: string;
      title: string;
      description?: string;
      type?: string;
      videoUrl?: string;
      videoDuration?: number;
      thumbnailUrl?: string;
      content?: string;
      resourceUrl?: string;
      position: number;
      isFree?: boolean;
    },
  ) {
    return this.lessonsService.createLesson(body.moduleId, body);
  }

  @Patch(':id/thumbnail')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set or update the thumbnail URL for a lesson' })
  updateThumbnail(
    @Param('id') lessonId: string,
    @Body() body: { thumbnailUrl: string },
  ) {
    return this.lessonsService.updateThumbnailUrl(lessonId, body.thumbnailUrl);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a lesson as completed (student)' })
  markComplete(
    @Param('id') lessonId: string,
    @CurrentUser('id') studentId: string,
    @Body() body: { enrollmentId: string; watchedSecs?: number },
  ) {
    return this.lessonsService.markLessonComplete(
      studentId, body.enrollmentId, lessonId, body.watchedSecs,
    );
  }

  @Patch(':id/progress')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update video watch position' })
  updateProgress(
    @Param('id') lessonId: string,
    @Body() body: { enrollmentId: string; watchedSecs: number },
  ) {
    return this.lessonsService.updateWatchProgress(
      body.enrollmentId, lessonId, body.watchedSecs,
    );
  }

  // ----------------------------------------------------------
  // DRIP CONTENT SCHEDULER ENDPOINTS (Issue #98)
  // ----------------------------------------------------------

  @Post('courses/:courseId/drip-schedule')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Configure drip schedule pacing for a course (Instructor/Admin)' })
  configureCourseDrip(
    @Param('courseId') courseId: string,
    @CurrentUser('id') instructorId: string,
    @Body() dto: ConfigureCourseDripDto,
  ) {
    return this.dripScheduleService.configureCourseDrip(courseId, instructorId, dto);
  }

  @Get('courses/:courseId/drip-schedule')
  @ApiOperation({ summary: 'Get student drip schedule and next unlock date for a course' })
  getStudentDripSchedule(
    @Param('courseId') courseId: string,
    @CurrentUser('id') studentId: string,
  ) {
    return this.dripScheduleService.getStudentDripSchedule(studentId, courseId);
  }

  @Patch(':id/drip-schedule')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Configure specific unlock delay or date for a lesson (Instructor/Admin)' })
  configureLessonDrip(
    @Param('id') lessonId: string,
    @CurrentUser('id') instructorId: string,
    @Body() dto: ConfigureLessonDripDto,
  ) {
    return this.dripScheduleService.configureLessonDrip(lessonId, instructorId, dto);
  }

  @Post('enrollments/:enrollmentId/drip-override')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Override drip schedule pacing for a student enrollment (Instructor/Admin)' })
  overrideInstructorDrip(
    @Param('enrollmentId') enrollmentId: string,
    @CurrentUser('id') instructorId: string,
    @Body() body: { lessonId?: string; unlockAt?: string },
  ) {
    return this.dripScheduleService.overrideInstructorDrip(
      instructorId,
      enrollmentId,
      body.lessonId,
      body.unlockAt,
    );
  }
}
