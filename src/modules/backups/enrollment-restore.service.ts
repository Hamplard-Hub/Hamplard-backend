import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import {
  EnrollmentConflictStrategy,
  RestoreEnrollmentRecordDto,
  RestoreEnrollmentsDto,
  RestoreLessonProgressDto,
} from './dto/restore-enrollments.dto';

export interface EnrollmentRestoreValidationIssue {
  studentId: string;
  courseId: string;
  lessonId?: string;
  reason: string;
}

export interface EnrollmentRestoreCounts {
  enrollmentsRequested: number;
  enrollmentsRestored: number;
  enrollmentsSkipped: number;
  enrollmentsOverwritten: number;
  enrollmentsMerged: number;
  progressRestored: number;
  progressSkipped: number;
  validationFailures: number;
}

export interface EnrollmentRestoreReport {
  id: string;
  requestedBy: string;
  conflictStrategy: EnrollmentConflictStrategy;
  counts: EnrollmentRestoreCounts;
  issues: EnrollmentRestoreValidationIssue[];
  createdAt: Date;
  completedAt: Date;
}

@Injectable()
export class EnrollmentRestoreService {
  private readonly logger = new Logger(EnrollmentRestoreService.name);
  private readonly reports = new Map<string, EnrollmentRestoreReport>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  /**
   * Restore enrollments + lesson progress from a backup payload.
   * Validates against the current course structure and resolves conflicts.
   */
  async restore(
    requestedBy: string,
    dto: RestoreEnrollmentsDto,
  ): Promise<EnrollmentRestoreReport> {
    const strategy =
      dto.conflictStrategy ?? EnrollmentConflictStrategy.SKIP;
    const counts: EnrollmentRestoreCounts = {
      enrollmentsRequested: dto.enrollments.length,
      enrollmentsRestored: 0,
      enrollmentsSkipped: 0,
      enrollmentsOverwritten: 0,
      enrollmentsMerged: 0,
      progressRestored: 0,
      progressSkipped: 0,
      validationFailures: 0,
    };
    const issues: EnrollmentRestoreValidationIssue[] = [];
    const createdAt = new Date();

    for (const record of dto.enrollments) {
      const validation = await this.validateAgainstCourseStructure(record);
      if (!validation.ok) {
        counts.validationFailures += 1;
        issues.push(...validation.issues);
        counts.enrollmentsSkipped += 1;
        continue;
      }
      // Collect soft validation warnings (e.g. orphan lesson ids)
      issues.push(...validation.issues);

      const mode =
        strategy === EnrollmentConflictStrategy.OVERWRITE
          ? 'overwrite'
          : strategy === EnrollmentConflictStrategy.MERGE
            ? 'merge'
            : 'create';

      const result = await this.enrollments.upsertFromBackup({
        id: record.id,
        studentId: record.studentId,
        courseId: record.courseId,
        amountPaid: record.amountPaid,
        txHash: record.txHash,
        status: record.status,
        progressPercent: record.progressPercent,
        completedAt: record.completedAt
          ? new Date(record.completedAt)
          : null,
        enrolledAt: record.enrolledAt
          ? new Date(record.enrolledAt)
          : undefined,
        mode: mode === 'create' ? 'create' : mode,
      });

      // When strategy is SKIP and record exists, upsert returns skipped
      if (result.action === 'skipped') {
        counts.enrollmentsSkipped += 1;
      } else if (result.action === 'overwritten') {
        counts.enrollmentsOverwritten += 1;
        counts.enrollmentsRestored += 1;
      } else if (result.action === 'merged') {
        counts.enrollmentsMerged += 1;
        counts.enrollmentsRestored += 1;
      } else {
        counts.enrollmentsRestored += 1;
      }

      // For SKIP on existing enrollment, still allow progress restore when missing
      if (record.lessonProgress?.length) {
        const progressResult = await this.restoreLessonProgress(
          result.enrollment.id,
          record.courseId,
          record.lessonProgress,
          strategy,
          validation.validLessonIds,
        );
        counts.progressRestored += progressResult.restored;
        counts.progressSkipped += progressResult.skipped;
        issues.push(...progressResult.issues);
      }
    }

    const report: EnrollmentRestoreReport = {
      id: randomUUID(),
      requestedBy,
      conflictStrategy: strategy,
      counts,
      issues,
      createdAt,
      completedAt: new Date(),
    };
    this.reports.set(report.id, report);
    this.logger.log(
      `Enrollment restore ${report.id}: restored=${counts.enrollmentsRestored} skipped=${counts.enrollmentsSkipped}`,
    );
    return report;
  }

