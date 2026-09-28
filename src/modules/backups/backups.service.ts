import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { createHash } from "node:crypto";
import {
  CourseBackup,
  CourseBackupStatus,
  CourseStatus,
  LessonType,
  Prisma,
  UserRole,
} from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import {
  CourseBackupExportPayload,
  CourseBackupValidationReport,
  MissingElementInfo,
  QueryCourseBackupsDto,
} from "./dto/course-backup.dto";
import {
  RestoreCourseBackupDto,
  RestoreLessonDto,
  RestoreModuleDto,
} from "./dto/restore-course.dto";

export interface UserContext {
  id: string;
  role: UserRole;
  stellarAddress?: string;
}

export interface ScheduledBackupSummary {
  timestamp: string;
  totalEligibleCourses: number;
  successfulBackups: number;
  failedBackups: number;
  errors: Array<{ courseId: string; message: string }>;
}

@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Request and immediately process a full course backup export.
   * Exports full course structure, modules, and lessons formatted for restore compatibility.
   */
  async exportCourseBackup(
    courseId: string,
    user?: UserContext,
    isAutomatic = false,
  ): Promise<CourseBackup> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: {
        modules: {
          orderBy: { position: "asc" },
          include: {
            lessons: {
              orderBy: { position: "asc" },
            },
          },
        },
      },
    });

    if (!course) {
      throw new NotFoundException(`Course with ID ${courseId} not found`);
    }

    if (user) {
      this.assertCourseAccess(course.instructorAddress, user);
    }

    // Determine the next version number for this course
    const latestBackup = await this.prisma.courseBackup.findFirst({
      where: { courseId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = latestBackup ? latestBackup.version + 1 : 1;

    // Validate completeness of course structure and content
    const validationReport = this.validateCompleteness(course);

    // Transform database course model into restorable format matching RestoreCourseBackupDto
    const coursePayload: RestoreCourseBackupDto = {
      id: course.id,
      instructorAddress: course.instructorAddress,
      title: course.title,
      description: course.description ?? undefined,
      category: course.category,
      level: course.level,
      language: course.language,
      thumbnailUrl: course.thumbnailUrl ?? undefined,
      previewVideoUrl: course.previewVideoUrl ?? undefined,
      price: Number(course.price),
      platformFeePercent: course.platformFeePercent,
      status: course.status,
      modules: course.modules.map((mod): RestoreModuleDto => ({
        id: mod.id,
        title: mod.title,
        position: mod.position,
        lessons: mod.lessons.map((lesson): RestoreLessonDto => ({
          id: lesson.id,
          title: lesson.title,
          description: lesson.description ?? undefined,
          type: lesson.type,
          videoUrl: lesson.videoUrl ?? undefined,
          videoDuration: lesson.videoDuration ?? undefined,
          content: lesson.content ?? undefined,
          resourceUrl: lesson.resourceUrl ?? undefined,
          position: lesson.position,
          isFree: lesson.isFree,
        })),
      })),
    };

    const unchecksummedPayload = {
      formatVersion: "1.0.0",
      courseBackupVersion: nextVersion,
      courseId: course.id,
      exportedAt: new Date().toISOString(),
      isAutomatic,
      requestedBy: user?.id ?? null,
      course: coursePayload,
      validationReport,
    };

    const serializedPayload = JSON.stringify(unchecksummedPayload);
    const checksum = createHash("sha256")
      .update(serializedPayload)
      .digest("hex");

    const fullPayload: CourseBackupExportPayload = {
      ...unchecksummedPayload,
      checksum,
    };

    const fileSizeBytes = Buffer.byteLength(
      JSON.stringify(fullPayload),
      "utf8",
    );

    try {
      const backup = await this.prisma.courseBackup.create({
        data: {
          courseId,
          version: nextVersion,
          status: CourseBackupStatus.COMPLETED,
          isAutomatic,
          requestedBy: user?.id ?? null,
          payload: fullPayload as unknown as Prisma.InputJsonValue,
          fileSizeBytes,
          checksum,
          isComplete: validationReport.isComplete,
          validationReport:
            validationReport as unknown as Prisma.InputJsonValue,
        },
      });

      this.logger.log(
        `Created backup for course ${courseId} (v${nextVersion}, size: ${fileSizeBytes} bytes, complete: ${validationReport.isComplete})`,
      );
      return backup;
    } catch (error) {
      this.logger.error(
        `Failed to record backup for course ${courseId}: ${error?.message ?? error}`,
      );
      throw error;
    }
  }

  /**
   * Validate exported data completeness and structural integrity.
   */
  validateCompleteness(course: {
    id: string;
    title: string;
    instructorAddress: string;
    category: string;
    price: any;
    status: CourseStatus;
    modules?: Array<{
      id: string;
      title: string;
      position: number;
      lessons?: Array<{
        id: string;
        title: string;
        position: number;
        type: LessonType;
        videoUrl?: string | null;
        content?: string | null;
      }>;
    }>;
  }): CourseBackupValidationReport {
    const errors: string[] = [];
    const warnings: string[] = [];
    const missingContentLessons: MissingElementInfo[] = [];
    const missingVideoLessons: MissingElementInfo[] = [];

    if (!course.id?.trim()) {
      errors.push("Course id is required and cannot be empty");
    }
    if (!course.title?.trim()) {
      errors.push("Course title is required and cannot be empty");
    }
    if (!course.instructorAddress?.trim()) {
      errors.push("Instructor Stellar address is required");
    }
    if (!course.category?.trim()) {
      errors.push("Course category is required");
    }
    if (
      course.price === undefined ||
      course.price === null ||
      Number(course.price) < 0
    ) {
      errors.push("Course price must be a non-negative number");
    }

    const modules = course.modules ?? [];
    if (modules.length === 0) {
      errors.push("Course contains no modules");
    }

    let totalLessons = 0;
    let totalVideoLessons = 0;
    let totalTextLessons = 0;

    const modulePositions = new Set<number>();

    for (const mod of modules) {
      if (!mod.title?.trim()) {
        errors.push(`Module ${mod.id} is missing a title`);
      }
      if (typeof mod.position !== "number" || mod.position < 0) {
        errors.push(
          `Module "${mod.title || mod.id}" has an invalid position (${mod.position})`,
        );
      } else if (modulePositions.has(mod.position)) {
        warnings.push(`Duplicate module position detected: ${mod.position}`);
      } else {
        modulePositions.add(mod.position);
      }

      const lessons = mod.lessons ?? [];
      if (lessons.length === 0) {
        warnings.push(`Module "${mod.title || mod.id}" contains no lessons`);
      }

      const lessonPositions = new Set<number>();

      for (const lesson of lessons) {
        totalLessons += 1;

        if (!lesson.title?.trim()) {
          errors.push(
            `Lesson ${lesson.id} in module "${mod.title}" is missing a title`,
          );
        }
        if (typeof lesson.position !== "number" || lesson.position < 0) {
          errors.push(
            `Lesson "${lesson.title || lesson.id}" has an invalid position (${lesson.position})`,
          );
        } else if (lessonPositions.has(lesson.position)) {
          warnings.push(
            `Duplicate lesson position ${lesson.position} in module "${mod.title}"`,
          );
        } else {
          lessonPositions.add(lesson.position);
        }

        if (lesson.type === LessonType.VIDEO) {
          totalVideoLessons += 1;
          if (!lesson.videoUrl?.trim()) {
            const info: MissingElementInfo = {
              moduleId: mod.id,
              moduleTitle: mod.title,
              lessonId: lesson.id,
              lessonTitle: lesson.title,
              field: "videoUrl",
              message: `Video lesson "${lesson.title}" has no video URL`,
            };
            missingVideoLessons.push(info);
            errors.push(info.message);
          }
        } else if (lesson.type === LessonType.TEXT) {
          totalTextLessons += 1;
          if (!lesson.content?.trim()) {
            const info: MissingElementInfo = {
              moduleId: mod.id,
              moduleTitle: mod.title,
              lessonId: lesson.id,
              lessonTitle: lesson.title,
              field: "content",
              message: `Text lesson "${lesson.title}" has no textual content`,
            };
            missingContentLessons.push(info);
            errors.push(info.message);
          }
        }
      }
    }

    return {
      isComplete: errors.length === 0,
      errors,
      warnings,
      totalModules: modules.length,
      totalLessons,
      totalVideoLessons,
      totalTextLessons,
      missingContentLessons,
      missingVideoLessons,
    };
  }

  /**
   * Retrieve list of backup versions for a specific course.
   */
  async getCourseBackupVersions(
    courseId: string,
    user?: UserContext,
    page = 1,
    limit = 20,
  ) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, instructorAddress: true },
    });

    if (!course) {
      throw new NotFoundException(`Course with ID ${courseId} not found`);
    }

    if (user) {
      this.assertCourseAccess(course.instructorAddress, user);
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.courseBackup.findMany({
        where: { courseId },
        skip,
        take: limit,
        orderBy: { version: "desc" },
        select: {
          id: true,
          courseId: true,
          version: true,
          status: true,
          isAutomatic: true,
          requestedBy: true,
          fileSizeBytes: true,
          checksum: true,
          isComplete: true,
          validationReport: true,
          downloadCount: true,
          lastDownloadedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.courseBackup.count({
        where: { courseId },
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Retrieve a specific backup by courseId and version number.
   */
  async getCourseBackupByVersion(
    courseId: string,
    version: number,
    user?: UserContext,
  ) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, instructorAddress: true },
    });

    if (!course) {
      throw new NotFoundException(`Course with ID ${courseId} not found`);
    }

    if (user) {
      this.assertCourseAccess(course.instructorAddress, user);
    }

    const backup = await this.prisma.courseBackup.findUnique({
      where: {
        courseId_version: {
          courseId,
          version,
        },
      },
    });

    if (!backup) {
      throw new NotFoundException(
        `Backup version ${version} for course ${courseId} not found`,
      );
    }

    return backup;
  }

  /**
   * Provide download status and metadata for a backup.
   */
  async getBackupStatus(backupId: string, user?: UserContext) {
    const backup = await this.prisma.courseBackup.findUnique({
      where: { id: backupId },
      include: {
        course: {
          select: { id: true, instructorAddress: true, title: true },
        },
        requester: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    if (!backup) {
      throw new NotFoundException(`Backup ${backupId} not found`);
    }

    if (user) {
      this.assertCourseAccess(backup.course.instructorAddress, user);
    }

    return {
      id: backup.id,
      courseId: backup.courseId,
      courseTitle: backup.course.title,
      version: backup.version,
      status: backup.status,
      isAutomatic: backup.isAutomatic,
      isComplete: backup.isComplete,
      fileSizeBytes: backup.fileSizeBytes,
      checksum: backup.checksum,
      downloadCount: backup.downloadCount,
      lastDownloadedAt: backup.lastDownloadedAt,
      errorMessage: backup.errorMessage,
      validationReport: backup.validationReport,
      createdAt: backup.createdAt,
      updatedAt: backup.updatedAt,
      requester: backup.requester,
    };
  }

  /**
   * Download the restorable backup file payload and increment download metrics.
   */
  async downloadBackup(backupId: string, user?: UserContext) {
    const backup = await this.prisma.courseBackup.findUnique({
      where: { id: backupId },
      include: {
        course: {
          select: { id: true, instructorAddress: true, title: true },
        },
      },
    });

    if (!backup) {
      throw new NotFoundException(`Backup ${backupId} not found`);
    }

    if (user) {
      this.assertCourseAccess(backup.course.instructorAddress, user);
    }

    if (backup.status !== CourseBackupStatus.COMPLETED) {
      throw new BadRequestException(
        `Backup ${backupId} is not ready for download (status: ${backup.status})`,
      );
    }

    // Increment download counter and record timestamp
    await this.prisma.courseBackup.update({
      where: { id: backupId },
      data: {
        downloadCount: { increment: 1 },
        lastDownloadedAt: new Date(),
      },
    });

    return {
      filename: `course-${backup.courseId}-v${backup.version}.json`,
      payload: backup.payload,
      checksum: backup.checksum,
      fileSizeBytes: backup.fileSizeBytes,
    };
  }

  /**
   * Filter and list course backups.
   */
  async listBackups(query: QueryCourseBackupsDto, user?: UserContext) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.CourseBackupWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.isAutomatic !== undefined) {
      where.isAutomatic = query.isAutomatic;
    }

    // If instructor, limit to courses they own
    if (user && user.role !== UserRole.ADMIN) {
      where.course = {
        instructorAddress: user.stellarAddress,
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.courseBackup.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          course: {
            select: { id: true, title: true, instructorAddress: true },
          },
        },
      }),
      this.prisma.courseBackup.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Scheduled automatic course backup runner.
   * Runs daily at midnight UTC to backup active and draft courses.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: "automatic-course-backups",
    timeZone: "UTC",
  })
  async handleScheduledAutomaticBackups(): Promise<ScheduledBackupSummary> {
    this.logger.log("Starting daily scheduled automatic course backups...");
    return this.runScheduledBackups();
  }

  /**
   * Execute scheduled backup routine for eligible courses.
   */
  async runScheduledBackups(): Promise<ScheduledBackupSummary> {
    const startedAt = new Date().toISOString();

    const courses = await this.prisma.course.findMany({
      where: {
        status: {
          in: [CourseStatus.ACTIVE, CourseStatus.DRAFT, CourseStatus.PENDING],
        },
      },
      select: { id: true },
    });

    const summary: ScheduledBackupSummary = {
      timestamp: startedAt,
      totalEligibleCourses: courses.length,
      successfulBackups: 0,
      failedBackups: 0,
      errors: [],
    };

    for (const course of courses) {
      try {
        await this.exportCourseBackup(course.id, undefined, true);
        summary.successfulBackups += 1;
      } catch (error) {
        summary.failedBackups += 1;
        summary.errors.push({
          courseId: course.id,
          message: error?.message ?? "Unknown error",
        });
        this.logger.error(
          `Scheduled backup failed for course ${course.id}: ${error?.message ?? error}`,
        );
      }
    }

    this.logger.log(
      `Scheduled automatic backup run complete: ${summary.successfulBackups}/${summary.totalEligibleCourses} courses backed up, ${summary.failedBackups} failed.`,
    );

    return summary;
  }

  /**
   * Helper to verify instructor course ownership or admin privileges.
   */
  private assertCourseAccess(instructorAddress: string, user: UserContext) {
    if (user.role === UserRole.ADMIN) {
      return;
    }

    if (
      user.role !== UserRole.INSTRUCTOR ||
      !user.stellarAddress ||
      user.stellarAddress !== instructorAddress
    ) {
      throw new ForbiddenException(
        "You do not have permission to access backups for this course",
      );
    }
  }
}
