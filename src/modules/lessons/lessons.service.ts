// lessons.service.ts
import {
  Injectable, NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class LessonsService {
  private readonly logger = new Logger(LessonsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createModule(courseId: string, title: string, position: number) {
    return this.prisma.courseModule.create({
      data: { courseId, title, position },
    });
  }

  async createLesson(moduleId: string, data: {
    title: string;
    description?: string;
    type?: string;
    videoUrl?: string;
    videoDuration?: number;
    content?: string;
    resourceUrl?: string;
    position: number;
    isFree?: boolean;
  }) {
    const lesson = await this.prisma.lesson.create({
      data: {
        moduleId,
        title:         data.title,
        description:   data.description,
        type:          data.type as any ?? 'VIDEO',
        videoUrl:      data.videoUrl,
        videoDuration: data.videoDuration,
        content:       data.content,
        resourceUrl:   data.resourceUrl,
        position:      data.position,
        isFree:        data.isFree ?? false,
      },
    });

    // Update totalLessons on the course
    const module = await this.prisma.courseModule.findUnique({
      where: { id: moduleId },
    });
    if (module) {
      await this.prisma.course.update({
        where: { id: module.courseId },
        data: { totalLessons: { increment: 1 } },
      });
    }

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

  // ----------------------------------------------------------
  // PROGRESS TRACKING
  // ----------------------------------------------------------

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
    enrollmentId: string,
    lessonId: string,
    watchedSecs: number,
  ) {
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