  getReport(id: string): EnrollmentRestoreReport | undefined {
    return this.reports.get(id);
  }

  listReports(): EnrollmentRestoreReport[] {
    return Array.from(this.reports.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /**
   * Ensure the course exists and that referenced lessons belong to it.
   */
  async validateAgainstCourseStructure(
    record: RestoreEnrollmentRecordDto,
  ): Promise<{
    ok: boolean;
    issues: EnrollmentRestoreValidationIssue[];
    validLessonIds: Set<string>;
  }> {
    const issues: EnrollmentRestoreValidationIssue[] = [];
    const validLessonIds = new Set<string>();

    const student = await this.prisma.user.findUnique({
      where: { id: record.studentId },
      select: { id: true },
    });
    if (!student) {
      issues.push({
        studentId: record.studentId,
        courseId: record.courseId,
        reason: 'Student does not exist',
      });
      return { ok: false, issues, validLessonIds };
    }

    const course = await this.prisma.course.findUnique({
      where: { id: record.courseId },
      include: {
        modules: { include: { lessons: { select: { id: true } } } },
      },
    });

    if (!course) {
      issues.push({
        studentId: record.studentId,
        courseId: record.courseId,
        reason: 'Course does not exist in current catalog',
      });
      return { ok: false, issues, validLessonIds };
    }

    for (const mod of course.modules) {
      for (const lesson of mod.lessons) {
        validLessonIds.add(lesson.id);
      }
    }

    for (const progress of record.lessonProgress ?? []) {
      if (!validLessonIds.has(progress.lessonId)) {
        issues.push({
          studentId: record.studentId,
          courseId: record.courseId,
          lessonId: progress.lessonId,
          reason: 'Lesson is not part of the current course structure',
        });
      }
    }

    return { ok: true, issues, validLessonIds };
  }

  private async restoreLessonProgress(
    enrollmentId: string,
    courseId: string,
    items: RestoreLessonProgressDto[],
    strategy: EnrollmentConflictStrategy,
    validLessonIds: Set<string>,
  ): Promise<{
    restored: number;
    skipped: number;
    issues: EnrollmentRestoreValidationIssue[];
  }> {
    let restored = 0;
    let skipped = 0;
    const issues: EnrollmentRestoreValidationIssue[] = [];

    for (const item of items) {
      if (!validLessonIds.has(item.lessonId)) {
        skipped += 1;
        issues.push({
          studentId: '',
          courseId,
          lessonId: item.lessonId,
          reason: 'Skipped progress — lesson missing from current course',
        });
        continue;
      }

      const existing = await this.prisma.lessonProgress.findUnique({
        where: {
          enrollmentId_lessonId: {
            enrollmentId,
            lessonId: item.lessonId,
          },
        },
      });

      const data = {
        completed: item.completed ?? false,
        watchedSecs: item.watchedSecs ?? 0,
        completedAt: item.completedAt ? new Date(item.completedAt) : null,
      };

      if (!existing) {
        await this.prisma.lessonProgress.create({
          data: { enrollmentId, lessonId: item.lessonId, ...data },
        });
        restored += 1;
        continue;
      }

      if (strategy === EnrollmentConflictStrategy.SKIP) {
        skipped += 1;
        continue;
      }

      if (strategy === EnrollmentConflictStrategy.OVERWRITE) {
        await this.prisma.lessonProgress.update({
          where: { id: existing.id },
          data,
        });
        restored += 1;
        continue;
      }

      await this.prisma.lessonProgress.update({
        where: { id: existing.id },
        data: {
          completed: existing.completed || data.completed,
          watchedSecs: Math.max(existing.watchedSecs, data.watchedSecs),
          completedAt:
            existing.completedAt && data.completedAt
              ? existing.completedAt < data.completedAt
                ? existing.completedAt
                : data.completedAt
              : existing.completedAt ?? data.completedAt,
        },
      });
      restored += 1;
    }

    return { restored, skipped, issues };
  }
}
