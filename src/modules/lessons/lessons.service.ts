// lessons.service.ts
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DripScheduleService } from './drip-schedule.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { SERVER_ANALYTICS_EVENTS } from '../analytics/dto/track-analytics-event.dto';

@Injectable()
export class LessonsService {
  private readonly logger = new Logger(LessonsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly dripSchedule: DripScheduleService,
  ) {}

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
      quizDurationMinutes?: number;
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
        quizDurationMinutes: data.quizDurationMinutes,
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

  // ----------------------------------------------------------
  // CONTENT MANAGEMENT: UPDATE / DELETE / REORDER (#330)
  // ----------------------------------------------------------

  private async verifyLessonOwnership(
    lessonId: string,
    user?: { id?: string; stellarAddress?: string; role?: string },
  ) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { module: { select: { id: true, courseId: true } } },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    await this.verifyCourseOwnership(lesson.module.courseId, user);
    return lesson;
  }

  async updateModule(
    moduleId: string,
    data: { title?: string; position?: number },
    user?: { id?: string; stellarAddress?: string; role?: string },
  ) {
    const module = await this.verifyModuleOwnership(moduleId, user);

    const updated = await this.prisma.courseModule.update({
      where: { id: moduleId },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.position !== undefined ? { position: data.position } : {}),
      },
    });

    // Module order drives sequential drip pacing.
    if (data.position !== undefined && data.position !== module.position) {
      await this.dripSchedule.resyncCourseSchedules(module.courseId);
    }

    return updated;
  }

  async deleteModule(
    moduleId: string,
    user?: { id?: string; stellarAddress?: string; role?: string },
  ) {
    const module = await this.verifyModuleOwnership(moduleId, user);

    const lessons = await this.prisma.lesson.findMany({
      where: { moduleId },
      select: { id: true },
    });
    const lessonIds = lessons.map((l) => l.id);

    await this.prisma.$transaction(async (tx) => {
      await this.purgeLessons(tx, lessonIds);
      await tx.courseModule.delete({ where: { id: moduleId } });
      await this.syncTotalLessons(tx, module.courseId);
    });

    await this.dripSchedule.resyncCourseSchedules(module.courseId);

    return { success: true, id: moduleId, deletedLessons: lessonIds.length };
  }

  async updateLesson(
    lessonId: string,
    data: {
      title?: string;
      description?: string;
      type?: string;
      videoUrl?: string;
      videoDuration?: number;
      quizDurationMinutes?: number;
      thumbnailUrl?: string;
      content?: string;
      resourceUrl?: string;
      position?: number;
      isFree?: boolean;
    },
    user?: { id?: string; stellarAddress?: string; role?: string },
  ) {
    const lesson = await this.verifyLessonOwnership(lessonId, user);

    const fields = [
      'title', 'description', 'type', 'videoUrl', 'videoDuration', 'quizDurationMinutes',
      'thumbnailUrl', 'content', 'resourceUrl', 'position', 'isFree',
    ] as const;
    const updateData: Record<string, unknown> = {};
    for (const field of fields) {
      if (data[field] !== undefined) updateData[field] = data[field];
    }

    const updated = await this.prisma.lesson.update({
      where: { id: lessonId },
      data: updateData as Prisma.LessonUpdateInput,
    });

    if (data.position !== undefined && data.position !== lesson.position) {
      await this.dripSchedule.resyncCourseSchedules(lesson.module.courseId);
    }

    return updated;
  }

  async deleteLesson(
    lessonId: string,
    user?: { id?: string; stellarAddress?: string; role?: string },
  ) {
    const lesson = await this.verifyLessonOwnership(lessonId, user);
    const courseId = lesson.module.courseId;

    await this.prisma.$transaction(async (tx) => {
      await this.purgeLessons(tx, [lessonId]);
      await this.syncTotalLessons(tx, courseId);
    });

    await this.dripSchedule.resyncCourseSchedules(courseId);

    return { success: true, id: lessonId };
  }

  /**
   * Bulk reorder modules and lessons of a course in a single transaction.
   * Lessons may also be moved to another module of the same course.
   */
  async reorderCourseContent(
    courseId: string,
    data: {
      modules?: { id: string; position: number }[];
      lessons?: { id: string; position: number; moduleId?: string }[];
    },
    user?: { id?: string; stellarAddress?: string; role?: string },
  ) {
    await this.verifyCourseOwnership(courseId, user);

    const modules = data.modules ?? [];
    const lessons = data.lessons ?? [];

    if (modules.length === 0 && lessons.length === 0) {
      throw new BadRequestException('Provide at least one module or lesson position');
    }

    const moduleIds = modules.map((m) => m.id);
    const lessonIds = lessons.map((l) => l.id);
    if (new Set(moduleIds).size !== moduleIds.length || new Set(lessonIds).size !== lessonIds.length) {
      throw new BadRequestException('Duplicate IDs in reorder payload');
    }

    const courseModules = await this.prisma.courseModule.findMany({
      where: { courseId },
      select: { id: true },
    });
    const courseModuleIds = new Set(courseModules.map((m) => m.id));

    for (const m of modules) {
      if (!courseModuleIds.has(m.id)) {
        throw new BadRequestException(`Module ${m.id} does not belong to this course`);
      }
    }
    for (const l of lessons) {
      if (l.moduleId && !courseModuleIds.has(l.moduleId)) {
        throw new BadRequestException(`Module ${l.moduleId} does not belong to this course`);
      }
    }

    if (lessonIds.length > 0) {
      const courseLessons = await this.prisma.lesson.findMany({
        where: { id: { in: lessonIds }, module: { courseId } },
        select: { id: true },
      });
      if (courseLessons.length !== lessonIds.length) {
        throw new BadRequestException('One or more lessons do not belong to this course');
      }
    }

    await this.prisma.$transaction([
      ...modules.map((m) =>
        this.prisma.courseModule.update({
          where: { id: m.id },
          data: { position: m.position },
        }),
      ),
      ...lessons.map((l) =>
        this.prisma.lesson.update({
          where: { id: l.id },
          data: { position: l.position, ...(l.moduleId ? { moduleId: l.moduleId } : {}) },
        }),
      ),
    ]);

    await this.dripSchedule.resyncCourseSchedules(courseId);

    return this.prisma.courseModule.findMany({
      where: { courseId },
      orderBy: { position: 'asc' },
      include: {
        lessons: {
          orderBy: { position: 'asc' },
          select: { id: true, title: true, position: true, moduleId: true },
        },
      },
    });
  }

  /**
   * Removes lessons together with dependent rows that are not cascaded by the
   * database (progress, Q&A, assignments). Quiz data, drip configs and unlocks
   * cascade on lesson delete.
   */
  private async purgeLessons(tx: Prisma.TransactionClient, lessonIds: string[]) {
    if (lessonIds.length === 0) return;

    await tx.answer.deleteMany({ where: { question: { lessonId: { in: lessonIds } } } });
    await tx.question.deleteMany({ where: { lessonId: { in: lessonIds } } });
    await tx.assignmentSubmission.deleteMany({
      where: { assignment: { lessonId: { in: lessonIds } } },
    });
    await tx.assignment.deleteMany({ where: { lessonId: { in: lessonIds } } });
    await tx.lessonProgress.deleteMany({ where: { lessonId: { in: lessonIds } } });
    await tx.lesson.deleteMany({ where: { id: { in: lessonIds } } });
  }

  /** Recomputes course.totalLessons from the actual lesson rows. */
  private async syncTotalLessons(tx: Prisma.TransactionClient, courseId: string) {
    const totalLessons = await tx.lesson.count({ where: { module: { courseId } } });
    await tx.course.update({
      where: { id: courseId },
      data: { totalLessons },
    });
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
    const enrollment = await this.verifyEnrollmentAndLesson(
      studentId,
      enrollmentId,
      lessonId,
    );
    const existingProgress = await this.prisma.lessonProgress.findUnique({
      where: { enrollmentId_lessonId: { enrollmentId, lessonId } },
      select: { completed: true },
    });

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
    const progressPercent = await this.recalculateProgress(enrollmentId);
    if (!existingProgress?.completed) {
      await this.analytics.trackEvent(
        {
          eventType: SERVER_ANALYTICS_EVENTS.LESSON_COMPLETED,
          properties: {
            enrollmentId,
            lessonId,
            courseId: enrollment.courseId,
          },
        },
        { userId: studentId, source: 'server' },
      );
    }
    if (progressPercent === 100 && enrollment.status !== 'COMPLETED') {
      await this.analytics.trackEvent(
        {
          eventType: SERVER_ANALYTICS_EVENTS.COURSE_COMPLETED,
          properties: { enrollmentId, courseId: enrollment.courseId },
        },
        { userId: studentId, source: 'server' },
      );
    }

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
