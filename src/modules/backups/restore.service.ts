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
  coursesFailedIds: string[];
  modulesRestored: number;
  lessonsRestored: number;
}

/** Shorthand for the interactive-transaction client Prisma exposes. */
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
      coursesFailedIds: [],
      modulesRestored: 0,
      lessonsRestored: 0,
    };

    let completedSteps = 0;
    const totalSteps = job.totalSteps || this.countSteps(payload.courses);
    let jobFailed = false;
    let lastError: Error | null = null;

    for (const course of payload.courses) {
      // ── pre-flight checks (no transaction needed) ──────────────────────
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

      // ── atomic per-course restore ──────────────────────────────────────
      try {
        const courseSummary = await this.prisma.$transaction(async (tx) => {
          const partial = {
            modulesRestored: 0,
            lessonsRestored: 0,
          };

          await this.restoreCourseInTx(tx, course, !!existing);
          completedSteps += 1;

          for (const mod of course.modules ?? []) {
            const moduleId = await this.restoreModuleInTx(tx, course.id, mod);
            partial.modulesRestored += 1;
            completedSteps += 1;

            for (const lesson of mod.lessons ?? []) {
              await this.restoreLessonInTx(tx, moduleId, lesson);
              partial.lessonsRestored += 1;
              completedSteps += 1;
            }
          }

          return partial;
        });

        summary.coursesRestored += 1;
        summary.modulesRestored += courseSummary.modulesRestored;
        summary.lessonsRestored += courseSummary.lessonsRestored;
        await this.updateProgress(jobId, completedSteps, totalSteps);
      } catch (error) {
        // Transaction was rolled back automatically — original data is intact.
        const errMsg: string = error?.message ?? 'Unknown restore error';
        this.logger.error(
          `Course ${course.id} restore failed and was rolled back: ${errMsg}`,
          error?.stack,
        );
        summary.coursesFailedIds.push(course.id);
        completedSteps += this.countCourseSteps(course);
        await this.updateProgress(jobId, completedSteps, totalSteps);
        jobFailed = true;
        lastError = error as Error;
      }
    }

    // ── finalise job record ────────────────────────────────────────────────
    const hasSuccesses = summary.coursesRestored > 0;
    const allFailed =
      summary.coursesFailedIds.length ===
      summary.coursesRequested - summary.coursesSkipped;

    const finalStatus =
      !jobFailed
        ? CourseRestoreStatus.COMPLETED
        : hasSuccesses && !allFailed
          ? CourseRestoreStatus.COMPLETED   // partial success — mark completed with failure list in summary
          : CourseRestoreStatus.FAILED;

    return this.prisma.courseRestoreJob.update({
      where: { id: jobId },
      data: {
        status: finalStatus,
        progressPercent: 100,
        completedSteps: totalSteps,
        completedAt: new Date(),
        summary: summary as unknown as Prisma.InputJsonValue,
        ...(jobFailed && {
          errorMessage:
            summary.coursesFailedIds.length === 1
              ? `Course ${summary.coursesFailedIds[0]} failed: ${lastError?.message ?? 'Unknown error'}`
              : `${summary.coursesFailedIds.length} courses failed: ${summary.coursesFailedIds.join(', ')}`,
        }),
      },
    });
  }

  // ── transactional helpers ────────────────────────────────────────────────

  /**
   * Clear existing structure for `course` then upsert its top-level record,
   * all within the supplied transaction client.
   */
  private async restoreCourseInTx(
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
      // Clear dependents bottom-up before removing modules/lessons.
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

      return tx.course.update({ where: { id: course.id }, data });
    }

    return tx.course.create({ data: { id: course.id, ...data } });
  }

  private async restoreModuleInTx(
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

  private async restoreLessonInTx(
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

  // ── validation helpers ───────────────────────────────────────────────────

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
