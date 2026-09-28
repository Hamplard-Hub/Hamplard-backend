// lessons.service.ts
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class LessonsService {
  private readonly logger = new Logger(LessonsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async verifyCourseOwnership(
    courseId: string,
    user?: { id?: string; stellarAddress?: string; role?: string },
  ) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: { instructor: true },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    if (user && user.role !== UserRole.ADMIN) {
      const isOwner =
        (user.stellarAddress && course.instructorAddress === user.stellarAddress) ||
        (user.id && (course.instructorAddress === user.id || course.instructor?.id === user.id));

      if (!isOwner) {
        throw new ForbiddenException('You are not authorized to manage content for this course');
      }
    }

    return course;
  }

  private async verifyModuleOwnership(
    moduleId: string,
    user?: { id?: string; stellarAddress?: string; role?: string },
  ) {
    const module = await this.prisma.courseModule.findUnique({
      where: { id: moduleId },
      include: {
        course: {
          include: { instructor: true },
        },
      },
    });

    if (!module) {
      throw new NotFoundException('Module not found');
    }

    if (user && user.role !== UserRole.ADMIN) {
      const course = module.course;
      const isOwner =
        (user.stellarAddress && course.instructorAddress === user.stellarAddress) ||
        (user.id && (course.instructorAddress === user.id || course.instructor?.id === user.id));

      if (!isOwner) {
        throw new ForbiddenException('You are not authorized to manage content for this course');
      }
    }

    return module;
  }

  async createModule(
    courseId: string,
    title: string,
    position: number,
    user?: { id?: string; stellarAddress?: string; role?: string },
  ) {
    await this.verifyCourseOwnership(courseId, user);
    return this.prisma.courseModule.create({
      data: { courseId, title, position },
    });
  }

  async createLesson(
    moduleId: string,
    data: {
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
    user?: { id?: string; stellarAddress?: string; role?: string },
  ) {
    const module = await this.verifyModuleOwnership(moduleId, user);

    const lesson = await this.prisma.lesson.create({
      data: {
        moduleId,
        title:         data.title,
        description:   data.description,
        type:          data.type as any ?? 'VIDEO',
        videoUrl:      data.videoUrl,
        videoDuration: data.videoDuration,
        thumbnailUrl:  data.thumbnailUrl,
        content:       data.content,
        resourceUrl:   data.resourceUrl,
        position:      data.position,
        isFree:        data.isFree ?? false,
      },
    });

    // Update totalLessons on the course
    await this.prisma.course.update({
      where: { id: module.courseId },
      data: { totalLessons: { increment: 1 } },
    });

    return lesson;
  }

  async findLesson(lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { module: { include: { course: true } }, assignment: true },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    return lesson;
  }

  /**
   * Stores or updates the thumbnail URL on a lesson record.
   * Called after video thumbnail extraction completes.
   */
  async updateThumbnailUrl(lessonId: string, thumbnailUrl: string) {
    const lesson = await this.prisma.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) throw new NotFoundException('Lesson not found');

    return this.prisma.lesson.update({
      where: { id: lessonId },
      data: { thumbnailUrl },
    });
  }

  // ----------------------------------------------------------
  // PROGRESS TRACKING
  // ----------------------------------------------------------

  private async verifyEnrollmentAndLesson(
    studentId: string,
    enrollmentId: string,
    lessonId: string,
  ) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        course: {
          include: {
            modules: {
              include: {
                lessons: {
                  select: { id: true },
                },
              },
            },
          },
        },
      },
    });

    if (!enrollment) {
      throw new NotFoundException('Enrollment not found');
    }

    if (enrollment.studentId !== studentId) {
      throw new ForbiddenException('This enrollment does not belong to you');
    }

    const courseLessonIds = new Set(
      enrollment.course.modules.flatMap((m) => m.lessons.map((l) => l.id)),
    );
    if (!courseLessonIds.has(lessonId)) {
      throw new BadRequestException('Lesson does not belong to the enrolled course');
    }

    return enrollment;
  }

  /**
   * Mark a lesson as watched / completed by a student.
   * Automatically recalculates the enrollment progress percentage.
   * Called when the student reaches the end of a video or marks a text lesson done.
   */
  async markLessonComplete(
    studentId: string,
    enrollmentId: string,
    lessonId: string,
    watchedSecs?: number,
  ) {
    await this.verifyEnrollmentAndLesson(studentId, enrollmentId, lessonId);

    const progress = await this.prisma.lessonProgress.upsert({
      where: { enrollmentId_lessonId: { enrollmentId, lessonId } },
      create: {
        enrollmentId,
        lessonId,
        completed:   true,
        watchedSecs: watchedSecs ?? 0,
        completedAt: new Date(),
      },
      update: {
        completed:   true,
        watchedSecs: watchedSecs ?? 0,
        completedAt: new Date(),
      },
    });

    // Recalculate enrollment progress
    await this.recalculateProgress(enrollmentId);

    return progress;
  }

  /**
   * Update video watch position (called periodically by the frontend player).
   */
  async updateWatchProgress(
    studentId: string,
    enrollmentId: string,
    lessonId: string,
    watchedSecs: number,
  ) {
    await this.verifyEnrollmentAndLesson(studentId, enrollmentId, lessonId);

    return this.prisma.lessonProgress.upsert({
      where: { enrollmentId_lessonId: { enrollmentId, lessonId } },
      create: { enrollmentId, lessonId, watchedSecs },
      update: { watchedSecs },
    });
  }

  async getStudentProgress(enrollmentId: string) {
    return this.prisma.lessonProgress.findMany({
      where: { enrollmentId },
      include: { lesson: { select: { title: true, position: true } } },
      orderBy: { lesson: { position: 'asc' } },
    });
  }

  private async recalculateProgress(enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: { course: { include: { modules: { include: { lessons: true } } } } },
    });
    if (!enrollment) return;

    const allLessons = enrollment.course.modules.flatMap((m) => m.lessons);
    const total = allLessons.length;
    if (total === 0) return;

    const completed = await this.prisma.lessonProgress.count({
      where: { enrollmentId, completed: true },
    });

    const progressPercent = Math.round((completed / total) * 100);

    await this.prisma.enrollment.update({
      where: { id: enrollmentId },
      data: {
        progressPercent,
        ...(progressPercent === 100 ? {
          status:      'COMPLETED',
          completedAt: new Date(),
        } : {}),
      },
    });

    this.logger.debug(`Enrollment ${enrollmentId} progress: ${progressPercent}%`);
    return progressPercent;
  }
}
