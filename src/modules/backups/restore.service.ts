import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  CourseRestoreStatus,
  CourseStatus,
  LessonType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  RestoreCourseBackupDto,
  RestoreCoursesDto,
  RestoreLessonDto,
  RestoreModuleDto,
} from './dto/restore-course.dto';

export interface SchemaValidationError {
  courseId?: string;
  field: string;
  message: string;
}

export interface CourseRestoreSummary {
  coursesRequested: number;
  coursesRestored: number;
  coursesSkipped: number;
  coursesFailed: number;
  modulesRestored: number;
  lessonsRestored: number;
  errors: Array<{ courseId: string; message: string }>;
}

// Transactional Prisma client — the type Prisma passes into $transaction callbacks.
type TxClient = Prisma.TransactionClient;

@Injectable()
export class RestoreService {
  private readonly logger = new Logger(RestoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Queue or immediately execute a course restore from backup payload.
   */
  async requestRestore(requestedBy: string, dto: RestoreCoursesDto) {
    const validationErrors = this.validateBackupAgainstSchema(dto.courses);
    if (validationErrors.length) {
      throw new BadRequestException({
        message: 'Backup payload failed schema validation',
        validationErrors,
      });
    }

    const totalSteps = this.countSteps(dto.courses);
    const scheduledFor = dto.scheduledFor
      ? new Date(dto.scheduledFor)
      : null;

    if (scheduledFor && scheduledFor.getTime() <= Date.now()) {
      throw new BadRequestException('scheduledFor must be in the future');
    }

    const job = await this.prisma.courseRestoreJob.create({
      data: {
        requestedBy,
        status: scheduledFor
          ? CourseRestoreStatus.SCHEDULED
          : CourseRestoreStatus.PENDING,
        totalSteps,
        scheduledFor,
        backupPayload: dto as unknown as Prisma.InputJsonValue,
        validationErrors: [],
      },
    });

    if (!scheduledFor) {
      return this.executeJob(job.id);
    }

    this.logger.log(
      `Course restore job ${job.id} scheduled for ${scheduledFor.toISOString()}`,
    );
    return this.getStatus(job.id);
  }

  async getStatus(jobId: string) {
    const job = await this.prisma.courseRestoreJob.findUnique({
      where: { id: jobId },
      include: {
        requester: {
          select: { id: true, name: true, email: true },
        },
      },
    });
    if (!job) throw new NotFoundException(`Restore job ${jobId} not found`);
    return job;
  }

  async listJobs(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.courseRestoreJob.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          requester: {
            select: { id: true, name: true, email: true },
          },
        },
      }),
      this.prisma.courseRestoreJob.count(),
    ]);
    return { data, meta: { total, page, limit } };
  }

  /**
   * Validate backup course data against the current Prisma/course schema shape.
   */
  validateBackupAgainstSchema(
    courses: RestoreCourseBackupDto[],
  ): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];
    const allowedStatuses = new Set(Object.values(CourseStatus));
    const allowedLessonTypes = new Set(Object.values(LessonType));

    if (!Array.isArray(courses) || courses.length === 0) {
      errors.push({
        field: 'courses',
        message: 'At least one course is required',
      });
      return errors;
    }

    for (const course of courses) {
      if (!course.id?.trim()) {
        errors.push({
          courseId: course.id,
          field: 'id',
          message: 'Course id is required',
        });
      }
      if (!course.instructorAddress?.trim()) {
        errors.push({
          courseId: course.id,
          field: 'instructorAddress',
          message: 'instructorAddress is required',
        });
      }
      if (!course.title?.trim()) {
        errors.push({
          courseId: course.id,
          field: 'title',
          message: 'title is required',
        });
      }
      if (!course.category?.trim()) {
        errors.push({
          courseId: course.id,
          field: 'category',
          message: 'category is required',
        });
      }
      if (typeof course.price !== 'number' || course.price < 0) {
        errors.push({
          courseId: course.id,
          field: 'price',
          message: 'price must be a non-negative number',
        });
      }
      if (course.status && !allowedStatuses.has(course.status as CourseStatus)) {
        errors.push({
          courseId: course.id,
          field: 'status',
          message: `Invalid course status "${course.status}"`,
        });
      }

      for (const mod of course.modules ?? []) {
        this.validateModule(mod, course.id, allowedLessonTypes, errors);
      }
    }

    return errors;
  }

  /**
   * Poll scheduled restores every minute and execute due jobs.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduledRestores() {
    const due = await this.prisma.courseRestoreJob.findMany({
      where: {
        status: CourseRestoreStatus.SCHEDULED,
        scheduledFor: { lte: new Date() },
      },
      take: 5,
      orderBy: { scheduledFor: 'asc' },
    });

    for (const job of due) {
      try {
        await this.executeJob(job.id);
      } catch (error) {
        this.logger.error(
          `Scheduled restore ${job.id} failed: ${error?.message ?? error}`,
        );
      }
    }
  }

  async executeJob(jobId: string) {
    const job = await this.prisma.courseRestoreJob.findUnique({
      where: { id: jobId },
    });
    if (!job) throw new NotFoundException(`Restore job ${jobId} not found`);

    if (
      job.status === CourseRestoreStatus.COMPLETED ||
      job.status === CourseRestoreStatus.IN_PROGRESS
    ) {
      return job;
    }

    const payload = job.backupPayload as unknown as RestoreCoursesDto;
    const overwriteExisting = payload.overwriteExisting !== false;

    await this.prisma.courseRestoreJob.update({
      where: { id: jobId },
      data: {
        status: CourseRestoreStatus.IN_PROGRESS,
        startedAt: new Date(),
        progressPercent: 0,
        completedSteps: 0,
      },
    });

    const summary: CourseRestoreSummary = {
      coursesRequested: payload.courses.length,
      coursesRestored: 0,
      coursesSkipped: 0,
      coursesFailed: 0,
      modulesRestored: 0,
      lessonsRestored: 0,
      errors: [],
    };

    let completedSteps = 0;
    const totalSteps = job.totalSteps || this.countSteps(payload.courses);

    for (const course of payload.courses) {
      // Resolve instructor outside the transaction (read-only, no atomicity needed)
      const instructor = await this.prisma.user.findUnique({
        where: { stellarAddress: course.instructorAddress },
        select: { id: true },
      });

      if (!instructor) {
        summary.coursesSkipped += 1;
        completedSteps += this.countCourseSteps(course);
        await this.updateProgress(jobId, completedSteps, totalSteps);
        continue;
      }

      const existing = await this.prisma.course.findUnique({
        where: { id: course.id },
      });

      if (existing && !overwriteExisting) {
        summary.coursesSkipped += 1;
        completedSteps += this.countCourseSteps(course);
        await this.updateProgress(jobId, completedSteps, totalSteps);
        continue;
      }

      // ─── Per-course atomic transaction ────────────────────────────────────
      // A failure anywhere inside rolls back only this course's changes,
      // leaving already-restored courses and the original data intact.
      try {
        const courseResult = await this.prisma.$transaction(async (tx) => {
          const modulesRestored: number[] = [];
          const lessonsRestored: number[] = [];

          await this.restoreCourse(tx, course, !!existing);

          for (const mod of course.modules ?? []) {
            const moduleId = await this.restoreModule(tx, course.id, mod);
            modulesRestored.push(1);

            for (const lesson of mod.lessons ?? []) {
              await this.restoreLesson(tx, moduleId, lesson);
              lessonsRestored.push(1);
            }
          }

          return {
            modules: modulesRestored.length,
            lessons: lessonsRestored.length,
          };
        });

        summary.coursesRestored += 1;
        summary.modulesRestored += courseResult.modules;
        summary.lessonsRestored += courseResult.lessons;
        completedSteps += this.countCourseSteps(course);
        await this.updateProgress(jobId, completedSteps, totalSteps);
      } catch (error) {
        // Record the failure for this course but continue processing others
        const message: string = error?.message ?? 'Unknown restore error';
        this.logger.error(
          `Restore job ${jobId}: course ${course.id} failed — ${message}`,
          error?.stack,
        );
        summary.coursesFailed += 1;
        summary.errors.push({ courseId: course.id, message });
        completedSteps += this.countCourseSteps(course);
        await this.updateProgress(jobId, completedSteps, totalSteps);
      }
    }

    // Mark the overall job completed (or failed if every course failed)
    const allFailed =
      summary.coursesFailed > 0 &&
      summary.coursesRestored === 0 &&
      summary.coursesSkipped === 0;

    return this.prisma.courseRestoreJob.update({
      where: { id: jobId },
      data: {
        status: allFailed
          ? CourseRestoreStatus.FAILED
          : CourseRestoreStatus.COMPLETED,
        progressPercent: 100,
        completedSteps: totalSteps,
        completedAt: new Date(),
        summary: summary as unknown as Prisma.InputJsonValue,
        // Surface the first course-level error as the top-level message when
        // the entire job failed, so callers get a useful errorMessage field.
        ...(allFailed && summary.errors.length
          ? {
              errorMessage: `Course ${summary.errors[0].courseId}: ${summary.errors[0].message}`,
            }
          : {}),
      },
    });
  }

  // ─── Private helpers (all accept a `tx` transactional client) ─────────────

  private async restoreCourse(
    tx: TxClient,
    course: RestoreCourseBackupDto,
    exists: boolean,
  ) {
    const data = {
      instructorAddress: course.instructorAddress,
      title: course.title,
      description: course.description ?? null,
      category: course.category,
      level: course.level ?? 'Beginner',
      language: course.language ?? 'English',
      thumbnailUrl: course.thumbnailUrl ?? null,
      previewVideoUrl: course.previewVideoUrl ?? null,
      price: course.price,
      platformFeePercent: course.platformFeePercent ?? 20,
      status: (course.status as CourseStatus) ?? CourseStatus.DRAFT,
      totalLessons: (course.modules ?? []).reduce(
        (n, m) => n + (m.lessons?.length ?? 0),
        0,
      ),
    };

    if (exists) {
      // Clear dependents (lesson progress, quiz questions, assignments, lessons,
      // then modules) before writing the new structure — all within the same tx.
      const modules = await tx.courseModule.findMany({
        where: { courseId: course.id },
        select: { id: true },
      });
      const moduleIds = modules.map((m) => m.id);

      if (moduleIds.length) {
        const lessons = await tx.lesson.findMany({
          where: { moduleId: { in: moduleIds } },
          select: { id: true },
        });
        const lessonIds = lessons.map((l) => l.id);

        if (lessonIds.length) {
          await tx.lessonProgress.deleteMany({
            where: { lessonId: { in: lessonIds } },
          });
          await tx.quizQuestion.deleteMany({
            where: { lessonId: { in: lessonIds } },
          });
          await tx.assignment.deleteMany({
            where: { lessonId: { in: lessonIds } },
          });
          await tx.lesson.deleteMany({
            where: { id: { in: lessonIds } },
          });
        }
        await tx.courseModule.deleteMany({
          where: { courseId: course.id },
        });
      }

      return tx.course.update({
        where: { id: course.id },
        data,
      });
    }

    return tx.course.create({
      data: { id: course.id, ...data },
    });
  }

  private async restoreModule(
    tx: TxClient,
    courseId: string,
    mod: RestoreModuleDto,
  ): Promise<string> {
    const created = await tx.courseModule.create({
      data: {
        ...(mod.id ? { id: mod.id } : {}),
        courseId,
        title: mod.title,
        position: mod.position,
      },
    });
    return created.id;
  }

  private async restoreLesson(
    tx: TxClient,
    moduleId: string,
    lesson: RestoreLessonDto,
  ) {
    return tx.lesson.create({
      data: {
        ...(lesson.id ? { id: lesson.id } : {}),
        moduleId,
        title: lesson.title,
        description: lesson.description ?? null,
        type: (lesson.type as LessonType) ?? LessonType.VIDEO,
        videoUrl: lesson.videoUrl ?? null,
        videoDuration: lesson.videoDuration ?? null,
        content: lesson.content ?? null,
        resourceUrl: lesson.resourceUrl ?? null,
        position: lesson.position,
        isFree: lesson.isFree ?? false,
      },
    });
  }

  private validateModule(
    mod: RestoreModuleDto,
    courseId: string,
    allowedLessonTypes: Set<string>,
    errors: SchemaValidationError[],
  ) {
    if (!mod.title?.trim()) {
      errors.push({
        courseId,
        field: 'modules.title',
        message: 'Module title is required',
      });
    }
    if (typeof mod.position !== 'number') {
      errors.push({
        courseId,
        field: 'modules.position',
        message: 'Module position must be a number',
      });
    }
    for (const lesson of mod.lessons ?? []) {
      if (!lesson.title?.trim()) {
        errors.push({
          courseId,
          field: 'lessons.title',
          message: 'Lesson title is required',
        });
      }
      if (typeof lesson.position !== 'number') {
        errors.push({
          courseId,
          field: 'lessons.position',
          message: 'Lesson position must be a number',
        });
      }
      if (lesson.type && !allowedLessonTypes.has(lesson.type)) {
        errors.push({
          courseId,
          field: 'lessons.type',
          message: `Invalid lesson type "${lesson.type}"`,
        });
      }
    }
  }

  private countSteps(courses: RestoreCourseBackupDto[]): number {
    return courses.reduce((sum, c) => sum + this.countCourseSteps(c), 0);
  }

  private countCourseSteps(course: RestoreCourseBackupDto): number {
    const modules = course.modules ?? [];
    const lessons = modules.reduce((n, m) => n + (m.lessons?.length ?? 0), 0);
    return 1 + modules.length + lessons;
  }

  private async updateProgress(
    jobId: string,
    completedSteps: number,
    totalSteps: number,
  ) {
    const progressPercent =
      totalSteps <= 0
        ? 100
        : Math.min(99, Math.floor((completedSteps / totalSteps) * 100));

    await this.prisma.courseRestoreJob.update({
      where: { id: jobId },
      data: { completedSteps, progressPercent, totalSteps },
    });
  }
}
