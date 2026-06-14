import {
  Controller, Get, Post, Patch, Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { LessonsService } from './lessons.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('lessons')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('lessons')
export class LessonsController {
  constructor(private readonly lessonsService: LessonsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get lesson content (must be enrolled)' })
  findOne(@Param('id') id: string) {
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
      content?: string;
      resourceUrl?: string;
      position: number;
      isFree?: boolean;
    },
  ) {
    return this.lessonsService.createLesson(body.moduleId, body);
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
}
