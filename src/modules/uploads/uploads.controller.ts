import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UploadsService } from './uploads.service';
import { VideoTranscodeService } from './video-transcode.service';
import { VirusScanService } from './virus-scan.service';

/**
 * Default file size limit for general uploads: 500 MB
 * Matches MAX_FILE_SIZE_MB in .env.example.
 * Individual category limits (images, documents, videos) are applied by UploadsService.
 */
const DEFAULT_MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

@ApiTags('uploads')
@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly uploadsService: UploadsService,
    private readonly videoTranscodeService: VideoTranscodeService,
    private readonly virusScanService: VirusScanService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('course-asset')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: DEFAULT_MAX_FILE_SIZE_BYTES },
  }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload course asset (thumbnail/preview image)' })
  async uploadCourseAsset(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('courseId') courseId: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    if (!courseId) {
      throw new BadRequestException('courseId is required');
    }

    this.uploadsService.validateFile(file, 'document');

    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: { instructor: true },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    const user = req.user;
    if (
      user.role !== UserRole.ADMIN &&
      course.instructorAddress !== user.stellarAddress &&
      course.instructor.id !== user.id
    ) {
      throw new ForbiddenException('Only the course instructor or an admin can upload course assets');
    }

    return this.uploadsService.saveFile(file, `courses/${courseId}`, 'public', 'document');
  }

  @Post('lesson-video')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor('video', {
    storage: memoryStorage(),
    limits: { fileSize: DEFAULT_MAX_FILE_SIZE_BYTES },
  }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload lesson video and trigger transcode pipeline' })
  async uploadLessonVideo(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('lessonId') lessonId: string,
    @Body('courseId') courseId?: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    if (!lessonId) {
      throw new BadRequestException('lessonId is required');
    }

    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        module: {
          include: {
            course: {
              include: { instructor: true },
            },
          },
        },
      },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    const course = lesson.module.course;
    const user = req.user;
    if (
      user.role !== UserRole.ADMIN &&
      course.instructorAddress !== user.stellarAddress &&
      course.instructor.id !== user.id
    ) {
      throw new ForbiddenException('Only the course instructor or an admin can upload lesson videos');
    }

    return this.uploadsService.saveVideo(
      file,
      `courses/${course.id}/lessons/${lessonId}`,
      lessonId,
    );
  }

  @Get('video-jobs/:jobId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Poll video transcoding job status' })
  async getVideoJobStatus(@Param('jobId') jobId: string) {
    const jobStatus = await this.videoTranscodeService.getJobStatus(jobId);
    if (!jobStatus) {
      throw new NotFoundException(`Video transcode job ${jobId} not found`);
    }
    return jobStatus;
  }

  @Get('scans/:fileId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get scan status of an uploaded file' })
  async getScanStatus(@Param('fileId') fileId: string) {
    const status = await this.virusScanService.getScanStatus(fileId);
    if (!status) {
      throw new NotFoundException(`Scan result for file ${fileId} not found`);
    }
    return status;
  }
}
