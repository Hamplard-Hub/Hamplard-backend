import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '@prisma/client';

export interface ConfigureCourseDripDto {
  enabled: boolean;
  dripIntervalDays?: number;
}

export interface ConfigureLessonDripDto {
  delayDays?: number;
  unlockDate?: string | Date;
}

@Injectable()
export class DripScheduleService {
  private readonly logger = new Logger(DripScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Configure drip schedule pacing for a course (Instructor / Admin).
   */
  async configureCourseDrip(
    courseId: string,
    instructorIdOrAddress: string,
    dto: ConfigureCourseDripDto,
  ) {
    await this.assertCourseOwnership(courseId, instructorIdOrAddress);

    const config = await this.prisma.courseDripConfig.upsert({
      where: { courseId },
      update: {
        enabled: dto.enabled,
        dripIntervalDays: dto.dripIntervalDays ?? 1,
      },
      create: {
        courseId,
        enabled: dto.enabled,
        dripIntervalDays: dto.dripIntervalDays ?? 1,
      },
    });

    // Re-sync unlock schedules for all active enrollments in this course
    const enrollments = await this.prisma.enrollment.findMany({
      where: { courseId, status: 'ACTIVE' },
      select: { id: true },
    });

    for (const enrollment of enrollments) {
      await this.calculateAndSyncUnlockSchedule(enrollment.id);
    }

    return config;
  }

  /**
   * Configure specific drip delay or unlock date for a lesson (Instructor / Admin).
   */
  async configureLessonDrip(
    lessonId: string,
    instructorIdOrAddress: string,
    dto: ConfigureLessonDripDto,
  ) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { module: true },
    });
    if (!lesson) throw new NotFoundException(`Lesson ${lessonId} not found`);

    await this.assertCourseOwnership(lesson.module.courseId, instructorIdOrAddress);

    const unlockDateParsed = dto.unlockDate ? new Date(dto.unlockDate) : null;

    const config = await this.prisma.lessonDripConfig.upsert({
      where: { lessonId },
      update: {
        delayDays: dto.delayDays ?? 0,
        unlockDate: unlockDateParsed,
      },
      create: {
        lessonId,
        delayDays: dto.delayDays ?? 0,
        unlockDate: unlockDateParsed,
      },
    });

    // Re-sync unlock schedule for active enrollments
    const enrollments = await this.prisma.enrollment.findMany({
      where: { courseId: lesson.module.courseId, status: 'ACTIVE' },
      select: { id: true },
    });

    for (const enrollment of enrollments) {
      await this.calculateAndSyncUnlockSchedule(enrollment.id);
    }

    return config;
  }

  /**
   * Get drip configuration for a course and its lessons.
   */
  async getCourseDripConfig(courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: {
        dripConfig: true,
        modules: {
          orderBy: { position: 'asc' },
          include: {
            lessons: {
              orderBy: { position: 'asc' },
              include: { dripConfig: true },
            },
          },
        },
      },
    });

    if (!course) throw new NotFoundException(`Course ${courseId} not found`);

    return course;
  }

  /**
   * Calculates and synchronizes lesson unlock timestamps for a given enrollment.
   */
  async calculateAndSyncUnlockSchedule(enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        course: {
          include: {
            dripConfig: true,
            modules: {
              orderBy: { position: 'asc' },
              include: {
                lessons: {
                  orderBy: { position: 'asc' },
                  include: { dripConfig: true },
                },
              },
            },
          },
        },
        dripUnlocks: true,
      },
    });

    if (!enrollment) throw new NotFoundException(`Enrollment ${enrollmentId} not found`);

    const existingMap = new Map(enrollment.dripUnlocks.map((u) => [u.lessonId, u]));
    const dripConfig = enrollment.course.dripConfig;
    const isDripEnabled = dripConfig?.enabled ?? false;
    const intervalDays = dripConfig?.dripIntervalDays ?? 1;

    const allLessons = enrollment.course.modules.flatMap((m) => m.lessons);
    const enrolledAtTime = enrollment.enrolledAt.getTime();

    for (let index = 0; index < allLessons.length; index++) {
      const lesson = allLessons[index];
      const existingUnlock = existingMap.get(lesson.id);

      // Preserve existing manual instructor overrides
      if (existingUnlock?.isOverridden) {
        continue;
      }

      let unlockAt: Date;

      if (!isDripEnabled) {
        // Immediate unlock if drip is disabled
        unlockAt = enrollment.enrolledAt;
      } else {
        const lessonDrip = lesson.dripConfig;
        if (lessonDrip?.unlockDate) {
          unlockAt = new Date(lessonDrip.unlockDate);
        } else if (lessonDrip && lessonDrip.delayDays > 0) {
          unlockAt = new Date(enrolledAtTime + lessonDrip.delayDays * 24 * 60 * 60 * 1000);
        } else {
          // Automatic sequential pacing: unlock after (index * intervalDays) days
          unlockAt = new Date(enrolledAtTime + index * intervalDays * 24 * 60 * 60 * 1000);
        }
      }

      await this.prisma.enrollmentLessonUnlock.upsert({
        where: {
          enrollmentId_lessonId: { enrollmentId, lessonId: lesson.id },
        },
        update: { unlockAt },
        create: {
          enrollmentId,
          lessonId: lesson.id,
          unlockAt,
        },
      });
    }
  }

  /**
   * Validates if a student has access to a lesson based on drip schedule and preview status.
   */
  async validateLessonAccess(studentId: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { module: { include: { course: true } } },
    });

    if (!lesson) throw new NotFoundException(`Lesson ${lessonId} not found`);

    if (lesson.isFree) {
      return { allowed: true, reason: 'free_preview' };
    }

    const courseId = lesson.module.courseId;
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
      include: {
        dripUnlocks: { where: { lessonId } },
      },
    });

    if (!enrollment) {
      throw new ForbiddenException('You must be enrolled in this course to access this lesson');
    }

    let unlock = enrollment.dripUnlocks[0];
    if (!unlock) {
      await this.calculateAndSyncUnlockSchedule(enrollment.id);
      const rechecked = await this.prisma.enrollmentLessonUnlock.findUnique({
        where: { enrollmentId_lessonId: { enrollmentId: enrollment.id, lessonId } },
      });
      unlock = rechecked;
    }

    const now = new Date();
    if (unlock && (unlock.isOverridden || now >= unlock.unlockAt)) {
      return { allowed: true, unlockAt: unlock.unlockAt };
    }

    const unlockDateStr = unlock?.unlockAt ? unlock.unlockAt.toISOString() : 'a future date';
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Lesson Locked',
      message: `This lesson is scheduled to unlock on ${unlockDateStr}`,
      nextUnlockDate: unlock?.unlockAt ?? null,
    });
  }

  /**
   * Checks if a lesson is unlocked for an enrollment.
   */
  async isLessonUnlocked(enrollmentId: string, lessonId: string): Promise<boolean> {
    const unlock = await this.prisma.enrollmentLessonUnlock.findUnique({
      where: { enrollmentId_lessonId: { enrollmentId, lessonId } },
    });

    if (!unlock) return true; // Default fallback if no schedule record
    return unlock.isOverridden || new Date() >= unlock.unlockAt;
  }

  /**
   * Instructor override for drip pacing on a student enrollment.
   */
  async overrideInstructorDrip(
    instructorIdOrAddress: string,
    enrollmentId: string,
    lessonId?: string,
    overrideUnlockAt?: Date | string,
  ) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: { course: true },
    });

    if (!enrollment) throw new NotFoundException(`Enrollment ${enrollmentId} not found`);

    await this.assertCourseOwnership(enrollment.courseId, instructorIdOrAddress);

    const unlockTime = overrideUnlockAt ? new Date(overrideUnlockAt) : new Date();

    if (lessonId) {
      return this.prisma.enrollmentLessonUnlock.upsert({
        where: { enrollmentId_lessonId: { enrollmentId, lessonId } },
        update: {
          isOverridden: true,
          overriddenBy: instructorIdOrAddress,
          unlockAt: unlockTime,
        },
        create: {
          enrollmentId,
          lessonId,
          isOverridden: true,
          overriddenBy: instructorIdOrAddress,
          unlockAt: unlockTime,
        },
      });
    }

    // Bulk override for all lessons in the enrollment
    const lessons = await this.prisma.lesson.findMany({
      where: { module: { courseId: enrollment.courseId } },
      select: { id: true },
    });

    for (const l of lessons) {
      await this.prisma.enrollmentLessonUnlock.upsert({
        where: { enrollmentId_lessonId: { enrollmentId, lessonId: l.id } },
        update: {
          isOverridden: true,
          overriddenBy: instructorIdOrAddress,
          unlockAt: unlockTime,
        },
        create: {
          enrollmentId,
          lessonId: l.id,
          isOverridden: true,
          overriddenBy: instructorIdOrAddress,
          unlockAt: unlockTime,
        },
      });
    }

    return { success: true, count: lessons.length, overrideUnlockAt: unlockTime };
  }

  /**
   * Retrieve a student's full drip schedule and next unlock date for a course.
   */
  async getStudentDripSchedule(studentId: string, courseId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
      include: {
        course: {
          include: {
            dripConfig: true,
            modules: {
              orderBy: { position: 'asc' },
              include: {
                lessons: {
                  orderBy: { position: 'asc' },
                  select: { id: true, title: true, position: true, isFree: true },
                },
              },
            },
          },
        },
        dripUnlocks: true,
      },
    });

    if (!enrollment) throw new NotFoundException('Enrollment not found');

    const unlockMap = new Map(enrollment.dripUnlocks.map((u) => [u.lessonId, u]));
    const now = new Date();

    let nextUnlockDate: Date | null = null;

    const lessonsSchedule = enrollment.course.modules.flatMap((m) =>
      m.lessons.map((lesson) => {
        const unlock = unlockMap.get(lesson.id);
        const unlockAt = unlock?.unlockAt ?? enrollment.enrolledAt;
        const isUnlocked = lesson.isFree || (unlock?.isOverridden ?? false) || now >= unlockAt;

        if (!isUnlocked && unlockAt > now) {
          if (!nextUnlockDate || unlockAt < nextUnlockDate) {
            nextUnlockDate = unlockAt;
          }
        }

        return {
          lessonId: lesson.id,
          title: lesson.title,
          moduleTitle: m.title,
          isFree: lesson.isFree,
          unlockAt,
          isUnlocked,
          isOverridden: unlock?.isOverridden ?? false,
        };
      }),
    );

    return {
      courseId,
      studentId,
      enrolledAt: enrollment.enrolledAt,
      isDripEnabled: enrollment.course.dripConfig?.enabled ?? false,
      nextUnlockDate,
      schedule: lessonsSchedule,
    };
  }

  /**
   * Cron job that checks for newly unlocked lessons and notifies enrolled students.
   */
  @Cron('0 */10 * * * *')
  async notifyNewlyUnlockedLessons() {
    const now = new Date();

    const pendingUnlocks = await this.prisma.enrollmentLessonUnlock.findMany({
      where: {
        unlockAt: { lte: now },
        notifiedAt: null,
      },
      include: {
        enrollment: {
          select: { studentId: true, course: { select: { title: true } } },
        },
        lesson: { select: { title: true } },
      },
      take: 100,
    });

    for (const unlock of pendingUnlocks) {
      try {
        await this.notifications.notifyUser(
          unlock.enrollment.studentId,
          NotificationType.LESSON_UNLOCKED,
          'New Lesson Unlocked! 🔓',
          `Lesson "${unlock.lesson.title}" in "${unlock.enrollment.course.title}" is now available to learn.`,
          { lessonId: unlock.lessonId, courseTitle: unlock.enrollment.course.title },
        );

        await this.prisma.enrollmentLessonUnlock.update({
          where: { id: unlock.id },
          data: { notifiedAt: now },
        });
      } catch (err) {
        this.logger.error(`Failed to notify student for unlock ${unlock.id}: ${err.message}`);
      }
    }
  }

  private async assertCourseOwnership(courseId: string, instructorIdOrAddress: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: { instructor: true },
    });

    if (!course) throw new NotFoundException(`Course ${courseId} not found`);

    const isMatch =
      course.instructorAddress === instructorIdOrAddress ||
      course.instructor?.id === instructorIdOrAddress;

    if (!isMatch) {
      throw new ForbiddenException('You do not have permission to manage drip settings for this course');
    }
  }
}
